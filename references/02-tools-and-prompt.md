# 02 · 工具执行与提示词（per-step 启用 / 执行器拆分 / apply_patch / 观察策略 / pi-ai 1.3.0）

> **影响谁 / 什么时候会踩到**：三种人——(a) 在 profile 的 `cordis.patch.yml` 里写过 `tools: mode:` 或设过 `DSH_TOOLS_MODE` 的人，**升级后启动或首个工具调用就失败**；
> (b) 依赖"edit 前必须先读"这条防护的人（含自动化脚本、subagent 约定），**升级后防护静默消失**，风险出现在第一次覆盖写；
> (c) 自己注册工具或改工具提示/schema 的插件作者，**升级后**才会发现条件工具"通告了却调不动"、或整批工具因一个坏参数全不执行。

## 证据路径约定

- 0.2.2-rc.1：`asar022/dsh/node_modules/@deepseek-ai/<pkg>/...`
- 0.2.1-rc.5：`asar021/dsh/node_modules/@deepseek-ai/<pkg>/...`

两版都用 `npx @electron/asar extract "<app.asar>" asar0xx` 解出；行号即该文件行号。

---

## 1. 工具按步骤条件启用（`when` / `ResolvedToolSet` / `executable`）与提示词组装

**变更**
- 注册签名 `register(definition)` → `register(definition, options = {})`，新增 **`when`**：每个模型步骤算一次，收 `{ agent, modelSelection, signal }`，返回 `false` 就从 **执行器描述、PTC 绑定、执行集合** 三处同时排除。（证据：`dsh-tools/lib/index.js:433-445`；0.2.1 同文件 `:2974` 为 `register(definition) {`，无第二参数。）
- 新增步骤级准入：`await tools.resolve({ agent, modelSelection, signal })` → `ResolvedToolSet`，交给提示词组装与 `ctx.tools.execute()`，批次结束 `dispose()`；同一步骤内重试复用它。（证据：`:542-572`；`dsh-tools/README.zh.md:69`、`:71`。）
- 新增执行期查找 `executable(name, scope, toolSet)`：**没有集合时，带 `when` 的注册一律不可用**（返回 `undefined` → 调用按 `UNKNOWN_TOOL` 失败）；`get/definitions/schemas` 同样收 `toolSet`。（证据：`:530-534`、`:519-521`、`:579-591`、`README.zh.md:73`。）
- 条件抛错不再"当作不可用"，而是 `TOOL_ACTIVATION_FAILED` **中止步骤准备**。（证据：`:550-555`、`README.zh.md:69`。）
- 提示词侧接口同步：`systemPrompt.tools` 回调从 `(context)` 变成 `({ scope, toolSet })`，描述、PTC 绑定、执行准入吃同一份集合。0.2.1 是 `ctx.systemPrompt.tools((context) => this.wireSchemas(context.scope))`（`dsh-tools/lib/index.js:2802`），0.2.2 是 `({ scope, toolSet }) => selectExecutor(scope).describe(this.definitions(scope, toolSet))`（`:418-424`）。

**症状**
- 插件提示段仍按 `scope` 生成清单：模型看到工具、调用却 `UNKNOWN_TOOL`（通告面 ≠ 可调用面）。
- 把"这一步给不给这个工具"实现成注册/注销：与本步集合打架，出现同步骤内工具抖动、或注销后仍被调用。
- `when` 内抛异常（含读配置失败）：整步准备失败，用户看到"这条消息没跑"而不是"少一个工具"。

**迁移动作**
```js
// before（0.2.1：没有条件，只能注册/注销，或在自己的提示词里过滤）
ctx.tools.register(definition)

// after（0.2.2：声明条件，准入由注册表统一算）
ctx.tools.register(definition, {
  when: ({ agent, modelSelection }) => agent.mode !== 'plan' && modelSelection.model === 'x',
})
```
```js
// 提示词与执行必须用同一份集合
const toolSet = await ctx.tools.resolve({ agent, modelSelection, signal })
try {
  const defs = ctx.tools.definitions(agent, toolSet)      // 描述用
  ctx.systemPrompt.tools(({ scope, toolSet }) => render(defs))  // 回调里照抄 toolSet
  await ctx.tools.execute({ calls, agent, toolSet })      // 执行用
} finally { toolSet.dispose() }
```
- `when` 必须响应 `signal` 取消，且**不得**在里面做注册变更或执行工具。

