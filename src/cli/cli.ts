/**
 * 命令行入口。
 *
 * 子命令：
 *   review <target>     完整审查（Agent 循环：扫描 → 读码 → 运行验证 → 出报告）
 *   chat                交互式多轮对话（可审代码、可问答、可生成测试）
 *   scan <target>       纯静态分析（规则引擎，不调用 LLM，离线可用）
 *   test <target>       生成单元测试并实际运行验证
 *   tools               列出全部工具及参数
 *   tool <name> <json>  直接调用单个工具（调试/演示用）
 *   config              显示当前配置与健康检查
 *   web                 启动本地 Web 界面
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { CodeReviewAgent, callToolDirect } from '../agent/agent';
import { CHAT_SYSTEM_PROMPT, buildReviewPrompt, buildTestPrompt, renderToolList } from '../agent/prompts';
import { loadDotEnv, maskSecret, PROVIDER_PRESETS, resolveConfig, validateConfig, type AppConfig } from '../core/config';
import { normalizeError } from '../core/errors';
import { closeTrace, createLogger, openTrace, setColor, setLogLevel } from '../core/logger';
import type { AgentEvent } from '../core/types';
import { LlmClient } from '../llm/client';
import { MockProvider } from '../llm/mock';
import { createDefaultRegistry, createReviewRegistry, type ToolRegistry } from '../tools/registry';
import { scanPath } from '../tools/static-analysis';
import { flagBool, flagNumber, flagString, parseArgv, parseToolArgs } from './args';
import { TerminalRenderer } from './renderer';

export const VERSION = '1.0.0';
const log = createLogger('cli');

/* ------------------------------------------------------------------ *
 * 全局中断控制
 * ------------------------------------------------------------------ */

const abortController = new AbortController();
let interrupted = false;

process.on('SIGINT', () => {
  if (interrupted) process.exit(130);
  interrupted = true;
  abortController.abort();
  process.stdout.write('\n\x1b[33m收到中断信号，正在停止…（再按一次 Ctrl+C 强制退出）\x1b[0m\n');
});

/* ------------------------------------------------------------------ *
 * 交互式输入 / 审批
 * ------------------------------------------------------------------ */

let sharedRl: readline.Interface | null = null;

function getRl(): readline.Interface {
  if (!sharedRl) {
    sharedRl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: Boolean(process.stdin.isTTY),
    });
  }
  return sharedRl;
}

function closeRl(): void {
  if (sharedRl) {
    sharedRl.close();
    sharedRl = null;
  }
}

/** 读取一行输入（CLI 内部与测试共用）。 */
export function askLine(prompt: string): Promise<string> {
  const rl = getRl();
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => resolve(answer));
  });
}

/** 危险工具的审批提示。返回 allow / deny / allow_all。 */
export async function confirmApproval(
  req: { tool: string; args: Record<string, unknown>; description: string },
  renderer: TerminalRenderer,
): Promise<'allow' | 'deny' | 'allow_all'> {
  renderer.section('需要你的授权');
  process.stdout.write(`  工具：${req.tool}\n`);
  process.stdout.write(`  用途：${req.description.split('\n')[0]}\n`);
  const lines = JSON.stringify(req.args, null, 2).split('\n');
  process.stdout.write(`  参数：\n${lines.slice(0, 40).map((l) => `    ${l}`).join('\n')}\n`);
  if (lines.length > 40) process.stdout.write(`    …（参数共 ${lines.length} 行，已折叠）\n`);

  const answer = (await askLine('  是否执行？（y=允许 / n=拒绝 / a=本会话内全部允许）> ')).trim().toLowerCase();
  if (answer === 'y' || answer === 'yes' || answer === '是') return 'allow';
  if (answer === 'a' || answer === 'all') return 'allow_all';
  return 'deny';
}

/* ------------------------------------------------------------------ *
 * Agent 装配
 * ------------------------------------------------------------------ */

export interface BuildOptions {
  /** 只读工具集（审查/生成测试场景：不给写盘能力） */
  readOnly: boolean;
  /** 是否对危险工具走交互式审批 */
  requireApproval: boolean;
  verbose: boolean;
  color: boolean;
  maxSteps?: number;
  systemPrompt?: string;
  /** 离线演示：脚本化模拟模型，无需 API Key */
  demo?: boolean;
  onEvent?: (e: AgentEvent) => void;
}

