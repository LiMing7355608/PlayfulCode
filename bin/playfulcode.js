#!/usr/bin/env node
/**
 * PlayfulCode 可执行入口。
 *
 * 该脚本既可能从源码树运行（<root>/bin/pleyfulcode.js），
 * 也可能因为构建拷贝而从 <root>/dist/bin/ 运行，
 * 因此这里按候选列表依次探测编译产物。
 */

'use strict';

const path = require('node:path');
const fs = require('node:fs');

const candidates = [
  path.join(__dirname, '..', 'dist', 'main.js'), // 源码树运行
  path.join(__dirname, '..', 'main.js'), // dist/bin 运行
];

const entry = candidates.find((p) => fs.existsSync(p));

if (!entry) {
  process.stderr.write(
    '\n[PlayfulCode] 未找到编译产物，请先构建：\n\n' +
      '    npm install\n    npm run build\n\n' +
      '然后再执行本命令（或直接使用 node dist/main.js）。\n\n',
  );
  process.exit(1);
}

require(entry);
