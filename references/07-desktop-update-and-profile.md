# 07 · 桌面更新与 profile（worktree 入口、退出时机、诊断、升级 runbook）

**影响谁 / 什么时候踩到**：用桌面版（Electron）升级到 0.2.2-rc.1 的人；profile 里启用了独立「Git 工作树」插件的环境；在 0.2.1 上点过更新但卡在安装的人。踩到时机是**点下更新按钮之后**（应用会关闭、当前会话中断），以及**升级后第一次启动**（插件被跳过、入口消失）。

**证据前缀约定**：

| 前缀 | 实际路径 |
|---|---|
| `MAIN/` | `.update-investigation/work/x022c-07/lib/main.js`（0.2.2-rc.1 解包） |
| `MAIN021/` | `.update-investigation/work/asar/lib/main.js`（0.2.1-rc.5，安装目录同源） |
| `DHOST/` | `.update-investigation/work/x022c-07/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js` |
| `DHOST021/` | `.update-investigation/work/x022c-07b/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js` |
| `OB/` | `.update-investigation/work/x022c-06/dsh/node_modules/@deepseek-ai/dsh-official-bundles/lib/index.js` |
| `FORGE-RM/` | `.update-investigation/work/x022c-06/dsh/node_modules/@deepseek-ai/dsh-experimental-forge-bundle/README.zh.md` |
| `NSIS/` | `.update-investigation/work/x022c-07/node_modules/electron-updater/out/NsisUpdater.js` |
| `RELNOTES.md` | `.update-investigation/RELNOTES.md` |

---

## 1. 「Git 工作树」入口并入「变更请求与工作树」

### 变更
- 0.2.2 新增实验性 bundle `@deepseek-ai/dsh-experimental-forge-bundle`，它在插件页显示为**「变更请求与工作树」**：查看变更请求/检查/diff、在 Git 工作树里开新 Session、同一开关启用 `create_worktree` 工具（`FORGE-RM:12`、`FORGE-RM:30`）。
- 独立的 `@deepseek-ai/dsh-experimental-tool-worktree` **仍在安装里**（`OB:47` 的 `OPTIONAL_BUNDLES`、`OB:132` 的 `EXPERIMENTAL_BUNDLES`），但被列进 `HIDDEN_BUNDLES`（`OB:87-96`）——插件页**不再给它单独一页**。
- 独立包自己的 README 说清楚了归属：Web 与 Desktop 通过「变更请求与工作树」提供本工具，**其他 profile 才需要这个独立组合包**（`…/dsh-experimental-tool-worktree/README.zh.md:12`，本机编码显示为乱码时用 `read` 工具按 UTF-8 打开）。
- 官方口径：已选中独立工作树组合包的 profile，需**在启用新组合包之前**按升级指南调整配置（`FORGE-RM:30` 指向 `docs/upgrade-guide/v0.2.2-alpha.2/forge-worktree-entry/guide.zh.md`，该文档不随安装包发布）。

### 症状
- 插件页里找不到独立的「Git 工作树」项（被 `HIDDEN_BUNDLES` 隐藏），以为功能丢了。
- 没删旧 bundle 就启用 forge bundle：两个 bundle 都提供 `create_worktree` 工具与工作树入口，出现重复工具名/重复菜单项，或工具注册冲突导致该步直接失败。
- 删了 `node_modules` 里的包但没改 `dsh.profile.bundles`：启动时该 bundle 解析失败进 `skippedBundles`，stderr 出现 `skipping profile bundle "@deepseek-ai/dsh-experimental-tool-worktree"`。

### 迁移动作
1. 只改**profile 清单**，不要删包目录：
   ```powershell
   $p = "$env:USERPROFILE\.dsh\profiles\desktop\package.json"
   Copy-Item $p "$p.bak-worktree-$(Get-Date -Format yyyyMMdd-HHmmss)"
   # 手工编辑 dsh.profile.bundles：删掉 "@deepseek-ai/dsh-experimental-tool-worktree"
   ```
   本机该条目是 `bundles` 的**第 5 项**（`.update-investigation/BRIEF.md:21`；文件 `C:\Users\Catherine\.dsh\profiles\desktop\package.json`），现在仍在列表里。
