/**
 * 可执行入口。
 *
 * 单独出一个文件而不是把逻辑塞进 cli/cli.ts，是为了让
 * `node dist/main.js`（最直白的调用方式）与 `npx playfulcode` 走同一条路径。
 */

import { main } from './cli/cli';
import { createLogger } from './core/logger';

const log = createLogger('main');

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    const err = e instanceof Error ? e : new Error(String(e));
    log.error(`未捕获异常：${err.stack ?? err.message}`);
    process.exitCode = 1;
  },
);
