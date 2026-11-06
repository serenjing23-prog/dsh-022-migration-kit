# 升级 runbook：Windows 桌面版（0.2.1-rc.5 → 0.2.2-rc.1）

目标：版本真的换掉、插件不被静默跳过、出问题能回到可用状态。
命令默认 PowerShell，路径按实际替换。

---

## 0. 先决条件

```powershell
$app     = "$env:LOCALAPPDATA\Programs\DeepSeek Harness"
$profile = "$env:USERPROFILE\.dsh\profiles\desktop"
$pending = "$env:LOCALAPPDATA\@deepseek-aidsh-desktop-updater\pending"
```

- 确认待安装包存在且与 `update-info.json` 一致（sha512 由更新器写入）：

```powershell
$info = Get-Content "$pending\update-info.json" -Raw | ConvertFrom-Json
$file = Join-Path $pending $info.fileName
$bytes = [IO.File]::ReadAllBytes($file)
$hash  = [Convert]::ToBase64String([Security.Cryptography.SHA512]::Create().ComputeHash($bytes))
"match = $($hash -eq $info.sha512)"; "file  = $file"
```

- 签名（可选但推荐）：

```powershell
(Get-AuthenticodeSignature $file).Status   # 期望 Valid
```

- 磁盘：安装包约 280 MiB，升级过程需要同量级临时空间。

---

## 1. 备份（升级唯一不可省略的步骤）

```powershell
$backup = "$env:USERPROFILE\dsh-backup-$(Get-Date -Format yyyyMMdd-HHmm)"
New-Item -ItemType Directory -Force $backup | Out-Null
Copy-Item "$profile\package.json","$profile\cordis.patch.yml","$profile\cordis.yml","$profile\pnpm-lock.yaml" $backup -Force
Copy-Item "$env:USERPROFILE\.dsh\storages" "$backup\storages" -Recurse -Force -ErrorAction SilentlyContinue
"backup -> $backup"
```

**注意**：历史上有 DSH 升级把 `cordis.patch.yml` 覆盖成模板的事故。备份后升级完要 `diff` 一次，
不要只看"文件还在"。

---

## 2. 预检 profile（升级前跑，知道会掉什么）

```powershell
node scripts/check-profile-compat.mjs --profile $profile --target 0.2.2-rc.1
```

- `SKIP`：这些 bundle 升级后不会加载 → 先决定"升级该包"还是"接受跳过"。
- `RET`：安装包已退役 → 从 `dsh.profile.bundles` 删掉。
- 特别注意 `@deepseek-ai/dsh-experimental-tool-worktree`：官方要求**手动移除**。

移除示例（改 JSON，不动 node_modules）：

```powershell
$pkgPath = "$profile\package.json"
$pkg = Get-Content $pkgPath -Raw | ConvertFrom-Json
$remove = @('@deepseek-ai/dsh-experimental-tool-worktree')
$pkg.dsh.profile.bundles = @($pkg.dsh.profile.bundles | Where-Object { $remove -notcontains $_ })
$pkg | ConvertTo-Json -Depth 20 | Set-Content $pkgPath -Encoding UTF8
```

---

## 3. 关闭应用与残留 Host

0.2.1 的已知问题：桌面 Host 在退出时可能残留事件循环句柄，**阻塞更新安装**（0.2.2 才修复）。
所以不要指望"点一下自动更新"就一定能装完。

```powershell
# 1) 先正常退出应用（GUI：菜单退出 / 托盘退出）
# 2) 确认没有残留
Get-Process | Where-Object { $_.ProcessName -match 'DeepSeek Harness' } | Select-Object Id,ProcessName
# 3) 仍有残留再强杀（会中断正在跑的会话）
Get-Process | Where-Object { $_.ProcessName -eq 'DeepSeek Harness' } | Stop-Process -Force
```

> 如果当前会话就运行在 DSH 里，这一步会结束它。先把要留下的东西写进文件。

---

## 4. 静默安装

electron-updater 的安装参数（证据：`electron-updater/out/NsisUpdater.js:107-113`）：
`--updated` 必带，`/S` 静默，`--force-run` 装完拉起新版本。

```powershell
Start-Process -FilePath $file -ArgumentList '--updated','/S','--force-run' -Wait
"exit = $LASTEXITCODE"
```

手动执行等价的完整流程（含拉起）：

```powershell
Start-Process -FilePath $file -ArgumentList '--updated','/S','--force-run'
# 等 60-120 秒，然后确认进程与新版本
Get-Process | Where-Object { $_.ProcessName -eq 'DeepSeek Harness' } | Select-Object Id,StartTime
```

---

## 5. 验证（四项，缺一不可）

```powershell
# 1) 版本
& "$app\resources\runtime\cli\bin\dsh.cmd" --version

# 2) 没有 incompatible
& "$app\resources\runtime\cli\bin\dsh.cmd" --profile desktop --dump-default-config 2>&1 |
  Select-String -Pattern 'incompatible'

# 3) 门禁复检
node scripts/check-profile-compat.mjs --profile $profile --target 0.2.2-rc.1

# 4) 冒烟：打开 GUI，逐项各调一次
#    文件读写 / shell / PTC run_code / 子智能体 / MCP 工具 / 插件设置页
```

桌面版 `--profile desktop` 可能被拒绝（"managed exclusively by the Electron application"），
此时用 GUI 的插件管理页或 `--profile <临时 profile>` 做等价验证。

---

## 6. 修复被跳过的插件（升级后）

优先用**插件管理页**（0.2.2 新增"更新第三方插件包"，失败会回滚旧版本），而不是手改 lockfile。
需要命令行时：

```powershell
# 官方插件：把钉死的 0.2.1-rc.5 升到与新运行时同版本
& "$app\resources\runtime\cli\bin\dsh.cmd" plugin --profile <name> add "@deepseek-ai/dsh-subagent-claude-code@0.2.2-rc.1"
```

若某插件暂无兼容版本，可选择：
1. 暂时移除（最安全）；
2. 等作者更新；
3. 用精确版本豁免接受风险（`dsh plugin allow-version` 或插件管理页）——**仅在你接受崩溃/数据丢失风险时**。

---

## 7. 回滚

```powershell
# profile 回滚（应用版本回滚需重装旧安装包）
Copy-Item "<backup>\package.json"      "$profile\package.json" -Force
Copy-Item "<backup>\cordis.patch.yml" "$profile\cordis.patch.yml" -Force
Copy-Item "<backup>\pnpm-lock.yaml"   "$profile\pnpm-lock.yaml" -Force
```

注意：0.2.2 会把存储重写为新格式（可读旧版声明）。**回滚旧版本前**务必用第 1 步的
`storages` 备份覆盖回去。

---

## 8. 常见故障

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 安装器一闪而过，版本没变 | 应用/残留 Host 仍在运行，或安装器被中断 | 强杀宿主进程后重跑 `--updated /S --force-run` |
| 装完启动即崩 | 插件在加载期抛错 | 安全模式/清空 `dsh.profile.bundles` 后逐个加回 |
| GUI 打开但插件不见了 | 门禁跳过 | 第 5 步第 2、3 项定位；升级该插件 |
| 更新提示反复出现 | 更新器缓存与已装版本不一致 | 删除 `%LOCALAPPDATA%\@deepseek-aidsh-desktop-updater\pending` 后重试 |
| 设置/注入块丢失 | `cordis.patch.yml` 被覆盖 | 从第 1 步备份恢复 |
