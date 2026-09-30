/**
 * 本地 Web 服务端。
 *
 * 只用 node:http，没有 express / ws 依赖：
 * - 下行用 SSE（Server-Sent Events）推送 Agent 事件，单向、自动重连；
 * - 上行用普通 POST（提问 / 审批 / 换工作目录 / 新建与切换对话）。
 *
 * 模型分两层，这是「侧边栏多个对话」能成立的前提：
 * - Workspace：工作目录 + 配置，全局唯一（Agent 的授权范围），由 Manager 持有；
 * - Task：一次对话，拥有自己的 Agent、记忆、事件缓冲、消息队列与审批挂起项。
 *   多个对话可以并行推进，互不污染上下文；切换对话只是换一个事件流去订阅。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { URL } from 'node:url';
import { CodeReviewAgent } from '../agent/agent';
import { CHAT_SYSTEM_PROMPT } from '../agent/prompts';
import type { AppConfig } from '../core/config';
import { maskSecret, PROVIDER_PRESETS, resolveConfig, validateConfig } from '../core/config';
import { normalizeError } from '../core/errors';
import { createLogger } from '../core/logger';
import type { AgentEvent, ChatMessage, LlmProvider } from '../core/types';
import { LlmClient } from '../llm/client';
import { MockProvider } from '../llm/mock';
import type { ApprovalRequest, ApprovalDecision } from '../tools/executor';
import { createDefaultRegistry } from '../tools/registry';
import { scanPath } from '../tools/static-analysis';
import { loadIndexHtml } from './ui';

const log = createLogger('web');

export interface WebServerOptions {
  config: AppConfig;
  host: string;
  port: number;
  version: string;
  demo?: boolean;
}

interface PendingApproval {
  request: ApprovalRequest;
  resolve: (d: ApprovalDecision) => void;
}

export interface TaskSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  running: boolean;
}

/* ------------------------------------------------------------------ *
 * 工作目录
 * ------------------------------------------------------------------ */

