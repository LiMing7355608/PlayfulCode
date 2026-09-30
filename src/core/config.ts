/**
 * 配置层。
 *
 * 优先级：显式传入的 overrides > 环境变量 > .env 文件 > 内置默认值。
 * 之所以自己写一遍 .env 解析（而不是装 dotenv），是为了让项目保持
 * 零运行时依赖 —— 助教 clone 下来 `npm i && npm run build` 即可跑通。
 */

import fs from 'node:fs';
import path from 'node:path';
import { PlayfulError } from './errors';

/* --------------------------- 服务商预设 --------------------------- */

export interface ProviderPreset {
  id: string;
  label: string;
  baseUrl: string;
  defaultModel: string;
  /** 读取 API Key 时按顺序尝试的环境变量名 */
  apiKeyEnv: string[];
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'deepseek',
    label: 'DeepSeek（深度求索）',
    baseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    apiKeyEnv: ['PC_API_KEY', 'DEEPSEEK_API_KEY'],
  },
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    apiKeyEnv: ['PC_API_KEY', 'OPENAI_API_KEY'],
  },
  {
    id: 'moonshot',
    label: 'Moonshot（Kimi）',
    baseUrl: 'https://api.moonshot.cn/v1',
    defaultModel: 'moonshot-v1-8k',
    apiKeyEnv: ['PC_API_KEY', 'MOONSHOT_API_KEY'],
  },
  {
    id: 'zhipu',
    label: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: 'glm-4-flash',
    apiKeyEnv: ['PC_API_KEY', 'ZHIPU_API_KEY'],
  },
  {
    id: 'dashscope',
    label: '通义千问（阿里云百炼）',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen-plus',
    apiKeyEnv: ['PC_API_KEY', 'DASHSCOPE_API_KEY'],
  },
  {
    id: 'ollama',
    label: 'Ollama（本地部署）',
    baseUrl: 'http://127.0.0.1:11434/v1',
    defaultModel: 'qwen2.5:7b',
    apiKeyEnv: ['PC_API_KEY', 'OLLAMA_API_KEY'],
  },
  {
    id: 'custom',
    label: '自定义（OpenAI 兼容）',
    baseUrl: 'http://127.0.0.1:8000/v1',
    defaultModel: 'default',
    apiKeyEnv: ['PC_API_KEY'],
  },
];

export function findPreset(id: string): ProviderPreset | undefined {
  const key = id.trim().toLowerCase();
  return PROVIDER_PRESETS.find((p) => p.id === key);
}

/* ----------------------------- 配置对象 ----------------------------- */

export interface AppConfig {
  provider: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  temperature: number;
  maxSteps: number;
  requestTimeoutMs: number;
  maxRetries: number;
  memoryWindow: number;
  maxToolOutputChars: number;
  requireApproval: boolean;
  workspaceRoots: string[];
  execTimeoutMs: number;
  execMaxOutput: number;
  workdir: string;
  webHost: string;
  webPort: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  traceFile?: string;
  /** 强制走文本 JSON 协议（不支持 function calling 的模型用） */
  forceTextProtocol: boolean;
}

export interface ConfigOverrides {
  provider?: string;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  temperature?: number;
  maxSteps?: number;
  requireApproval?: boolean;
  workdir?: string;
  webHost?: string;
  webPort?: number;
  logLevel?: AppConfig['logLevel'];
  workspaceRoots?: string[];
  forceTextProtocol?: boolean;
}

/* ------------------------------ 解析 ------------------------------ */

/** 解析 .env 文本为键值对（支持 # 注释、引号、export 前缀）。 */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).replace(/^export\s+/, '').trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** 加载 .env（不覆盖已存在的真实环境变量）。返回被加载的键数量。 */
export function loadDotEnv(dir: string, filename = '.env'): number {
  const file = path.join(dir, filename);
  if (!fs.existsSync(file)) return 0;
  let parsed: Record<string, string>;
  try {
    parsed = parseEnvFile(fs.readFileSync(file, 'utf8'));
  } catch {
    return 0;
  }
  let count = 0;
  for (const [k, v] of Object.entries(parsed)) {
    if (process.env[k] === undefined) {
      process.env[k] = v;
      count += 1;
    }
  }
  return count;
}

function num(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function bool(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
  const raw = env[key]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (['1', 'on', 'true', 'yes', 'y'].includes(raw)) return true;
  if (['0', 'off', 'false', 'no', 'n'].includes(raw)) return false;
  return fallback;
}

function splitList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[;,]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => path.resolve(s));
}

