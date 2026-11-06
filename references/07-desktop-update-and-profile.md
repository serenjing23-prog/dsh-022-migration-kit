# 07 · 桌面更新与 profile（worktree 入口、退出时机、诊断、升级 runbook）

**影响谁 / 什么时候踩到**：用桌面版（Electron）升级到 0.2.2-rc.1 的人；profile 里启用了独立「Git 工作树」插件的环境；在 0.2.1 上点过更新但卡在安装的人。踩到时机是**点下更新按钮之后**（应用会关闭、当前会话中断），以及**升级后第一次启动**（插件被跳过、入口消失）。

**证据前缀**（0.2.2-rc.1 解包树用 `asar022/`，0.2.1-rc.5 用 `asar021/`，均由 `npx @electron/asar extract` 解出）：

| 前缀 | 位置 |
|---|---|
| `MAIN/` · `MAIN021/` | `lib/main.js`（桌面壳） |
| `DHOST/` · `DHOST021/` | `dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js` |
| `OB/` | `dsh/node_modules/@deepseek-ai/dsh-official-bundles/lib/index.js` |
| `FORGE-RM/` | `…/dsh-experimental-forge-bundle/README.zh.md` |
| `NSIS/` | `node_modules/electron-updater/out/NsisUpdater.js` |
| `RELNOTES.md` | `.update-investigation/RELNOTES.md` |

---

## 1. 「Git 工作树」入口并入「变更请求与工作树」

### 变更
- 0.2.2 新增实验性 bundle `@deepseek-ai/dsh-experimental-forge-bundle`，插件页显示为**「变更请求与工作树」**：查看变更请求/检查/diff、在 Git 工作树里开新 Session，同一开关启用 `create_worktree` 工具（`FORGE-RM:12`、`:30`）。
- 独立的 `@deepseek-ai/dsh-experimental-tool-worktree` **仍在安装里**（`OB:47` 的 `OPTIONAL_BUNDLES`、`OB:132` 的 `EXPERIMENTAL_BUNDLES`），但进了 `HIDDEN_BUNDLES`（`OB:87-96`）——插件页不再给它单独一页。
- 独立包 README 说清归属：Web/Desktop 由「变更请求与工作树」提供该工具，**其他 profile 才需要这个独立组合包**（`…/dsh-experimental-tool-worktree/README.zh.md:12`，用 `read` 工具按 UTF-8 打开）。
- 官方口径：已选中独立工作树组合包的 profile，需**在启用新组合包之前**按升级指南调整配置（`FORGE-RM:30` 指向 `docs/upgrade-guide/v0.2.2-alpha.2/forge-worktree-entry/guide.zh.md`，该文档不随安装包发布）。

### 症状
- 插件页找不到独立的「Git 工作树」项（被 `HIDDEN_BUNDLES` 隐藏），以为功能丢了。
- 没删旧 bundle 就启用 forge bundle：两者都提供 `create_worktree` 工具与工作树入口，出现重复工具名/菜单项或注册冲突。
- 删了 `node_modules` 里的包却没改 `dsh.profile.bundles`：启动时解析失败进 `skippedBundles`，stderr 出现 `skipping profile bundle "@deepseek-ai/dsh-experimental-tool-worktree"`。

### 迁移动作
- 只改**profile 清单**，不要删包目录。本机该条目是 `dsh.profile.bundles` 的**第 5 项**（`%USERPROFILE%\.dsh\profiles\desktop\package.json`），现在仍在列表里：
  ```powershell
  $p = "$env:USERPROFILE\.dsh\profiles\desktop\package.json"
  Copy-Item $p "$p.bak-worktree-$(Get-Date -Format yyyyMMdd-HHmmss)"
  # 编辑 dsh.profile.bundles：删掉 "@deepseek-ai/dsh-experimental-tool-worktree"
  ```
- 然后在插件页启用「变更请求与工作树」（官方分组）并确认 `create_worktree` 可用；`dependencies` 里的同名条目可保留（不影响加载）。

### 验证方式
- `…dsh.cmd --profile <p> --dump-config` 的 bundle 层里**不应**再有该包，且出现 forge bundle 的层；stderr 无对应 `skipping`。
- 插件页出现「变更请求与工作树」；输入框勾选「工作树」能开出新 worktree Session，且同名工具只有一份。

---

## 2. Ralph 循环与会话搜索「不再显示在实验性列表」

