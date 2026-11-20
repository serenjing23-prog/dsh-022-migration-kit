# DSH desktop updater (runs detached from the DSH process tree)
#
# Fixes learned from the 2026-11-14 failure:
#  - NSIS renames the install dir to "<app>.old-<guid>"; if any file under it is
#    still open, it fails with Windows error 32 and aborts (installer-logs/
#    directory-failure-*.log). So: kill by image path, not just process name,
#    wait for the lock to clear, and PROVE it by moving the dir away first.
#  - Windows PowerShell 5.1 writes a UTF-8 BOM with `Set-Content -Encoding UTF8`;
#    a BOM in the profile package.json makes DSH fail to boot. All JSON writes
#    here use UTF8Encoding($false).
#
# 1. verify pending installer (sha512 + Authenticode)
# 2. back up the profile, drop bundles the target retired (no-BOM rewrite)
# 3. close DSH and any process whose image lives under the install dir
# 4. move the old install dir aside (this is the definitive lock test, with retries)
# 5. install with the electron-updater arguments, relaunch, verify FileVersion
# 6. on failure restore the moved dir; always record + push UPGRADE-LOG.md

$ErrorActionPreference = 'Continue'
$log = Join-Path $PSScriptRoot 'install-0.2.2.log'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Log([string]$msg) {
  $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
  Add-Content -Path $log -Value $line -Encoding UTF8
  Write-Output $line
}
function Finish([int]$code) { Log "EXIT $code"; exit $code }
function Write-NoBom([string]$path, [string]$text) { [IO.File]::WriteAllText($path, $text, $utf8NoBom) }

Log '=== DSH desktop update started ==='

$appDir  = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness'
$asar    = Join-Path $appDir 'resources\app.asar'
$exe     = Join-Path $appDir 'DeepSeek Harness.exe'
$profile = Join-Path $env:USERPROFILE '.dsh\profiles\desktop'
$pending = Join-Path $env:LOCALAPPDATA '@deepseek-aidsh-desktop-updater\pending'

$versionBefore = if (Test-Path $exe) { (Get-Item $exe).VersionInfo.FileVersion } else { '' }
Log "version before: $versionBefore"

$infoPath = Join-Path $pending 'update-info.json'
if (-not (Test-Path $infoPath)) { Log "missing $infoPath"; Finish 10 }
$info = Get-Content $infoPath -Raw | ConvertFrom-Json
$installer = Join-Path $pending $info.fileName
if (-not (Test-Path $installer)) { Log "missing installer $installer"; Finish 11 }
$expectedVersion = ([regex]::Match($info.fileName, '(\d+\.\d+\.\d+(?:-[a-z0-9.]+)?)-win')).Groups[1].Value
Log "pending installer: $($info.fileName) (expected $expectedVersion)"

# idempotent: already on the target version (e.g. this script re-ran from RunOnce)
if ($versionBefore -eq $expectedVersion) {
  Log "already on $expectedVersion; nothing to do"
  if (-not (Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue) -and (Test-Path $exe)) {
    Start-Process -FilePath $exe; Log 'relaunched DSH'
  }
  Finish 0
}

# --- verify ---------------------------------------------------------------
$stream = [IO.File]::OpenRead($installer)
try { $hash = [Convert]::ToBase64String([Security.Cryptography.SHA512]::Create().ComputeHash($stream)) }
finally { $stream.Dispose() }
if ($hash -ne $info.sha512) { Log "sha512 MISMATCH: $hash"; Finish 12 }
Log 'sha512 verified'
$sig = Get-AuthenticodeSignature $installer
if ($sig.Status -ne 'Valid') { Log "signature NOT valid: $($sig.Status)"; Finish 13 }
Log 'signature verified'

