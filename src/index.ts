/**
 * 库入口（programmatic API）。
 *
 * 除了 CLI，PlayfulCode 也可以被当作一个库直接调用：
 *
 *   const { CodeReviewAgent, createDefaultRegistry, resolveConfig } = require('playful-code');
 *
 * 对外只暴露稳定的接口，内部模块结构变化不会破坏使用方。
 */

export { main, assembleAgent, resolveRuntimeConfig, askLine, confirmApproval, VERSION } from './cli/cli';
export { parseArgv } from './cli/args';
export { TerminalRenderer } from './cli/renderer';

export { CodeReviewAgent, createAgent, callToolDirect } from './agent/agent';
export { ConversationMemory } from './agent/memory';
export {
  BASE_SYSTEM_PROMPT,
  CHAT_SYSTEM_PROMPT,
  buildReviewPrompt,
  buildExplainPrompt,
  buildTestPrompt,
  renderToolList,
} from './agent/prompts';

export { ToolRegistry, createDefaultRegistry, createReviewRegistry } from './tools/registry';
export { ToolExecutor, renderToolMessage } from './tools/executor';
export {
  scanPath,
  analyzeSource,
  RULES,
  rulesCatalog,
  renderReportForPrompt,
  renderReportText,
  sortBySeverity,
} from './tools/static-analysis';
export { validateArgs } from './tools/validate';
export { resolveInside, displayPath, readTextFileSafe, walkSourceFiles } from './tools/path-guard';

export { LlmClient } from './llm/client';
export { MockProvider } from './llm/mock';
export { OpenAiCompatibleProvider } from './llm/openai-compatible';
export { parseTextReply, toLlmResponse, buildTextProtocolPrompt } from './llm/text-protocol';

export { resolveConfig, validateConfig, loadDotEnv, parseEnvFile, PROVIDER_PRESETS, maskSecret } from './core/config';
export { PlayfulError, isPlayfulError, normalizeError } from './core/errors';
export { createLogger, setLogLevel, setColor } from './core/logger';
export type * from './core/types';