### 变更（**与发布说明有偏差，按实际代码理解**）
- 发布说明写的是「Ralph 循环与会话搜索不再显示在实验性列表」（`RELNOTES.md:123`，英文 `:263`）。
- 但 0.2.2-rc.1 实际数据里两者**仍在** `EXPERIMENTAL_BUNDLES`（`OB:134` session-search、`OB:137` ralph-bundle），也仍在 `MORE_BUNDLES`（`OB:116`、`OB:119`），并且仍列在 `OPTIONAL_BUNDLES`（`OB:35-36`）。
- 徽章判定从 0.2.1 的**包名前缀** heuristic（`…0*b/…dsh-client-ui-plugin-manager/lib/client.js:668`：`pkg.name.startsWith("@deepseek-ai/dsh-experimental-")`）改成集合查表（`…0*/…client.js:2633`：`beta: EXPERIMENTAL_BUNDLES.has(pkg.name)`）。两版结论一致：**rc.1 里仍带实验性徽章**。
- 本 rc 可观察的真实变化只有：二者都在 `MORE_BUNDLES`，主列表默认不展示，要去「更多」里找（`OB:111-122`）。

### 症状
- 按发布说明去找"消失的徽章"找不到；或反过来以为 bundle 被删了（`generated` 列表没删，profile 里它们照常加载）。

### 迁移动作
- **不需要迁移**。官方 bundle 仍在，保持启用即可；不想用就在插件页关闭（别从 `bundles` 手删，除非确定不再需要会话搜索/Ralph）。
- 团队文档里把「实验性分类」改写成「可选 bundle + 主列表隐藏」，不要照抄发布说明。

### 验证方式
- 插件页 →「更多」应能搜到「Ralph 循环」「会话搜索」，且仍带实验性徽章。
- 代码级复核：`grep -n "dsh-experimental-ralph-bundle" <新解包>/…/dsh-official-bundles/lib/index.js`，看它落在 `EXPERIMENTAL_BUNDLES` 还是被移出。

---

## 3. 桌面 Host 退出与「0.2.1 更新卡住」的真实机制

### 变更
- Host 侧：0.2.1 的 `stop()` 只做三件事——`application.shutdown.shutdown(0)` → `process.send({type:"shutdown-complete"})` → `process.disconnect()`，**没有 `process.exit()`**（`DHOST021:263-267`）。0.2.2 在 disconnect 之后补了 `if (running !== void 0) process.exit();`（`DHOST:480-488`）。
- 这就是发布说明那条修复：`Exit the Desktop Host immediately after acknowledging completed teardown so leftover event-loop handles do not block update installation`（`RELNOTES.md:245`，中文 `:105`）。
- 主进程侧：安装前 `requireCleanStop = true` 再 `await backend.stop()`；`stop(true)` 给 10s 优雅窗口，超时 `SIGTERM`、再 5s 后 `SIGKILL`，并抛 `DesktopHostUncleanExitError`（`desktop update: Host did not complete graceful task teardown …`）——一旦抛出就是 `stop-failed`，**安装不会发生**（`MAIN:10127-10143`、`MAIN:20568-20573`；0.2.1 同逻辑 `MAIN021:3910-3926`、`MAIN021:12360-12366`）。
- 安装手递手：`install(version)` → `beforeRestart()` 成功 → `this.updater.quitAndInstall(true, true)`（`MAIN:15443-15457`）；electron-updater 在 Windows spawn 安装器并附 `--updated /S --force-run /D=<安装目录>`（`NSIS/…NsisUpdater.js` 的 `doInstall`）。

### 机制结论（本机可验证的因果链）
0.2.1 上"更新卡住"不是下载问题，而是**退出握手完成但进程不退出**：
1. 用户点安装 → 锁任务、关平台视图、`backend.stop(true)`（`MAIN:20561-20570`）；
2. Host 完成 `shutdown()`、发出 `shutdown-complete`、断开 IPC —— **但 0.2.1 不显式退出**，遗留事件循环句柄（计时器/监听器/子进程管道）让 node 进程继续存活；
3. 主进程 10s 优雅窗口吃满 → `SIGTERM`/`SIGKILL` → `DesktopHostUncleanExitError` → 更新准备阶段报 `stop-failed`；即使最终杀掉，安装器（NSIS）仍需等应用进程树退出并释放安装目录文件句柄，外部表现是**进度停在"正在安装"或安装器窗口不出现**。
0.2.2 把第 2 步改成"确认清理完就 `process.exit()`"，第 3 步的等待前提消失。