export function resolveConfig(overrides: ConfigOverrides = {}, env: NodeJS.ProcessEnv = process.env): AppConfig {
  const providerId = (overrides.provider ?? env.PC_PROVIDER ?? 'deepseek').toLowerCase();
  const preset = findPreset(providerId);
  if (!preset) {
    throw new PlayfulError('CONFIG_ERROR', `未知的 LLM 服务商：${providerId}`, {
      hint: `可选值：${PROVIDER_PRESETS.map((p) => p.id).join(' / ')}`,
    });
  }

  const baseUrl = (overrides.baseUrl ?? env.PC_BASE_URL ?? preset.baseUrl).replace(/\/+$/, '');
  const model = overrides.model ?? env.PC_MODEL ?? preset.defaultModel;

  let apiKey = overrides.apiKey ?? '';
  if (!apiKey) {
    for (const key of preset.apiKeyEnv) {
      const v = env[key];
      if (v && v.trim()) {
        apiKey = v.trim();
        break;
      }
    }
  }
  // Ollama 等本地服务不校验 Key，给个占位串即可
  if (!apiKey && providerId === 'ollama') apiKey = 'ollama';

  const logLevelRaw = (overrides.logLevel ?? env.PC_LOG_LEVEL ?? 'info').toLowerCase();
  const logLevel = (['debug', 'info', 'warn', 'error'] as const).includes(logLevelRaw as AppConfig['logLevel'])
    ? (logLevelRaw as AppConfig['logLevel'])
    : 'info';

  const rootsFromEnv = splitList(env.PC_WORKSPACE_ROOTS);
  // 工作目录默认留空：不把进程所在目录当作默认授权范围。
  // 必须由用户通过 --workdir / PC_WORKDIR / Web 界面显式指定，
  // 这样「Agent 能碰哪些文件」永远是使用者主动做的决定，而不是启动方式的副产物。
  const rawWorkdir = overrides.workdir ?? env.PC_WORKDIR ?? '';
  const workdir = rawWorkdir.trim() ? path.resolve(rawWorkdir) : '';

  const cfg: AppConfig = {
    provider: providerId,
    baseUrl,
    model,
    apiKey,
    temperature: overrides.temperature ?? num(env, 'PC_TEMPERATURE', 0.2),
    maxSteps: overrides.maxSteps ?? num(env, 'PC_MAX_STEPS', 16),
    requestTimeoutMs: num(env, 'PC_REQUEST_TIMEOUT_MS', 120_000),
    maxRetries: num(env, 'PC_MAX_RETRIES', 3),
    memoryWindow: num(env, 'PC_MEMORY_WINDOW', 40),
    maxToolOutputChars: num(env, 'PC_MAX_TOOL_OUTPUT_CHARS', 12_000),
    requireApproval: overrides.requireApproval ?? bool(env, 'PC_REQUIRE_APPROVAL', true),
    workspaceRoots: overrides.workspaceRoots ?? (rootsFromEnv.length > 0 ? rootsFromEnv : [workdir]),
    execTimeoutMs: num(env, 'PC_EXEC_TIMEOUT_MS', 15_000),
    execMaxOutput: num(env, 'PC_EXEC_MAX_OUTPUT', 8_000),
    workdir,
    webHost: overrides.webHost ?? env.PC_WEB_HOST ?? '127.0.0.1',
    webPort: overrides.webPort ?? num(env, 'PC_WEB_PORT', 3080),
    logLevel,
    traceFile: env.PC_TRACE_FILE || undefined,
    forceTextProtocol: overrides.forceTextProtocol ?? bool(env, 'PC_FORCE_TEXT_PROTOCOL', false),
  };

  return cfg;
}

/** 检查配置是否具备调用 LLM 的最小条件。缺失时返回人类可读的原因列表。 */
export function validateConfig(cfg: AppConfig): string[] {
  const problems: string[] = [];
  if (!cfg.apiKey && cfg.provider !== 'ollama') {
    problems.push(
      `未检测到 API Key。请设置环境变量 ${findPreset(cfg.provider)?.apiKeyEnv.join(' 或 ') ?? 'PC_API_KEY'}，` +
        `或在项目根目录创建 .env 并填入 PC_API_KEY=sk-xxx`,
    );
  }
  if (!Number.isFinite(cfg.maxSteps) || cfg.maxSteps < 1) problems.push('PC_MAX_STEPS 必须是 >= 1 的整数');
  if (!/^https?:\/\//.test(cfg.baseUrl)) problems.push(`非法的 PC_BASE_URL：${cfg.baseUrl}`);
  return problems;
}

/** 把 API Key 打码，用于日志与界面回显。只保留末尾 4 位，不暴露前缀。 */
export function maskSecret(secret: string): string {
  if (!secret) return '(未设置)';
  if (secret.length <= 4) return '****';
  return `****${secret.slice(-4)}`;
}