/** 校验并规范化用户给出的工作目录。 */
export function normalizeWorkdir(input: string, fallback: string): string {
  const cleaned = String(input ?? '').trim().replace(/^["']|["']$/g, '');
  if (!cleaned) throw new Error('工作目录不能为空');
  const abs = path.resolve(cleaned);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch {
    throw new Error(`目录不存在：${abs}`);
  }
  if (!stat.isDirectory()) throw new Error(`不是目录：${abs}`);
  return abs;
}

/* ------------------------------------------------------------------ *
 * 系统原生文件夹选择对话框
 * ------------------------------------------------------------------ */

/**
 * 唤起操作系统自带的「选择文件夹」对话框，返回用户选中的目录。
 *
 * 为什么放在服务端：浏览器出于安全限制拿不到真实目录的绝对路径
 * （`<input webkitdirectory>` 只能拿到相对文件名，`showDirectoryPicker` 到处受限）。
 * 本工具是本地服务 + 本地浏览器，服务端有完整的进程权限，
 * 由它拉起系统对话框再把绝对路径回传给前端，才能得到「系统自带」的体验。
 */
export interface PickFolderResult {
  ok: boolean;
  canceled?: boolean;
  path?: string;
  error?: string;
  unsupported?: boolean;
}

/** 同一时刻只允许一个系统对话框，避免误触连开多个窗口。 */
let pickerOpen = false;

export function pickFolderNative(currentDir?: string): Promise<PickFolderResult> {
  if (pickerOpen) return Promise.resolve({ ok: false, error: '已经有一个选择窗口打开了' });
  pickerOpen = true;

  const finish = (r: PickFolderResult): PickFolderResult => {
    pickerOpen = false;
    return r;
  };

  if (process.platform === 'win32') {
    return pickFolderWindows(currentDir)
      .then(finish)
      .catch((e: unknown) => finish({ ok: false, error: String(e) }));
  }
  if (process.platform === 'darwin') {
    return runPicker('osascript', ['-e', 'POSIX path of (choose folder with prompt "选择工作区目录")'])
      .then(finish)
      .catch((e: unknown) => finish({ ok: false, error: String(e) }));
  }
  return runPicker('zenity', ['--file-selection', '--directory', '--title=选择工作区目录'])
    .then(finish)
    .catch(() =>
      runPicker('kdialog', ['--getexistingdirectory'])
        .then(finish)
        .catch(() => finish({ ok: false, unsupported: true, error: '当前系统没有可用的文件夹选择窗口' })),
    );
}

function pickFolderWindows(currentDir?: string): Promise<PickFolderResult> {
  // 注意：必须用换行分隔语句 —— PowerShell 的 if/else 无法用分号串成一行
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    '$dlg = New-Object System.Windows.Forms.FolderBrowserDialog',
    '$dlg.Description = "选择 PlayfulCode 的工作区目录（Agent 只能读写这个目录）"',
    '$dlg.ShowNewFolderButton = $true',
    'if ($env:PC_PICK_DIR) { $dlg.SelectedPath = $env:PC_PICK_DIR }',
    '$owner = New-Object System.Windows.Forms.Form',
    '$owner.TopMost = $true',
    '$owner.ShowInTaskbar = $false',
    '$owner.WindowState = "Minimized"',
    '$owner.Show()',
    '$owner.Activate() | Out-Null',
    '$r = $dlg.ShowDialog($owner)',
    '$owner.Close()',
    'if ($r -eq [System.Windows.Forms.DialogResult]::OK) {',
    '  [Console]::Out.Write($dlg.SelectedPath)',
    '} else {',
    '  [Console]::Out.Write("__CANCELED__")',
    '}',
  ].join('\n');

  return new Promise<PickFolderResult>((resolve) => {
    const child = spawn('powershell', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      windowsHide: true,
      env: { ...process.env, PC_PICK_DIR: currentDir ? path.resolve(currentDir) : '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let out = '';
    let err = '';
    child.stdout.on('data', (c: Buffer) => {
      out += c.toString('utf8');
    });
    child.stderr.on('data', (c: Buffer) => {
      err += c.toString('utf8');
    });

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* 已退出 */
      }
      resolve({ ok: false, error: '选择超时（5 分钟未操作）' });
    }, 300_000);

    child.on('error', (e: Error) => {
      clearTimeout(timer);
      resolve({ ok: false, error: `无法启动系统对话框：${e.message}` });
    });

    child.on('close', () => {
      clearTimeout(timer);
      const picked = out.trim();
      if (picked === '__CANCELED__') {
        resolve({ ok: false, canceled: true });
        return;
      }
      if (!picked) {
        resolve({ ok: false, error: err.trim().split('\n')[0] || '系统对话框未返回路径' });
        return;
      }
      resolve({ ok: true, path: picked });
    });
  });
}

/** 通用命令行选择器（macOS / Linux）。 */
function runPicker(command: string, args: string[]): Promise<PickFolderResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (c: Buffer) => {
      out += c.toString('utf8');
    });
    const timer = setTimeout(() => child.kill(), 300_000);
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ ok: false, unsupported: true, error: '系统没有安装该对话框程序' });
    });
    child.on('close', (code: number | null) => {
      clearTimeout(timer);
      const picked = out.trim().replace(/\/$/, '');
      if (code === 0 && picked) resolve({ ok: true, path: picked });
      else resolve({ ok: false, canceled: true });
    });
  });
}

/* ------------------------------------------------------------------ *
 * 对话（Task）
 * ------------------------------------------------------------------ */

const MAX_EVENTS = 3000;
const MAX_TASKS = 40;

/** 一次对话：拥有独立的 Agent 记忆、事件流、队列与审批。 */
export class Task {
  readonly id: string;
  readonly createdAt = Date.now();
  title: string;
  updatedAt = Date.now();
  readonly events: { seq: number; event: AgentEvent }[] = [];

  agent: CodeReviewAgent;

  private readonly subscribers = new Set<http.ServerResponse>();
  private readonly queue: string[] = [];
  private busy = false;
  private seq = 0;
  private readonly approvals = new Map<string, PendingApproval>();
  private approvalSeq = 0;

  constructor(id: string, title: string, private readonly owner: Manager) {
    this.id = id;
    this.title = title;
    this.agent = owner.createAgent((e) => this.publish(e), (r) => this.waitApproval(r));
  }

