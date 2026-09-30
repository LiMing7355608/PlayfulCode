/**
 * 演示用「问题代码」——教学样本，请勿模仿。
 *
 * 这个文件的作用是让静态分析引擎有真实的命中样本，
 * 也让 Agent 在演示时能展示「规则发现有嫌疑 → 读上下文确认 → 给出结论」的完整链路。
 * 每条规则前都标注了对应的规则编号，方便与 README 中的规则表对照。
 */

/* eslint-disable */
// @ts-nocheck

// COR-002（空 catch 吞异常）
export function parseConfig(text) {
  try {
    return JSON.parse(text);
  } catch (e) {}
}

// SEC-003（硬编码凭证）
export function checkPassword(input) {
  const adminPassword = 'admin@12345';
  return input === adminPassword;
}

// MNT-002（松散比较）
export function isEnabled(flag) {
  if (flag == true) {
    return 'enabled';
  }
  return 'disabled';
}

// COR-003（浮点等值比较）
export function isExactAmount(total) {
  if (total === 0.3) {
    return true;
  }
  return false;
}

// MNT-001 / COR-004（var 声明与循环闭包捕获）
export function buildHandlers(items) {
  var handlers = [];
  for (var i = 0; i < items.length; i++) {
    handlers.push(function () {
      return items[i];
    });
  }
  return handlers;
}

// SEC-006（命令拼接）
export function runUserCommand(name) {
  const { exec } = require('node:child_process');
  return exec('ls -la ' + name);
}

// PERF-001（循环内查询 DOM）
export function markRows(rows) {
  for (let i = 0; i < rows.length; i++) {
    const node = document.querySelector('#row-' + i);
    if (node) node.textContent = String(rows[i]);
  }
}

// MNT-005（遗留调试输出）
export function sumAll(list) {
  console.log('sumAll called with', list.length, 'items');
  return list.reduce((a, b) => a + b, 0);
}

// MNT-006（未闭环的待办标记，见函数体下方注释）
export function clamp(value, min, max) {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}
// 边界取值还没想清楚，先这样

// CPX-003（参数列表过长）
export function createReport(title, author, date, version, tags, extra, options) {
  return { title, author, date, version, tags, extra, options };
}
