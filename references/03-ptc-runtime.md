# 03 · PTC 运行时迁移（0.2.1-rc.5 → 0.2.2-rc.1）

> **影响谁**：写过或改过 `run_code` 提示词/Schema、自部署过 PTC bootstrap 或 SSH helper、在 SDK/会话层按错误码给工具失败分类的插件作者。只要你的 profile 里出现过 `tools.mode`、`DSH_TOOLS_MODE`，或依赖 `CODE_RUN_FAILED` 处理用户取消，升级后一定会踩到本文任意一条。

**证据约定**：`021:` = 0.2.1-rc.5 安装包 `resources/app.asar` 的解包根；`022:` = 0.2.2-rc.1 安装包 `app.asar` 的解包根。行号均为该文件解包后的实际行号（minified ESM，单行可能很长）。标「推断」的结论没有直接代码证据，已附验证方法；其余均可按标注行号复核。

## 1. Node PTC 新增 VM Script 模式

### 变更

`@deepseek-ai/dsh-ptc-runtime-node` 的 `executionMode` 从两值扩到三值，并新增独立的 `scriptPersistence`：

| 配置 | `programFormat` | 保留跨调用状态 | 语法 |
|---|---|---|---|
| `per-call`（默认） | `function-body` | 否 | 异步函数体，可 `return` |
| `vm-script` + `scriptPersistence: false`（默认） | `script` | 否 | 脚本语句，末尾表达式即结果 |
| `vm-script` + `scriptPersistence: true` | `script` | **是** | 同上，且顶层声明跨调用存活 |
| `persistent-in-memory` | `repl` | 是 | REPL 语句 |

- 0.2.1 只有 `per-call` / `persistent-in-memory`：`021: dsh-ptc-runtime-node/lib/index.js:691`（`executionMode: z.union([z.const("per-call"), z.const("persistent-in-memory")])`）。
- 0.2.2 增加 `vm-script` 与 `scriptPersistence: z.boolean().default(false)`：`022: dsh-ptc-runtime-node/lib/index.js:67`、`:71`、`:73`。
- 模式到语法的映射集中在 `resolveMode()`：`022: …/lib/index.js:1323`；`vm-script` 分支在 `:1340`，对外只读 `programFormat` 在 `:1439`。
- 非法组合在加载期就被拒绝：`scriptPersistence` 只能配 `vm-script`（`022: …/lib/index.js:95`，错误文本 `ptc-runtime-node: scriptPersistence requires executionMode: vm-script`）。
- profile 编辑器可用 `resolvePersistentExecution()` 从有效 `programFormat` 反推两个设置，并**原子合入**：`022: dsh-ptc-runtime-node/lib/configuration.js:8`（`script` → `{ executionMode: "vm-script", scriptPersistence: true }`，`function-body`/`repl` → `{ executionMode: "persistent-in-memory", scriptPersistence: false }`）。

### 症状

- 升级本身不改变行为：旧配置在 0.2.2 上默认仍是 `per-call`；只有显式写 `vm-script` 才变。反过来**回退**到 0.2.1 时，`vm-script` 会 schema 失败。
- 只加 `scriptPersistence: true` 而忘记改 `executionMode` 时，插件提供方加载失败，且报错发生在 PTC 首次被使用时，不在 profile 启动期，容易被误判成“PTC 坏了”。
- `vm-script` 下写顶层 `return` 得到 `exception`；`using` 声明同样不支持（**推断**：代码只保证「可擦除 TypeScript」，`using` 属需降级的运行时语义，`022: …/lib/index.js:1341-1343` 的 `executionInstructions` 只声明顶层声明与 `await` 可用，未列 `using`）。
- `vm-script` 顶层 `await import("node:fs")` 可用，但静态 `import`/`export` 不可用（脚本是 Script 而非 Module）。

### 迁移动作

```yaml
# 0.2.1：只能二选一
- id: ptc-runtime
  config: { executionMode: per-call }        # 或 persistent-in-memory

# 0.2.2：脚本模式（顶层 await + 表达式结果）；加 scriptPersistence 才跨调用保留
- id: ptc-runtime
  config: { executionMode: vm-script, scriptPersistence: true }
```