2. 在插件页启用「变更请求与工作树」（官方分组），确认 `create_worktree` 可用。
3. `dependencies` 里的同名条目可保留（不影响加载），要清爽再用插件页卸载。

### 验证方式
- `…dsh.cmd --profile <p> --dump-config` 的 bundle 层里**不应**再有 `@deepseek-ai/dsh-experimental-tool-worktree`，且出现 forge bundle 的层。
- stderr 无对应 `skipping profile bundle`。
- 插件页出现「变更请求与工作树」；输入框勾选「工作树」能开出新 worktree Session，且没有重复的同名工具。

---

## 2. Ralph 循环与会话搜索「不再显示在实验性列表」

### 变更（**与发布说明存在偏差，需按实际代码理解**）
- 发布说明：`Ralph 循环与会话搜索不再显示在实验性列表`（`RELNOTES.md:123`，英文 `:263`）。
- 但 0.2.2-rc.1 实际数据里，两者**仍然**在 `EXPERIMENTAL_BUNDLES`（`OB:134` = `dsh-experimental-session-search`、`OB:137` = `dsh-experimental-ralph-bundle`），也仍在 `MORE_BUNDLES`（`OB:116`、`OB:119`）。
- 0.2.1 判定实验性徽章用的是**包名前缀** heuristic（`.update-investigation/work/x022c-07b/…/dsh-client-ui-plugin-manager/lib/client.js:668`：`pkg.name.startsWith("@deepseek-ai/dsh-experimental-")`）；0.2.2 改成查集合（`.update-investigation/work/x022c-07/…/client.js:2633`：`beta: EXPERIMENTAL_BUNDLES.has(pkg.name)`）。两版结论相同：**这两个包在 rc.1 里仍带实验性徽章**。
- 因此本 rc 里可观察的真实变化只有一条：它们都被放进 `MORE_BUNDLES`，主列表默认不展示，需在「更多」里找到（`OB:111-122`）。

### 症状
- 按发布说明去找"消失的徽章"找不到；或反过来以为 bundle 被删掉了。
- 老 profile 里这两个 bundle 仍然正常加载（列表没删，`OB` 的 `OPTIONAL_BUNDLES` 也仍含它们，`OB:35-36`）。

### 迁移动作
- **不需要迁移**。官方 bundle 仍在，保持启用即可；不想用就在插件页关闭（不要从 `bundles` 手删，除非你确定不再需要会话搜索/Ralph）。
- 如果团队文档依赖"实验性分类"，把它改成"可选 bundle + 主列表隐藏"，别照抄发布说明。

### 验证方式
- 升级后打开插件页 →「更多」：应能搜到「Ralph 循环」「会话搜索」，且仍带实验性徽章。
- 复核代码级别（推荐）：对新 asar 解包后 `grep -n "dsh-experimental-ralph-bundle" <新树>/…/dsh-official-bundles/lib/index.js`，看它落在 `EXPERIMENTAL_BUNDLES` 还是被移出。

---

## 3. 桌面 Host 退出与「0.2.1 更新卡住」的真实机制

### 变更
- Host 侧：0.2.1 的 `stop()` 只做三件事——`application.shutdown.shutdown(0)` → `process.send({type:"shutdown-complete"})` → `process.disconnect()`，**没有 `process.exit()`**（`DHOST021:263-267`）。0.2.2 在 disconnect 之后补了 `if (running !== void 0) process.exit();`（`DHOST:480-488`）。
- 这正是发布说明那条修复：`Exit the Desktop Host immediately after acknowledging completed teardown so leftover event-loop handles do not block update installation`（`RELNOTES.md:245`，中文 `:105`）。
- 主进程侧：更新安装前会 `requireCleanStop = true` 再 `await backend.stop()`；`stop(true)` 给 10s 优雅窗口，超时 `SIGTERM`、再 5s 后 `SIGKILL`，并抛 `DesktopHostUncleanExitError`（`desktop update: Host did not complete graceful task teardown …`）——一旦抛出就变成 `stop-failed`，**安装不会发生**（`MAIN:10127-10143`、`MAIN:20568-20573`；0.2.1 同逻辑见 `MAIN021:3910-3926`、`MAIN021:12360-12366`）。
- 安装手递手：`install(version)` → `beforeRestart()` 成功 → `this.updater.quitAndInstall(true, true)`（`MAIN:15443-15457`），electron-updater 在 Windows 上 spawn 安装器并附 `--updated /S --force-run /D=<安装目录>` 参数（`NSIS:doInstall`）。

