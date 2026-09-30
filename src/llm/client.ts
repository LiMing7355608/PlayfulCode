/**
 * LLM 统一客户端。
 *
 * 职责：
 * 1. 依据配置装配具体 Provider；
 * 2. 在「原生 function calling」与「文本 JSON 协议」之间自动降级（只降一次，之后锁定）；
 * 3. 把重试事件翻译成 AgentEvent 推给 UI；
 * 4. 统计 token 用量。
 */

import type { AppConfig } from '../core/config';
import { PlayfulError, normalizeError } from '../core/errors';
import { createLogger } from '../core/logger';
import type { AgentEvent, LlmProvider, LlmRequest, LlmResponse, ChatMessage, ToolSpec } from '../core/types';
import { OpenAiCompatibleProvider } from './openai-compatible';
import { toLlmResponse, withTextProtocol } from './text-protocol';

const log = createLogger('llm');

export interface LlmClientOptions {
  config: AppConfig;
  /** 事件回调（重试提示、降级警告等） */
  emit?: (e: AgentEvent) => void;
  /** 允许注入自定义 Provider（测试用 Mock） */
  provider?: LlmProvider;
}

export class LlmClient {
  readonly provider: LlmProvider;
  readonly model: string;

  private readonly cfg: AppConfig;
  private readonly emit?: (e: AgentEvent) => void;

  /** 是否已降级到文本协议 */
  private textMode: boolean;
  /** 累计 token 用量 */
  private readonly usageAcc = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

  constructor(opts: LlmClientOptions) {
    this.cfg = opts.config;
    this.emit = opts.emit;
    this.textMode = opts.config.forceTextProtocol;

    this.provider =
      opts.provider ??
      new OpenAiCompatibleProvider(
        {
          baseUrl: opts.config.baseUrl,
          apiKey: opts.config.apiKey,
          model: opts.config.model,
          temperature: opts.config.temperature,
          timeoutMs: opts.config.requestTimeoutMs,
          retries: opts.config.maxRetries,
          sendTools: !this.textMode,
          onRetry: (attempt, delayMs, reason) => {
            this.emit?.({ type: 'retry', attempt, delayMs, reason });
          },
        },
        opts.config.provider,
        true,
      );

    this.model = this.provider.model;
    if (this.textMode) log.info(`已按配置强制使用文本 JSON 协议（模型：${this.model}）`);
  }

  get usingTextProtocol(): boolean {
    return this.textMode;
  }

  get usage(): { promptTokens: number; completionTokens: number; totalTokens: number } {
    return { ...this.usageAcc };
  }

  /** 发起一次对话补全。 */
  async chat(messages: ChatMessage[], tools: ToolSpec[], signal?: AbortSignal): Promise<LlmResponse> {
    const req: LlmRequest = { messages, tools, temperature: this.cfg.temperature, signal };
    const res = await this.dispatch(req);

    if (res.usage) {
      this.usageAcc.promptTokens += res.usage.promptTokens ?? 0;
      this.usageAcc.completionTokens += res.usage.completionTokens ?? 0;
      this.usageAcc.totalTokens += res.usage.totalTokens ?? 0;
      this.emit?.({
        type: 'usage',
        promptTokens: res.usage.promptTokens,
        completionTokens: res.usage.completionTokens,
        totalTokens: res.usage.totalTokens,
      });
    }
    return res;
  }

  private async dispatch(req: LlmRequest): Promise<LlmResponse> {
    if (!this.textMode) {
      try {
        return await this.provider.chat(req);
      } catch (e) {
        const err = normalizeError(e);
        // 判定是否需要降级到文本协议：模型或网关不认 tools 字段
        const canDowngrade =
          err.code === 'LLM_PROTOCOL_ERROR' ||
          /tool|function/i.test(err.message) ||
          (err.code === 'LLM_HTTP_ERROR' && /tool|function/i.test(err.message));

        if (!canDowngrade) throw err;

        // 只降级一次，之后本次会话固定走文本协议
        this.textMode = true;
        const downgraded = this.provider as Partial<OpenAiCompatibleProvider>;
        if (typeof downgraded.disableNativeTools === 'function') downgraded.disableNativeTools();

        log.warn(`原生 function calling 不可用，已自动降级为文本 JSON 协议：${err.message}`);
        this.emit?.({
          type: 'warning',
          message: `模型 ${this.model} 不支持 function calling，已自动降级为「文本 JSON 协议」，功能不受影响。`,
        });
      }
    }

    // 文本协议：注入协议说明 + 用文本解析回工具调用
    const patched = withTextProtocol(req.messages, req.tools);
    const raw = await this.provider.chat({ ...req, messages: patched, tools: [] });
    return toLlmResponse(raw.content, raw.model);
  }

  /** 预检：确认服务端可达、鉴权有效。失败时抛出带 hint 的 PlayfulError。 */
  async ping(signal?: AbortSignal): Promise<void> {
    if (!this.cfg.apiKey && this.cfg.provider !== 'ollama') {
      throw new PlayfulError('CONFIG_ERROR', '未配置 API Key', {
        hint: '设置 PC_API_KEY 或 DEEPSEEK_API_KEY 等环境变量后重试',
      });
    }
    await this.chat([{ role: 'user', content: 'ping' }], [], signal);
  }
}
