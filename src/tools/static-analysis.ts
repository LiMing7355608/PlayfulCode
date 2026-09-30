/**
 * 静态分析引擎。
 *
 * 为什么要有它？
 * 纯靠 LLM 做代码审查有三个硬伤：漏报、幻觉、不可复现。
 * 本模块用一套确定性的规则引擎先扫出「客观证据」（文件:行:代码片段），
 * 再把这些证据交给 LLM 做「价值判断」（是否真问题、影响面、怎么改）。
 * 这样 Agent 的结论有据可依，也解释了它为什么比单轮 Prompt 更可靠。
 *
 * 实现上是轻量词法级扫描 + 局部块结构分析，刻意不引入 babel/typescript，
 * 以保证零依赖；规则表是声明式的，新增规则只需要加一个对象。
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Finding, ScanReport, Severity } from '../core/types';
import { displayPath, isSourceLike, readTextFileSafe, shouldIgnoreDir, shouldIgnoreFile, walkSourceFiles } from './path-guard';

/* ------------------------------------------------------------------ *
 * 词法屏蔽：把注释与字符串内容替换为空格，避免正则误命中
 * ------------------------------------------------------------------ */

interface ShieldResult {
  lines: string[];
  /** 原始行内容（渲染片段时用） */
  rawLines: string[];
}

/**
 * 词法屏蔽：把注释与「有实义的字符串内容」清空，避免正则误命中。
 *
 * 保留策略（这是本引擎误报率的关键）：
 * - 长度 < 8 的字符串**原样保留** —— 像 "md5"、"sha1"、"0"（关闭校验）这类短字面量
 *   本身就是安全信号，屏蔽掉它们会让规则失效；
 * - 长度 >= 8 的字符串内容替换为等长空格 —— 既清掉了「代码写在大段文本里」的噪音，
 *   又把完整的引号形态留了下来，便于规则匹配 `hashlib.md5(` 之类的调用形态；
 * - 模板字符串整体屏蔽（可能跨多行且常含大段文本）。
 */
export function shieldCommentsAndStrings(source: string): ShieldResult {
  const rawLines = source.split(/\r?\n/);
  const lines = source.split(/\r?\n/).map((l) => l);

  let inBlockComment = false;
  let inTemplate = false;

  const blank = (s: string): string => ' '.repeat(s.length);
  /** 清洗单行内的字符串字面量。 */
  const scrubStrings = (text: string): string =>
    text.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, (lit) =>
      lit.length < 10 ? lit : `${lit[0]}${' '.repeat(lit.length - 2)}${lit[lit.length - 1]}`,
    );

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const out: string[] = [];
    let j = 0;

    while (j < line.length) {
      const ch = line[j] as string;
      const next = line[j + 1];

      if (inBlockComment) {
        if (ch === '*' && next === '/') {
          out.push('  ');
          j += 2;
          inBlockComment = false;
        } else {
          out.push(' ');
          j += 1;
        }
        continue;
      }

      if (inTemplate) {
        out.push(ch === '`' ? ' ' : ' ');
        if (ch === '`') inTemplate = false;
        j += 1;
        continue;
      }

      if (ch === '/' && next === '/') {
        out.push(blank(line.slice(j)));
        break;
      }
      if (ch === '/' && next === '*') {
        out.push('  ');
        j += 2;
        inBlockComment = true;
        continue;
      }
      if (ch === '"' || ch === "'") {
        // 找同行内的闭合引号，整段处理
        const quote = ch;
        let k = j + 1;
        let closed = false;
        while (k < line.length) {
          const c = line[k] as string;
          if (c === '\\') {
            k += 2;
            continue;
          }
          if (c === quote) {
            closed = true;
            break;
          }
          k += 1;
        }
        const lit = closed ? line.slice(j, k + 1) : line.slice(j);
        out.push(lit.length < 10 ? lit : `${quote}${' '.repeat(lit.length - (closed ? 2 : 1))}${closed ? quote : ''}`);
        j = closed ? k + 1 : line.length;
        continue;
      }
      if (ch === '`') {
        out.push(' ');
        j += 1;
        inTemplate = true;
        continue;
      }

      out.push(ch);
      j += 1;
    }

    lines[i] = scrubStrings(out.join(''));
  }

  return { lines, rawLines };
}

/* ------------------------------------------------------------------ *
 * 规则定义
 * ------------------------------------------------------------------ */

export type Lang = 'js' | 'py' | 'java' | 'any';

export interface RuleContext {
  /** 已屏蔽注释与字符串的源码行 */
  masked: string[];
  /** 原始源码行 */
  raw: string[];
  /** 原始完整源码 */
  source: string;
  /** 文件绝对路径 */
  absPath: string;
  /** 相对展示路径 */
  file: string;
  /** 语言 */
  lang: Lang;
}

export interface RuleHit {
  line: number;
  column?: number;
  snippet?: string;
  message?: string;
  suggestion?: string;
  severity?: Severity;
}