- 只把 `vm-script` 当“语法开关”，不要把 context 当安全边界：`022: …/lib/index.js:1341` 明确 context 不是隔离边界，Node 访问仍受进程沙箱约束。
- 从 `per-call` 切到 `vm-script` 时同步检查提示词：函数体示例里的 `return await tools.x(...)` 在脚本模式下应改写为 `console.log(await tools.x(...))` 或末尾表达式（`022: dsh-tool-executor-ptc/lib/index.js:936` 的 `renderBashExample` 就是按 `programFormat` 二分支生成示例的）。
- 保留模式的所有者必须先 `release(owner)` 才能改权限模式/工作区根/额外可写根/Session 身份（`022: dsh-ptc-runtime-node/README.zh.md:96`）。

### 验证方式

```ts
// 脚本模式：动态导入 + 顶层 await + 末尾表达式结果
const fs = await import("node:fs/promises");
await fs.readdir(".");
```

- 返回值的 `result` 应为最后一次表达式的 await 后无损 JSON；`console.log` 进入 `logs`。
- 连续两次 `run_code`，第二次引用第一次的顶层 `var`：`scriptPersistence: true` 时成功，`false` 时抛引用错误。
- 改一次会话沙箱模式后重跑：保留变量应被清空（`022: …/lib/index.js` 的 `PolicyProcesses` 在 `:1358` 定义，`:1368` 起监听 `sandbox/mode`）。

## 2. 原生/PTC 执行拆成按 Agent 作用域选择的插件

### 变更

- 0.2.1：`tools` 提供方自己持有 `mode`，进程级二选一。
  - Schema：`021: dsh-tools/lib/index.js:2763` → `mode: z.union(["native", "ptc"]).default("native")`。
  - 进程级开关由 bundle patch 注入环境变量：`021: dsh-web-app/cordis.patch.yml:32`（`- id: tools`）与 `:38`（`mode: !!js process.env.DSH_TOOLS_MODE`）；headless 同款在 `021: dsh-headless/cordis.patch.yml:14`、`:17`。
  - 预设层还有一条 `tool-presentation` 行带 `mode: ptc`：`021: dsh-web-app/presets/ptc.patch.yml:123`、`:126`。
- 0.2.2：`tools` 只做注册表与作用域分派，执行体由插件提供。
  - `mode` 与 `maxParallelSubCalls` 变成显式“已移除”字段，写入即 schema 报错：`022: dsh-tools/lib/index.js:407`（`mode: z.never().description("Removed. Mount a native or PTC tool executor instead.")`）、`:408`（`maxParallelSubCalls` 已移到执行器配置）。
  - 作用域选择 API：`setExecutor(executor)`（`022: dsh-tools/lib/index.js:598`，同一作用域只允许一个，重复注册抛 `Only one tool executor may be registered in each scope`）、`selectExecutor(scope)`（`:624`，按 scope 链就近解析，缺失时抛 `ToolExecutorUnavailableError`）。
  - base 层执行器相关行：`022: dsh-base/cordis.patch.yml:498`（`tools`）、`:501`（`tool-executor-native`，启用）、`:504`（`tool-executor-ptc`，`disabled: true`）。
  - PTC 由预设/overlay 挂载：`022: dsh-web-app/presets/ptc.patch.yml:125`（`- id: tool-executor-ptc` / `name: '@deepseek-ai/dsh-tool-executor-ptc'`）。
  - 环境变量彻底失效：`022: dsh-sdk-app/README.zh.md:26` 原文「`DSH_TOOLS_MODE` 不生效」。

### 症状

- profile `cordis.patch.yml` 里残留 `- id: tools` + `mode: ptc`：启动期 schema 校验失败（`z.never()`），表现为该行配置被拒，而不是静默忽略。
- 仍用 `DSH_TOOLS_MODE=ptc` 启动：进程正常起来，但工具目录里永远没有 `run_code`——**没有报错**，是最难查的一种。
- 在错误的 scope 里 `setExecutor`：第二次注册抛 `Only one tool executor may be registered in each scope`；卸载后该 scope 的选择变为不可用，直到被替换（`022: dsh-tools/lib/index.js:593-603`）。