### 症状
- 点「安装并重启」后进度条不动、安装器无窗口、重启后版本仍是 0.2.1；日志/界面报 `desktop update: Host did not complete graceful task teardown (exit … signal SIGKILL … graceful deadline exceeded true)`（`MAIN:10143` 的文案）。
- 任务管理器里仍有 `DeepSeek Harness.exe` 子进程，占着 `resources\app.asar` 或 `resources\runtime\*`。

### 迁移动作
- 首选**手动升级**（下文 runbook）；必须走应用内更新时，先退出所有会话、等 Host 空闲、关掉终端与后台任务再点安装，失败后按 runbook 第 3 步清残留进程重试。

### 验证方式
- 升级后重复一次「检查更新」（无新版本应正常结束），确认不再出现 `stop-failed`；退出应用后立刻 `Get-Process -Name 'DeepSeek Harness'` 应为空。

---

## 4. 启动故障诊断报告 + 有界近期插件操作记录

### 变更
- 崩溃/启动失败仍写 `crash-<ISO 时间>-<source>.log` 到 `app.getPath("logs")`，报告里新增 `operationHistoryPlanned`（`MAIN:16146-16162`、`MAIN:19991-20009`；命名沿用 0.2.1 的 `crash-…-(host|web-boot|renderer|main).log`，`MAIN021:8414-8416`）。
- **新增**操作记录 journal：`%APPDATA%\@deepseek-ai\dsh-desktop\plugin-operations`，上限 64 KiB / 100 条 / 单条 4096 B、输出 64 KiB、超时 500 ms（`MAIN:20013-20026`、`MAIN:20372-20377`）；报告默认只保留 10 份，按文件名排序删最旧（`MAIN:16170`）。
- 0.2.1 **没有**这套 journal（`MAIN021/` 里 grep `OperationJournal|plugin-operations` 零命中）——升级后才有这条排查线。
- 崩溃对话框提供「获取诊断报告」与对应文案（`MAIN:13820-13822`：`getDiagnosticReport`、`reportWrittenTo`、`reportPending`）。

### 症状
- 启动崩溃只剩一个对话框；旧版拿不到"最近装/改了哪个插件"的线索。
- 找不到日志：路径不是安装目录，而是 **`%APPDATA%\@deepseek-ai\dsh-desktop\logs`**（本机实测已有 10+ 个 `crash-*.log`）。

### 迁移动作
- 诊断顺序：对话框 →「获取诊断报告」→ `%APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-*.log`（最新一份）→ 需要时附 `plugin-operations` 的近期记录。
- 用「禁用全部插件」排障前先知道代价：它会把 `cordis.patch.yml` 改名为 `.bak-<毫秒时间戳>` 并把 bundles 重置为基础模板（`MAIN:5517-5531`、`MAIN:5548-5573`），见 §6。

### 验证方式
- 人为触发一次启动失败（临时写坏 `cordis.patch.yml`），`logs` 下应新增 `crash-*-main.log` 且含 `operationHistoryPlanned`；`crash-*.log` 数量 ≤ 10。

---

## 5. 升级 runbook（Windows，可复制）

> **会中断会话**：第 3 步（关闭应用）之后当前 GUI 会话立即结束；第 4 步静默安装会等待应用退出。请在**另一个终端**执行第 1-7 步，或存成脚本再跑。其余步骤不关闭应用。

```powershell
# 0) 变量
$app     = "$env:LOCALAPPDATA\Programs\DeepSeek Harness"
$dsh     = "$app\resources\runtime\cli\bin\dsh.cmd"
$profile = "$env:USERPROFILE\.dsh\profiles\desktop"
$pending = "$env:LOCALAPPDATA\@deepseek-aidsh-desktop-updater\pending"
$stamp   = Get-Date -Format 'yyyyMMdd-HHmmss'

# 1) 备份 profile（跳过 node_modules，1.1 GB 无必要；robocopy 退出码 0-7 都算成功）
$bak = "$env:USERPROFILE\dsh-profile-$stamp"
robocopy $profile $bak /E /XD node_modules /NFL /NDL /NJH /NJS | Out-Null
Copy-Item "$profile\package.json","$profile\cordis.patch.yml","$profile\pnpm-lock.yaml","$profile\pnpm-workspace.yaml" $bak -ErrorAction SilentlyContinue
if (Test-Path "$profile\compatibility.json") { Copy-Item "$profile\compatibility.json" $bak }
Get-ChildItem $bak | Select-Object Name,Length

# 2) 校验安装包 sha512（与 electron-updater 的 update-info.json 对齐）
$info  = Get-Content (Join-Path $pending 'update-info.json') -Raw | ConvertFrom-Json
$file  = Join-Path $pending $info.fileName
$hex   = (Get-FileHash $file -Algorithm SHA512).Hash.ToLower()
$bytes = for ($i=0; $i -lt $hex.Length; $i+=2) { [Convert]::ToByte($hex.Substring($i,2),16) }
"match: $([Convert]::ToBase64String([byte[]]$bytes) -eq $info.sha512)"   # 本机实测 True（文件 293,425,336 B）
```