  /* ------------------------- 事件总线 ------------------------- */

  private publish(event: AgentEvent): void {
    this.pushEvent(event as unknown as Record<string, unknown>);
  }

  /** 推送一条不属于 AgentEvent 联合类型的界面事件（answer / notice / clear / approval_request）。 */
  publishRaw(payload: Record<string, unknown>): void {
    this.pushEvent(payload);
  }

  private pushEvent(payload: Record<string, unknown>): void {
    this.seq += 1;
    this.updatedAt = Date.now();
    this.events.push({ seq: this.seq, event: payload as unknown as AgentEvent });
    if (this.events.length > MAX_EVENTS) this.events.splice(0, 500);
    const frame = `event: event\ndata: ${JSON.stringify({ ...payload, seq: this.seq })}\n\n`;
    for (const res of this.subscribers) {
      try {
        res.write(frame);
      } catch {
        this.subscribers.delete(res);
      }
    }
  }

  addSubscriber(res: http.ServerResponse): void {
    this.subscribers.add(res);
    res.on('close', () => this.subscribers.delete(res));
  }

  subscriberCount(): number {
    return this.subscribers.size;
  }

  /** 回放历史事件（刷新页面/切换回来时不丢内容）。 */
  replay(res: http.ServerResponse, fromSeq: number): void {
    for (const { seq, event } of this.events) {
      if (seq <= fromSeq) continue;
      res.write(`event: event\ndata: ${JSON.stringify({ ...event, seq })}\n\n`);
    }
  }

  /* ------------------------- 审批 ------------------------- */

  waitApproval(request: ApprovalRequest): Promise<ApprovalDecision> {
    this.approvalSeq += 1;
    const id = `ap_${this.approvalSeq}_${Date.now().toString(36)}`;
    return new Promise<ApprovalDecision>((resolve) => {
      this.approvals.set(id, { request, resolve });
      this.publishRaw({
        type: 'approval_request',
        id,
        tool: request.tool,
        args: request.args,
        description: request.description,
      });
    });
  }

  approve(id: string, decision: ApprovalDecision): boolean {
    const item = this.approvals.get(id);
    if (!item) return false;
    this.approvals.delete(id);
    item.resolve(decision);
    return true;
  }

  /* ------------------------- 队列执行 ------------------------- */

  get isBusy(): boolean {
    return this.busy;
  }

  get queueLength(): number {
    return this.queue.length;
  }

  get messageCount(): number {
    return Math.max(0, this.agent.memorySize - 1);
  }

  enqueue(message: string): void {
    if (this.messageCount === 0) {
      this.title = message.length > 28 ? `${message.slice(0, 28)}…` : message;
    }
    this.queue.push(message);
    this.updatedAt = Date.now();
    if (!this.busy) void this.drain();
  }

  private async drain(): Promise<void> {
    this.busy = true;
    try {
      while (this.queue.length > 0) {
        const message = this.queue.shift() as string;
        const result = await this.agent.run(message, { remember: true });
        this.publishRaw({ type: 'answer', content: result.answer });
      }
    } catch (e) {
      const err = normalizeError(e);
      this.publish({ type: 'error', message: err.toUserMessage(), recoverable: false });
      this.publishRaw({ type: 'answer', content: `运行失败：${err.toUserMessage()}` });
    } finally {
      this.busy = false;
      for (const [, item] of this.approvals) item.resolve('deny');
      this.approvals.clear();
    }
  }

  reset(): void {
    this.agent.reset();
    this.publishRaw({ type: 'notice', message: '对话已重置' });
  }

  /** 工作目录切换后，用新配置重建 Agent 并清空记忆与事件。 */
  rebuild(): void {
    this.agent = this.owner.createAgent((e) => this.publish(e), (r) => this.waitApproval(r));
    this.events.length = 0;
    this.publishRaw({ type: 'clear' });
  }

  summary(): TaskSummary {
    return {
      id: this.id,
      title: this.title,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      messageCount: this.messageCount,
      running: this.busy,
    };
  }

  detach(): void {
    for (const res of this.subscribers) {
      try {
        res.end();
      } catch {
        /* 已断开 */
      }
    }
    this.subscribers.clear();
  }
}