### 机制结论（本机可验证的因果链）
0.2.1 上"更新卡住"不是下载问题，而是**退出握手完成但进程不退出**：
1. 用户点安装 → 主进程锁任务、关平台视图、`backend.stop(true)`（`MAIN:20561-20570`）；
2. Host 收到 `shutdown`，完成 `shutdown()`、发出 `shutdown-complete`、断开 IPC —— **但 0.2.1 不再显式退出**，遗留事件循环句柄（计时器/监听器/子进程管道）让 node 进程继续存活；
3. 主进程的 10s 优雅窗口吃满 → `SIGTERM`/`SIGKILL` → `DesktopHostUncleanExitError` → 更新准备阶段报 `stop-failed`；
4. 即使宿主最终被杀掉，安装器（NSIS）在执行 `--updated` 时仍需等待应用进程树退出并释放安装目录内的文件句柄，外部表现就是**进度停在"正在安装"或安装器窗口不出现**。
0.2.2 把第 2 步改成"确认清理完就 `process.exit()`"，第 3-4 步的等待前提消失。

### 症状
- 点「安装并重启」后进度条不动、安装器无窗口、重启后版本仍是 0.2.1。
- 日志/界面报 `desktop update: Host did not complete graceful task teardown (exit … signal SIGKILL … graceful deadline exceeded true)`（`MAIN:10143` 的文案）。
- 任务管理器里仍有 `DeepSeek Harness.exe` 子进程，占着 `resources\app.asar` 或 `resources\runtime\*`。

### 迁移动作
- 首选：**手动升级**（下文 runbook），绕开应用内更新路径。
- 必须走应用内更新时：先退出所有会话、等 Host 空闲、关掉终端/后台任务，再点安装；失败后按 runbook 第 3 步清理残留进程再重试。

### 验证方式
- 升级成功后重复一次「检查更新」（无新版本时应正常结束），确认不再出现 `stop-failed`。
- 退出应用后立刻 `Get-Process -Name 'DeepSeek Harness'` 应为空（0.2.1 上经常有残留，0.2.2 期望立即消失）。

---

## 4. 启动故障诊断报告 + 有界近期插件操作记录

### 变更
- 崩溃/启动失败仍有 `crash-<ISO 时间>-<source>.log`，写到 `app.getPath("logs")`，且报告里新增 `operationHistoryPlanned` 标记（`MAIN:16146-16162`、`MAIN:19991-20009`；命名规则沿用 0.2.1 的 `crash-…-(host|web-boot|renderer|main).log`，`MAIN021:8414-8416`）。
- **新增**操作记录 journal：`%APPDATA%\@deepseek-ai\dsh-desktop\plugin-operations`，上限 64 KiB / 100 条 / 单条 4096 B，输出上限 64 KiB，超时 500 ms（`MAIN:20013-20026`、`MAIN:20372-20377`）。
- 报告默认只保留 10 份，按文件名排序删最旧（`MAIN:16170`）。
- 0.2.1 **没有**这套 journal（在 `MAIN021/` 里 grep `OperationJournal|plugin-operations` 零命中）——所以这是升级后才有的排查手段。
- 崩溃对话框有「获取诊断报告」动作与对应文案（`MAIN:13820-13822`：`getDiagnosticReport`、`reportWrittenTo`、`reportPending`）。

### 症状
- 启动崩溃时只看到对话框；以前拿不到"最近装/改了哪个插件"的线索，现在报告里有。
- 报告目录里文件越堆越多（旧版本），升级后会自动裁剪到 10 份。
- 找不到日志：路径不是安装目录，而是 **`%APPDATA%\@deepseek-ai\dsh-desktop\logs`**（本机实测存在 10+ 个 `crash-*.log`）。