# --- backup ---------------------------------------------------------------
$backup = Join-Path $env:USERPROFILE ("dsh-backup-" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Force $backup | Out-Null
foreach ($f in 'package.json', 'cordis.patch.yml', 'cordis.yml', 'pnpm-lock.yaml', 'pnpm-workspace.yaml') {
  $src = Join-Path $profile $f
  if (Test-Path $src) { Copy-Item $src (Join-Path $backup $f) -Force }
}
Log "profile backed up -> $backup"
$asarBefore = if (Test-Path $asar) { (Get-Item $asar).Length } else { 0 }
Log "app.asar before: $asarBefore bytes"

# --- profile repair: drop bundles the target release retired ---------------
$pkgPath = Join-Path $profile 'package.json'
$removeBundles = @(
  '@deepseek-ai/dsh-experimental-tool-worktree',
  '@deepseek-ai/dsh-experimental-agent-team-profile'
)
try {
  $pkg = [IO.File]::ReadAllText($pkgPath) | ConvertFrom-Json
  $before = @($pkg.dsh.profile.bundles).Count
  $next = @($pkg.dsh.profile.bundles | Where-Object { $removeBundles -notcontains $_ })
  if ($next.Count -ne $before) {
    $pkg.dsh.profile.bundles = $next
    $json = $pkg | ConvertTo-Json -Depth 30
    $check = $json | ConvertFrom-Json
    if (@($check.dsh.profile.bundles).Count -ne $next.Count) { throw 'bundle count mismatch after rewrite' }
    Copy-Item $pkgPath "$pkgPath.bak-before-update" -Force
    Write-NoBom $pkgPath $json
    Log "removed retired bundle(s) ($before -> $($next.Count)), written without BOM"
  } else { Log 'no retired bundle present (already clean)' }
} catch {
  Log "profile repair failed, original package.json left untouched: $($_.Exception.Message)"
}

# --- close DSH + anything running from the install dir --------------------
# A plain Stop-Process does not kill children. The desktop Host is a separate
# node process that keeps app.asar mapped, so the install dir stays locked for
# minutes after the Electron processes die. Kill the whole tree with
# `taskkill /T`, then catch anything that still has modules loaded from the
# install dir (process.Path may be unreadable for elevated/system processes,
# but module paths usually are readable).
function Kill-InstallDirHolders([string]$prefix) {
  foreach ($p in (Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue)) {
    Log "  taskkill /T /F $($p.Id) $($p.ProcessName)"
    & taskkill /PID $p.Id /T /F 2>&1 | Out-Null
  }
  Get-Process | ForEach-Object {
    $proc = $_
    $hit = $null
    try { $hit = $proc.Modules | Where-Object { $_.FileName -and $_.FileName.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) } | Select-Object -First 1 } catch {}
    if (-not $hit) { try { if ($proc.Path -and $proc.Path.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { $hit = $proc } } catch {} }
    if ($hit) {
      Log "  kill $($proc.Id) $($proc.ProcessName) (holds install dir)"
      & taskkill /PID $proc.Id /T /F 2>&1 | Out-Null
    }
  }
  foreach ($name in 'WerFault', 'WerFaultSecure') {
    Get-Process -Name $name -ErrorAction SilentlyContinue | ForEach-Object { & taskkill /PID $_.Id /T /F 2>&1 | Out-Null }
  }
}

Log 'closing DSH and any process under the install dir'
Kill-InstallDirHolders $appDir
Start-Sleep -Seconds 5

# wait until nothing is running from the install dir (up to 60s)
for ($i = 0; $i -lt 20; $i++) {
  $still = @()
  Get-Process | ForEach-Object {
    $proc = $_
    $hit = $null
    try { $hit = $proc.Modules | Where-Object { $_.FileName -and $_.FileName.StartsWith($appDir, [StringComparison]::OrdinalIgnoreCase) } | Select-Object -First 1 } catch {}
    if (-not $hit) { try { if ($proc.Path -and $proc.Path.StartsWith($appDir, [StringComparison]::OrdinalIgnoreCase)) { $hit = $proc } } catch {} }
    if ($hit) { $still += "$($proc.Id):$($proc.ProcessName)" }
  }
  if (-not $still) { Log 'no process is using the install dir'; break }
  Log "still using install dir: $($still -join ', ') - waiting"
  Start-Sleep -Seconds 3
  Kill-InstallDirHolders $appDir
}

# --- prove the dir is unlocked by moving it aside -------------------------
$moved = $null
for ($attempt = 1; $attempt -le 30; $attempt++) {
  $candidate = "$appDir.updating-" + (Get-Date -Format 'yyyyMMdd-HHmmss')
  try {
    [IO.Directory]::Move($appDir, $candidate)
    $moved = $candidate
    Log "install dir moved aside after attempt ${attempt}: $candidate"
    break
  } catch {
    Log "attempt ${attempt}: move failed - $($_.Exception.GetType().Name): $($_.Exception.Message)"
  }
  Start-Sleep -Seconds 10
}
if (-not $moved) {
  Log 'ABORT: install dir could not be moved aside after 5 minutes; nothing was changed'
  Log 'hint: close antivirus scanning / File Explorer windows on that folder, or reboot, then rerun'
  # Arm a RunOnce entry: after the next logon nothing holds the install dir, so the
  # same script can finish the update before the user opens DSH.
  try {
    $runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\RunOnce'
    $cmd = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $PSScriptRoot 'install-0.2.2.ps1') + '"'
    Set-ItemProperty -Path $runKey -Name 'DSHUpdate' -Value $cmd -Force
    Log 'armed RunOnce\DSHUpdate: the update will run automatically after the next logon'
  } catch { Log "failed to arm RunOnce: $($_.Exception.Message)" }
  try {
    $w = New-Object -ComObject Wscript.Shell
    $w.Popup("DSH update could not run while DSH was open. Reboot the computer: the update will finish automatically after you sign in.", 20, 'DSH update', 48) | Out-Null
  } catch {}
  if (-not (Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue)) {
    if (Test-Path $exe) { Start-Process -FilePath $exe; Log 'relaunched the existing version so DSH is not left closed' }
  }
  Finish 14
}

