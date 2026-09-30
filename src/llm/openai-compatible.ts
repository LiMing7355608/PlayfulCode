/**
 * OpenAI 兼容协议 Provider。
 *
 * 覆盖 OpenAI / DeepSeek / Moonshot / 智谱 / 通义千问（兼容模式）/ Ollama，
 * 它们都实现了 `POST {baseUrl}/chat/completions` 与 `tools` 字段。
 */

import { PlayfulError } from '../core/errors';
import type { ChatMessage, JsonSchema, LlmProvider, LlmRequest, LlmResponse, ToolCall, ToolSpec } from '../core/types';
import { httpJson, HttpError } from './http';

/* --------------------------- 线上传输结构 --------------------------- */

interface OpenAiToolDef {
  type: 'function';
  function: { name: string; description: string; parameters: JsonSchema };
}

interface OpenAiMessage {
  role: string;
  content: string | null;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
  name?: string;
}

interface OpenAiChoice {
  index: number;
  message?: {
    role?: string;
    content?: string | null;
    reasoning_content?: string | null;
    tool_calls?: { id?: string; type?: string; function?: { name?: string; arguments?: string } }[];
  };
  finish_reason?: string;
}

interface OpenAiResponse {
  id?: string;
  model?: string;
  choices?: OpenAiChoice[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  error?: { message?: string; type?: string; code?: string };
}

/* ----------------------------- 序列化 ----------------------------- */

export function toOpenAiTools(tools: ToolSpec[]): OpenAiToolDef[] {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

export function toOpenAiMessages(messages: ChatMessage[]): OpenAiMessage[] {
  return messages.map((m) => {
    const base: OpenAiMessage = { role: m.role, content: m.content ?? '' };
    if (m.role === 'tool') {
      base.tool_call_id = m.toolCallId ?? 'call_0';
      base.content = m.content ?? '';
      if (m.name) base.name = m.name;
      return base;
    }
    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
      base.tool_calls = m.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: JSON.stringify(tc.args ?? {}) },
      }));
      base.content = m.content ?? '';
    }
    return base;
  });
}

/** 宽容地解析模型给出的 arguments（可能是对象、字符串、或半截 JSON）。 */
export function parseToolArguments(raw: unknown): Record<string, unknown> {
  if (raw === null || raw === undefined) return {};
  if (Array.isArray(raw)) return {};
  if (typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw !== 'string') return {};
  const text = raw.trim();
  if (!text) return {};
  const asObject = (v: unknown): Record<string, unknown> =>
    v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  try {
    return asObject(JSON.parse(text));
  } catch {
    // 容错：模型偶尔会包一层 markdown 或带尾随逗号
    const cleaned = text
      .replace(/^```(?:json)?/i, '')
      .replace(/```$/, '')
      .replace(/,\s*([}\]])/g, '$1')
      .trim();
    try {
      return asObject(JSON.parse(cleaned));
    } catch {
      return {};
    }
  }
}

/* ------------------------------ Provider ------------------------------ */

export interface OpenAiCompatibleOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  timeoutMs: number;
  retries: number;
  /** 是否在请求中携带 tools 字段（文本协议模式下为 false） */
  sendTools: boolean;
  onRetry?: (attempt: number, delayMs: number, reason: string) => void;
}

export class OpenAiCompatibleProvider implements LlmProvider {
  readonly name: string;
  readonly model: string;
  supportsNativeTools: boolean;

  private readonly opts: OpenAiCompatibleOptions;

  constructor(opts: OpenAiCompatibleOptions, name = 'openai-compatible', supportsNativeTools = true) {
    this.opts = opts;
    this.name = name;
    this.model = opts.model;
    this.supportsNativeTools = supportsNativeTools;
  }

  /** 运行时降级开关：模型实测不支持 function calling 时调用。 */
  disableNativeTools(): void {
    this.supportsNativeTools = false;
  }

  async chat(req: LlmRequest): Promise<LlmResponse> {
    const useTools = this.opts.sendTools && this.supportsNativeTools && req.tools.length > 0;

    const body: Record<string, unknown> = {
      model: this.opts.model,
      messages: toOpenAiMessages(req.messages),
      temperature: req.temperature ?? this.opts.temperature,
      stream: false,
    };
    if (useTools) {
      body.tools = toOpenAiTools(req.tools);
      body.tool_choice = 'auto';
    }

    let raw: OpenAiResponse;
    try {
      raw = await httpJson<OpenAiResponse>(`${this.opts.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.opts.apiKey}` },
        body,
        timeoutMs: this.opts.timeoutMs,
        retries: this.opts.retries,
        signal: req.signal,
        onRetry: this.opts.onRetry,
      });
    } catch (e) {
      if (e instanceof HttpError) {
        // 服务端明确说「不认识 tools 字段」→ 交给上层降级到文本协议
        if (useTools && looksLikeToolUnsupported(e)) {
          throw new PlayfulError(
            'LLM_PROTOCOL_ERROR',
            `模型 ${this.opts.model} 可能不支持 function calling（HTTP ${e.status}）：${e.bodyText.slice(0, 200)}`,
            {
              retryable: false,
              hint: '可设置 PC_FORCE_TEXT_PROTOCOL=1 强制使用文本 JSON 协议',
            },
          );
        }
      }
      throw e;
    }

    if (raw.error?.message) {
      throw new PlayfulError('LLM_HTTP_ERROR', `服务端错误：${raw.error.message}`, { retryable: false });
    }

    const choice = raw.choices?.[0];
    if (!choice) {
      throw new PlayfulError('LLM_PROTOCOL_ERROR', '服务端响应缺少 choices 字段');
    }

    const msg = choice.message ?? {};
    const content = typeof msg.content === 'string' ? msg.content : (msg.reasoning_content ?? '') || '';
    const toolCalls: ToolCall[] = (msg.tool_calls ?? [])
      .filter((tc) => Boolean(tc?.function?.name))
      .map((tc, i) => ({
        id: tc.id && tc.id.length > 0 ? tc.id : `call_${i}_${Date.now()}`,
        name: String(tc.function?.name ?? ''),
        args: parseToolArguments(tc.function?.arguments),
      }));

    return {
      content,
      toolCalls,
      model: raw.model ?? this.opts.model,
      finishReason: choice.finish_reason,
      ...(raw.usage
        ? {
            usage: {
              promptTokens: raw.usage.prompt_tokens,
              completionTokens: raw.usage.completion_tokens,
              totalTokens: raw.usage.total_tokens,
            },
          }
        : {}),
    };
  }
}

function looksLikeToolUnsupported(e: HttpError): boolean {
  if (e.status !== 400 && e.status !== 404 && e.status !== 422) return false;
  const t = e.bodyText.toLowerCase();
  return (
    t.includes('tool') ||
    t.includes('function') ||
    t.includes('not support') ||
    t.includes('unsupported') ||
    t.includes('invalid_request')
  );
}
