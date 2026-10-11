# PlayfulCode 静态分析规则清单

规则表定义在 `src/tools/static-analysis.ts`，共 28 条。

用 `npm start -- scan --list-rules` 查看清单，或用 `npm start -- tool scan_code '{"describeRules":true}'`。

## 规则如何工作

规则跑在词法屏蔽后的文本上。屏蔽过程把注释与字符串内容替换为等长空格，但保留长度小于 10 的字符串字面量，算法名、数值、开关值都属于这一类，屏蔽掉它们会让规则失效。较长字符串保留首尾引号、清空内容，这样既能匹配"函数名加字符串参数"的调用形态，又不会把大段文本当成代码。

规则同时可见两个视图：屏蔽版用于判定，原始版用于截取代码片段。敏感信息规则在输出前把命中的密钥值替换为星号。

命中结果按规则、文件、行号去重，再按严重级别排序。

## 正确性

### COR-001 残留调试语句

`high` / js py java

检测 `debugger`、`breakpoint(`、`pdb.set_trace(`。Python 的 `print(` 单独按 `low` 报告，并跳过测试文件。

调试断点进入生产环境会中断执行或暴露内部状态。

修复：删除该语句；需要保留日志时改用项目统一的 logger 并以 debug 级别输出。

### COR-002 空 catch 块吞掉异常

`high` / js java

检测同行空块 `catch (...) {}`，或 `catch (...) {` 的下一行以 `}` 开头。Python 侧对应 `except: pass`。

捕获后不做任何处理会让故障静默，排查成本极高。

修复：至少记录日志并保留上下文；确实需要忽略时写明原因注释。

### COR-003 浮点数使用全等比较

`medium` / js

检测与浮点字面量的 `===`、`!==`、`==`、`!=`。

IEEE 754 精度误差会让等值比较随机失败。

修复：改用 `Math.abs(a - b) < Number.EPSILON` 或定点整数比较。

### COR-004 for 循环中用 var 声明计数器

`medium` / js

检测 `for ( var`。

`var` 没有块级作用域，闭包捕获时会拿到循环结束后的最终值。

修复：改用 `let` 或 `const`。

### COR-005 异步回调的数组遍历

`medium` / js

检测 `.forEach(async`。

`forEach` 不会等待异步回调，循环结束不代表异步任务完成。

修复：改用 `for...of` 顺序执行，或 `Promise.all(items.map(async ...))` 并发执行。

### COR-006 forEach 回调里使用 await

`low` / js

检测箭头函数体内含 `await` 的 `forEach`。

与 COR-005 同源的异步陷阱变体。

修复：同 COR-005。

### COR-007 可变对象作为默认参数

`medium` / py

检测 `def` 参数默认值为 `[]`、`{}` 或 `set()`。

Python 默认参数在函数定义时求值一次，跨调用共享可变对象会累积状态。

修复：默认值改为 `None`，函数体内再初始化。

## 安全

### SEC-001 eval 与 exec 执行动态字符串

`critical` / js py

检测 `eval(`、`new Function(`、Python 的 `exec(`、`os.system(`、`subprocess.*(shell=True)`。`eval` 使用负向后顾断言，避免误判 `myEval()`。

动态执行字符串是最直接的代码注入面。

修复：改用 `JSON.parse`、显式分支或映射表；`shell=True` 改用参数列表传参。

### SEC-002 innerHTML 直接插值

`high` / js

检测 `.innerHTML =`、`document.write(`、`dangerouslySetInnerHTML`。

未转义的插值会形成 XSS，在 Electron 或内嵌浏览器场景可能升级为远程代码执行。

修复：改用 `textContent`，或引入 DOMPurify 做白名单净化。

### SEC-003 硬编码密钥

`critical` / js py java any

变量名命中密钥关键词，且值形态是长字符串。排除已从环境变量读取的写法、占位符、纯点星号、全大写下划线常量。命中证据中的真实值替换为星号。

密钥进入源码仓库后即视为泄露。

修复：改从环境变量或密钥管理服务读取，并立即轮换该凭证。

### SEC-004 SQL 语句字符串拼接

`critical` / js py java any

同行同时满足"是 SQL 文本或 SQL API 调用"与"存在拼接痕迹"。

拼接式 SQL 是注入漏洞的标准形态。

修复：改用参数化查询。

### SEC-005 弱哈希算法

`medium` / js py java any

检测 `createHash("md5"|"sha1")`、`hashlib.md5|sha1(`、`MessageDigest.getInstance("MD5"|"SHA-1")`，以及独立的 `md5(` 与 `sha1(` 调用。

MD5 与 SHA1 已可被低成本碰撞。

修复：口令用 bcrypt、scrypt 或 argon2；完整性校验用 SHA-256 及以上。

### SEC-006 shell 命令拼接外部输入

`critical` / js

检测 `exec(` 与 `execSync(` 的字符串参数中出现模板插值或字符串拼接。

这是命令注入的执行点。

修复：使用 `execFile` 或 `spawn` 并传数组参数，或对输入做白名单校验。

### SEC-007 CORS 通配符

`high` / js any

检测 `Access-Control-Allow-Origin` 被设置为 `*`。

