# DSH 0.2.2-rc.1 — 全部开发者向破坏性变更（30 项）

来源：官方 `v0.2.2-rc.1` release notes「其他变更」段（`.update-investigation/RELNOTES.md` 第 111-141 行），
并对 0.2.2-rc.1 `app.asar` 做了源码核对。每条标注 **证据**（可直接查证）或 **推断**（需本地验证）。
面向两类读者：**升级 profile 的人**（A 列动作）与 **插件作者**（B 列动作）。

> 门禁基线（不是变更条目，但决定了所有插件命运）：0.2.2 用
> `semver.satisfies(runtimeVersion, range, { includePrerelease: true })` 判定兼容，
> `dsh.engines.dsh` 单独决定、存在时忽略 peer；否则只检查 `@deepseek-ai/dsh` /
> `@deepseek-ai/dsh-*` 的 peer；`workspace:^|~|*` 视为当前运行时。
> 证据：0.2.2 `@deepseek-ai/dsh-app-boot/lib/index.js:1094-1117`。

---

## A. 运行时与核心

### 1. Cordis Core 4.1.0 / Loader 1.1.0 / Include 1.1.0
- **变更**：统一配置访问、条目变更和持久化行为；三个包一起升级。
- **A 动作**：无需手改；但任何钉死 `@deepseek-ai/cordis@4.0.x` 的插件需升到 `~4.1.0`。
- **B 动作**：不要依赖 4.0 的 loader 内部字段；配置读写走 ctx 公开接口。
- **症状**：启动时报 loader schema / 条目持久化错误，或热更新后设置丢失。
- **验证**：`dsh --version` 后 `--dump-config` 无 cordis 报错；改一项设置 → 重启 → 设置仍在。
- **证据**：0.2.2 asar 内 `@deepseek-ai/cordis@4.1.0`、`cordis-plugin-loader@1.1.0`。

### 2. Cordis Fiber 统一配置来源
- **变更**：Fiber 同时提供原始配置、候选配置解析、生效配置访问；设置编辑与热更新用同一来源。
- **B 动作**：插件不要再各自缓存"我读到的配置"；写入候选配置后以生效配置为准。
- **症状**：设置页显示已改，插件行为没变（或反之）。
- **验证**：改设置 → 不重启热更新 → 插件行为与设置页一致。
- **证据**：release notes；`@deepseek-ai/dsh-config-editor` 在 0.2.2 组合中出现。

### 3. 最低 Node.js 版本提高到 24.9
- **变更**：旧运行时（22.x/24.0-24.8）不被支持。
- **A 动作**：自部署/CLI 用户先升 Node；桌面版自带运行时，不受影响。
- **症状**：启动即失败，或语法错误（新 API 在旧 Node 上不存在）。
- **验证**：`node -v` ≥ 24.9（`@deepseek-ai/dsh` 桌面运行时为 44.7.0 的 Electron 内置 Node，无需处理）。

### 4. cordis.patch.yml / profile 配置层的升级风险
- **变更**：这不是官方条目，而是 2026-11-01 本机真实事故：DSH 升级把用户
  `cordis.patch.yml` 覆盖成模板，设置与 MCP 注入块丢失。
- **A 动作**：升级前备份 `package.json`、`cordis.patch.yml`、`cordis.yml`、`pnpm-lock.yaml`；
  升级后比对 diff，不要"看起来还在"就跳过。
- **验证**：`Get-FileHash` 升级前后对比，或 `git diff`（profile 建议纳入版本管理）。

### 5. 插件设置页可提供导航图标
- **变更**：插件可为自己设置页提供导航图标；卸载后恢复默认。
- **B 动作**：可选增强；声明图标需走 0.2.2 的设置页注册契约，旧字段会被忽略。
- **验证**：安装后图标出现，卸载后恢复默认。

---

## B. 工具、提示词与 PTC

### 6. 工具按步骤条件启用；三者一致
- **变更**：模型声明、PTC 绑定、执行准入现在必须一致；插件需迁移 `tools.resolve` /
  `executable` 与提示词组装接口。
- **B 动作**：工具注册从"注册即永远可用"改为"声明 + 解析 + 准入"三段一致；
  按步骤条件启用时，三处必须同一条件。
- **证据**：0.2.2 `@deepseek-ai/dsh-tools/lib/types/index.js:174-189` 暴露
  `executable(name, scope, toolSet)` 与 `async resolve(context)`。
- **症状**：模型能看到工具但调用返回 `UNKNOWN_TOOL`，或 PTC 里能调用、原生调用不行。
- **验证**：同一工具分别在原生与 PTC 下调用一次，结果一致。

### 7. 原生与 PTC 工具执行拆为按 Agent 作用域选择的插件
- **变更**：执行器拆包（`@deepseek-ai/dsh-tool-executor-native`、`...-ptc`），PTC 通过配置 overlay 启用。
- **A 动作**：旧 `tools.mode` 与 `DSH_TOOLS_MODE` 需迁移到 overlay 配置；否则 PTC 不可用或双执行器冲突。
- **症状**：PTC 完全不可用；或工具被执行两次。
- **验证**：`--dump-config` 中只出现一个执行器 + 期望的 overlay。