export interface AgentBundle {
  agent: CodeReviewAgent;
  config: AppConfig;
  renderer: TerminalRenderer;
}

/** 解析配置（含 .env 加载与 CLI 覆盖）。 */
export function resolveRuntimeConfig(cliOverrides: Record<string, unknown> = {}): AppConfig {
  loadDotEnv(process.cwd());
  return resolveConfig(cliOverrides as never);
}

/**
 * 装配一次可用的 Agent：配置 → 渲染器 → 工具集 → LLM 客户端 → Agent。
 * 所有子命令共用这一条装配路径，保证行为一致。
 */
export function assembleAgent(build: BuildOptions, cliOverrides: Record<string, unknown> = {}): AgentBundle {
  const config = resolveRuntimeConfig({
    ...cliOverrides,
    requireApproval: build.requireApproval,
  });

  if (config.traceFile) openTrace(config.traceFile);

  const renderer = new TerminalRenderer({ verbose: build.verbose, color: build.color, showThinking: true });
  setColor(build.color);
  setLogLevel(config.logLevel);

  const registry: ToolRegistry = build.readOnly ? createReviewRegistry() : createDefaultRegistry();

  let client: LlmClient | undefined;
  if (build.demo) {
    const mock = new MockProvider(demoScript());
    client = new LlmClient({
      config: { ...config, apiKey: 'demo', requireApproval: false },
      emit: (e) => renderer.handle(e),
      provider: mock,
    });
    renderer.warn('DEMO 模式：使用脚本化模拟模型，不会访问任何真实 LLM 服务。');
  }

  const agent = new CodeReviewAgent({
    config,
    registry,
    ...(client ? { client } : {}),
    ...(build.systemPrompt ? { systemPrompt: build.systemPrompt } : {}),
    onEvent: (e: AgentEvent) => {
      renderer.handle(e);
      build.onEvent?.(e);
    },
    ...(build.requireApproval ? { onApproval: (req) => confirmApproval(req, renderer) } : {}),
  });

  return { agent, config, renderer };
}

/* ------------------------------------------------------------------ *
 * 离线演示脚本（让无 Key 环境也能完整演示 Agent 循环）
 * ------------------------------------------------------------------ */

