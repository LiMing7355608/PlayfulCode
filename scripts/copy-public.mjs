/**
 * 构建辅助脚本：把 Web 静态资源与可执行入口拷贝到 dist。
 *
 * 之所以用脚本而不是 shell 命令（cp / xcopy），是为了让 Windows、macOS、Linux
 * 上的 `npm run build` 行为完全一致 —— 助教无论在什么系统上都能一次跑通。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function copyDir(from, to) {
  if (!fs.existsSync(from)) {
    console.error(`[build] 源目录不存在：${from}`);
    return 0;
  }
  fs.mkdirSync(to, { recursive: true });
  let count = 0;
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) count += copyDir(src, dst);
    else {
      fs.copyFileSync(src, dst);
      count += 1;
    }
  }
  return count;
}

const copiedWeb = copyDir(path.join(root, 'src', 'web', 'public'), path.join(root, 'dist', 'web', 'public'));
console.log(`[build] 已拷贝 Web 静态资源 ${copiedWeb} 个文件 → dist/web/public`);

const binSrc = path.join(root, 'bin', 'playfulcode.js');
const binDst = path.join(root, 'dist', 'bin', 'playfulcode.js');
if (fs.existsSync(binSrc)) {
  fs.mkdirSync(path.dirname(binDst), { recursive: true });
  fs.copyFileSync(binSrc, binDst);
  console.log('[build] 已拷贝可执行入口 → dist/bin/playfulcode.js');
}