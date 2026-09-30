# PlayfulCode

一个能自己读代码、自己跑代码、最后给你结论的**代码助手**。零运行时依赖。

```bash
npm install && npm run build

npm start -- scan src/demo              # 静态分析，不需要 API Key
npm start -- review src/demo --demo     # 完整 Agent 循环演示
npm run web                             # Web 界面
```

要接真实模型，在根目录建 `.env`：

```ini
PC_PROVIDER=deepseek
PC_API_KEY=sk-你的密钥
```

## 它能做什么

| 能力 | 命令 |
| --- | --- |
| 审查 —— 找缺陷、给带行号的结论与改法 | `review <目标>` |
| 解释 —— 讲清设计与数据流 | `chat` |
| 生成测试 —— 写完还实际跑一遍 | `test <目标>` |
| 改代码 —— 精确补丁，改前看 diff | `chat` |

三种界面：CLI（9 个子命令）、Web（多对话 + 系统文件夹选择 + 授权确认）、库（`require('playful-code')`）。

## 怎么做到的

把「找事实」和「下判断」分开：

- **找事实** —— 内置 26 条规则的静态分析引擎，输出可复现的 `文件:行号 + 代码片段`
- **下判断** —— 模型读上下文、判断真伪、评估影响、给出改法
- **要证据** —— 结论依赖运行时行为时，用 `run_code` 写最小复现脚本真的跑一遍

模型自己决定下一步看什么文件、要不要搜调用点、要不要跑验证 —— 这个循环是它与「一问一答」的分界线。

## 结构

```
src/
├── core/     类型 / 错误 / 配置 / 日志
├── llm/      LLM 接入（原生 function calling + 文本协议降级）
├── tools/    8 个工具 + 26 条规则的静态分析引擎
├── agent/    Agent 循环状态机 + 上下文记忆
├── cli/      命令行界面
└── web/      HTTP + SSE 服务端，前端单页
```

技术栈：TypeScript（strict）、Node ≥ 18.17、**运行时零依赖**（只用 Node 内置模块）。LLM 走原生 OpenAI 兼容 API，覆盖 DeepSeek / OpenAI / Moonshot / 智谱 / 通义 / Ollama。

## 配置

全部参数见 [`.env.example`](./.env.example)。常用：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PC_PROVIDER` | `deepseek` | 服务商 |
| `PC_API_KEY` | — | 密钥 |
| `PC_MAX_STEPS` | `16` | 单次任务最多推理-工具轮次 |
| `PC_REQUIRE_APPROVAL` | `on` | 危险操作是否需人工确认 |
| `PC_WORKSPACE_ROOTS` | — | 允许工具访问的根目录 |