function demoScript(): ConstructorParameters<typeof MockProvider>[0] {
  return [
    { kind: 'tools', content: '先建立工程结构认识。', calls: [{ name: 'list_files', args: { path: '.', maxDepth: 2 } }] },
    { kind: 'tools', content: '运行静态分析引擎获取客观证据。', calls: [{ name: 'scan_code', args: { path: 'src/demo' } }] },
    { kind: 'tools', content: '读取问题集中的文件确认上下文。', calls: [{ name: 'read_file', args: { path: 'src/demo/legacy-utils.ts' } }] },
    {
      kind: 'text',
      content: `### 一、审查概述

审查覆盖 \`src/demo\` 目录（2 个文件 / 约 90 行），是一组遗留工具函数。
发现 2 个 high 级、3 个 medium 级问题，均属可直接修复的实现缺陷。

### 二、问题清单

**[high] 异常被静默吞掉，故障无迹可寻**
- 位置：\`src/demo/legacy-utils.ts:15\`
- 证据：规则命中 \`COR-002\`，\`catch (e) {}\` 为空实现
- 影响：解析失败时返回看似正常的 undefined，调用方无法区分「没有数据」与「数据损坏」，线上故障将无从定位
- 建议：改为 \`catch (e) { logger.warn('parse failed', { err: e }); return null; }\`，并用返回值契约显式区分两种状态

**[high] 凭证明文硬编码并直接比较**
- 位置：\`src/demo/legacy-utils.ts:21\`
- 证据：规则命中 \`SEC-003\`，\`const adminPassword = '********'\`
- 影响：源码即泄露入口，且明文比较存在时序侧信道，需立即轮换
- 建议：凭据移入环境变量，比较使用 \`crypto.timingSafeEqual\`

**[critical] 命令拼接外部输入**
- 位置：\`src/demo/legacy-utils.ts:55\`
- 证据：规则命中 \`SEC-006\`，\`exec('ls -la ' + name)\`
- 影响：入参可控时等价于任意命令执行，属于最高优先级漏洞
- 建议：改用 \`execFile('ls', ['-la', name])\`，或对 \`name\` 做白名单校验

**[medium] 松散比较导致隐式类型转换**
- 位置：\`src/demo/legacy-utils.ts:27\`
- 证据：规则命中 \`MNT-002\`，\`if (flag == true)\`
- 影响：\`'0' == false\` 与 \`[] == false\` 均为真，空值/零值会走错分支
- 建议：统一改为 \`===\`，在入口做一次类型归一

**[medium] 浮点数直接等值比较**
- 位置：\`src/demo/legacy-utils.ts:35\`
- 证据：规则命中 \`COR-003\`，\`if (total === 0.3)\`
- 影响：\`0.1 + 0.2 === 0.3\` 为 false，金额校验会在特定输入下静默失效
- 建议：改用 \`Math.abs(total - 0.3) < Number.EPSILON\`，或统一按整数「分」处理金额

**[medium] 循环变量使用 var，闭包捕获最终值**
- 位置：\`src/demo/legacy-utils.ts:44\`
- 证据：规则命中 \`COR-004\`
- 影响：回调中引用循环变量时全部取到最后一次迭代的值，是典型的闭包陷阱
- 建议：改用 \`let\` 获得块级作用域

### 三、验证记录

- \`scan_code\`：2 个文件 / 155 行，critical=2 high=1 medium=4 low=4
- \`read_file\`：确认上述问题均存在于真实代码中，位置与规则输出一致
- 未做运行时验证；如需强证据，可用 \`run_code\` 复现 \`0.1 + 0.2 === 0.3\` 的失败

### 四、改进优先级

1. 先修 SEC-006 命令拼接：存在被利用的可能，属于最高优先级；
2. 再处理硬编码凭证与空 catch：前者是安全债需立即轮换，后者让故障完全静默；
3. 最后批量清理 \`==\` 与 \`var\`，可作为一次机械化重构一并完成。`,
    },
  ];
}

/* ------------------------------------------------------------------ *
 * 子命令
 * ------------------------------------------------------------------ */

async function cmdReview(
  target: string,
  build: BuildOptions,
  cliOverrides: Record<string, unknown>,
  outFile?: string,
): Promise<number> {
  const { agent, config, renderer } = assembleAgent(build, cliOverrides);

  const problems = build.demo ? [] : validateConfig(config);
  if (problems.length > 0) {
    renderer.fail('配置不完整，无法调用模型：');
    for (const p of problems) renderer.dim(`  · ${p}`);
    renderer.dim('');
    renderer.dim('可选方案：');
    renderer.dim('  1) 在项目根目录创建 .env 并填入 PC_API_KEY=sk-xxx');
    renderer.dim('  2) 运行 `npm run scan -- <目标>` 做纯静态分析（无需 API Key）');
    renderer.dim('  3) 加 --demo 查看模拟的完整 Agent 循环');
    return 2;
  }

  const abs = path.isAbsolute(target) ? path.resolve(target) : path.resolve(config.workdir || process.cwd(), target);
  if (!config.workdir && !path.isAbsolute(target)) {
    renderer.warn(`未指定工作目录，本次以当前目录 ${process.cwd()} 为基准（可用 --workdir 或 PC_WORKDIR 指定）`);
  }
  if (!fs.existsSync(abs)) {
    renderer.fail(`审查目标不存在：${abs}`);
    return 2;
  }

  const result = await agent.run(buildReviewPrompt({ target }), {
    maxSteps: build.maxSteps ?? config.maxSteps,
    signal: abortController.signal,
    remember: false,
  });

  renderer.renderAnswer(result.answer);
  renderer.renderSummary(result);

  if (outFile) {
    const file = path.resolve(config.workdir || process.cwd(), outFile);
    const md = [
      '# 代码审查报告',
      '',
      `- 审查目标：\`${target}\``,
      `- 使用模型：${config.provider} / ${config.model}`,
      `- 生成时间：${new Date().toLocaleString('zh-CN')}`,
      `- 运行统计：${result.steps} 步 / ${(result.ms / 1000).toFixed(1)}s / 工具调用 ${result.toolsUsed.length} 次`,
      '',
      '---',
      '',
      result.answer,
      '',
    ].join('\n');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, md, 'utf8');
    renderer.success(`报告已写入 ${file}`);
  }

  return result.stopReason === 'error' ? 1 : 0;
}

