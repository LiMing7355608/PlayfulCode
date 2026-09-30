/**
 * 全局类型契约。
 *
 * 这一层被 CLI / Web / Agent / Tool / Provider 共用，
 * 任何跨模块的数据结构都必须先在这里定义，避免隐式耦合。
 */

/* ------------------------------------------------------------------ *
 * 消息（上下文记忆的最小单元）
 * ------------------------------------------------------------------ */

export type Role = 'system' | 'user' | 'assistant' | 'tool';

/** 模型请求的原生工具调用（OpenAI 兼容格式）。 */
export interface ToolCall {
  id: string;
  /** 工具名 */
  name: string;
  /** 已经 JSON.parse 过的入参 */
  args: Record<string, unknown>;
}

export interface ChatMessage {
  role: Role;
  /** 文本内容；assistant 可能只有 toolCalls 而无文本 */
  content: string;
  /** role === 'assistant' 且模型决定调用工具时存在 */
  toolCalls?: ToolCall[];
  /** role === 'tool' 时，指回对应的 toolCall.id */
  toolCallId?: string;
  /** role === 'tool' 时，工具名，便于渲染 */
  name?: string;
  /** 注入的时间戳，仅用于日志与调试，不发送给模型 */
  at?: number;
}

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */

/** JSON Schema 子集：足够描述本项目的工具入参。 */
export interface JsonSchema {
  type: 'object' | 'string' | 'number' | 'integer' | 'boolean' | 'array';
  description?: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  required?: string[];
  enum?: string[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
}

export interface ToolContext {
  /** 本次运行的唯一 id，便于日志串联 */
  runId: string;
  /** 工作区根目录（已解析为绝对路径） */
  workdir: string;
  /** 允许访问的根目录白名单，空数组表示不限制 */
  roots: string[];
  /** 已配置的执行超时 */
  execTimeoutMs: number;
  /** 执行结果输出上限 */
  execMaxOutput: number;
  /** 进度回调，工具可借此向 UI 推送中间状态 */
  emit?: (event: AgentEvent) => void;
}

export interface ToolResult {
  ok: boolean;
  /** 给模型看的文本结果（会被注入上下文） */
  content: string;
  /** 给 UI/日志看的结构化附加信息 */
  meta?: Record<string, unknown>;
  /** 工具名，便于审计 */
  tool?: string;
}

/**
 * 工具声明。
 * TArgs 只约束为 object（而非 Record<string, unknown>），
 * 这样每个工具可以用自己的具名接口描述入参，运行期再由 validateArgs 兜底校验。
 */
export interface ToolSpec<TArgs extends object = Record<string, unknown>> {
  name: string;
  /** 面向模型的说明，写得好坏直接决定调用准确率 */
  description: string;
  parameters: JsonSchema;
  /** 是否需要人工确认（写操作 / 任意代码执行） */
  dangerous?: boolean;
  /** 纯函数式执行；抛错会被 executor 统一转成 ok:false 的 ToolResult */
  run(args: TArgs, ctx: ToolContext): Promise<ToolResult> | ToolResult;
}

/* ------------------------------------------------------------------ *
 * Provider（LLM 接入层）
 * ------------------------------------------------------------------ */

export interface LlmRequest {
  messages: ChatMessage[];
  tools: ToolSpec[];
  temperature?: number;
  signal?: AbortSignal;
}

export interface LlmUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface LlmResponse {
  /** 模型文本输出，可能为空串 */
  content: string;
  /** 模型请求的工具调用，可能为空数组 */
  toolCalls: ToolCall[];
  /** 实际使用的模型名 */
  model: string;
  usage?: LlmUsage;
  /** 完成原因，用于诊断（stop / tool_calls / length ...） */
  finishReason?: string;
}

export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  /** 该 Provider 是否支持原生 function calling */
  readonly supportsNativeTools: boolean;
  chat(req: LlmRequest): Promise<LlmResponse>;
}

/* ------------------------------------------------------------------ *
 * Agent 事件流（CLI 与 Web 都消费这一个契约）
 * ------------------------------------------------------------------ */

export type AgentEvent =
  | { type: 'run_start'; runId: string; task: string; provider: string; model: string }
  | { type: 'thinking'; step: number; note: string }
  | { type: 'assistant_text'; step: number; content: string }
  | { type: 'tool_call'; step: number; id: string; name: string; args: Record<string, unknown> }
  | { type: 'tool_result'; step: number; id: string; name: string; ok: boolean; content: string; ms: number }
  | { type: 'tool_denied'; step: number; id: string; name: string; reason: string }
  | { type: 'retry'; attempt: number; delayMs: number; reason: string }
  | { type: 'usage'; promptTokens?: number; completionTokens?: number; totalTokens?: number }
  | { type: 'warning'; message: string }
  | { type: 'error'; message: string; recoverable: boolean }
  | { type: 'run_end'; runId: string; steps: number; ms: number; answer: string; stopReason: StopReason };

export type StopReason =
  | 'final_answer'
  | 'max_steps'
  | 'aborted'
  | 'error';

/* ------------------------------------------------------------------ *
 * 静态分析
 * ------------------------------------------------------------------ */

export type Severity = 'critical' | 'high' | 'medium' | 'low';

export interface Finding {
  ruleId: string;
  title: string;
  severity: Severity;
  file: string;
  line: number;
  column: number;
  /** 命中的源码片段（已裁剪） */
  snippet: string;
  message: string;
  suggestion: string;
}

export interface ScanReport {
  files: string[];
  findings: Finding[];
  stats: {
    files: number;
    lines: number;
    bySeverity: Record<Severity, number>;
  };
  ms: number;
}