放开任意源等同于取消同源保护。

修复：对请求 Origin 做白名单校验后再回写。

### SEC-008 关闭证书校验

`critical` / js py

检测 `NODE_TLS_REJECT_UNAUTHORIZED="0"`、`rejectUnauthorized: false`、Python 的 `verify = False`、`strictSSL: false`。

禁用 TLS 校验后中间人可任意篡改流量。

修复：移除该配置；自签证书场景显式导入可信 CA。

## 可维护性

### MNT-001 使用 var 声明

`low` / js

检测 `var` 声明，排除 `var x = require(...)` 这种旧式引入写法。

函数级作用域与变量提升会带来难以察觉的作用域泄漏。

修复：改用 `const` 或 `let`。

### MNT-002 使用松散比较

`medium` / js

检测 `==` 与 `!=`，排除同行出现 `===`、`!==`、`=>` 的情况。

隐式类型转换会产出反直觉结果。

修复：统一使用全等比较；确需宽松比较时显式转换类型。

### MNT-003 滥用 any

`low` / 仅 TypeScript

检测 `: any`、`<any>`、`as any`。跳过测试文件。

`any` 会关闭类型检查，问题推迟到运行时暴露。

修复：使用 `unknown` 加类型收窄，或定义精确接口。

### MNT-004 魔法数字

`low` / js py java

检测三位及以上的数字字面量，白名单外的才报告。排除常量声明行，以及同行出现颜色、尺寸、超时、端口等语义关键词的行。跳过测试文件，每行只报一个。

无名字面量难以理解业务含义，修改时容易遗漏。

修复：提取为具名常量并附注来源。

### MNT-005 遗留 console 日志

`low` / js

检测 `console` 的各级输出。排除同行含 `eslint-disable` 或 `@ts-ignore`、行以注释开头、以及测试文件与脚本目录。

直接输出到标准输出会污染命令行输出，且无法按级别关闭。

修复：替换为项目统一 logger。

### MNT-006 未闭环的 TODO

`low` / js py java any

检测 `TODO`、`FIXME`、`XXX`、`HACK`，在原始行上匹配。

长期悬空的 TODO 会让技术债失去上下文。

修复：补上责任人与关联任务号，或删除。

### MNT-007 未实现的占位函数

`low` / js py

检测抛出"未实现"类错误的语句。

这类函数会在调用时才暴露问题。

修复：补齐实现，或标记为废弃并给出替代方案。

## 复杂度

### CPX-001 函数过长

`medium` / js py java

函数体超过 80 行。JavaScript 用大括号配平定位函数块，Python 与 Java 用缩进推断。

超过 80 行的函数通常混合了多个抽象层级。

修复：按准备数据、核心逻辑、输出结果拆分，单一函数控制在 50 行内。

### CPX-002 嵌套层级过深

`medium` / js java

按三种括号累计深度，达到 6 层时报告一次，降到 4 层以下后重新武装，避免同一区域刷屏。

嵌套过深时遗漏分支的概率大幅提高。

修复：用卫语句提前返回，或把内层逻辑提取为独立函数。

### CPX-003 参数列表过长

`low` / js py java

函数签名参数超过 5 个。

参数过多通常意味着函数承担了过多职责。

修复：聚合为配置对象，或拆分为多个职责单一的函数。

## 性能

### PERF-001 循环内查询 DOM

`medium` / js

检测循环行的后两行中出现 DOM 查询。

DOM 查询与布局读取在循环内会触发反复重排。

修复：把查询结果提到循环外缓存，批量更新后再写回。

### PERF-002 循环内创建正则

`medium` / js

检测循环行的后两行中出现 `new RegExp(`。

正则编译开销不小，循环内反复创建会拖慢热路径。

修复：把正则字面量提到模块顶层常量。

### PERF-003 嵌套循环线性查找

`low` / js py java

检测循环行后三行中同时出现循环关键字与 `includes`、`indexOf` 或 `in` 查找。

双层循环内做线性查找会把复杂度推到平方级。

修复：预先构建 `Set` 或 `Map` 索引，把查找降到常数级。

## 严重度定义

| 级别 | 含义 | 典型形态 |
| --- | --- | --- |
| `critical` | 安全漏洞、数据丢失、可被外部利用 | 命令注入、硬编码密钥、SQL 拼接、关闭证书校验 |
| `high` | 明确的逻辑错误、资源泄漏、会静默失败 | 吞异常、异步时序错误、残留调试语句 |
| `medium` | 特定输入下出错、性能退化、可维护性受损 | 浮点比较、松散比较、函数过长、循环内 DOM 查询 |
| `low` | 风格与一致性 | `var`、魔法数字、遗留 console、悬空 TODO |

## 关于误报

规则引擎是确定性的，能给出可复现的证据，但不等于正确结论。词法级扫描无法理解语义，因此会误报。

系统提示词明确授权模型推翻规则结论，对命中处读取上下文，判断是否为真问题。所以规则的输出应当被视为待验证的线索，而不是最终结论。

`scan` 命令直接输出的报告是未经模型判断的原始命中。把它接入流水线时，建议先按项目实际情况调整规则白名单与最低严重级别。