async function cmdChat(build: BuildOptions, cliOverrides: Record<string, unknown>): Promise<number> {
  const { agent, config, renderer } = assembleAgent({ ...build, systemPrompt: CHAT_SYSTEM_PROMPT }, cliOverrides);

  const problems = build.demo ? [] : validateConfig(config);
  if (problems.length > 0) {
    renderer.fail('配置不完整，无法调用模型：');
    for (const p of problems) renderer.dim(`  · ${p}`);
    return 2;
  }

  renderer.section('交互式会话');
  renderer.dim(`模型：${config.provider} / ${config.model}`);
  renderer.dim(`工具：${agent.listTools().join(', ')}`);
  renderer.dim('命令：:help 帮助　:reset 清空记忆　:tools 工具清单　:exit 退出');

  while (!interrupted) {
    const line = (await askLine('\n你 > ')).trim();
    if (line === '') continue;

    if (line === ':exit' || line === ':quit' || line === 'exit') break;
    if (line === ':help') {
      renderer.dim('直接用自然语言提问即可：');
      renderer.dim('  审查 src/tools/executor.ts');
      renderer.dim('  src/agent/agent.ts 的最大步数逻辑是怎么处理的？');
      renderer.dim('  为 src/tools/validate.ts 生成单元测试');
      continue;
    }
    if (line === ':reset') {
      agent.reset();
      renderer.success('已清空对话记忆');
      continue;
    }
    if (line === ':tools') {
      renderer.renderToolList(renderToolList(createDefaultRegistry().list()));
      continue;
    }

    const result = await agent.ask(line, { maxSteps: config.maxSteps, signal: abortController.signal });
    renderer.renderAnswer(result.answer);
  }

  closeRl();
  renderer.dim('会话已结束。');
  return 0;
}

function cmdScan(target: string, build: BuildOptions, cliOverrides: Record<string, unknown>, json: boolean): number {
  const config = resolveRuntimeConfig(cliOverrides);
  const renderer = new TerminalRenderer({ verbose: build.verbose, color: build.color });
  setColor(build.color);

  try {
    const report = scanPath({ target, workdir: config.workdir, maxFiles: 2000 });
    if (json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      renderer.renderScanReport(report);
    }
    return report.stats.bySeverity.critical > 0 ? 1 : 0;
  } catch (e) {
    renderer.fail((e as Error).message);
    return 2;
  }
}

async function cmdTest(target: string, build: BuildOptions, cliOverrides: Record<string, unknown>): Promise<number> {
  const { agent, config, renderer } = assembleAgent(build, cliOverrides);

  const problems = build.demo ? [] : validateConfig(config);
  if (problems.length > 0) {
    renderer.fail('配置不完整，无法调用模型：');
    for (const p of problems) renderer.dim(`  · ${p}`);
    return 2;
  }

  const result = await agent.run(buildTestPrompt(target), {
    maxSteps: build.maxSteps ?? config.maxSteps,
    signal: abortController.signal,
    remember: false,
  });
  renderer.renderAnswer(result.answer);
  renderer.renderSummary(result);
  return result.stopReason === 'error' ? 1 : 0;
}

function cmdTools(build: BuildOptions): number {
  const renderer = new TerminalRenderer({ color: build.color });
  setColor(build.color);
  renderer.renderToolList(renderToolList(createDefaultRegistry().list()));
  return 0;
}

