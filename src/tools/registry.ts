/**
 * 工具注册表。
 *
 * 采用「注册表 + 契约」模式而非散落的 if-else：
 * - Agent 只认识 ToolRegistry 接口，新增工具不需要改动 Agent；
 * - 工具集可以按场景裁剪（审查场景给只读工具，改码场景再放开写工具），
 *   这是「最小权限」在架构层面的落地方式。
 */

import type { ToolSpec } from '../core/types';
import { PlayfulError } from '../core/errors';
import { applyPatchTool } from './apply-patch';
import { listFilesTool } from './list-files';
import { readFileTool } from './read-file';
import { readManyFilesTool } from './read-many-files';
import { runCodeTool } from './run-code';
import { scanCodeTool } from './scan-code';
import { searchCodeTool } from './search-code';
import { writeFileTool } from './write-file';

export class ToolRegistry {
  private readonly tools = new Map<string, ToolSpec<never>>();

  constructor(initial: ToolSpec<never>[] = []) {
    for (const t of initial) this.register(t);
  }

  register<T extends object>(tool: ToolSpec<T>): this {
    if (this.tools.has(tool.name)) {
      throw new PlayfulError('CONFIG_ERROR', `工具名重复注册：${tool.name}`);
    }
    this.tools.set(tool.name, tool as unknown as ToolSpec<never>);
    return this;
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get(name: string): ToolSpec<never> {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new PlayfulError('TOOL_NOT_FOUND', `未知工具：${name}`, {
        hint: `当前可用工具：${this.names().join('、')}`,
      });
    }
    return tool;
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  list(): ToolSpec<never>[] {
    return [...this.tools.values()];
  }

  size(): number {
    return this.tools.size;
  }

  /** 按名称裁剪出一个子集（最小权限）。 */
  subset(names: string[]): ToolRegistry {
    const next = new ToolRegistry();
    for (const n of names) next.register(this.get(n) as ToolSpec<never>);
    return next;
  }

  /** 排除若干工具。 */
  without(names: string[]): ToolRegistry {
    const drop = new Set(names);
    return new ToolRegistry(this.list().filter((t) => !drop.has(t.name)) as ToolSpec<never>[]);
  }
}

/** 全部内置工具。 */
export function createDefaultRegistry(): ToolRegistry {
  return new ToolRegistry([
    listFilesTool as unknown as ToolSpec<never>,
    readFileTool as unknown as ToolSpec<never>,
    readManyFilesTool as unknown as ToolSpec<never>,
    searchCodeTool as unknown as ToolSpec<never>,
    scanCodeTool as unknown as ToolSpec<never>,
    runCodeTool as unknown as ToolSpec<never>,
    writeFileTool as unknown as ToolSpec<never>,
    applyPatchTool as unknown as ToolSpec<never>,
  ]);
}

/** 只读审查工具集（不含任何写盘能力）。 */
export function createReviewRegistry(): ToolRegistry {
  return new ToolRegistry([
    listFilesTool as unknown as ToolSpec<never>,
    readFileTool as unknown as ToolSpec<never>,
    readManyFilesTool as unknown as ToolSpec<never>,
    searchCodeTool as unknown as ToolSpec<never>,
    scanCodeTool as unknown as ToolSpec<never>,
    runCodeTool as unknown as ToolSpec<never>,
  ]);
}

export {
  applyPatchTool,
  listFilesTool,
  readFileTool,
  readManyFilesTool,
  runCodeTool,
  scanCodeTool,
  searchCodeTool,
  writeFileTool,
};