### 迁移动作
- 诊断时按顺序看：对话框 →「获取诊断报告」→ 打开 `%APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-*.log`（最新一份）→ 需要时附上 `plugin-operations` 最近记录。
- 桌面端崩过且插件可疑时，用「禁用全部插件」恢复：注意它会**把 `cordis.patch.yml` 改名为 `.bak-<毫秒时间戳>` 并把 bundles 重置为基础模板**（`MAIN:5517-5531`、`MAIN:5548-5573`），见下一节。

### 验证方式
- 人为触发一次启动失败（例如临时在 `cordis.patch.yml` 写非法 YAML），确认 `logs` 下新增 `crash-*-main.log` 且含 `operationHistoryPlanned`。
- 数一下 `logs` 里 `crash-*.log` 数量 ≤ 10。

---

## 5. 升级 runbook（Windows，可复制）

> **会中断会话的步骤**：第 3 步（关闭应用）之后，当前 GUI 会话立即结束；第 4 步是静默安装，安装器会拉起/等待应用退出。请在**另一个终端**里执行第 1-7 步，或把命令保存成脚本再跑。本文档其余步骤不关闭应用。

```powershell
# 0) 变量（按需改）
$app        = "$env:LOCALAPPDATA\Programs\DeepSeek Harness"
$dsh        = "$app\resources\runtime\cli\bin\dsh.cmd"
$profile    = "$env:USERPROFILE\.dsh\profiles\desktop"
$pending    = "$env:LOCALAPPDATA\@deepseek-aidsh-desktop-updater\pending"
$stamp      = Get-Date -Format 'yyyyMMdd-HHmmss'
```

```powershell
# 1) 备份 profile（不备份 node_modules，1.1 GB 无必要）
$bak = "$env:USERPROFILE\dsh-profile-$stamp"
robocopy $profile $bak /E /XD node_modules /NFL /NDL /NJH /NJS | Out-Null
# robocopy 退出码 0-7 都算成功
Copy-Item "$profile\package.json","$profile\cordis.patch.yml","$profile\pnpm-lock.yaml","$profile\pnpm-workspace.yaml" $bak -ErrorAction SilentlyContinue
if (Test-Path "$profile\compatibility.json") { Copy-Item "$profile\compatibility.json" $bak }
Get-ChildItem $bak | Select-Object Name,Length
```

```powershell
# 2) 校验安装包 sha512（与 electron-updater 的 update-info.json 对齐）
$info  = Get-Content (Join-Path $pending 'update-info.json') -Raw | ConvertFrom-Json
$file  = Join-Path $pending $info.fileName
$hex   = (Get-FileHash $file -Algorithm SHA512).Hash.ToLower()
$bytes = for ($i=0; $i -lt $hex.Length; $i+=2) { [Convert]::ToByte($hex.Substring($i,2),16) }
$b64   = [Convert]::ToBase64String([byte[]]$bytes)
"recorded: $($info.sha512)"
"computed: $b64"
"match   : $($b64 -eq $info.sha512)"     # 本机实测 True，文件 293,425,336 B
```

```powershell
# 3) 关闭应用（含残留 Host 子进程）——会中断当前会话
Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | Select-Object Id,StartTime,Path
# 先礼貌退出
Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | ForEach-Object { $_.CloseMainWindow() | Out-Null }
Start-Sleep -Seconds 5
# 仍在的直接结束（Host 子进程与主进程同名，见 MAIN 的 DesktopHostProcess spawn）
Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 2
if (Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue) { throw '仍有残留进程，先处理再安装' }
```

```powershell
# 4) 静默安装（NSIS；/D 必须是最后一个参数且不加引号）
Start-Process -FilePath $file -ArgumentList '/S' -Wait
# 非默认安装目录时：
# Start-Process -FilePath $file -ArgumentList '/S', "/D=$app" -Wait
```