async function cmdTool(
  name: string,
  rawArgs: string,
  extraArgs: string[],
  build: BuildOptions,
  cliOverrides: Record<string, unknown>,
): Promise<number> {
  const config = resolveRuntimeConfig(cliOverrides);
  const renderer = new TerminalRenderer({ verbose: true, color: build.color });
  setColor(build.color);

  const parsed = parseToolArgs(rawArgs, extraArgs);
  if (parsed.error) {
    renderer.fail(parsed.error);
    renderer.dim('用法示例：');
    renderer.dim("  playfulcode tool read_file '{\"path\":\"src/app.ts\",\"maxLines\":40}'");
    renderer.dim('  playfulcode tool read_file path=src/app.ts maxLines=40');
    renderer.dim('  playfulcode tool scan_code @args.json');
    return 2;
  }

  try {
    const out = await callToolDirect(createDefaultRegistry(), name, parsed.args, {
      workdir: config.workdir,
      roots: config.workspaceRoots,
      execTimeoutMs: config.execTimeoutMs,
      execMaxOutput: config.execMaxOutput,
    });
    process.stdout.write(`${out}\n`);
    return 0;
  } catch (e) {
    renderer.fail(normalizeError(e).toUserMessage());
    return 1;
  }
}

function cmdConfig(build: BuildOptions, cliOverrides: Record<string, unknown>): number {
  const config = resolveRuntimeConfig(cliOverrides);
  const renderer = new TerminalRenderer({ color: build.color });
  setColor(build.color);

  renderer.section('当前配置');
  const rows: [string, string][] = [
    ['服务商', `${config.provider}（${PROVIDER_PRESETS.find((p) => p.id === config.provider)?.label ?? '自定义'}）`],
    ['模型', config.model],
    ['接口地址', config.baseUrl],
    ['API Key', maskSecret(config.apiKey)],
    ['工作目录', config.workdir || '（未指定，可用 --workdir 或 PC_WORKDIR 设置）'],
    ['授权根目录', config.workspaceRoots.join('，') || '（未指定，工具不会访问任何目录）'],
    ['最大步数', String(config.maxSteps)],
    ['记忆窗口', `${config.memoryWindow} 条消息`],
    ['请求超时', `${config.requestTimeoutMs}ms`],
    ['重试次数', String(config.maxRetries)],
    ['危险工具审批', config.requireApproval ? '开启' : '关闭'],
    ['代码执行超时', `${config.execTimeoutMs}ms`],
    ['文本协议', config.forceTextProtocol ? '强制启用' : '优先使用原生 function calling'],
    ['日志级别', config.logLevel],
  ];
  for (const [k, v] of rows) process.stdout.write(`  ${k.padEnd(14, ' ')} ${v}\n`);

  const problems = validateConfig(config);
  renderer.section('配置检查');
  if (problems.length > 0) {
    for (const p of problems) renderer.warn(p);
    return 1;
  }
  renderer.success('配置检查通过，可以调用模型。');
  return 0;
}

function printHelp(): void {
  process.stdout.write(`
PlayfulCode  代码助手 · v${VERSION}

用法：playfulcode <命令> [选项]

命令：
  review <目标>        完整审查（Agent 循环：静态扫描 → 读码 → 运行验证 → 出报告）
  chat                 进入交互式多轮对话
  scan <目标>          纯静态分析（26 条规则，不调用 LLM，离线可用）
  scan --list-rules    查看全部内置规则清单
  test <目标>          为指定代码生成单元测试并用 run_code 实际验证
  tools                列出全部可用工具及参数
  tool <名> [参数]     直接调用单个工具；参数支持 JSON、key=value 简写或 @文件.json
  config               显示当前配置与健康检查
  web                  启动本地 Web 界面

选项：
  --max-steps <n>      最大推理-工具轮次（默认 16）
  --out <file>         审查报告写入 Markdown 文件
  --json               scan 命令输出 JSON
  --verbose, -v        展开工具完整输出
  --no-color           关闭彩色输出
  --no-approval        跳过危险工具的交互式审批（谨慎使用）
  --demo               离线演示模式：脚本化模拟模型，无需 API Key
  --provider <id>      指定服务商：${PROVIDER_PRESETS.map((p) => p.id).join(' / ')}
  --model <name>       指定模型
  --port <n>           web 子命令端口
  --help, -h           显示本帮助
  --version            显示版本

示例：
  playfulcode review src/                    审查 src 目录
  playfulcode review . --out report.md       全量审查并导出报告
  playfulcode scan src/tools --json          静态扫描并输出 JSON
  playfulcode tool read_file path=src/app.ts maxLines=40
  playfulcode tool scan_code '{"path":"src"}'
  playfulcode web --port 3080                启动 Web 界面
  playfulcode review . --demo                无 Key 演示完整流程
`);
}