### 迁移动作

1. 删除所有 `tools.mode` / `tools.maxParallelSubCalls` 写入，删掉 `DSH_TOOLS_MODE` 环境变量（自部署脚本、systemd unit、SDK 启动参数都要清）。
2. 需要 PTC 的 Agent：在其预设里挂 `tool-executor-ptc`，并让同一作用域不要再挂 `tool-executor-native`；需要显式覆盖部署默认时，用 overlay 关掉 native、打开 ptc：

```yaml
# 0.2.2 overlay（等价于旧 DSH_TOOLS_MODE=ptc 的作用域版）
- id: tool-executor-native
  disabled: true
- id: tool-executor-ptc
  disabled: false
  config: { maxParallelSubCalls: 10 }   # 原 tools.maxParallelSubCalls 的新家
```

3. 旧的 `tool-presentation`（`mode: ptc`）行不再需要，删除即可；PTC 语义已由执行器决定。

### 验证方式

- `dsh --profile <p> --dump-config`：应看到 `tool-executor-native` 与 `tool-executor-ptc` 两行，且只有一个在该作用域生效。
- 起一个 PTC 预设会话，模型侧工具清单应只有 `run_code`，没有逐个原生工具；标准预设反之。
- 反向验证：把 overlay 里的 ptc 行 `disabled: true`，工具清单应回退为原生工具，且不报 `ToolExecutorUnavailableError`。

## 3. PTC Node 控制通道改用 birpc；bootstrap 与 SSH helper 必须同步升级

### 变更

- 0.2.1：控制通道是自研的逐行 JSON 帧，失败名 `protocol`，典型消息 `invalid persistent PTC frame`：`021: dsh-ptc-runtime-node/lib/index.js:1197`；全包无 birpc 依赖（grep `birpc` 无命中）。
- 0.2.2：改为 `birpc` 承载 Host↔子进程 RPC：`022: dsh-ptc-runtime-node/lib/index.js:11`（`import { createBirpc } from "birpc"`）、`:437`（`const rpc = createBirpc(functions, { … })`）。Host 调子进程 `run()`，注入的绑定回调 Host `invoke()`，捕获输出走通知（`022: dsh-ptc-runtime-node/README.zh.md:128`）。
- bootstrap 入口收敛为单一 `process.js`：0.2.1 的 `scriptBootstrapArgs` 按 `persistent` 选 `process` 还是 `persistent-process`、并调 `runNodeMain`/`runPersistentMain`（`021: dsh-ptc-runtime-node/lib/index.js:668`、`:669`、`:680`）；0.2.2 所有模式都用 `process.js` + `runNodeMain`，`persistent-process.js` 只是委托同一循环（`022: …/lib/index.js:46`、`:60`；`022: …/README.zh.md:134`）。继承通道助手 `openInheritedControlChannel` 两边都在，所以**不兼容发生在消息层（帧→birpc），不在管道层**——这是自部署 bootstrap 最容易误判的地方。
- 版本不匹配的报错被写死在代码里：`022: …/lib/index.js:466` —— `control message is not a JSON object; the Node bootstrap may be from another release`。
- 文档把这条列为硬约束：`022: dsh-ptc-runtime-node/README.zh.md:202`「控制协议没有版本握手——预装的 `launch.bootstrapPath` 或 SSH helper 必须来自与客户端相同的版本；其他版本的 bootstrap 会在第一条控制消息时失败。」

### 症状

- 自部署 `launch.bootstrapPath`（旧 `process.js`）：PTC 每次调用立即失败，错误文本落在 `protocol` 或上面那句 “may be from another release”，日志里看不到任何模型代码执行。
- SSH 远端 helper 未同步：远端 PTC 在第一条控制消息即失败，本地 PTC 正常 —— 典型“一半好用”。SSH 协议号 2→3 来自发布说明 `RELNOTES.md:129`；**推断**：代码里没有可 grep 的协议版本常量，因此无法从 asar 直接证实这个数字，只能按“旧 helper 必定失败”的行为判断。

### 迁移动作