```powershell
# 3) 关闭应用（含残留 Host 子进程）——会中断当前会话
Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | Select-Object Id,StartTime,Path
Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | ForEach-Object { $_.CloseMainWindow() | Out-Null }
Start-Sleep -Seconds 5
# Host 子进程与主进程同名（DesktopHostProcess 用 process.execPath spawn），仍在的直接结束
Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 2
if (Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue) { throw '仍有残留进程，先处理再安装' }
```

```powershell
# 4) 静默安装（NSIS；/D 必须是最后一个参数且不加引号）
Start-Process -FilePath $file -ArgumentList '/S' -Wait
# 非默认安装目录： Start-Process -FilePath $file -ArgumentList '/S', "/D=$app" -Wait

# 5) 重启应用
Start-Process -FilePath "$app\DeepSeek Harness.exe"; Start-Sleep -Seconds 15

# 6) 验证版本（两条独立证据）
(Get-Item "$app\DeepSeek Harness.exe").VersionInfo.FileVersion   # 期望 0.2.2-rc.1（0.2.1 时实测 0.2.1-rc.5）
& $dsh --version                                                  # 期望 0.2.2-rc.1

# 7) 按报告修复被 skip 的插件
& $dsh --profile <profile> --dump-config 2>&1 | Select-String 'skipping profile bundle'
& $dsh plugin --profile <profile> version-exemptions
# 确需豁免时（先经用户同意）：& $dsh plugin --profile <profile> allow-version "<pkg>@<ver>" --dsh-version 0.2.2-rc.1 --accept-risk
```
- 桌面 profile 可能被应用独占（`BRIEF.md:96-97`），被拒时改在 GUI 插件页处理。
- **回滚**：关应用 → 用备份覆盖 `package.json` / `cordis.patch.yml` / `pnpm-lock.yaml` → 用旧安装包重装同版本 → 启动。安装包与 pending 目录可保留一段时间。

---

## 6. profile 的 `package.json` / `cordis.patch.yml` / `pnpm-lock` 在升级中的处理

### 变更（**0.2.2 不会自动同步 profile 依赖**）
- 每次启动只跑 `applyRelease()`，做四件事：读运行时元数据、迁移**特定旧格式**的 `pnpm-workspace.yaml`、`createPluginProfile`（仅在文件缺失时创建 `package.json`/`cordis.patch.yml`/`pnpm-workspace.yaml`）、清理 0.1.5 遗留的 link projection（`MAIN:5577-5584`、`MAIN:5396-5411`、`MAIN:5548-5553`、`MAIN:5422-5431`）。注释原话：`prepare the external plugin profile without installing packages`（`MAIN:5575`）。
- **不会**跑 pnpm、**不会**改 `dependencies` 版本、**不会**改 `dsh.profile.bundles`（除恢复流程），也**不会**碰 `pnpm-lock.yaml`。0.2.1 实现完全相同（`MAIN021:3591-3596`）——不是新增行为，而是必须记住的事实。
- 恢复流程才重写清单：`sanitizeProfile` 把 `cordis.patch.yml` 改名为 `cordis.patch.yml.bak-<Date.now()>` 并把 bundles 重置为 `PROFILE_TEMPLATES.web`（`@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app`），随后 `initProfile` 因文件缺失写入**空模板** `[]`（`MAIN:5517-5531`、`MAIN:5396-5409`）。
- 本机证据：profile 目录里有 5 个 `cordis.patch.yml.bak-<13 位毫秒>`（如 `cordis.patch.yml.bak-1793544442608`），命名与 `MAIN:5520` 的 `${patchPath}.bak-${Date.now()}` 完全一致——**2026-11-01 设置丢失就是这个恢复流程跑过**（`BRIEF.md:51-53`）。
- 插件包管理失败会回滚 manifest 与 lockfile 到 pnpm 运行前快照（见 06 文档 `PM-RM:130`），所以"装坏了"通常不会留下半截 `package.json`。