**验证方式**
```powershell
Select-String -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\*\lib\*.js" -Pattern "\.register\(|toolSet|TOOL_ACTIVATION_FAILED" | Select-Object Path,LineNumber,Line
# 运行期：给工具加 when，切换触发条件，提示词清单与可调用面应同步变化（unavailable 时得到 UNKNOWN_TOOL）
```

---

## 2. 原生 / PTC 执行拆成按 Agent 作用域选择的插件；`tools.mode` 与 `DSH_TOOLS_MODE`

**变更**
- 0.2.1：`dsh-tools` 里一个 `ToolRuntime`，配置即开关：`static Config = z.object({ mode: z.union(["native","ptc"]).default("native"), maxParallelSubCalls: z.natural().min(1).default(10) })`（证据：0.2.1 `dsh-tools/lib/index.js:2758-2761`）。
- 0.2.2：这两个键变成 **`z.never()`**，写了就校验失败并直接给迁移指令：`mode: z.never().description("Removed. Mount a native or PTC tool executor instead.")`、`maxParallelSubCalls: z.never().description("Moved to the PTC tool executor configuration.")`（证据：`dsh-tools/lib/index.js:406-409`）。
- 执行器拆成两个插件 + **作用域选择**：`setExecutor()` 每作用域只允许一个（否则 `Only one tool executor may be registered in each scope`），`selectExecutor(scope)` 取"最近作用域的，否则部署默认"，`execute()` 分派时选、已接纳批次仍由它结算（证据：`:598-618`、`:624-634`、`:641-643`）。
- 出厂行（`dsh-base/cordis.patch.yml:500-505`）：native 挂上、ptc `disabled: true`。`dsh-app-boot` 把这两个 id 列入必须能激活的启动清单（`requiredStartupEntryIds`，`:5014-5025`）：缺失/禁用不挡启动，但**已启用且在表里的条目必须激活**。
- 旧 PTC 开关是接进配置的临时 env seam，0.2.1 的 web bundle 逐字写着（`dsh-web-app/cordis.patch.yml:32-38`）：
  `# TEMPORARY workaround: DSH_TOOLS_MODE (native|ptc) opts a whole dsh process into PTC mode ...` + `- id: tools` / `config: mode: !!js process.env.DSH_TOOLS_MODE`。
- 0.2.2 里**没有任何代码读它**：整个 `app.asar`（213 MB）二进制扫描仅 2 处命中，都在 SDK 文档且都写"不生效"——`dsh-sdk-app/README.zh.md:26`：「…通过 `--patch` 或 TypeScript、Python SDK 的 `patches` 选项传入执行器 overlay。**`DSH_TOOLS_MODE` 不生效**。」`- id: tools` 行也不再带 `config`（`dsh-base/cordis.patch.yml:497-498`）。

**症状**
- profile patch 里还留 `mode: native|ptc`：**启动即配置校验失败**，报错文本就是上面的 `Removed. ...`。
- `DSH_TOOLS_MODE=ptc` 完全无效（没人读），你以为在用 PTC、其实仍是 native——**静默**，只有看工具清单才发现。
- 同一作用域同时启用 native 与 ptc：`Only one tool executor may be registered in each scope`。
- 把两个执行器条目都删掉：不挡启动，但首次工具调用以 `ToolExecutorUnavailableError` 失败。

**迁移动作**
```yaml
# before（0.2.1，全局开 PTC）
- id: tools
  config:
    mode: ptc
    maxParallelSubCalls: 10

# after（0.2.2）：执行器当插件挂，PTC 用 overlay + Agent 作用域启用
- id: tool-executor-native
  disabled: true             # 同作用域只能有一个
- id: tool-executor-ptc
  disabled: false
  config:
    maxParallelSubCalls: 10  # 并发上限搬到这里
```
- 出厂做法：`ptc` preset 在自己的 `plugins` 列表 insert 一条 `tool-executor-ptc`（`dsh-web-app/presets/ptc.patch.yml:125-126`），于是**只有该 preset 的 Agent 作用域**用 PTC，其余仍走根作用域 native。
- 只想"这次启动用 PTC"：写 overlay 文件，`dsh --profile <name> --patch .\ptc.yml`；SDK 用户传 `patches` 选项（官方指引 `dsh-sdk-app/README.zh.md:26`）。
- 清掉所有 `DSH_TOOLS_MODE`（脚本、CI、`launch.json`、快捷方式）。