1. 重新构建/部署与客户端同版本的 bootstrap（本包构建产物 `process.js`；REPL 保留模式同一文件），更新 `launch.bootstrapPath` 或镜像里的文件。不要只拷贝 `persistent-process.js`。
2. SSH helper 与客户端**同一次**升级，不要分批灰度；旧 helper 留在远端等于永久坏掉。
3. 升级后检查 bootstrap 里确实出现 birpc 传输层与 `openInheritedControlChannel`，而不是旧的帧解析函数。

### 验证方式

```bash
# 推断项的复核方法：确认 bootstrap 是否已换成 birpc 版
grep -c "createBirpc" <deployed>/process.js        # 0.2.2 应为 ≥1
grep -c "openInheritedControlChannel" <deployed>/process.js
```

- 跑一次远端（SSH）`run_code`：应返回正常结果，而不是第一条控制消息就失败。
- 故意保留一份旧 bootstrap 指向 `launch.bootstrapPath`：应稳定复现 `… may be from another release`，以此确认自检有效。

## 4. run_code 的调用方取消改为 ABORTED

### 变更

- 0.2.1：`run_code` 对**所有** `result.error` 一律抛 `CodeRunFailedError`（`code: 'CODE_RUN_FAILED'`）：
  - 抛点：`021: dsh-tools/lib/index.js:1520`；
  - 错误类与文档注释把 abort 明确算作 run 失败：`021: dsh-tools/lib/index.js:1041-1046`（“a program exception, a budget expiry, an abort, or substrate death”）。
- 0.2.2：先分流“调用方取消”，再落到运行失败：
  - `022: dsh-tool-executor-ptc/lib/index.js:648-650`：
    ```js
    if (result.error.kind === "abort" && exec.signal.aborted) {
      const error = new HarnessError("tool call aborted", TOOL_ABORTED);
      error.name = "AbortError";
      throw error;
    }
    ```
  - 注释同步改写：`022: dsh-tool-executor-ptc/lib/types/errors.js:3-10`（“a runtime-local abort … Caller cancellation uses the shared `AbortError` / `ABORTED` tool outcome.”）。
  - `ABORTED` 常量本身来自 `dsh-tools`（`TOOL_ABORTED`，经 `022: dsh-tool-executor-ptc/lib/index.js:1` 具名导入）。

### 症状

- SDK/Session 消费方按 `CODE_RUN_FAILED` 分类：用户按了停止，却收到“程序运行失败”，于是重试、告警、写错误轨迹；反过来，真正的程序异常继续是 `CODE_RUN_FAILED`，两者不再可混用。
- UI 若把 `CODE_RUN_FAILED` 当“可重试”，现在取消路径会绕过该分支，取消后不再弹重试。

### 迁移动作

```ts
// 0.2.1 写法：所有失败一视同仁
if (result.error?.code === "CODE_RUN_FAILED") retryable = true;

// 0.2.2：先判取消（AbortError/ABORTED），再判运行失败
if (result.error?.name === "AbortError" || result.error?.code === "ABORTED") {
  cancelled = true;            // 不要重试、不要计为失败
} else if (result.error?.code === "CODE_RUN_FAILED") {
  retryable = true;            // 程序异常、超时、substrate death
}
```

- 事件/轨迹消费方：把 `ABORTED` 归入“用户取消”分类，保留原始错误文本用于展示（0.2.2 也修了 Trajectory 保留失败工具原文的行为，`RELNOTES.md:96`、`:236`）。

### 验证方式

- 发起一个长 `run_code`（例如 `await new Promise(r => setTimeout(r, 60000))`），中途取消：结果应是 `ABORTED` / `AbortError`，且 Session 里该调用不再被标为失败工具。
- 同一提示词改为抛异常（`throw new Error("boom")`）：仍是 `CODE_RUN_FAILED`，`text` 含 `code run failed (exception): …`。

## 5. 与插件作者相关：run_code 的输出与 Schema

### 变更

