/**
 * run_code：在隔离目录中执行代码，把「运行结果」变成可验证的证据。
 *
 * 关键设计：
 * 1. 隔离：每次执行都落在一个独立的临时目录（.playfulcode/runs/<runId>），
 *    并把源码先复制进去，避免在用户的工程目录里产生脏文件；
 * 2. 超时：软超时只发信号，硬超时强杀整棵进程树（Windows 用 taskkill /T /F），
 *    防止子进程逃逸成孤儿；
 * 3. 熔断：输出超过阈值立即终止，避免「死循环打印」把上下文冲爆；
 * 4. 降级：TypeScript 优先用本机 tsc，缺失时用内置的轻量类型擦除器兜底。
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PlayfulError } from '../core/errors';
import type { ToolResult, ToolSpec } from '../core/types';
import { detectLanguage, displayPath, resolveInside } from './path-guard';
import { validateArgs } from './validate';

interface Args {
  code?: string;
  file?: string;
  language?: 'auto' | 'js' | 'ts' | 'py';
  command?: 'auto' | 'node' | 'python' | 'npm';
  timeoutMs?: number;
  args?: string[];
  env?: Record<string, string>;
  cleanup?: boolean;
}

/* ------------------------- 运行时探测 ------------------------- */

type Runtime = 'node' | 'tsx' | 'ts-node' | 'python' | 'py' | 'npm' | null;

const runtimeCache = new Map<string, Runtime>();

export function which(command: string): boolean {
  if (runtimeCache.has(command)) return runtimeCache.get(command) !== null;
  const probe = process.platform === 'win32' ? 'where' : 'which';
  try {
    const res = spawnSync(probe, [command], { stdio: 'ignore', timeout: 4000 });
    const found = res.status === 0;
    runtimeCache.set(command, found ? 'node' : null);
    return found;
  } catch {
    runtimeCache.set(command, null);
    return false;
  }
}

function pickPython(): Runtime {
  for (const c of ['python', 'python3', 'py']) if (which(c)) return c as Runtime;
  return null;
}

/* ------------------------- TS 降级转译 ------------------------- */

/** 极简 TypeScript 类型擦除：够跑通示例脚本，不追求完整语义。 */
export function stripTypes(source: string): string {
  let out = source;

  // 整块删除纯类型声明（interface / type / declare），含多行体
  out = out.replace(/^[ \t]*(?:export\s+)?interface\s+\w+[^{]*\{(?:[^{}]|\{[^{}]*\})*\}[ \t]*;?/gm, '');
  out = out.replace(/^[ \t]*(?:export\s+)?type\s+\w+[^=]*=[^;]*;[ \t]*$/gm, '');
  out = out.replace(/^[ \t]*declare\s+[^;]+;[ \t]*$/gm, '');
  out = out.replace(/^[ \t]*import\s+type\s+[^;]+;?[ \t]*$/gm, '');
  out = out.replace(/^[ \t]*export\s+type\s+[^;]+;?[ \t]*$/gm, '');

  // 可选参数 / 可选属性：`b?: number` → `b: number`，`c?` → `c`
  out = out.replace(/([A-Za-z_$][\w$]*)\?\s*:/g, '$1:');
  out = out.replace(/([A-Za-z_$][\w$]*)\?(?=\s*[,)\]}=;])/g, '$1');

  // 形参/变量上的类型标注：`: Type`
  out = out.replace(
    /:\s*(?:[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*(?:<[^;{}()=]*?>)?(?:\[\])*)(\s*[,)=;\]{}])/g,
    '$1',
  );
  // 修饰符
  out = out.replace(/\b(readonly|public|private|protected|abstract|override)\s+/g, '');
  // 非空断言：`x!.y` → `x.y`，`x!` → `x`
  out = out.replace(/!\s*\./g, '.');
  out = out.replace(/([A-Za-z_$][\w$]*)!(?=\s*[,;)\]}=])/g, '$1');
  // 类型断言：先处理 `x as unknown as T` 这类连续断言
  out = out.replace(/\s+as\s+unknown\s+as\s+[A-Za-z_$][\w$.<>[\]]*/g, '');
  out = out.replace(/\s+as\s+(?:const|[A-Za-z_$][\w$.<>[\]]*)/g, '');
  // 泛型调用：`fn<T>(` → `fn(`
  out = out.replace(/([A-Za-z_$][\w$]*)\s*<[^<>()]*>\s*\(/g, '$1(');
  // enum → 对象
  out = out.replace(/(?:export\s+)?enum\s+(\w+)\s*\{([\s\S]*?)\}/g, (_m, name: string, body: string) => {
    const entries = body
      .split(',')
      .map((s: string) => s.trim())
      .filter(Boolean)
      .map((s: string, i: number) => {
        const [k, v] = s.split('=').map((x) => x.trim());
        return `${k}: ${v ?? i}`;
      });
    return `const ${name} = { ${entries.join(', ')} };`;
  });

  return out;
}