### 症状
- 升级后 profile 里 `@deepseek-ai/dsh-subagent-claude-code` / `dsh-subagent-codex` 仍是 `0.2.1-rc.5`（本机实测磁盘版本也是 `0.2.1-rc.5`），应用自带的是 `0.2.2-rc.1` → profile 侧插件与宿主运行时版本错位，可能出现重复模块/能力缺失。
- 升级后 `cordis.patch.yml` 变成 `[]`，自定义配置与 MCP 插入块消失——真凶不是升级器，而是崩溃恢复/「禁用全部插件」。
- `pnpm-lock.yaml` 与 `package.json` 不一致（手工改过 range）时，下一次插件操作才报错，升级当时无感。

### 迁移动作
- 升级前**必须**备份四个文件（runbook 第 1 步已备整个 profile）；升级后手工对齐 profile 里的官方插件版本（**不要期待自动**）：
  ```powershell
  & "$app\resources\runtime\bin\node.cmd" "$app\resources\runtime\primary-runtime\dependencies\pnpm\bin\pnpm.mjs" `
    add "@deepseek-ai/dsh-subagent-claude-code@0.2.2-rc.1" "@deepseek-ai/dsh-subagent-codex@0.2.2-rc.1" --dir $profile
  ```
  或在插件页对这两个包卸载/重装（走同一套 pnpm 操作，带快照回滚）。
- `cordis.patch.yml` 被清空时，从最新 `.bak-<毫秒>` 拷回**内容**再重启（别直接改名，避免冲突）：
  ```powershell
  Get-ChildItem "$profile\cordis.patch.yml.bak-*" | Sort-Object LastWriteTime -Descending | Select-Object -First 3 Name,Length,LastWriteTime
  Copy-Item "$profile\cordis.patch.yml.bak-<最大时间戳>" "$profile\cordis.patch.yml"
  ```
- 不要用「禁用全部插件」排障，除非接受 patch 被改名 + bundles 被重置；优先用日志与 `--dump-config`。

### 验证方式
- `node -p "require('%USERPROFILE%/.dsh/profiles/desktop/package.json').dsh.profile.bundles.length"` 应等于预期数量（本机升级前 28）。
- `Get-Content $profile\cordis.patch.yml -Raw` 非空且不是 `[]`；插件页里 profile 侧 `@deepseek-ai/*` 版本与应用版本一致。

## 复核清单

| 检查 | 命令 | 期望 |
|---|---|---|
| worktree 已移除 | `--dump-config` 的 bundle 层 | 无 `dsh-experimental-tool-worktree` |
| 版本 | `(Get-Item "$app\DeepSeek Harness.exe").VersionInfo.FileVersion` | `0.2.2-rc.1` |
| 安装包完整 | sha512 base64 对比 | `match: True` |
| 无残留进程 | `Get-Process -Name 'DeepSeek Harness'` | 空 |
| 被 skip 的插件 | `--dump-config 2>&1 \| Select-String skipping` | 只剩真越界/pin |
| 设置完好 / 依赖 | `cordis.patch.yml`、profile `@deepseek-ai/*` 版本 | 非空非 `[]`、与 0.2.2-rc.1 对齐 |

**推断项（需复核）**
1. 「更新卡住」的**外部表现**（进度停在"正在安装"/安装器无窗口）是推断：代码证据只证明「Host 不退出 → 主进程 `stop-failed` → 安装器等待进程树退出」这条链，本机没有 0.2.1 卡住时的现场日志。复核：升级前先在 0.2.1 上触发一次应用内更新，抓 `logs\crash-*` 与 `plugin-operations`，确认是否出现 `stop-failed`。
2. 移除 worktree bundle 后 `create_worktree` 是否完全由 forge bundle 提供（无残留重复注册），以及"不再显示实验性"是否针对发现页而非插件页：代码只显示 forge bundle 启用即接入该工具（`FORGE-RM:30`）、`EXPERIMENTAL_BUNDLES` 仍含两者（`OB:134`、`OB:137`）。复核：升级后跑一次"让模型创建 worktree"看工具是否只出现一次，并分别看插件页「更多」与发现页的徽章。