**验证方式**
```powershell
Select-String -Path "$env:USERPROFILE\.dsh\profiles\desktop\cordis.patch.yml" -Pattern "mode:|DSH_TOOLS_MODE|maxParallelSubCalls"
$env:DSH_TOOLS_MODE   # 期望空
dsh --profile web --dump-config | Select-String "tool-executor-(native|ptc)" -Context 0,1
```

---

## 3. `apply_patch`（默认关闭）与旧的写文件工具

**变更**
- 新工具 `apply_patch`：一次完成多文件新增/更新/删除/移动，参数是**一个字符串** `input`（沿用 Codex 参数名），语法 `*** Begin Patch` / `*** End Patch` + Add/Update/Delete 文件头 + 可选 `Move to` + 上下文/新增/删除 hunk 行，路径相对 Session 工作目录（证据：`dsh-tool-fs/README.zh.md:263`、`:52`）。
- 开关是 `tool-fs` 的 **`applyPatch`，默认 `false`**（`dsh-tool-fs/README.zh.md:66`、`:58`）。出厂四处 patch 全部显式关掉：`dsh-base/cordis.patch.yml:295-299`（注释 "Set false to drop the apply_patch tool beside edit."）、`dsh-web-app/cordis.patch.yml:34`、`presets/standard.patch.yml:31`、`presets/ptc.patch.yml:31`。
- 与旧工具的关键差异：**整份补丁先预检**（语法、hunk 匹配、缺文件），被拒则磁盘 0 变更；**开始提交后按序执行、首个失败即停、不回滚**，此时仍返回 `isError: false` 以保留已发生的部分效果与 diff；错误码 `PATCH_SYNTAX` / `PATCH_SYMLINK_SOURCE`（证据：`dsh-tool-fs/README.zh.md:84`、`:268`）。

**症状**
- 升级后模型看不到 `apply_patch`——这是默认状态，不是故障。
- 打开后模型仍用 `edit`/`write`：它是**并行新增**的第四个修改工具，不替代 `write`/`edit`/`str_replace`；`applyPatch:false` 只隐藏它。
- 拼错补丁：`PATCH_SYNTAX` 且 0 文件被改；一旦进入提交阶段报错，文件是**部分改动**状态，需重新读再重试。

**迁移动作**
```yaml
# 只想给"跨文件/分散区域"的改动加一条快路：在 profile patch 里覆盖同一行
- id: tool-fs
  config:
    applyPatch: true
```
- 脚本/CI 解析工具结果时注意新增的 `phase`、`cancelled`、有序 `operations`、`affectedPaths`，以及"提交中失败仍是成功结果"这条语义。
- 依赖"失败即 0 变更"的自动化：只有**预检**阶段有这条保证。

**验证方式**
```powershell
dsh --profile web --dump-config | Select-String "applyPatch"   # false=关，true=开
# 运行期：让模型一次改两个文件，看是否走 apply_patch、Review 里有 A/M/D 分组
```

---

## 4. 文件修改「先读 + 外部修改防护」默认关闭（如何显式恢复）

**变更**
- 防护仍在，仍以插件随发行版交付，但**默认不挂**：`dsh-base/cordis.patch.yml:291-293` 为 `- id: fs-observation-policy` / `disabled: true`。
- 它守三件事（证据：`dsh-fs-observation-policy/README.zh.md:12`、`:44`、`:48`）：`edit`/`delete` 必须先 `read` 过（否则 `FS_NOT_OBSERVED`，模型侧文案 `cannot modify "<path>": file has not been read — read the file, then retry`）；读后文件被外部改过 → `FS_STALE_VERSION`（追加 `— re-read the file, then retry`）；读一个**不存在**的路径＝记录"确认缺失"，之后 `write` 才能带防护地创建。`write` 可建新文件，但拒绝覆盖本会话未读过的现有文件。
- 沙箱限制与 Review 不受影响；观察记录**不持久化**，恢复的会话必须重读（`:128`）；直接 `ctx.fs` 读取不算"读过"（`:130`）。

**症状**
- 升级后 `edit` 不再要求先读：模型可以覆盖它从未读过的文件，也能覆盖你刚在编辑器里改过的文件——**静默丢改动**，没有任何错误。
- 用 `FS_NOT_OBSERVED` 做流程门禁的脚本/自动化：门禁失效，全部放行。