# --- install --------------------------------------------------------------
Log "running installer: $installer --updated /S --force-run"
$p = Start-Process -FilePath $installer -ArgumentList '--updated', '/S', '--force-run' -PassThru
if (-not $p.WaitForExit(600000)) { Log 'installer did not exit in 10 minutes' }
else { Log "installer exit code: $($p.ExitCode)" }
Start-Sleep -Seconds 10

$asarAfter = if (Test-Path $asar) { (Get-Item $asar).Length } else { 0 }
$installedVersion = if (Test-Path $exe) { (Get-Item $exe).VersionInfo.FileVersion } else { '' }
Log "app.asar after: $asarAfter bytes; installed version: $installedVersion"
$versionOk = $expectedVersion -ne '' -and $installedVersion -eq $expectedVersion
$dirOk = Test-Path $exe
Log "version match: $versionOk; install dir present: $dirOk"

# surface the installer's own failure log if it wrote one
$failureLogs = Get-ChildItem (Join-Path (Split-Path $pending -Parent) 'installer-logs') -Filter '*.log' -ErrorAction SilentlyContinue |
  Where-Object { $_.LastWriteTime -gt (Get-Date).AddMinutes(-15) }
foreach ($fl in $failureLogs) { Log "installer log $($fl.Name): $((Get-Content $fl.FullName -Raw) -replace '\r?\n', ' | ')" }

# --- failure: restore the old install -------------------------------------
if (-not $dirOk) {
  Log 'restoring the previous install dir (installer did not produce a new one)'
  try {
    Move-Item -LiteralPath $moved -Destination $appDir -ErrorAction Stop
    Log 'restored previous install dir'
    if (Test-Path $exe) { Start-Process -FilePath $exe; Log 'relaunched the previous version' }
  } catch { Log "RESTORE FAILED: $($_.Exception.Message) - old dir kept at $moved" }
  Finish 21
}

# --- success path: clean up the moved-aside dir, relaunch if needed -------
if ($moved -and (Test-Path $moved)) {
  try { Remove-Item -LiteralPath $moved -Recurse -Force -ErrorAction Stop; Log 'removed the moved-aside old install dir' }
  catch { Log "could not remove old install dir (kept at $moved): $($_.Exception.Message)" }
}
if (-not (Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue)) {
  if (Test-Path $exe) { Start-Process -FilePath $exe; Log 'relaunched DSH' }
}
Start-Sleep -Seconds 5

# --- record the update and publish it -------------------------------------
$kit = Split-Path $PSScriptRoot -Parent
$upgradeLog = Join-Path $kit 'UPGRADE-LOG.md'
try {
  if (-not (Test-Path $upgradeLog)) {
    Write-NoBom $upgradeLog "# DSH desktop upgrade log`n`nMachine-generated by scripts/install-0.2.2.ps1. One section per update run.`n"
  }
  $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
  $record = @(
    '',
    "## $stamp - $expectedVersion",
    '',
    "- pending installer: ``$($info.fileName)`` (sha512 verified, Authenticode valid)",
    "- version before: ``$versionBefore`` -> after: ``$installedVersion`` (match: $versionOk)",
    "- app.asar: $asarBefore -> $asarAfter bytes",
    "- profile backup: ``$backup``",
    "- install dir moved aside and old copy removed: $([bool]$moved)",
    "- result: $(if ($versionOk) { 'update applied' } else { 'installed but version mismatch' })"
  ) -join "`n"
  Add-Content -Path $upgradeLog -Value $record -Encoding UTF8
  Log "wrote $upgradeLog"

  Push-Location $kit
  try {
    $env:GIT_TERMINAL_PROMPT = '0'
    $env:GIT_SSH_COMMAND = 'ssh -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new'
    & git add UPGRADE-LOG.md 2>&1 | Out-Null
    & git -c user.name="serenjing23-prog" -c user.email="serenjing23@gmail.com" commit -m "chore: record desktop update to $expectedVersion ($stamp)" 2>&1 | Out-Null
    $pushOut = & git push 2>&1 | Out-String
    Log ("git push: " + ($pushOut.Trim() -replace "`r?`n", ' / '))
  } finally { Pop-Location }
} catch { Log "publish step failed (continues): $($_.Exception.Message)" }

# --- desktop notification -------------------------------------------------
try {
  $toast = New-Object -ComObject Wscript.Shell
  $msg = if ($versionOk) { "DSH updated to $expectedVersion. Starting..." } else { "DSH update did not complete (current $installedVersion). See install-0.2.2.log." }
  $toast.Popup($msg, 15, 'DSH update', 64) | Out-Null
  Log 'desktop notification shown'
} catch { Log "notification failed: $($_.Exception.Message)" }

if ($versionOk) { Log 'RESULT: update applied'; Finish 0 }
Log 'RESULT: update NOT applied'
Finish 20