/* ------------------------------------------------------------------ *
 * main
 * ------------------------------------------------------------------ */

export async function main(argv: string[]): Promise<number> {
  const parsed = parseArgv(argv);
  const maxSteps = flagNumber(parsed.flags, 'max-steps');
  const build: BuildOptions = {
    readOnly: false,
    requireApproval: !flagBool(parsed.flags, 'no-approval'),
    verbose: flagBool(parsed.flags, 'verbose'),
    color: !flagBool(parsed.flags, 'no-color'),
    demo: flagBool(parsed.flags, 'demo'),
    ...(maxSteps !== undefined ? { maxSteps } : {}),
  };

  const cliOverrides: Record<string, unknown> = {};
  const map: [string, string][] = [
    ['provider', 'provider'],
    ['model', 'model'],
    ['base-url', 'baseUrl'],
    ['api-key', 'apiKey'],
    ['workdir', 'workdir'],
    ['log-level', 'logLevel'],
  ];
  for (const [flag, key] of map) {
    const v = flagString(parsed.flags, flag);
    if (v) cliOverrides[key] = v;
  }
  if (flagBool(parsed.flags, 'no-approval')) cliOverrides.requireApproval = false;

  if (flagBool(parsed.flags, 'version')) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  const command = parsed.command || (flagBool(parsed.flags, 'help') ? 'help' : '');
  const target = parsed.positional[0];

  try {
    switch (command) {
      case '': {
        const renderer = new TerminalRenderer({ color: build.color });
        renderer.banner(VERSION);
        printHelp();
        return 0;
      }
      case 'help':
        printHelp();
        return 0;

      case 'review': {
        if (!target) {
          process.stderr.write('用法：playfulcode review <文件或目录> [--out report.md]\n');
          return 2;
        }
        return await cmdReview(target, { ...build, readOnly: true }, cliOverrides, flagString(parsed.flags, 'out'));
      }

      case 'chat':
        return await cmdChat(build, cliOverrides);

      case 'scan':
        if (flagBool(parsed.flags, 'list-rules')) {
          const renderer = new TerminalRenderer({ color: build.color });
          setColor(build.color);
          renderer.renderRuleCatalog();
          return 0;
        }
        return cmdScan(target ?? '.', build, cliOverrides, flagBool(parsed.flags, 'json'));

      case 'test': {
        if (!target) {
          process.stderr.write('用法：playfulcode test <文件>\n');
          return 2;
        }
        return await cmdTest(target, { ...build, readOnly: true }, cliOverrides);
      }

      case 'tools':
        return cmdTools(build);

      case 'tool': {
        if (!target) {
          process.stderr.write("用法：playfulcode tool <工具名> '<JSON参数>' 或 playfulcode tool <工具名> key=value ...\n");
          return 2;
        }
        return await cmdTool(target, parsed.positional[1] ?? '', parsed.positional.slice(2), build, cliOverrides);
      }

      case 'config':
        return cmdConfig(build, cliOverrides);

      case 'web': {
        const { startWebServer } = await import('../web/server');
        const config = resolveRuntimeConfig(cliOverrides);
        const port = flagNumber(parsed.flags, 'port') ?? config.webPort;
        const host = flagString(parsed.flags, 'host') ?? config.webHost;
        await startWebServer({ config, host, port, version: VERSION, demo: build.demo });
        return 0;
      }

      default:
        process.stderr.write(`未知命令：${command}\n`);
        printHelp();
        return 2;
    }
  } catch (e) {
    const err = normalizeError(e);
    process.stderr.write(`\n✗ ${err.toUserMessage()}\n`);
    return err.code === 'ABORTED' ? 130 : 1;
  } finally {
    closeTrace();
    closeRl();
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      log.error(`未捕获异常：${(e as Error).stack ?? String(e)}`);
      process.exitCode = 1;
    },
  );
}