```powershell
# 5) 重启应用
Start-Process -FilePath "$app\DeepSeek Harness.exe"
Start-Sleep -Seconds 15     # 等 Host 起来
```

```powershell
# 6) 验证版本（两条独立证据）
& $dsh --version            # 期望 0.2.2-rc.1
node -e "const fs=require('fs');const b=fs.readFileSync(process.argv[1]);const hs=b.readUInt32LE(4),jl=b.readUInt32LE(12);const j=JSON.parse(b.subarray(16,16+jl).toString('utf8'));const files=j.files;const pkg=files['package.json'];const base=8+hs;const buf=Buffer.alloc(pkg.size);fs.readSync(fs.openSync(process.argv[1],'r'),buf,0,pkg.size,base+Number(pkg.offset));console.log(JSON.parse(buf.toString('utf8')).version)" "$app\resources\app.asar"
```

```powershell
# 7) 按报告修复被 skip 的插件
& $dsh --profile <profile> --dump-config 2>&1 | Select-String 'skipping profile bundle'
& $dsh plugin --profile <profile> version-exemptions
# 真需要豁免时（先经用户同意，风险自负）：
# & $dsh plugin --profile <profile> allow-version "<pkg>@<ver>" --dsh-version 0.2.2-rc.1 --accept-risk
```
- 桌面 profile 可能被应用独占（`.update-investigation/BRIEF.md:96-97`），被拒时改在 GUI 插件页处理。

**回滚**：关应用 → 用备份覆盖 `package.json` / `cordis.patch.yml` / `pnpm-lock.yaml` → 用旧安装包重装同版本 → 启动。安装包与 pending 目录都可保留一段时间。

---

## 6. profile 的 `package.json` / `cordis.patch.yml` / `pnpm-lock` 在升级中的处理

### 变更（**0.2.2 不会自动同步 profile 依赖**）
- 每次启动只跑 `applyRelease()`，它做四件事：读运行时元数据、迁移**特定旧格式**的 `pnpm-workspace.yaml`、`createPluginProfile`（仅在文件缺失时创建 `package.json`/`cordis.patch.yml`/`pnpm-workspace.yaml`）、清理 0.1.5 遗留的 link projection（`MAIN:5577-5584`、`MAIN:5396-5411`、`MAIN:5548-5553`、`MAIN:5422-5431`）。注释原话：`prepare the external plugin profile without installing packages`（`MAIN:5575`）。
- **不会**跑 pnpm、**不会**改 `dependencies` 的版本、**不会**改 `dsh.profile.bundles`（除恢复流程），也**不会**碰 `pnpm-lock.yaml`。0.2.1 的实现完全相同（`MAIN021:3591-3596`），所以这不是新增行为，而是需要持续记住的事实。
- 恢复流程才会重写清单：`sanitizeProfile` 把 `cordis.patch.yml` 改名为 `cordis.patch.yml.bak-<Date.now()>`，并把 bundles 重置为 `PROFILE_TEMPLATES.web`（`@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app`）；随后 `initProfile` 因文件缺失写入**空模板** `[]`（`MAIN:5517-5531`、`MAIN:5396-5409`）。
- 本机证据：`C:\Users\Catherine\.dsh\profiles\desktop` 里有 5 个 `cordis.patch.yml.bak-<13 位毫秒>`（如 `cordis.patch.yml.bak-1793544442608`），命名与 `MAIN:5520` 的 `${patchPath}.bak-${Date.now()}` 完全一致——**2026-11-01 设置丢失就是这个恢复流程跑过**（`.update-investigation/BRIEF.md:51-53`）。
- 插件包管理失败会回滚 manifest 与 lockfile 到 pnpm 运行前快照（`PM-RM:130`），所以"插件装坏了"通常不会留下半截 `package.json`。

### 症状
- 升级后 profile 里 `@deepseek-ai/dsh-subagent-claude-code` / `dsh-subagent-codex` 仍是 `0.2.1-rc.5`（本机实测磁盘版本也是 `0.2.1-rc.5`），而应用内自带的是 `0.2.2-rc.1` → profile 侧的插件与宿主运行时版本错位，可能出现重复模块/能力缺失。
- 升级后 `cordis.patch.yml` 变成 `[]`（空模板），所有自定义配置与 MCP 插入块消失——真凶不是升级器，而是崩溃恢复/「禁用全部插件」。
- `pnpm-lock.yaml` 与 `package.json` 不一致（手工改过 range）时，下一次插件操作才报错，升级当时无感。