/* ------------------------------------------------------------------ *
 * 工作区与对话管理器
 * ------------------------------------------------------------------ */

export class Manager {
  readonly version: string;
  readonly tasks = new Map<string, Task>();
  private order: string[] = [];

  /** 启动时的基础配置（provider / key / 超时等），工作目录在 resolvedConfig() 里动态合并。 */
  private readonly baseConfig: AppConfig;
  private workdir: string;
  private workdirExplicit: boolean;
  private taskSeq = 0;

  private readonly demo: boolean;
  private readonly injectedProvider?: LlmProvider;

  constructor(config: AppConfig, demo: boolean, version: string, provider?: LlmProvider) {
    this.baseConfig = config;
    this.demo = demo;
    this.version = version;
    this.injectedProvider = provider;
    // 工作目录不做隐式兜底：未显式指定时留空，等界面上选择
    this.workdir = config.workdir ? path.resolve(config.workdir) : '';
    this.workdirExplicit = Boolean(this.workdir) || detectWorkdirExplicit();
    this.createTask();
  }

  /**
   * 合成当前生效配置。
   * 工作目录未选定时，内部仍需要一个可解析的相对路径基准，因此对内外分离：
   * 对外（快照、界面）如实报告「未选择」，对内用进程目录作为路径解析基准，
   * 但访问仍会被 workspaceRoots 拦住 —— 未选中时 roots 为空，工具无法落地任何文件。
   */
  private resolvedConfig(): AppConfig {
    const envRootsSet = Boolean(process.env.PC_WORKSPACE_ROOTS && process.env.PC_WORKSPACE_ROOTS.trim());
    return resolveConfig(
      {
        provider: this.baseConfig.provider,
        model: this.baseConfig.model,
        baseUrl: this.baseConfig.baseUrl,
        apiKey: this.baseConfig.apiKey,
        temperature: this.baseConfig.temperature,
        maxSteps: this.baseConfig.maxSteps,
        requireApproval: this.baseConfig.requireApproval,
        workdir: this.workdir || process.cwd(),
        logLevel: this.baseConfig.logLevel,
        // 未显式配置授权范围时，把它绑定到当前工作目录
        ...(envRootsSet ? {} : { workspaceRoots: this.workdir ? [this.workdir] : [] }),
      },
      process.env,
    );
  }

  /* ------------------------- 装配 ------------------------- */

  /** 由 Task 调用，创建一个绑定好事件与审批回调的 Agent。 */
  createAgent(onEvent: (e: AgentEvent) => void, onApproval: (r: ApprovalRequest) => Promise<ApprovalDecision>): CodeReviewAgent {
    const config = this.resolvedConfig();
    let provider = this.injectedProvider;
    if (!provider && this.demo && this.injectedProvider === undefined) {
      provider = new MockProvider([
        { kind: 'tools', content: '先查看工程结构。', calls: [{ name: 'list_files', args: { path: '.', maxDepth: 2 } }] },
        { kind: 'tools', content: '扫描一遍，拿到客观证据。', calls: [{ name: 'scan_code', args: { path: '.' } }] },
        {
          kind: 'text',
          content: [
            '### 一、审查概述',
            '',
            '这是 **DEMO 模式**：模型被替换为脚本化输出，用于在没有 API Key 的环境下演示完整的 Agent 循环。',
            '下面的工具调用与返回都是真实的 —— 换成真实模型后，推理路径会由模型自己决定。',
            '',
            '### 二、怎么接入真实模型',
            '',
            '在项目根目录创建 `.env`，填入：',
            '',
            '```ini',
            'PC_PROVIDER=deepseek',
            'PC_API_KEY=sk-你的密钥',
            '```',
            '',
            '然后重启 `npm run web`。',
          ].join('\n'),
        },
      ]);
    }

    const client = provider
      ? new LlmClient({ config: { ...config, apiKey: config.apiKey || 'demo' }, provider })
      : undefined;

    return new CodeReviewAgent({
      config,
      registry: createDefaultRegistry(),
      ...(client ? { client } : {}),
      systemPrompt: CHAT_SYSTEM_PROMPT,
      onEvent,
      onApproval,
    });
  }