### 8. Node PTC 新增 VM Script 模式
- **变更**：支持顶层 await、动态导入、表达式结果；可独立开启跨调用状态保留；默认仍逐次执行；
  脚本顶层不支持 `return` 或 `using`。
- **B 动作**：依赖旧的"顶层 return"写法要改成表达式结果；跨调用状态需显式开启。
- **症状**：脚本语法错误（`return` 在顶层）；或第二次调用看不到第一次的变量。
- **验证**：写一个含顶层 await 的脚本，再写一个依赖跨调用状态的脚本，分别开关验证。

### 9. PTC 控制通道改用 birpc；SSH 协议 2→3
- **变更**：自部署 bootstrap 与 SSH helper 必须同步升级；SSH 协议版本 2 升 3。
- **A 动作**：自部署远程执行环境必须同时升级 helper，否则握手失败。
- **症状**：远程 PTC 连接失败，协议版本不匹配。
- **验证**：升级后远端执行一次 `run_code`。

### 10. PTC 取消语义变更
- **变更**：调用方取消的 `run_code` 返回 `ABORTED`（不再是 `CODE_RUN_FAILED`）。
- **B 动作**：所有消费取消结果的地方（SDK、Session 消费方、UI 分类）更新判断。
- **症状**：取消被显示成"执行失败"，或重试逻辑被触发。
- **验证**：手动取消一次 PTC 执行，看状态分类。

### 11. `apply_patch` 工具（默认关闭）
- **变更**：新增一次性完成多文件新增/编辑/删除/移动的工具，Review 中可见变更；默认关闭。
- **A 动作**：需要时显式启用；同时评估与现有 `edit`/`write` 工具链的提示词冲突。
- **验证**：启用后做一次多文件补丁，Review 显示完整 diff。

### 12. 文件修改"先读 + 外部修改防护"默认关闭
- **变更**：观察策略默认关闭；沙箱限制与 Review 不变；需要旧防护的 profile 显式恢复。
- **A 动作**：依赖"改前必读"防呆的团队要显式恢复 `fs` 观察策略，否则可能覆盖外部改动。
- **症状**：模型不再报"必须先读文件"，直接覆盖。
- **验证**：外部改文件后让模型编辑，看是否提示冲突。

### 13. 工具参数校验前置
- **变更**：pi-ai 1.3.0 下，完整的工具参数格式错误会在执行任何工具前终止该次响应。
- **B 动作**：schema 要精确，可选参数不要写成必填；否则整轮直接失败。
- **症状**：一整轮没有任何工具执行，直接报参数错误。
- **验证**：构造一个非法参数调用，确认在第一个工具前中止。

---

## C. 会话、投影与存储

### 14. Session API 拆成独立接口
- **变更**：可分别读取快照、持续订阅事件日志、运行状态、事件投影数据。
- **B 动作**：不要再用"一个订阅拿全部"；分别订阅，按需组合。
- **验证**：断开重连后快照+增量不重复、不丢事件。

### 15. 会话创建/恢复/销毁期间的事件顺序修复
- **变更**：初始化事件可实时订阅；取消时等待已取得资源完成清理。
- **B 动作**：依赖旧顺序的插件要复核；取消路径上不要假设资源立即释放。
- **验证**：创建→取消→再创建的压力循环，无重复订阅、无泄漏。

### 16. Session Projection 注册 API 改为异步
- **变更**：注册必须 `await`，并在插件启动时持有句柄（`handle.dispose()` 是 async）；
  `stateOf(session, key)` 已废弃，改用 `handle.stateOf(session)`。
- **证据**：0.2.2 `@deepseek-ai/dsh-session-projection/lib/index.js:115-186`（`async acquire()`、
  `handle = { async dispose(), stateOf(session), readerFor(session) }`；`stateOf(session,key)` 标 `@deprecated`）。
- **症状**：投影数据为空/滞后；或启动时报未持有句柄。
- **验证**：启动后立即读投影，应已完成初始化；插件卸载后无残留注册。

### 17. 存储格式兼容
- **变更**：整单元 JSON 与 SQLite 存储支持读取"领域明确声明的旧版本"，并以新格式写入。
- **A 动作**：升级后旧数据可读，但会被重写为新格式 → **升级前备份 `~/.dsh` 会话/存储目录**。
- **症状**：回滚旧版本后读不了新写的数据。
- **验证**：升级后打开一个旧会话；备份后回滚验证可读。

### 18. 普通会话分支不再被识别为子智能体
- **变更**：分支独立运行；真正子智能体保留创建者关系。
- **B 动作**：用"是否有父"判断子智能体的逻辑要改成显式字段。
- **验证**：创建分支会话，确认不显示为子智能体。

---

## D. 模型、请求头与网络

### 19. 模型在提示词组装与 pre-step 前固定
- **变更**：本步模型在组装前确定，重试保持同一选择；插件应通过 `agent.model` 选择模型；
  `agent/request` 不再允许改路由。