- 定义搬家：0.2.1 的 `createRunCodeTool` 在 `dsh-tools`（`021: dsh-tools/lib/index.js:1181`）；0.2.2 在 `dsh-tool-executor-ptc`（`022: dsh-tool-executor-ptc/lib/index.js:304`），只从 `dsh-tools` 取 `RUN_CODE_NAME`、`defineTool`、`projectToolSchema` 等公共件（`:1`）。
- **输出结构不变**：仍是 `{ logs: string[], result?: json, sandbox?: { mode, denied, enforcement? } }`，`render` 仍拼「logs + result + 沙箱部分强制提示」，空输出回落 `(run_code completed with no output)`：`022: …/lib/index.js:332-373`（对照 0.2.1 的同一函数 `021: dsh-tools/lib/index.js:1181` 起）。按结构消费的代码不需要改。
- **Schema 文本变**：参数说明与 SDK 提示按运行时语法生成。
  - `resolveFlavor(runtime)`：只有 `language === "typescript" && programFormat === "function-body"` 才用 `TYPESCRIPT_FUNCTION_FLAVOR`，其余走 `RUN_CODE_FLAVORS[language]`（`022: …/lib/index.js:165`）。
  - 面向模型的 SDK 说明由 `renderSdkInstructions(programFormat)` / `renderSdkProgramInstructions(programFormat)` 分支生成（`022: …/lib/index.js:915`、`:921`、`:962`）。注意 `programFormat` 分支在 0.2.1 就有（`021: dsh-tools/lib/index.js:1777`、`:1824`），0.2.2 只是多了 `script` 这一条路径，结构未变。
  - `run_code` 控制参数未变：`timeoutMs`、`sandbox_permissions`、`justification`（`022: …/lib/index.js:134-146`）。
- **并发配置换家**：`maxParallelSubCalls` 现在是执行器 Config（`022: …/lib/index.js:1701`，默认 10），不再是 `tools` 的字段。
- **运行时取用方式**：`requirePtcRuntime(ctx)` / `ctx.get("ptcRuntime")`，不再有模块级 `peekRuntime()` 单例（`022: …/lib/index.js:372` 的 `ctx.get("ptcRuntime")?.sandboxMode`）。

### 症状

- 从 `@deepseek-ai/dsh-tools` 导入 `createRunCodeTool` / `RunCodeFailedError` 的插件：0.2.2 里不存在（`dsh-tools` 只导出注册表与 `RUN_CODE_NAME` 等）。
- 自己改写过的 `run_code` 描述在被 preset 覆盖后失效：描述现由执行器按 `programFormat` 重算。
- 在 `tools` 行写 `maxParallelSubCalls`：schema 报错（`022: dsh-tools/lib/index.js:408`）。

### 迁移动作

- 工具名照旧从 `dsh-tools` 导入：`import { RUN_CODE_NAME } from "@deepseek-ai/dsh-tools"`。
- 需要定制执行语义时，改为替换执行器插件或包一层 `tools` 服务，而不是 patch `dsh-tools` 的实现。
- 消费 `run_code` 结果的代码保持原样；只把取消分类按第 4 节改掉。

### 验证方式

- 在 PTC 预设会话里取 `run_code` 的 JSON Schema：`programFormat: function-body` 时应出现 `return` 字样的示例，`script` 时应出现末尾表达式示例。
- 执行一次返回图片的工具：结果里的图片应在下一步作为附件出现（`run_code` 输出结构未变）。

## 6. 0.2.2 下确认 PTC 正常的检查清单

1. `--dump-config` 中 `tool-executor-native` / `tool-executor-ptc` 至少一个在该作用域启用；没有 `tools.mode`。
2. 环境里没有 `DSH_TOOLS_MODE`（清了也验证一次，避免 systemd/SDK 层残留）。
3. `executionMode` 与 `scriptPersistence` 组合合法（`vm-script` 才能 `true`）。
4. 部署的 bootstrap / SSH helper 与客户端同版本，含 birpc 与 `openInheritedControlChannel`。
5. `run_code` 能跑通顶层 `await import(...)`；脚本模式下末尾表达式被 await 并回填 `result`。
6. 取消一次长调用：得到 `ABORTED`/`AbortError`，不是 `CODE_RUN_FAILED`。
7. 抛异常一次：得到 `CODE_RUN_FAILED`，文本含 `code run failed (exception)`。
8. 保留模式下改沙箱模式：保留变量被清空，且下一次调用仍能启动。