  /* ------------------------- 对话管理 ------------------------- */

  createTask(): Task {
    this.taskSeq += 1;
    const id = `t${this.taskSeq}_${Date.now().toString(36)}`;
    const task = new Task(id, '新对话', this);
    this.tasks.set(id, task);
    this.order.push(id);

    // 超出上限时回收最旧的空闲对话，避免内存无限增长
    while (this.order.length > MAX_TASKS) {
      const victimId = this.order.find((tid) => {
        const t = this.tasks.get(tid);
        return t !== undefined && !t.isBusy && t.id !== id;
      });
      if (!victimId) break;
      const victim = this.tasks.get(victimId);
      victim?.detach();
      this.tasks.delete(victimId);
      this.order = this.order.filter((x) => x !== victimId);
    }
    return task;
  }

  getTask(id: string | null | undefined): Task | undefined {
    if (!id) return undefined;
    return this.tasks.get(id);
  }

  /** 取对话；不存在时自动新建一个（前端不会因此白屏）。 */
  ensureTask(id: string | null | undefined): Task {
    return this.getTask(id) ?? this.createTask();
  }

  deleteTask(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task) return false;
    task.detach();
    this.tasks.delete(id);
    this.order = this.order.filter((x) => x !== id);
    if (this.tasks.size === 0) this.createTask();
    return true;
  }

  listTasks(): TaskSummary[] {
    return this.order
      .map((id) => this.tasks.get(id))
      .filter((t): t is Task => Boolean(t))
      .map((t) => t.summary())
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /* ------------------------- 工作区 ------------------------- */

  getConfig(): AppConfig {
    return this.resolvedConfig();
  }

  /** 当前工作目录；未选择时为空字符串。 */
  getWorkdir(): string {
    return this.workdir;
  }

  get needSelectWorkdir(): boolean {
    return !this.workdir || !this.workdirExplicit;
  }

  problems(): string[] {
    return this.demo ? [] : validateConfig(this.getConfig());
  }

  /** 切换工作目录：所有对话都要重建（记忆清空，因为旧路径会误导模型）。 */
  changeWorkdir(input: string): string {
    const next = normalizeWorkdir(input, this.workdir);
    this.workdir = next;
    this.workdirExplicit = true;
    for (const task of this.tasks.values()) task.rebuild();
    return this.workdir;
  }

  /* ------------------------- 快照 ------------------------- */

  /**
   * 对外状态快照。
   * 未选择工作目录时 path 为空 —— 不把进程所在目录当作默认值暴露出去，
   * 界面也就不会显示任何本机路径。
   */
  snapshot(activeTaskId?: string | null): Record<string, unknown> {
    const cfg = this.getConfig();
    const problems = this.problems();
    const active = this.getTask(activeTaskId);
    return {
      version: this.version,
      provider: cfg.provider,
      model: cfg.model,
      apiKeyMasked: maskSecret(cfg.apiKey),
      ready: problems.length === 0 || this.demo,
      problems,
      workdir: {
        path: this.workdir,
        needSelect: this.needSelectWorkdir,
      },
      tasks: this.listTasks(),
      activeTaskId: active ? active.id : null,
      memorySize: active ? active.messageCount : 0,
      busy: active ? active.isBusy : false,
      queued: active ? active.queueLength : 0,
      demo: this.demo,
    };
  }
}

/** 工作目录是否被显式指定过（决定界面是否强制先选一次）。 */
function detectWorkdirExplicit(): boolean {
  if (process.env.PC_WORKDIR && process.env.PC_WORKDIR.trim()) return true;
  if (process.argv.some((a) => a === '--workdir' || a.startsWith('--workdir='))) return true;
  return false;
}

/* ------------------------------------------------------------------ *
 * HTTP 工具
 * ------------------------------------------------------------------ */