- **B 动作**：所有在 `agent/request` 里改 model/路由的代码必须迁移到 `agent.model`。
- **症状**：插件设置的模型被忽略，或被每步重新选择导致缓存失效。
- **验证**：插件指定模型 → 该步所有请求（含重试）都用它。

### 20. 动态请求头（按会话与用途）
- **变更**：pi-ai 支持插件按会话与请求用途提供动态请求头；无效请求头在请求发出前报错。
- **B 动作**：头构造要同步/可抛错；非法头不再"发出去再看"。
- **验证**：注入一个非法头，确认请求前即失败；正常头在服务端可见。

### 21. 未声明容量的自定义模型默认值变更
- **变更**：默认上下文/最大输出改为十进制 1M/128K。
- **A 动作**：小端点必须显式覆盖容量，否则会延迟压缩、超限失败。
- **验证**：查看该模型的 context 配置是否被显式设置。

### 22. pi-ai 1.3.0 模型目录/端点/推理回放
- **变更**：模型目录、端点、推理回放规则同步升级。
- **A 动作**：自定义 provider 的端点/模型名需要按新目录核对。
- **验证**：逐模型发一次最小请求。

### 23. Web Fetch 不再拒绝非公网地址
- **变更**：可用于代理与内网；部署应自行限制网络访问。
- **A 动作**：这是**安全边界变化**：沙箱外部署必须自己加网络限制。
- **验证**：内网地址抓取成功；同时确认外网暴露面已被限制。

### 24. Headless 支持实验性 Auto 自动审核
- **变更**：新能力，默认不启用。
- **A 动作**：按需开启；不在 headless 下假定有人工审批。

---

## E. 插件清单与生态

### 25. 「Git 工作树」并入「变更请求与工作树」
- **变更**：独立插件 `@deepseek-ai/dsh-experimental-tool-worktree` 合并进 forge。
- **A 动作**：**必须**手动从 `dsh.profile.bundles` 移除该包（否则双入口/双工具）。
- **验证**：`bundles` 中不再出现该包；工作树入口仍可用。

### 26. Ralph 循环与会话搜索不再显示在实验性列表
- **变更**：从"实验性"列表移除（仍是官方 bundle，功能保留）。
- **A 动作**：无需移除；若脚本按"experimental"列表筛选要更新。
- **验证**：插件管理页分类正确。

### 27. 官方组合包列表改由 `@deepseek-ai/dsh-official-bundles` 导出
- **变更**：自定义集成需更新原 app-boot 的相关导入。
- **B 动作**：`import { OPTIONAL_BUNDLES, RETIRED_BUNDLES, ... } from '@deepseek-ai/dsh-official-bundles'`。
- **证据**：0.2.2 该包 `lib/index.js` 导出 `PROFILE_TEMPLATES`、`INSTALLATION_OWNED_PROFILE_TUPLES`、
  `RETIRED_BUNDLES`（当前为 `dsh-experimental-schedule-bundle`）、`OPTIONAL_BUNDLES`、`ON_DEMAND_BUNDLES`、
  `PROTECTED_PLUGINS`、`HIDDEN_BUNDLES`、`EXTENSION_BUNDLES`、`MORE_BUNDLES`、`EXPERIMENTAL_BUNDLES`。
- **验证**：`node -e "import('@deepseek-ai/dsh-official-bundles').then(m=>console.log(Object.keys(m)))"`。

### 28. 「自定义插件市场」更名「自定义插件索引」
- **变更**：发现页读取用户添加的索引文件；索引生成器排除 private 版本、标签与默认分支包。
- **A 动作**：旧的"市场"配置迁移到索引文件；私有包不会再被自动索引进公开源。
- **验证**：索引里不再出现 private 版本。

### 29. 插件安装失败诊断与生命周期区分
- **变更**：安装失败显示完整诊断 + Host 日志入口；区分"安装失败"与"安装后启用失败"。
- **A 动作**：排查时先看分类，再决定是依赖问题还是加载期错误。
- **验证**：故意装一个坏包，确认两类错误分开显示。

### 30. 插件管理支持更新第三方包 + 热更新回滚
- **变更**：插件管理页可更新第三方包；热更新失败会尝试恢复旧版本。
- **A 动作**：升级后优先用插件管理页更新社区插件，而不是手改 lockfile。
- **验证**：更新一个插件，失败场景下版本回滚。

---

## 快速自查命令

```powershell
# 1) 运行时版本
"<install>/resources/runtime/cli/bin/dsh.cmd" --version

# 2) 未满足的门禁（这两条命中说明有 bundle 被跳过）
"<install>/resources/runtime/cli/bin/dsh.cmd" --profile <name> --dump-default-config 2>&1 | Select-String -Pattern "incompatible"

# 3) profile 预检（本包脚本）
node scripts/check-profile-compat.mjs --profile "$env:USERPROFILE/.dsh/profiles/<name>" --target 0.2.2-rc.1
```
