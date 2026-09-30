/**
 * 入参校验。
 *
 * 模型给的参数永远不可信任：可能是字符串型的数字、缺字段、多字段、类型错乱。
 * 这里做一层「宽容但不含糊」的校验 —— 能自动修正的修正（"3" → 3），
 * 修不了的明确报错并把错误信息回灌给模型，让它自我纠正。
 */

import { PlayfulError } from '../core/errors';
import type { JsonSchema } from '../core/types';

export function validateArgs<T extends object>(tool: string, args: unknown, schema: JsonSchema): T {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    throw new PlayfulError('TOOL_BAD_ARGS', `${tool} 的入参必须是 JSON 对象，实际收到：${describe(args)}`);
  }

  const input = { ...(args as Record<string, unknown>) };
  const props = schema.properties ?? {};
  const out: Record<string, unknown> = {};

  for (const key of schema.required ?? []) {
    const v = input[key];
    if (v === undefined || v === null || v === '') {
      throw new PlayfulError('TOOL_BAD_ARGS', `${tool} 缺少必填参数 "${key}"`, {
        hint: `必填参数：${(schema.required ?? []).join(', ')}`,
      });
    }
  }

  for (const [key, sub] of Object.entries(props)) {
    if (input[key] === undefined || input[key] === null) {
      if (sub.default !== undefined) out[key] = sub.default;
      continue;
    }
    out[key] = coerce(tool, key, input[key], sub);
  }

  // 保留 schema 未声明但模型传了的字段，交给工具自行忽略；这样便于未来扩展
  for (const [key, v] of Object.entries(input)) {
    if (!(key in props) && v !== undefined) out[key] = v;
  }

  return out as T;
}

function coerce(tool: string, key: string, value: unknown, schema: JsonSchema): unknown {
  switch (schema.type) {
    case 'string': {
      if (typeof value === 'string') return checkEnum(tool, key, value, schema);
      if (typeof value === 'number' || typeof value === 'boolean') return String(value);
      throw badType(tool, key, schema.type, value);
    }
    case 'number':
    case 'integer': {
      const raw: unknown = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
      if (typeof raw !== 'number' || !Number.isFinite(raw)) throw badType(tool, key, schema.type, value);
      let n: number = raw;
      if (schema.type === 'integer') n = Math.trunc(n);
      if (schema.minimum !== undefined && n < schema.minimum) {
        throw new PlayfulError('TOOL_BAD_ARGS', `${tool} 的 ${key} 必须 >= ${schema.minimum}，实际 ${n}`);
      }
      if (schema.maximum !== undefined && n > schema.maximum) {
        throw new PlayfulError('TOOL_BAD_ARGS', `${tool} 的 ${key} 必须 <= ${schema.maximum}，实际 ${n}`);
      }
      return n;
    }
    case 'boolean': {
      if (typeof value === 'boolean') return value;
      if (['true', '1', 'yes'].includes(String(value).toLowerCase())) return true;
      if (['false', '0', 'no'].includes(String(value).toLowerCase())) return false;
      throw badType(tool, key, 'boolean', value);
    }
    case 'array': {
      if (!Array.isArray(value)) throw badType(tool, key, 'array', value);
      if (schema.items) return value.map((v) => coerce(tool, `${key}[]`, v, schema.items as JsonSchema));
      return value;
    }
    case 'object': {
      if (typeof value !== 'object' || Array.isArray(value)) throw badType(tool, key, 'object', value);
      return value;
    }
    default:
      return value;
  }
}

function checkEnum(tool: string, key: string, value: string, schema: JsonSchema): string {
  if (schema.enum && !schema.enum.includes(value)) {
    throw new PlayfulError('TOOL_BAD_ARGS', `${tool} 的 ${key} 取值非法：${value}`, {
      hint: `允许的取值：${schema.enum.join(' | ')}`,
    });
  }
  return value;
}

function badType(tool: string, key: string, expected: string, actual: unknown): PlayfulError {
  return new PlayfulError('TOOL_BAD_ARGS', `${tool} 的 ${key} 期望 ${expected}，实际收到 ${describe(actual)}`);
}

export function describe(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return `array(${v.length})`;
  return typeof v === 'object' ? 'object' : `${typeof v}:${String(v).slice(0, 40)}`;
}