function readBody(req: http.IncomingMessage, limit = 512 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function json(res: http.ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

async function readJson<T extends object>(req: http.IncomingMessage): Promise<T> {
  const raw = await readBody(req);
  if (!raw.trim()) return {} as T;
  return JSON.parse(raw) as T;
}

/* ------------------------------------------------------------------ *
 * 服务器
 * ------------------------------------------------------------------ */

export async function startWebServer(opts: WebServerOptions): Promise<http.Server> {
  const demo = Boolean(opts.demo);
  const manager = new Manager(opts.config, demo, opts.version);

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    void (async () => {
      try {
        /* --------- 静态页面 --------- */
        if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
          const html = loadIndexHtml();
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
          res.end(html);
          return;
        }

        /* --------- 状态快照 --------- */
        if (req.method === 'GET' && (url.pathname === '/api/state' || url.pathname === '/api/config')) {
          json(res, 200, manager.snapshot(url.searchParams.get('task')));
          return;
        }

        /* --------- 对话列表 --------- */
        if (req.method === 'GET' && url.pathname === '/api/tasks') {
          json(res, 200, { tasks: manager.listTasks() });
          return;
        }

        /* --------- 新建对话 --------- */
        if (req.method === 'POST' && url.pathname === '/api/tasks') {
          const task = manager.createTask();
          json(res, 200, { ok: true, task: task.summary(), tasks: manager.listTasks() });
          return;
        }

        /* --------- 重命名 / 删除对话 --------- */
        if (req.method === 'POST' && url.pathname === '/api/task') {
          const body = await readJson<{ id?: string; action?: string; title?: string }>(req);
          const task = manager.getTask(String(body.id ?? ''));
          if (!task) {
            json(res, 404, { ok: false, error: '对话不存在' });
            return;
          }
          if (body.action === 'delete') {
            manager.deleteTask(task.id);
            json(res, 200, { ok: true, tasks: manager.listTasks() });
            return;
          }
          if (body.action === 'rename' && typeof body.title === 'string' && body.title.trim()) {
            task.title = body.title.trim().slice(0, 60);
            json(res, 200, { ok: true, task: task.summary(), tasks: manager.listTasks() });
            return;
          }
          json(res, 400, { ok: false, error: '未知操作' });
          return;
        }

        /* --------- 某个对话的历史消息（用于界面渲染） --------- */
        if (req.method === 'GET' && url.pathname === '/api/messages') {
          const task = manager.getTask(url.searchParams.get('task'));
          json(res, 200, { messages: task ? task.agent.history() : [] });
          return;
        }

        /* --------- 唤起系统文件夹窗口 --------- */
        if (req.method === 'POST' && url.pathname === '/api/pick-folder') {
          const body = await readJson<{ path?: string }>(req);
          const result = await pickFolderNative(body.path ? String(body.path) : manager.getWorkdir());
          json(res, 200, result);
          return;
        }

        /* --------- 切换工作目录 --------- */
        if (req.method === 'POST' && url.pathname === '/api/workdir') {
          const body = await readJson<{ path?: string }>(req);
          try {
            const resolved = manager.changeWorkdir(String(body.path ?? ''));
            json(res, 200, { ok: true, resolved, state: manager.snapshot(url.searchParams.get('task')) });
          } catch (e) {
            json(res, 400, { ok: false, error: normalizeError(e).message });
          }
          return;
        }

        /* --------- 工具清单 --------- */
        if (req.method === 'GET' && url.pathname === '/api/tools') {
          json(res, 200, {
            tools: createDefaultRegistry().names(),
            detail: createDefaultRegistry()
              .list()
              .map((t) => ({ name: t.name, description: t.description.split('\n')[0], dangerous: Boolean(t.dangerous) })),
          });
          return;
        }

        /* --------- SSE 流（按对话订阅） --------- */
        if (req.method === 'GET' && url.pathname === '/api/stream') {
          const task = manager.ensureTask(url.searchParams.get('task'));
          res.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache, no-transform',
            connection: 'keep-alive',
            'x-accel-buffering': 'no',
          });
          res.write(`retry: 2000\n\n`);
          res.write(`event: task\ndata: ${JSON.stringify({ task: task.summary() })}\n\n`);
          const fromSeqRaw = Number(url.searchParams.get('from') ?? '0');
          task.replay(res, Number.isFinite(fromSeqRaw) ? fromSeqRaw : 0);
          task.addSubscriber(res);
          const keepAlive = setInterval(() => {
            try {
              res.write(': keep-alive\n\n');
            } catch {
              clearInterval(keepAlive);
            }
          }, 15000);
          req.on('close', () => clearInterval(keepAlive));
          return;
        }

        /* --------- 发起提问 --------- */
        if (req.method === 'POST' && url.pathname === '/api/chat') {
          const body = await readJson<{ message?: string; task?: string }>(req);
          const message = String(body.message ?? '').trim();
          if (!message) {
            json(res, 400, { ok: false, error: '消息不能为空' });
            return;
          }
          // 必须先有授权范围：没有工作目录就不允许 Agent 动手
          if (!manager.getWorkdir()) {
            json(res, 400, { ok: false, error: '请先选择工作区目录' });
            return;
          }
          const problems = manager.problems();
          if (problems.length > 0) {
            json(res, 503, { ok: false, error: `模型未配置：${problems.join('；')}` });
            return;
          }
          const task = manager.ensureTask(body.task);
          task.enqueue(message);
          json(res, 200, { ok: true, task: task.summary(), queued: task.queueLength, busy: task.isBusy });
          return;
        }

        /* --------- 审批 --------- */
        if (req.method === 'POST' && url.pathname === '/api/approve') {
          const body = await readJson<{ id?: string; decision?: ApprovalDecision; task?: string }>(req);
          const decision: ApprovalDecision =
            body.decision === 'allow' || body.decision === 'allow_all' ? body.decision : 'deny';
          const task = manager.getTask(body.task);
          const ok = task ? task.approve(String(body.id ?? ''), decision) : false;
          json(res, ok ? 200 : 404, { ok, decision });
          return;
        }

        /* --------- 重置某个对话 --------- */
        if (req.method === 'POST' && url.pathname === '/api/reset') {
          const body = await readJson<{ task?: string }>(req);
          const task = manager.ensureTask(body.task);
          task.reset();
          json(res, 200, { ok: true });
          return;
        }

        /* --------- 静态扫描（不消耗模型额度） --------- */
        if (req.method === 'POST' && url.pathname === '/api/scan') {
          const body = await readJson<{ path?: string; task?: string }>(req);
          if (!manager.getWorkdir()) {
            json(res, 400, { ok: false, error: '请先选择工作目录' });
            return;
          }
          const report = scanPath({ target: body.path ?? '.', workdir: manager.getWorkdir(), maxFiles: 800 });
          manager.getTask(body.task)?.publishRaw({ type: 'scan_report', report });
          json(res, 200, report);
          return;
        }

        /* --------- 健康检查（不回传任何本机路径） --------- */
        if (req.method === 'GET' && url.pathname === '/api/health') {
          json(res, 200, {
            ok: true,
            version: opts.version,
            tasks: manager.tasks.size,
            workdirSelected: Boolean(manager.getWorkdir()),
          });
          return;
        }

        json(res, 404, { ok: false, error: `未知接口：${url.pathname}` });
      } catch (e) {
        const err = normalizeError(e);
        log.error(`请求处理失败 ${req.method} ${url.pathname}：${err.message}`);
        if (!res.headersSent) json(res, 500, { ok: false, error: err.toUserMessage() });
        else res.end();
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host, () => resolve());
  });

  const addr = `http://${opts.host}:${opts.port}`;
  const cfg = manager.getConfig();
  const problems = manager.problems();
  const wd = manager.getWorkdir();

  log.info(`Web 界面已启动：${addr}`);
  process.stdout.write(
    [
      '',
      '  PlayfulCode Web 界面已启动',
      `  地址：${addr}`,
      `  模型：${cfg.provider} / ${cfg.model}${demo ? '（DEMO 模式）' : ''}`,
      // 未显式指定时只说明状态，不打印任何本机路径
      wd ? `  工作目录：${wd}` : '  工作目录：未指定（请在界面上选择）',
      problems.length > 0 ? `  ⚠️  ${problems.join('；')}` : '',
      '  按 Ctrl+C 停止服务',
      '',
    ]
      .filter(Boolean)
      .join('\n') + '\n',
  );

  process.on('SIGINT', () => {
    log.info('正在关闭 Web 服务…');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500);
  });

  return server;
}

export const __testing = { Manager, Task, readBody, normalizeWorkdir, pickFolderNative, PROVIDER_PRESETS };