export interface Rule {
  id: string;
  title: string;
  severity: Severity;
  langs: Lang[];
  /** 便于阅读的规则说明，会出现在报告里 */
  rationale: string;
  defaultSuggestion: string;
  /**
   * 检查函数：返回命中列表。
   * `regex` 与 `check` 二选一，`regex` 是常见情况的语法糖。
   */
  regex?: RegExp;
  check?: (ctx: RuleContext) => RuleHit[];
  /** 命中后是否跳过（用于白名单，如测试文件里的 console） */
  ignore?: (ctx: RuleContext, hit: RuleHit) => boolean;
}

const EXT_LANG: Record<string, Lang> = {
  '.ts': 'js', '.tsx': 'js', '.js': 'js', '.jsx': 'js', '.mjs': 'js', '.cjs': 'js',
  '.mts': 'js', '.cts': 'js', '.vue': 'js', '.svelte': 'js',
  '.py': 'py', '.pyw': 'py',
  '.java': 'java', '.kt': 'java', '.scala': 'java',
};

function langOf(file: string): Lang {
  return EXT_LANG[path.extname(file).toLowerCase()] ?? 'any';
}

/* --------------------------- 工具函数 --------------------------- */

function snippetOf(raw: string[], line: number, max = 160): string {
  const text = (raw[line - 1] ?? '').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** 找出所有函数定义块（大括号计数），返回 [startLine, endLine]。 */
function findJsFunctionBlocks(masked: string[]): { start: number; end: number; name: string }[] {
  const blocks: { start: number; end: number; name: string }[] = [];
  const fnRe = /(?:function\s+([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*(?::[^=]*)?=>)|\b([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::[^={]*)?\{)/;

  for (let i = 0; i < masked.length; i += 1) {
    const line = masked[i] ?? '';
    const m = fnRe.exec(line);
    if (!m) continue;
    // 从当前行开始配平大括号
    let depth = 0;
    let started = false;
    let end = i;
    for (let k = i; k < masked.length && k < i + 400; k += 1) {
      const text = masked[k] ?? '';
      for (const ch of text) {
        if (ch === '{') {
          depth += 1;
          started = true;
        } else if (ch === '}') {
          depth -= 1;
        }
      }
      if (started && depth <= 0) {
        end = k;
        break;
      }
    }
    const name = m[1] ?? m[2] ?? m[3] ?? '(匿名函数)';
    blocks.push({ start: i + 1, end: end + 1, name });
  }

  // 去掉被外层包含的重复块，并按起点去重
  const seen = new Set<number>();
  return blocks
    .filter((b) => {
      if (seen.has(b.start)) return false;
      seen.add(b.start);
      return b.end > b.start;
    })
    .sort((a, b) => a.start - b.start);
}

/** 计算每一行的嵌套深度（按 {} 或 : 缩进推断）。 */
function computeDepths(masked: string[]): number[] {
  const depths: number[] = [];
  let depth = 0;
  for (const line of masked) {
    depths.push(depth);
    for (const ch of line) {
      if (ch === '{' || ch === '(' || ch === '[') depth += 1;
      else if (ch === '}' || ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
    }
  }
  return depths;
}

const TEST_FILE_RE = /(^|[\\/])(tests?|__tests__|spec|e2e)([\\/]|$)|\.(test|spec)\.[a-z]+$/i;

export function isTestFile(file: string): boolean {
  return TEST_FILE_RE.test(file);
}

/* ------------------------------------------------------------------ *
 * 规则表（按 id 排列，便于阅读）
 * ------------------------------------------------------------------ */

export const RULES: Rule[] = [
  /* ===== 正确性 ===== */
  {
    id: 'COR-001',
    title: '残留调试语句',
    severity: 'high',
    langs: ['js', 'py', 'java'],
    rationale: '调试断点/调试器语句进入生产环境会中断执行或暴露内部状态。',
    defaultSuggestion: '删除该语句；需要保留日志时改用项目统一的 logger 并以 debug 级别输出。',
    check: (ctx) => {
      const hits: RuleHit[] = [];
      ctx.masked.forEach((line, i) => {
        if (/^\s*debugger\s*;?\s*$/.test(line)) hits.push({ line: i + 1 });
        if (/\bbreakpoint\s*\(/.test(line)) hits.push({ line: i + 1 });
        if (/\bpdb\.set_trace\s*\(/.test(line)) hits.push({ line: i + 1 });
        if (/\bprint\s*\(/.test(line) && ctx.lang === 'py' && !isTestFile(ctx.file)) {
          hits.push({
            line: i + 1,
            severity: 'low',
            message: '使用 print 输出调试信息',
            suggestion: '改用 logging 模块，便于控制日志级别与输出目标。',
          });
        }
      });
      return hits;
    },
  },
  {
    id: 'COR-002',
    title: '空 catch 块吞掉异常',
    severity: 'high',
    langs: ['js', 'java'],
    rationale: '捕获后不做任何处理会让故障静默，排查成本极高。',
    defaultSuggestion: '至少记录日志并保留上下文；确实需要忽略时写明原因注释。',
    check: (ctx) => {
      const hits: RuleHit[] = [];
      ctx.masked.forEach((line, i) => {
        if (/catch\s*(\([^)]*\))?\s*\{\s*\}\s*$/.test(line.trim())) hits.push({ line: i + 1 });
        else if (/catch\s*(\([^)]*\))?\s*\{\s*$/.test(line.trim())) {
          const next = (ctx.masked[i + 1] ?? '').trim();
          if (next.startsWith('}')) hits.push({ line: i + 1 });
        }
      });
      ctx.masked.forEach((line, i) => {
        if (/\bexcept\s*:\s*pass\b/.test(line)) hits.push({ line: i + 1 });
        if (/^\s*except[^:]*:\s*$/.test(line)) {
          const next = (ctx.masked[i + 1] ?? '').trim();
          if (next === 'pass') hits.push({ line: i + 1 });
        }
      });
      return hits;
    },
  },
  {
    id: 'COR-003',
    title: '浮点数使用 === 比较',
    severity: 'medium',
    langs: ['js'],
    rationale: 'IEEE 754 精度误差会让等值比较随机失败（如 0.1 + 0.2 !== 0.3）。',
    defaultSuggestion: '改用 Math.abs(a - b) < Number.EPSILON 或定点整数比较。',
    regex: /(?:===|!==|==|!=)\s*-?\d+\.\d+/,
  },
  {
    id: 'COR-004',
    title: 'for 循环中使用 var 声明计数器',
    severity: 'medium',
    langs: ['js'],
    rationale: 'var 没有块级作用域，闭包捕获时会拿到循环结束后的最终值。',
    defaultSuggestion: '改用 let / const 获得块级作用域。',
    regex: /for\s*\(\s*var\s+/,
  },
  {
    id: 'COR-005',
    title: '异步函数中返回值被忽略的数组遍历',
    severity: 'medium',
    langs: ['js'],
    rationale: 'forEach 不会等待 async 回调，循环结束不代表异步任务完成，容易造成数据竞争。',
    defaultSuggestion: '改用 for...of 顺序执行，或 Promise.all(items.map(async ...)) 并发执行。',
    regex: /\.forEach\s*\(\s*async\b/,
  },
  {
    id: 'COR-006',
    title: 'await 出现在 forEach 回调中导致顺序丢失',
    severity: 'low',
    langs: ['js'],
    rationale: '同上，属于常见的异步陷阱变体。',
    defaultSuggestion: '见 COR-005 的修复建议。',
    regex: /\.forEach\s*\(\s*\(?[^)]*\)?\s*=>\s*\{[^}]*\bawait\b/,
  },
  {
    id: 'COR-007',
    title: '可变对象作为默认参数',
    severity: 'medium',
    langs: ['py'],
    rationale: 'Python 默认参数在函数定义时求值一次，跨调用共享可变对象会累积状态。',
    defaultSuggestion: '默认值改为 None，函数体内再初始化。',
    regex: /def\s+\w+\s*\([^)]*=\s*(\[\]|\{\}|set\(\))/,
  },

  /* ===== 安全 ===== */
  {
    id: 'SEC-001',
    title: 'eval / exec 执行动态字符串',
    severity: 'critical',
    langs: ['js', 'py'],
    rationale: '动态执行字符串是最直接的代码注入面，输入一旦可控即等价于任意代码执行。',
    defaultSuggestion: '改用 JSON.parse、显式分支或映射表；确需表达式求值时使用受限解析器。',
    check: (ctx) => {
      const hits: RuleHit[] = [];
      ctx.masked.forEach((line, i) => {
        // 用一个「非标识符前缀」断言，避免把 obj.eval() 之外的 myEval() 误判，
        // 同时保证行首的 eval(...) 也能被命中
        if (/(?<![\w$.])eval\s*\(/.test(line) && !/eval\s*\(\s*['"]use strict/.test(ctx.raw[i] ?? '')) hits.push({ line: i + 1 });
        if (/\bnew\s+Function\s*\(/.test(line)) hits.push({ line: i + 1 });
        if (ctx.lang === 'py' && /(?<![\w$.])exec\s*\(/.test(line)) hits.push({ line: i + 1 });
        if (/\bos\.system\s*\(/.test(line)) hits.push({ line: i + 1 });
        if (/subprocess\.\w+\([^)]*shell\s*=\s*True/.test(line)) {
          hits.push({ line: i + 1, message: 'shell=True 拼接外部命令', suggestion: '改用参数列表形式传参，避免 shell 解析。' });
        }
      });
      return hits;
    },
  },
  {
    id: 'SEC-002',
    title: 'innerHTML / dangerouslySetInnerHTML 直接插值',
    severity: 'high',
    langs: ['js'],
    rationale: '未转义的插值会形成 XSS；在 Electron / 内嵌浏览器场景可能升级为 RCE。',
    defaultSuggestion: '改用 textContent，或引入 DOMPurify 做白名单净化。',
    regex: /(\.innerHTML\s*=|document\.write\s*\(|dangerouslySetInnerHTML\s*=\s*\{\{\s*__html)/,
  },
  {
    id: 'SEC-003',
    title: '硬编码密钥/口令',
    severity: 'critical',
    langs: ['js', 'py', 'java', 'any'],
    rationale: '密钥进入源码仓库后即视为泄露，轮换成本远高于一开始就用环境变量。',
    defaultSuggestion: '改从环境变量或密钥管理服务读取，并把该凭证立即轮换。',
    check: (ctx) => {
      const hits: RuleHit[] = [];
      const kw = /(api[_-]?key|apikey|secret|passwd|password|token|access[_-]?key|private[_-]?key|client[_-]?secret)/i;
      // 在「已屏蔽长字符串」的文本上匹配，既能识别赋值形态，又不会把注释算进来
      ctx.masked.forEach((maskedLine, i) => {
        if (!kw.test(maskedLine)) return;
        if (/process\.env|os\.environ|getenv|import\.meta\.env|System\.getenv/.test(maskedLine)) return;
        // 取值必须是长字符串（短字面量已在 shield 阶段被保留，长字符串被清空但保留引号）
        const blanked = /[:=]\s*["'][ ]{8,}["']/.exec(maskedLine);
        if (!blanked) return;
        const rawLine = ctx.raw[i] ?? '';
        const real = /[:=]\s*["']([^"']{8,})["']/.exec(rawLine);
        const value = real?.[1] ?? '';
        if (/^(your|xxx|placeholder|change|todo|<|\$\{|example|dummy)/i.test(value)) return;
        if (/^[.\s*]+$/.test(value)) return;
        if (/^[A-Z_]{3,}$/.test(value)) return; // ENV_VAR_NAME 形态不算泄露
        hits.push({
          line: i + 1,
          snippet: value ? rawLine.trim().replace(value, '********') : rawLine.trim(),
          message: '检测到疑似硬编码凭证',
        });
      });
      return hits;
    },
  },
  {
    id: 'SEC-004',
    title: 'SQL 语句字符串拼接',
    severity: 'critical',
    langs: ['js', 'py', 'java', 'any'],
    rationale: '拼接式 SQL 是注入漏洞的标准形态。',
    defaultSuggestion: '改用参数化查询（占位符 / PreparedStatement / ORM 绑定变量）。',
    check: (ctx) => {
      const hits: RuleHit[] = [];
      const sqlKeyword = /\b(SELECT\s+[\s\S]*?\bFROM\b|INSERT\s+INTO\b|DELETE\s+FROM\b|UPDATE\s+\w+\s+SET\b)/i;
      const concat = /(\+\s*[A-Za-z_$]|\+\s*['"`]|['"`]\s*\+|\$\{|%s|\.format\s*\()/;
      const execFn = /\b(query|execute|exec|rawQuery|prepare|execSql)\s*\(/i;

      ctx.raw.forEach((line, i) => {
        const isSqlText = sqlKeyword.test(line);
        const isSqlApi = execFn.test(line) && /(['"`][^'"`]*(SELECT|INSERT|UPDATE|DELETE)[^'"`]*['"`])/i.test(line);
        if (!isSqlText && !isSqlApi) return;
        if (!concat.test(line)) return;
        hits.push({ line: i + 1, snippet: line.trim() });
      });
      return hits;
    },
  },
  {
    id: 'SEC-005',
    title: '弱哈希算法',
    severity: 'medium',
    langs: ['js', 'py', 'java', 'any'],
    rationale: 'MD5/SHA1 已可被低成本碰撞，用于口令或签名不安全。',
    defaultSuggestion: '口令用 bcrypt/scrypt/argon2；完整性校验用 SHA-256 及以上。',
    check: (ctx) => {
      const hits: RuleHit[] = [];
      ctx.masked.forEach((line, i) => {
        if (/createHash\s*\(\s*['"](md5|sha1)['"]/i.test(line)) hits.push({ line: i + 1 });
        else if (/hashlib\.(md5|sha1)\s*\(/i.test(line)) hits.push({ line: i + 1 });
        else if (/MessageDigest\.getInstance\s*\(\s*["'](MD5|SHA-?1)["']/i.test(line)) hits.push({ line: i + 1 });
        else if (/\b(md5|sha1)\s*\(/i.test(line) && !/\b(def|function|class)\b/.test(line)) hits.push({ line: i + 1 });
      });
      return hits;
    },
  },
  {
    id: 'SEC-006',
    title: 'shell 命令拼接外部输入',
    severity: 'critical',
    langs: ['js'],
    rationale: 'child_process 拼接字符串会成为命令注入的执行点。',
    defaultSuggestion: '使用 execFile/spawn 且传数组参数，或对输入做严格白名单校验。',
    check: (ctx) => {
      const hits: RuleHit[] = [];
      ctx.masked.forEach((line, i) => {
        if (/\bexec\s*\(\s*[`'"]/.test(line) && /(\$\{|\+\s*\w)/.test(line)) hits.push({ line: i + 1 });
        if (/\bexecSync\s*\(\s*[`'"]/.test(line) && /(\$\{|\+\s*\w)/.test(line)) hits.push({ line: i + 1 });
      });
      return hits;
    },
  },
  {
    id: 'SEC-007',
    title: 'CORS 通配符 + 凭证',
    severity: 'high',
    langs: ['js', 'any'],
    rationale: 'Access-Control-Allow-Origin: * 与 Credentials 同时开启时浏览器会拒绝，且放开任意源等同于取消同源保护。',
    defaultSuggestion: '改为对请求 Origin 做白名单校验后再回写。',
    regex: /['"]Access-Control-Allow-Origin['"]\s*,\s*['"]\*/,
  },
  {
    id: 'SEC-008',
    title: '关闭证书校验',
    severity: 'critical',
    langs: ['js', 'py'],
    rationale: '禁用 TLS 校验后中间人可任意篡改流量。',
    defaultSuggestion: '移除该配置；自签证书场景请显式导入可信 CA。',
    check: (ctx) => {
      const hits: RuleHit[] = [];
      ctx.masked.forEach((line, i) => {
        // 保留短字符串后，"0"/"false" 依然可见，因此这里能直接判定
        if (/NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*["']0["']/.test(line)) hits.push({ line: i + 1 });
        else if (/\brejectUnauthorized\s*:\s*false\b/.test(line)) hits.push({ line: i + 1 });
        else if (/\bverify\s*=\s*False\b/.test(line)) hits.push({ line: i + 1 });
        else if (/\bstrictSSL\s*:\s*false\b/.test(line)) hits.push({ line: i + 1 });
      });
      return hits;
    },
  },

  /* ===== 可维护性 ===== */
  {
    id: 'MNT-001',
    title: '使用 var 声明',
    severity: 'low',
    langs: ['js'],
    rationale: 'var 的函数级作用域与变量提升会带来难以察觉的作用域泄漏。',
    defaultSuggestion: '改用 const（默认）或 let（需重新赋值时）。',
    regex: /\bvar\s+[A-Za-z_$]/,
    ignore: (ctx, hit) => /\bvar\s+\w+\s*=\s*require\b/.test(ctx.masked[hit.line - 1] ?? ''),
  },
  {
    id: 'MNT-002',
    title: '使用 == 松散比较',
    severity: 'medium',
    langs: ['js'],
    rationale: '隐式类型转换会产出反直觉结果（如 [] == false 为 true）。',
    defaultSuggestion: '统一使用 === / !==；确需宽松比较时显式转换类型。',
    check: (ctx) => {
      const hits: RuleHit[] = [];
      ctx.masked.forEach((line, i) => {
        if (/([^=!<>])(==|!=)([^=])/.test(line) && !/(===|!==)/.test(line)) hits.push({ line: i + 1 });
        else if (/(==|!=)/.test(line) && !/(===|!==|=>)/.test(line) && !/\b(if|while)\s*\([^)]*[=!]==?/.test(line)) {
          hits.push({ line: i + 1 });
        }
      });
      return hits;
    },
  },
  {
    id: 'MNT-003',
    title: 'TypeScript 中滥用 any',
    severity: 'low',
    langs: ['js'],
    rationale: 'any 会关闭类型检查，问题将被推迟到运行时暴露。',
    defaultSuggestion: '使用 unknown + 类型收窄，或定义精确接口。',
    check: (ctx) => {
      if (!/\.tsx?$/.test(ctx.file)) return [];
      const hits: RuleHit[] = [];
      ctx.masked.forEach((line, i) => {
        if (/:\s*any\b/.test(line) || /<any>/.test(line) || /\bas\s+any\b/.test(line)) hits.push({ line: i + 1 });
      });
      return hits;
    },
    ignore: (ctx) => isTestFile(ctx.file),
  },
  {
    id: 'MNT-004',
    title: '魔法数字',
    severity: 'low',
    langs: ['js', 'py', 'java'],
    rationale: '无名字面量难以理解其业务含义，修改时容易遗漏。',
    defaultSuggestion: '提取为具名常量并附注来源。',
    check: (ctx) => {
      const hits: RuleHit[] = [];
      const allow = new Set(['0', '1', '2', '-1', '10', '100', '1000', '60', '24', '255', '1024', '3600', '0.5']);
      ctx.masked.forEach((line, i) => {
        const rawLine = ctx.raw[i] ?? '';
        const maskedLine = ctx.masked[i] ?? '';
        if (/^\s*(const|static\s+final|final)\b/.test(maskedLine)) return;
        if (/(color|rgba?|px|ms|timeout|delay|port|size|width|height|length)/i.test(rawLine)) return;
        const nums = maskedLine.match(/(?<![\w.$])\d{3,}(?:\.\d+)?/g) ?? [];
        for (const n of nums) {
          if (allow.has(n)) continue;
          hits.push({ line: i + 1, message: `发现魔法数字 ${n}`, snippet: rawLine.trim() });
          break;
        }
      });
      return hits;
    },
    ignore: (ctx) => isTestFile(ctx.file),
  },
  {
    id: 'MNT-005',
    title: '遗留 console 日志',
    severity: 'low',
    langs: ['js'],
    rationale: '直接输出到标准输出会污染 CLI 输出，且无法按级别关闭。',
    defaultSuggestion: '替换为项目统一 logger；测试中的输出可忽略。',
    regex: /\bconsole\.(log|debug|info|warn|error|trace)\s*\(/,
    ignore: (ctx, hit) => {
      const line = ctx.raw[hit.line - 1] ?? '';
      if (/\beslint-disable\b|@ts-ignore/.test(line)) return true;
      if (/^\s*\/\//.test(line)) return true;
      return isTestFile(ctx.file) || /scripts?[\\/]/.test(ctx.file);
    },
  },
  {
    id: 'MNT-006',
    title: 'TODO / FIXME 未闭环',
    severity: 'low',
    langs: ['js', 'py', 'java', 'any'],
    rationale: '长期悬空的 TODO 会让技术债失去上下文，无法追踪责任人。',
    defaultSuggestion: '补上责任人与关联任务号，或直接删除。',
    check: (ctx) => {
      const hits: RuleHit[] = [];
      ctx.raw.forEach((line, i) => {
        if (/(TODO|FIXME|XXX|HACK)\b/.test(line)) hits.push({ line: i + 1, snippet: line.trim() });
      });
      return hits;
    },
  },
  {
    id: 'MNT-007',
    title: '未使用的可疑命名导出占位',
    severity: 'low',
    langs: ['js', 'py'],
    rationale: '空的实现体或只抛未实现错误的函数会在调用时才暴露问题。',
    defaultSuggestion: '补齐实现或标记为 @deprecated 并给出替代方案。',
    regex: /throw\s+new\s+Error\s*\(\s*['"](not\s+implemented|TODO|待实现)/i,
  },

  /* ===== 复杂度 ===== */
  {
    id: 'CPX-001',
    title: '函数过长',
    severity: 'medium',
    langs: ['js', 'py', 'java'],
    rationale: '超过 80 行的函数通常混合了多个抽象层级，难以测试与复用。',
    defaultSuggestion: '按「准备数据 / 核心逻辑 / 输出结果」拆分，单一函数控制在 50 行内。',
    check: (ctx) => {
      if (ctx.lang !== 'js') {
        // Python / Java：用缩进块近似估计
        const hits: RuleHit[] = [];
        const lines = ctx.masked;
        for (let i = 0; i < lines.length; i += 1) {
          const m = /^(\s*)(?:def|public|private|protected|static)\b[^\n]*\{?\s*$/.exec(lines[i] ?? '');
          if (!m) continue;
          const indent = (m[1] ?? '').length;
          let end = i + 1;
          while (end < lines.length) {
            const l = lines[end] ?? '';
            if (l.trim() === '') {
              end += 1;
              continue;
            }
            const cur = l.length - l.trimStart().length;
            if (cur <= indent) break;
            end += 1;
          }
          const len = end - i;
          if (len > 80) hits.push({ line: i + 1, message: `函数体约 ${len} 行，超过 80 行阈值` });
          i = end - 1;
        }
        return hits;
      }

      return findJsFunctionBlocks(ctx.masked)
        .filter((b) => b.end - b.start + 1 > 80)
        .map((b) => ({
          line: b.start,
          message: `函数 ${b.name} 约 ${b.end - b.start + 1} 行，超过 80 行阈值`,
        }));
    },
  },
  {
    id: 'CPX-002',
    title: '嵌套层级过深',
    severity: 'medium',
    langs: ['js', 'java'],
    rationale: '嵌套超过 4 层时，人脑需要维护的路径数急剧上升，遗漏分支的概率大幅提高。',
    defaultSuggestion: '用卫语句提前 return，或把内层逻辑提取为独立函数。',
    check: (ctx) => {
      const hits: RuleHit[] = [];
      const depths = computeDepths(ctx.masked);
      let reported = false;
      depths.forEach((d, i) => {
        if (d >= 6 && !reported) {
          hits.push({ line: i + 1, message: `当前行嵌套深度约 ${d} 层` });
          reported = true;
        } else if (d < 4) {
          reported = false;
        }
      });
      return hits;
    },
  },
  {
    id: 'CPX-003',
    title: '参数列表过长',
    severity: 'low',
    langs: ['js', 'py', 'java'],
    rationale: '参数超过 5 个通常意味着该函数承担了过多职责，调用方也容易传错顺序。',
    defaultSuggestion: '聚合为配置对象，或拆分为多个职责单一的函数。',
    check: (ctx) => {
      const hits: RuleHit[] = [];
      ctx.masked.forEach((line, i) => {
        const m = /(?:function\s+\w+|(?:def|public|private|protected|static)\s+\w+|\w+\s*=)\s*(?:async\s*)?\(([^)]*)\)/.exec(line);
        if (!m) return;
        const params = (m[1] ?? '').split(',').filter((p) => p.trim());
        if (params.length > 5) hits.push({ line: i + 1, message: `发现 ${params.length} 个参数` });
      });
      return hits;
    },
  },

  /* ===== 性能 ===== */
  {
    id: 'PERF-001',
    title: '循环内查询 DOM',
    severity: 'medium',
    langs: ['js'],
    rationale: 'DOM 查询与布局读取在循环内会触发反复重排，复杂度从 O(n) 恶化到 O(n·m)。',
    defaultSuggestion: '把查询结果提到循环外缓存，批量更新后再写回。',
    check: (ctx) => {
      const hits: RuleHit[] = [];
      ctx.masked.forEach((line, i) => {
        if (/\b(for|while)\b/.test(line)) {
          const body = [ctx.masked[i + 1] ?? '', ctx.masked[i + 2] ?? ''].join(' ');
          if (/document\.(querySelector|getElementById|getElementsBy)|\.(querySelector|querySelectorAll)\s*\(/.test(body)) {
            hits.push({ line: i + 1 });
          }
        }
      });
      return hits;
    },
  },
  {
    id: 'PERF-002',
    title: '循环内创建正则表达式',
    severity: 'medium',
    langs: ['js'],
    rationale: '正则编译开销不小，循环内反复 new RegExp 会显著拖慢热路径。',
    defaultSuggestion: '把正则字面量提到模块顶层常量。',
    check: (ctx) => {
      const hits: RuleHit[] = [];
      ctx.masked.forEach((line, i) => {
        if (!/\b(for|while)\b/.test(line)) return;
        const body = [ctx.masked[i + 1] ?? '', ctx.masked[i + 2] ?? ''].join(' ');
        if (/new\s+RegExp\s*\(/.test(body)) hits.push({ line: i + 1 });
      });
      return hits;
    },
  },
  {
    id: 'PERF-003',
    title: '嵌套循环线性查找',
    severity: 'low',
    langs: ['js', 'py', 'java'],
    rationale: '双层循环内做 includes/indexOf 查找会把复杂度推到 O(n²)。',
    defaultSuggestion: '预先构建 Set / Map 索引，把查找降到 O(1)。',
    check: (ctx) => {
      const hits: RuleHit[] = [];
      ctx.masked.forEach((line, i) => {
        if (!/\b(for|while)\b/.test(line)) return;
        const body = [ctx.masked[i + 1] ?? '', ctx.masked[i + 2] ?? '', ctx.masked[i + 3] ?? ''].join(' ');
        if (/\.(includes|indexOf)\s*\(|\bin\s+\w+/.test(body) && /\b(for|while)\b/.test(body)) hits.push({ line: i + 1 });
      });
      return hits;
    },
  },
];

/* ------------------------------------------------------------------ *
 * 分析入口
 * ------------------------------------------------------------------ */

export interface AnalyzeOptions {
  /** 相对展示路径 */
  file: string;
  absPath: string;
  source: string;
  /** 规则白名单，空表示全部 */
  rules?: string[];
}

export function analyzeSource(opts: AnalyzeOptions): Finding[] {
  const { lines: masked, rawLines: raw } = shieldCommentsAndStrings(opts.source);
  const lang = langOf(opts.file);
  const ctx: RuleContext = {
    masked,
    raw,
    source: opts.source,
    absPath: opts.absPath,
    file: opts.file,
    lang,
  };

  const findings: Finding[] = [];
  const filter = opts.rules && opts.rules.length > 0 ? new Set(opts.rules) : null;

  for (const rule of RULES) {
    if (filter && !filter.has(rule.id)) continue;
    if (!rule.langs.includes('any') && !rule.langs.includes(lang)) continue;

    let hits: RuleHit[] = [];
    try {
      if (rule.check) hits = rule.check(ctx);
      else if (rule.regex) {
        hits = [];
        masked.forEach((line, i) => {
          rule.regex?.lastIndex !== undefined && (rule.regex.lastIndex = 0);
          if (rule.regex?.test(line)) hits.push({ line: i + 1 });
        });
      }
    } catch {
      // 单条规则异常不应中断整次扫描
      continue;
    }

    for (const hit of hits) {
      if (rule.ignore?.(ctx, hit)) continue;
      findings.push({
        ruleId: rule.id,
        title: rule.title,
        severity: hit.severity ?? rule.severity,
        file: opts.file,
        line: hit.line,
        column: hit.column ?? 1,
        snippet: hit.snippet ?? snippetOf(raw, hit.line),
        message: hit.message ?? `${rule.title}（${rule.id}）：${rule.rationale}`,
        suggestion: hit.suggestion ?? rule.defaultSuggestion,
      });
    }
  }

  return sortBySeverity(dedupe(findings));
}

function dedupe(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  const out: Finding[] = [];
  for (const f of findings) {
    const key = `${f.ruleId}|${f.file}|${f.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

export const SEVERITY_WEIGHT: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

/** 严重度优先的排序：critical → high → medium → low，同级按文件与行号。 */
export function sortBySeverity(findings: Finding[]): Finding[] {
  return [...findings].sort(
    (a, b) =>
      SEVERITY_WEIGHT[a.severity] - SEVERITY_WEIGHT[b.severity] ||
      a.file.localeCompare(b.file) ||
      a.line - b.line ||
      a.ruleId.localeCompare(b.ruleId),
  );
}

/* --------------------------- 目录级扫描 --------------------------- */

export interface ScanOptions {
  target: string;
  workdir: string;
  /** 仅扫描这些后缀（不含点），空表示全部源码 */
  extensions?: string[];
  /** 最低严重度（含） */
  minSeverity?: Severity;
  /** 规则白名单 */
  rules?: string[];
  maxFiles?: number;
}

export function scanPath(opts: ScanOptions): ScanReport {
  const started = Date.now();
  const abs = path.isAbsolute(opts.target) ? opts.target : path.resolve(opts.workdir, opts.target);

  let files: string[] = [];
  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch {
    throw new Error(`扫描目标不存在：${abs}`);
  }

  if (stat.isFile()) files = [abs];
  else files = walkSourceFiles(abs, { maxFiles: opts.maxFiles ?? 800 });

  if (opts.extensions && opts.extensions.length > 0) {
    const set = new Set(opts.extensions.map((e) => (e.startsWith('.') ? e : `.${e}`).toLowerCase()));
    files = files.filter((f) => set.has(path.extname(f).toLowerCase()));
  }
  files = files.filter((f) => isSourceLike(f) && !shouldIgnoreFile(path.basename(f)) && !shouldIgnoreDir(path.basename(path.dirname(f))));

  const all: Finding[] = [];
  let totalLines = 0;

  for (const file of files) {
    let text: string;
    try {
      text = readTextFileSafe(file).text;
    } catch {
      continue;
    }
    totalLines += text.split('\n').length;
    const rel = displayPath(file, opts.workdir);
    all.push(...analyzeSource({ file: rel, absPath: file, source: text, rules: opts.rules }));
  }

  const minWeight = SEVERITY_WEIGHT[opts.minSeverity ?? 'low'];
  const filtered = all.filter((f) => SEVERITY_WEIGHT[f.severity] <= minWeight);

  const bySeverity: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const f of filtered) bySeverity[f.severity] += 1;

  return {
    files: files.map((f) => displayPath(f, opts.workdir)),
    findings: sortBySeverity(filtered),
    stats: { files: files.length, lines: totalLines, bySeverity },
    ms: Date.now() - started,
  };
}
/** 把报告渲染成适合注入 Prompt 的紧凑 Markdown。 */
export function renderReportForPrompt(report: ScanReport, limit = 80): string {
  if (report.files.length === 0) return '（未发现可分析的源码文件）';
  const lines: string[] = [];
  lines.push(`扫描范围：${report.stats.files} 个文件 / ${report.stats.lines} 行，耗时 ${report.ms}ms`);
  lines.push(
    `问题统计：critical=${report.stats.bySeverity.critical} high=${report.stats.bySeverity.high} ` +
      `medium=${report.stats.bySeverity.medium} low=${report.stats.bySeverity.low}`,
  );
  lines.push('');
  if (report.findings.length === 0) {
    lines.push('规则引擎未发现明显问题。');
    return lines.join('\n');
  }
  lines.push('| # | 严重度 | 规则 | 位置 | 代码 | 说明 |');
  lines.push('|---|--------|------|------|------|------|');
  report.findings.slice(0, limit).forEach((f, i) => {
    const loc = `${f.file}:${f.line}`;
    const code = f.snippet.replace(/\|/g, '\\|').slice(0, 90);
    const msg = f.message.replace(/\|/g, '\\|').slice(0, 110);
    lines.push(`| ${i + 1} | ${f.severity} | ${f.ruleId} | ${loc} | \`${code}\` | ${msg} |`);
  });
  if (report.findings.length > limit) lines.push(`\n（仅展示前 ${limit} 条，共 ${report.findings.length} 条）`);
  return lines.join('\n');
}

/** 把报告渲染成人类可读的终端文本。 */
export function renderReportText(report: ScanReport): string {
  const out: string[] = [];
  out.push(`扫描：${report.stats.files} 个文件 / ${report.stats.lines} 行（耗时 ${report.ms}ms）`);
  out.push(
    `统计：严重 ${report.stats.bySeverity.critical} · 高 ${report.stats.bySeverity.high} · ` +
      `中 ${report.stats.bySeverity.medium} · 低 ${report.stats.bySeverity.low}`,
  );
  if (report.findings.length === 0) {
    out.push('未发现问题。');
    return out.join('\n');
  }
  out.push('');
  for (const f of report.findings) {
    out.push(`${[f.severity.toUpperCase()].join('')} ${f.file}:${f.line} [${f.ruleId}] ${f.message}`);
    if (f.snippet) out.push(`    ${f.snippet}`);
    out.push(`    → ${f.suggestion}`);
  }
  return out.join('\n');
}

export function rulesCatalog(): string {
  return sortRulesBySeverity(RULES)
    .map((r) => `${r.id}  [${r.severity.padEnd(8)}]  ${r.title}  —  ${r.rationale}`)
    .join('\n');
}

/** 规则清单按严重度排序，便于在文档与 CLI 里优先看到高危项。 */
export function sortRulesBySeverity(rules: Rule[]): Rule[] {
  return [...rules].sort((a, b) => SEVERITY_WEIGHT[a.severity] - SEVERITY_WEIGHT[b.severity] || a.id.localeCompare(b.id));
}