/* ------------------------- 进程执行 ------------------------- */

interface ExecOutcome {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  killedByOutput: boolean;
  ms: number;
  commandLine: string;
}

function killTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', timeout: 5000 });
    } catch {
      /* 忽略：进程可能已退出 */
    }
  } else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* 同上 */
      }
    }
  }
}

function execWithLimit(
  command: string,
  argv: string[],
  opts: { cwd: string; timeoutMs: number; maxOutput: number; env: Record<string, string> },
): Promise<ExecOutcome> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(command, argv, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env, NO_COLOR: '1', FORCE_COLOR: '0' },
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let killedByOutput = false;
    let settled = false;

    const hardTimer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, opts.timeoutMs);

    const onData = (chunk: Buffer, into: 'out' | 'err'): void => {
      const text = chunk.toString('utf8');
      if (into === 'out') stdout += text;
      else stderr += text;
      const total = stdout.length + stderr.length;
      if (total > opts.maxOutput * 3) {
        killedByOutput = true;
        killTree(child.pid);
      }
    };

    child.stdout?.on('data', (c: Buffer) => onData(c, 'out'));
    child.stderr?.on('data', (c: Buffer) => onData(c, 'err'));

    child.on('error', (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      resolve({
        code: null,
        stdout,
        stderr: `${stderr}\n[启动失败] ${err.message}`,
        timedOut,
        killedByOutput,
        ms: Date.now() - started,
        commandLine: [command, ...argv].join(' '),
      });
    });

    child.on('close', (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      resolve({
        code,
        stdout,
        stderr,
        timedOut,
        killedByOutput,
        ms: Date.now() - started,
        commandLine: [command, ...argv].join(' '),
      });
    });
  });
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, Math.floor(max * 0.7));
  const tail = text.slice(-Math.floor(max * 0.2));
  return `${head}\n…（省略 ${text.length - head.length - tail.length} 字符）…\n${tail}`;
}

/* ------------------------- 工具实现 ------------------------- */

