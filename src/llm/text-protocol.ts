/**
 * 文本 JSON 降级协议（ReAct-lite）。
 *
 * 有些模型（或本地小模型）不支持 function calling。此时我们不再依赖 API 的 tools 字段，
 * 而是在 System Prompt 里约定：需要调用工具时，输出一个 ```tool 代码块，内含
 * {"tool": "...", "args": {...}}。本模块负责把模型文本解析回统一的 LlmResponse。
 */

import type { ChatMessage, LlmResponse, ToolCall, ToolSpec } from '../core/types';
import { parseToolArguments } from './openai-compatible';

/** 追加到 System Prompt 末尾的协议说明。 */
export const TEXT_PROTOCOL_INSTRUCTIONS = `
## 工具调用协议（必须严格遵守）

你没有原生 function calling 能力，请用如下约定与我交互：

1. 需要调用工具时，**只输出**一个代码块，语言标记为 tool，内容为严格 JSON：

\`\`\`tool
{"tool": "工具名", "args": {"参数名": "参数值"}}
\`\`\`

2. 一次只调用一个工具，等待我返回结果后再决定下一步。
3. 需要并行了解多个文件时，逐个调用，不要臆测文件内容。
4. 当你已经掌握足够信息、准备给出最终回答时，**不要再输出任何 tool 代码块**，
   直接用自然语言（Markdown）写最终答案。

可用的工具名：{TOOL_NAMES}

工具参数详见下方工具清单。再次强调：未知内容必须先调用工具确认，禁止编造文件内容。
`;

/** 把工具清单渲染成纯文本，供文本协议模型阅读。 */
export function renderToolCatalog(tools: ToolSpec[]): string {
  if (tools.length === 0) return '（本次运行未注册任何工具）';
  return tools
    .map((t) => {
      const params = t.parameters.properties ?? {};
      const required = new Set(t.parameters.required ?? []);
      const lines = Object.entries(params).map(([key, schema]) => {
        const star = required.has(key) ? '（必填）' : '（可选）';
        const enumTip = schema.enum ? `，取值：${schema.enum.join('|')}` : '';
        const defTip = schema.default !== undefined ? `，默认：${JSON.stringify(schema.default)}` : '';
        return `    - ${key}: ${schema.type}${star} ${schema.description ?? ''}${enumTip}${defTip}`;
      });
      const head = `- ${t.name}: ${t.description}${t.dangerous ? '（危险操作，需要用户审批）' : ''}`;
      return [head, ...lines].join('\n');
    })
    .join('\n');
}

export function buildTextProtocolPrompt(tools: ToolSpec[]): string {
  return `${TEXT_PROTOCOL_INSTRUCTIONS.replace('{TOOL_NAMES}', tools.map((t) => t.name).join('、'))}
## 工具清单
${renderToolCatalog(tools)}`;
}

const FENCE_RE = /```(tool|json)\s*\n([\s\S]*?)```/g;

export interface ParsedTextReply {
  /** 去掉工具代码块后剩下的自然语言 */
  text: string;
  toolCalls: ToolCall[];
}

/** 解析模型文本，抽出所有 tool 代码块。 */
export function parseTextReply(content: string): ParsedTextReply {
  const toolCalls: ToolCall[] = [];
  let text = content;
  let index = 0;

  FENCE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FENCE_RE.exec(content)) !== null) {
    const body = (m[2] ?? '').trim();
    const call = tryParseToolBlock(body, index);
    if (call) {
      toolCalls.push(call);
      index += 1;
      text = text.replace(m[0], '');
    }
  }

  // 容错：模型忘了写 ``` 围栏，直接裸 JSON
  if (toolCalls.length === 0) {
    const bare = tryParseToolBlock(stripCodeFence(content.trim()), index);
    if (bare && looksLikeBareToolJson(content)) {
      toolCalls.push(bare);
      text = '';
    }
  }

  return { text: text.trim(), toolCalls };
}

function stripCodeFence(s: string): string {
  return s
    .replace(/^```(?:tool|json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();
}

function looksLikeBareToolJson(content: string): boolean {
  const t = content.trim();
  if (t.includes('```')) return false;
  return t.startsWith('{') && t.endsWith('}') && /"tool"\s*:/.test(t);
}

function tryParseToolBlock(body: string, index: number): ToolCall | null {
  if (!body) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    try {
      parsed = JSON.parse(body.replace(/,\s*([}\]])/g, '$1'));
    } catch {
      return null;
    }
  }
  const obj = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!obj || typeof obj !== 'object') return null;
  const rec = obj as Record<string, unknown>;
  const name = rec.tool ?? rec.name ?? rec.tool_name;
  if (typeof name !== 'string' || !name.trim()) return null;
  const args = rec.args ?? rec.arguments ?? rec.parameters ?? {};
  return {
    id: `text_call_${index}_${Math.random().toString(36).slice(2, 8)}`,
    name: name.trim(),
    args: parseToolArguments(args),
  };
}

/** 把解析结果包装成统一的 LlmResponse。 */
export function toLlmResponse(content: string, model: string): LlmResponse {
  const { text, toolCalls } = parseTextReply(content);
  return {
    content: text,
    toolCalls,
    model,
    finishReason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
  };
}

/** 判断一段文本里是否还残留未闭合的工具块（模型输出被截断时用）。 */
export function hasUnterminatedToolBlock(content: string): boolean {
  const opens = (content.match(/```(?:tool|json)/g) ?? []).length;
  const closes = (content.match(/```/g) ?? []).length;
  return opens * 2 > closes;
}

/** 供 Provider 使用的辅助：把文本协议的 System Prompt 拼进消息数组。 */
export function withTextProtocol(messages: ChatMessage[], tools: ToolSpec[]): ChatMessage[] {
  const extra = buildTextProtocolPrompt(tools);
  const out = messages.map((m) => ({ ...m }));
  const sys = out.find((m) => m.role === 'system');
  if (sys) sys.content = `${sys.content}\n${extra}`;
  else out.unshift({ role: 'system', content: extra });
  return out;
}