### 迁移动作
1. 升级前**必须**备份 `package.json`、`cordis.patch.yml`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`（runbook 第 1 步已经把整个 profile 备了）。
2. 升级后按需对齐 profile 里的官方插件版本（**这是手工动作，不要期待自动**）：
   ```powershell
   & "$app\resources\runtime\bin\node.cmd" "$app\resources\runtime\primary-runtime\dependencies\pnpm\bin\pnpm.mjs" `
     add "@deepseek-ai/dsh-subagent-claude-code@0.2.2-rc.1" "@deepseek-ai/dsh-subagent-codex@0.2.2-rc.1" --dir $profile
   ```
   或在插件页对这两个包做卸载/重装（走同一套 pnpm 操作，带快照回滚）。
3. `cordis.patch.yml` 被清空时，从最新的 `.bak-<毫秒>` 拷回**内容**（不要直接改名，避免与现有文件冲突），再重启：
   ```powershell
   Get-ChildItem "$profile\cordis.patch.yml.bak-*" | Sort-Object LastWriteTime -Descending | Select-Object -First 3 Name,Length,LastWriteTime
   Copy-Item "$profile\cordis.patch.yml.bak-<最大时间戳>" "$profile\cordis.patch.yml"
   ```
4. 不要用「禁用全部插件」来排障，除非你接受 patch 被改名 + bundles 被重置；排障优先用日志与 `--dump-config`。

### 验证方式
- `node -p "require('C:/Users/Catherine/.dsh/profiles/desktop/package.json').dsh.profile.bundles.length"` 应等于你预期的数量（本机升级前是 28）。
- `Get-Content $profile\cordis.patch.yml -Raw` 非空且不是 `[]`。
- 插件页里 profile 侧 `@deepseek-ai/*` 版本与应用版本一致（不一致时列出清单逐个对齐）。

---

## 复核清单

| 检查 | 命令 | 期望 |
|---|---|---|
| worktree 已移除 | `--dump-config` 的 bundle 层 | 无 `dsh-experimental-tool-worktree` |
| 版本 | `& $dsh --version` | `0.2.2-rc.1` |
| 安装包完整 | sha512 base64 对比 | `match : True` |
| 无残留进程 | `Get-Process -Name 'DeepSeek Harness'` | 空 |
| 被 skip 的插件 | `--dump-config 2>&1 \| Select-String skipping` | 只剩真越界/pin |
| 设置完好 | `cordis.patch.yml` 大小 | 非空、非 `[]` |
| 依赖同步 | profile 的 `@deepseek-ai/*` 版本 | 与 0.2.2-rc.1 对齐（手工） |

**推断项（需复核）**
1. 「更新卡住」在 0.2.1 上的**外部表现**（进度停在"正在安装"/安装器无窗口）是推断：代码证据只能证明"Host 不退出 + 主进程抛 `stop-failed` + 安装器等待进程树退出"这条链，本机没有 0.2.1 卡住的现场日志。复核：升级前先在 0.2.1 上触发一次应用内更新，抓 `logs\crash-*` 与 `plugin-operations`，确认是否出现 `stop-failed`。
2. 移除 worktree bundle 后 `create_worktree` 是否完全由 forge bundle 提供（无残留重复注册）：代码显示 forge bundle 启用即接入该工具（`FORGE-RM:30`），但未在运行时验证。复核：升级后跑一次"让模型创建 worktree"，看工具列表里 `create_worktree` 只出现一次。
3. 本文件第 2 节说「rc.1 仍带实验性徽章」是基于 `OB:124-140` 与客户端 `beta:` 判定；发布说明的"不再显示"可能针对**发现页/市场**而不是插件页。复核：升级后分别看插件页「更多」与发现页，记录徽章实际状态。