**迁移动作**
```yaml
# 显式恢复：加在 profile 的 cordis.patch.yml（用户层优先于 bundle 层，升级不会回退）
- id: fs-observation-policy
  disabled: false
```
- 只给某个 Agent/preset 恢复：把这行放进该 preset 的 `plugins` 列表，而不是 profile 根层。
- 不要改 bundle 内的行——bundle 在包内，升级即回退。

**验证方式**
```powershell
dsh --profile web --dump-config | Select-String "fs-observation-policy" -Context 0,1
# 端到端：新会话里让模型 edit 一个从未 read 的文件 —— 开启后应报 FS_NOT_OBSERVED；
# 关闭时同一操作直接成功（这就是风险面）
```

---

## 5. pi-ai 1.3.0：完整工具参数格式错误在执行任何工具前终止该次响应

**变更**
- `@earendil-works/pi-ai` **1.1.0 → 1.3.0**（证据：两份 `pi-ai/package.json` 的 `version`）。
- 行为（官方原文）：**完整工具参数格式错误会在执行任何工具前终止该次响应**——不是"这个工具失败"，而是**这一批一个都不执行**、整个响应结束。
- 机制：pi-ai 在**完成事件**里给出解析后的参数对象，DSH 适配器再解析并重新字符串化以符合原始 JSON 约定（`dsh-llm-pi-ai/README.zh.md:196`）；1.3.0 上打了 remove-per-delta-reparse 补丁，参数只在完成时解析一次（同文件 `:272`，补丁 `patches/@earendil-works__pi-ai@1.3.0.patch`）。因此"拼错的代价"从"卡顿"变成"整条响应失败"。

**症状**
- 一次多工具批次"一个都没跑"，对话里只看到该响应终止；模型下轮重试（可能与上次相同而再次失败）。
- 你以为是某个工具的实现问题，实际是**另一个**工具的参数 JSON 坏了（整批连坐）。
- 大参数工具更容易踩：上游逐 delta 重解析是 O(n²)，数 MB 参数流会卡事件循环；补丁后这类问题改为以解析失败暴露。

**迁移动作（插件 / tool schema 作者）**
- schema 尽量只接受一种形状：避免 `oneOf`/union（对象**或**字符串）诱导模型拼出非法 JSON；必填项收窄并给最小示例。
- 参数里不要塞"自由文本大块"（补丁、整文件内容）——那类操作用 `apply_patch`（单字符串参数）而不是几十个字段的结构化对象。
- 不要把"参数错误"当业务错误处理：它在你的 `execute()` 之前就发生，`try/catch` 抓不到。
- 升级后重跑"模型能否稳定产出合法参数"的回归，尤其是多工具并行批次。

**验证方式**
```powershell
node -p "require('./dsh/node_modules/@earendil-works/pi-ai/package.json').version"        # 1.3.0
node -p "require('./asar021/dsh/node_modules/@earendil-works/pi-ai/package.json').version"  # 1.1.0
# 行为：做一个必坏参数的 schema，发起两工具批次 → 期望 0 个工具执行 + 该响应终止
```

---

## 6. 速查

| # | 谁受影响 | 一行修复 | 先验证 |
|---|---|---|---|
| 1 | 注册工具/改提示词的插件 | `when` + 把 `toolSet` 传给 `definitions()`、`execute()`、`systemPrompt.tools` | 条件工具开关时提示词与调用面同步 |
| 2 | 设过 `tools.mode` / `DSH_TOOLS_MODE` 的 profile | 删 `mode`，改挂 `tool-executor-ptc` overlay | `--dump-config` 里两个执行器行 |
| 3 | 想用多文件补丁的人 | `tool-fs` 行 `applyPatch: true` | `--dump-config` 里 `applyPatch` |
| 4 | 依赖"先读再改"防护的人 | `fs-observation-policy` 行 `disabled: false` | 未读即 edit 应报 `FS_NOT_OBSERVED` |
| 5 | tool schema 作者 | 单一参数形状、拒绝巨型结构化参数 | 两工具批次 + 坏参数 → 0 执行 |

> **复核建议**：`dsh-tool-fs/README.zh.md:58` 称 `dsh-base` 与 Web 的 `standard` preset「在各自的 `tool-fs` 行上开启 `applyPatch`」，但 0.2.2-rc.1 的这两个文件实测都是 `applyPatch: false`（`dsh-base/cordis.patch.yml:299`、`presets/standard.patch.yml:31`），该行注释自身也在说 "Set false to drop ..."——**文档与发行物不一致，以发行物为准**，等正式版复核。
