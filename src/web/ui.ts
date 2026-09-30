/**
 * Web 界面资源加载。
 *
 * 页面本身是 src/web/public/index.html（纯静态、可直接用浏览器打开查看结构），
 * 这里负责按 dist/ 与源码树两种位置查找，并提供一个降级页面，
 * 保证即使静态文件丢失，Web 界面也不会变成一片空白。
 */

import fs from 'node:fs';
import path from 'node:path';

const CANDIDATE_PATHS = [
  // 编译后：dist/web/public/index.html（由 npm run build 拷贝）
  path.join(__dirname, 'public', 'index.html'),
  // 个别情况下 __dirname 指向 src/web
  path.join(__dirname, '..', 'web', 'public', 'index.html'),
  // 开发期直接运行源码目录
  path.join(__dirname, '..', '..', 'src', 'web', 'public', 'index.html'),
];

let cached: string | null = null;

export function loadIndexHtml(): string {
  if (cached) return cached;
  for (const p of CANDIDATE_PATHS) {
    try {
      if (fs.existsSync(p)) {
        cached = fs.readFileSync(p, 'utf8');
        return cached;
      }
    } catch {
      /* 继续尝试下一个候选路径 */
    }
  }
  cached = FALLBACK_HTML;
  return cached;
}

const FALLBACK_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>PlayfulCode</title>
<style>body{background:#0d1117;color:#e6edf3;font-family:system-ui,"Microsoft YaHei";padding:40px;line-height:1.7}
code{background:#ffffff14;padding:2px 6px;border-radius:4px}</style></head>
<body>
<h1>PlayfulCode Web 界面</h1>
<p>未能加载静态页面文件 <code>src/web/public/index.html</code>。</p>
<p>请重新执行 <code>npm run build</code>，或直接使用命令行：</p>
<pre>node dist/cli.js chat
node dist/cli.js review src --out report.md
node dist/cli.js scan src</pre>
</body></html>`;

export const __testing = { CANDIDATE_PATHS, FALLBACK_HTML };