export const runCodeTool: ToolSpec<Args> = {
  name: 'run_code',
  description:
    '在隔离的临时目录中执行代码，用于验证审查结论（例如证明某个函数在边界输入下确实抛错）。' +
    '支持直接执行代码片段（code）或执行工作区内的文件（file）。' +
    '默认超时 15 秒，输出超过上限会熔断，运行结束后临时文件自动清理。',
  dangerous: true,
  parameters: {
    type: 'object',
    properties: {
      code: { type: 'string', description: '要执行的代码片段；与 file 二选一' },
      file: { type: 'string', description: '要执行的工作区内文件路径；与 code 二选一' },
      language: {
        type: 'string',
        description: '语言，auto 表示按后缀自动判断',
        enum: ['auto', 'js', 'ts', 'py'],
        default: 'auto',
      },
      command: {
        type: 'string',
        description: '运行时，auto 表示自动探测（优先 node，其次 python）；npm 表示在工作区执行 npm 脚本',
        enum: ['auto', 'node', 'python', 'npm'],
        default: 'auto',
      },
      args: { type: 'array', description: '传给脚本的命令行参数', items: { type: 'string' } },
      env: { type: 'object', description: '附加环境变量' },
      timeoutMs: { type: 'integer', description: '超时毫秒数，默认取 PC_EXEC_TIMEOUT_MS（15000）', minimum: 1000, maximum: 120000 },
      cleanup: { type: 'boolean', description: '执行后是否删除临时文件，默认 true', default: true },
    },
  },

  async run(args, ctx): Promise<ToolResult> {
    const a = validateArgs<Args>('run_code', args, runCodeTool.parameters);
    // npm 模式只需要脚本名，不需要 code/file
    if (a.command !== 'npm' && !a.code && !a.file) {
      throw new PlayfulError('TOOL_BAD_ARGS', 'run_code 需要提供 code 或 file 之一', {
        hint: '例如 {"code": "console.log(1+1)", "language": "js"}；执行 npm 脚本请用 {"command":"npm","args":["test"]}',
      });
    }

    const timeoutMs = Math.min(a.timeoutMs ?? ctx.execTimeoutMs, 120_000);
    const maxOutput = ctx.execMaxOutput;
    const extraEnv = normalizeEnv(a.env);

    /* 情形 A：在工作区执行 npm 脚本 */
    if (a.command === 'npm') {
      if (!which('npm')) {
        return { ok: false, tool: 'run_code', content: '未在 PATH 中找到 npm，无法执行 npm 脚本。' };
      }
      const script = a.args?.[0];
      if (!script) {
        throw new PlayfulError('TOOL_BAD_ARGS', 'command=npm 时必须在 args 的第一个元素给出脚本名', {
          hint: '例如 {"command": "npm", "args": ["test"]}',
        });
      }
      const out = await execWithLimit('npm', ['run', script, ...(a.args ?? []).slice(1)], {
        cwd: ctx.workdir,
        timeoutMs,
        maxOutput,
        env: extraEnv,
      });
      return {
        ok: out.code === 0,
        tool: 'run_code',
        content: renderOutcome(out, maxOutput, `npm run ${script}`),
        meta: { exitCode: out.code, ms: out.ms, timedOut: out.timedOut },
      };
    }

    /* 情形 B：执行文件 / 代码片段 */
    const runDir = path.join(os.tmpdir(), 'playfulcode', `run-${ctx.runId}-${Date.now()}`);
    fs.mkdirSync(runDir, { recursive: true });

    let workFile: string;
    let language: 'js' | 'ts' | 'py';

    if (a.file) {
      const abs = resolveInside(a.file, ctx);
      if (!fs.existsSync(abs)) {
        throw new PlayfulError('FS_ERROR', `待执行文件不存在：${displayPath(abs, ctx.workdir)}`, {
          hint: '先用 list_files 确认路径，或改用 code 直接传入代码片段',
        });
      }
      const basename = path.basename(abs);
      workFile = path.join(runDir, basename);
      fs.copyFileSync(abs, workFile);
      const detected = detectLanguage(basename);
      language = a.language && a.language !== 'auto' ? a.language : detected === 'unknown' ? 'js' : detected;
      // 把同目录的相邻源码一并复制，便于本地 require
      try {
        const siblings = fs.readdirSync(path.dirname(abs));
        for (const name of siblings.slice(0, 40)) {
          if (name === basename) continue;
          if (!/\.(js|mjs|cjs|ts|json|py)$/i.test(name)) continue;
          if (name === 'package.json') continue; // 避免继承工作区的 type 字段
          try {
            fs.copyFileSync(path.join(path.dirname(abs), name), path.join(runDir, name));
          } catch {
            /* 单个文件失败不影响主流程 */
          }
        }
      } catch {
        /* 忽略 */
      }
    } else {
      const lang = a.language && a.language !== 'auto' ? a.language : 'js';
      language = lang;
      const ext = lang === 'py' ? '.py' : lang === 'ts' ? '.ts' : '.mjs';
      workFile = path.join(runDir, `snippet${ext}`);
      fs.writeFileSync(workFile, a.code ?? '', 'utf8');
    }

    const notes: string[] = [];
    let command: string;
    let argv: string[];

    if (language === 'py') {
      const py = pickPython();
      if (!py) {
        cleanup(runDir, a.cleanup ?? true);
        return {
          ok: false,
          tool: 'run_code',
          content: '未在 PATH 中找到 Python 解释器（尝试过 python / python3 / py），无法执行 Python 代码。',
        };
      }
      command = py;
      argv = [workFile, ...(a.args ?? [])];
    } else if (language === 'ts') {
      const tsPath = transpileTypeScript(workFile, runDir, notes);
      if (!which('node')) {
        cleanup(runDir, a.cleanup ?? true);
        return { ok: false, tool: 'run_code', content: '未在 PATH 中找到 node，无法执行 JavaScript/TypeScript 代码。' };
      }
      command = 'node';
      argv = [tsPath, ...(a.args ?? [])];
    } else {
      if (!which('node')) {
        cleanup(runDir, a.cleanup ?? true);
        return { ok: false, tool: 'run_code', content: '未在 PATH 中找到 node，无法执行 JavaScript 代码。' };
      }
      command = 'node';
      argv = [workFile, ...(a.args ?? [])];
    }

    const out = await execWithLimit(command, argv, { cwd: runDir, timeoutMs, maxOutput, env: extraEnv });
    cleanup(runDir, a.cleanup ?? true);

    const prefix = notes.length > 0 ? `${notes.join('\n')}\n` : '';
    return {
      ok: out.code === 0 && !out.timedOut && !out.killedByOutput,
      tool: 'run_code',
      content: prefix + renderOutcome(out, maxOutput, `${path.basename(workFile)}（${language}）`),
      meta: { exitCode: out.code, ms: out.ms, timedOut: out.timedOut, workFile: path.basename(workFile) },
    };
  },
};

function renderOutcome(out: ExecOutcome, maxOutput: number, label: string): string {
  const parts: string[] = [`▶ ${label}｜退出码 ${out.code ?? '未知'}｜耗时 ${out.ms}ms`];
  if (out.timedOut) parts.push(`⚠️ 已超时被强制终止（进程树已清理）`);
  if (out.killedByOutput) parts.push(`⚠️ 输出量过大触发熔断，进程已被终止`);
  if (out.stdout.trim()) parts.push(`--- stdout ---\n${clip(out.stdout, maxOutput)}`);
  if (out.stderr.trim()) parts.push(`--- stderr ---\n${clip(out.stderr, Math.floor(maxOutput / 2))}`);
  if (!out.stdout.trim() && !out.stderr.trim()) parts.push('（无输出）');
  return parts.join('\n');
}

function normalizeEnv(env: Record<string, unknown> | undefined): Record<string, string> {
  if (!env || typeof env !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === null || v === undefined) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) continue;
    out[k] = String(v);
  }
  return out;
}

function cleanup(dir: string, enabled: boolean): void {
  if (!enabled) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* 临时目录清理失败不影响结果 */
  }
}

/** TypeScript → JavaScript：优先调用本机 tsc，失败时用内置降级转译。 */
function transpileTypeScript(tsFile: string, runDir: string, notes: string[]): string {
  const outDir = path.join(runDir, '__out');
  fs.mkdirSync(outDir, { recursive: true });

  const localTsc = path.join(process.cwd(), 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc');
  if (fs.existsSync(localTsc) || which('tsc')) {
    const cmd = fs.existsSync(localTsc) ? localTsc : 'tsc';
    const res = spawnSync(
      cmd,
      [tsFile, '--outDir', outDir, '--module', 'commonjs', '--target', 'es2020', '--skipLibCheck', '--esModuleInterop'],
      { encoding: 'utf8', timeout: 60_000, windowsHide: true, shell: process.platform === 'win32' && cmd.endsWith('.cmd') },
    );
    const produced = path.join(outDir, path.basename(tsFile).replace(/\.tsx?$/, '.js'));
    if (res.status === 0 && fs.existsSync(produced)) {
      notes.push('（已通过本机 tsc 编译）');
      return produced;
    }
    notes.push('（本机 tsc 编译失败，已降级为内置轻量转译，仅支持无外部依赖的示例代码）');
  } else {
    notes.push('（未检测到 tsc，使用内置轻量转译，仅支持无外部依赖的示例代码）');
  }

  const js = path.join(runDir, `${path.basename(tsFile).replace(/\.tsx?$/, '')}.cjs`);
  fs.writeFileSync(js, stripTypes(fs.readFileSync(tsFile, 'utf8')), 'utf8');
  return js;
}

export default runCodeTool;
