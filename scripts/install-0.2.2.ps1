# DSH desktop updater (runs detached from the DSH process tree)
#
# Works for any pending update the app already downloaded:
# 1. verifies the pending installer (sha512 + Authenticode)
# 2. backs up the profile
# 3. drops bundles the target release retired (edit $removeBundles below)
# 4. closes DSH + leftover Host processes
# 5. runs the installer with the exact electron-updater arguments
# 6. relaunches DSH, verifies the new FileVersion, writes a result log

$ErrorActionPreference = 'Continue'
$log = Join-Path $PSScriptRoot 'install-0.2.2.log'
function Log([string]$msg) {
  $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
  Add-Content -Path $log -Value $line -Encoding UTF8
  Write-Output $line
}
function Finish([int]$code) { Log "EXIT $code"; exit $code }

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
Log "pending installer: $($info.fileName)"
$expectedVersion = ([regex]::Match($info.fileName, '(\d+\.\d+\.\d+(?:-[a-z0-9.]+)?)-win')).Groups[1].Value
Log "expected version: $expectedVersion"

# --- verify ---------------------------------------------------------------
$stream = [IO.File]::OpenRead($installer)
try { $hash = [Convert]::ToBase64String([Security.Cryptography.SHA512]::Create().ComputeHash($stream)) }
finally { $stream.Dispose() }
if ($hash -ne $info.sha512) { Log "sha512 MISMATCH: $hash"; Finish 12 }
Log 'sha512 verified'

$sig = Get-AuthenticodeSignature $installer
if ($sig.Status -ne 'Valid') { Log "signature NOT valid: $($sig.Status)"; Finish 13 }
Log "signature verified: $($sig.SignerCertificate.Subject -replace '\s+', ' ')"

# --- backup ---------------------------------------------------------------
$backup = Join-Path $env:USERPROFILE ("dsh-backup-" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Force $backup | Out-Null
foreach ($f in 'package.json', 'cordis.patch.yml', 'cordis.yml', 'pnpm-lock.yaml') {
  $src = Join-Path $profile $f
  if (Test-Path $src) { Copy-Item $src (Join-Path $backup $f) -Force }
}
Log "profile backed up -> $backup"
$asarBefore = if (Test-Path $asar) { (Get-Item $asar).Length } else { 0 }
Log "app.asar before: $asarBefore bytes"

# --- profile repair: drop bundles the target release retired ---------------
# 0.2.2: Git worktree entry merged into forge; standalone plugin must go.
# 0.2.2-rc.3: agent-team-profile replaced by the unified named-subagent team.
$pkgPath = Join-Path $profile 'package.json'
$removeBundles = @(
  '@deepseek-ai/dsh-experimental-tool-worktree',
  '@deepseek-ai/dsh-experimental-agent-team-profile'
)
try {
  $raw = Get-Content $pkgPath -Raw -Encoding UTF8
  $pkg = $raw | ConvertFrom-Json
  $before = @($pkg.dsh.profile.bundles).Count
  $next = @($pkg.dsh.profile.bundles | Where-Object { $removeBundles -notcontains $_ })
  if ($next.Count -ne $before) {
    $pkg.dsh.profile.bundles = $next
    $json = $pkg | ConvertTo-Json -Depth 30
    # validate before replacing: must parse and keep the expected bundle count
    $check = $json | ConvertFrom-Json
    if (@($check.dsh.profile.bundles).Count -ne $next.Count) { throw 'bundle count mismatch after rewrite' }
    Copy-Item $pkgPath "$pkgPath.bak-before-update" -Force
    Set-Content -Path $pkgPath -Value $json -Encoding UTF8
    Log "removed retired bundle(s) ($before -> $($next.Count))"
  } else { Log 'no retired bundle present (already clean)' }
} catch {
  Log "profile repair failed, original package.json left untouched: $($_.Exception.Message)"
}

# --- close DSH ------------------------------------------------------------
# Force-terminate on purpose: a graceful quit lets electron-updater's
# autoInstallOnAppQuit spawn its own installer, which would race with ours and
# is exactly the path that hangs on 0.2.1 (lingering Host handles).
$procs = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue
if ($procs) {
  Log "force-terminating $($procs.Count) DSH process(es)"
  $procs | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 5
} else { Log 'DSH was not running' }
$left = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue
if ($left) { Log "still running: $($left.Id -join ',')"; $left | Stop-Process -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 3 }

# --- install --------------------------------------------------------------
Log "running installer: $installer --updated /S --force-run"
$p = Start-Process -FilePath $installer -ArgumentList '--updated', '/S', '--force-run' -PassThru
if (-not $p.WaitForExit(600000)) { Log 'installer did not exit in 10 minutes'; }
else { Log "installer exit code: $($p.ExitCode)" }

Start-Sleep -Seconds 10
$asarAfter = if (Test-Path $asar) { (Get-Item $asar).Length } else { 0 }
Log "app.asar after: $asarAfter bytes"

# --- relaunch + verify ----------------------------------------------------
$exe = Join-Path $appDir 'DeepSeek Harness.exe'
if (-not (Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue)) {
  if (Test-Path $exe) { Start-Process -FilePath $exe; Log 'relaunched DSH' }
  else { Log "app executable missing: $exe" }
} else { Log 'DSH already running after install' }
Start-Sleep -Seconds 5

$installedVersion = if (Test-Path $exe) { (Get-Item $exe).VersionInfo.FileVersion } else { '' }
Log "installed version: $installedVersion"
$versionOk = $expectedVersion -ne '' -and $installedVersion -eq $expectedVersion
Log "version match: $versionOk"

# --- record the update and publish it -------------------------------------
# Appends a run record to UPGRADE-LOG.md and pushes it to the public repo, so
# "what changed on this machine" is visible on GitHub without manual work.
$kit = Split-Path $PSScriptRoot -Parent
$upgradeLog = Join-Path $kit 'UPGRADE-LOG.md'
try {
  if (-not (Test-Path $upgradeLog)) {
    Set-Content -Path $upgradeLog -Value "# DSH desktop upgrade log`n`nMachine-generated by scripts/install-0.2.2.ps1. One section per update run.`n" -Encoding UTF8
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
    "- retired bundles dropped from dsh.profile.bundles: $($removeBundles -join ', ')",
    "- result: $(if ($versionOk) { 'update applied' } elseif ($asarAfter -ne $asarBefore) { 'asar replaced, version string differs' } else { 'update NOT applied' })"
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
  } finally {
    Pop-Location
  }
} catch {
  Log "publish step failed (continues): $($_.Exception.Message)"
}

# --- desktop notification -------------------------------------------------
# English-only on purpose: Windows PowerShell 5.1 mis-parses non-ASCII text in a
# UTF-8 file without a BOM, and this script runs under powershell.exe.
try {
  $toast = New-Object -ComObject Wscript.Shell
  $msg = if ($versionOk) { "DSH updated to $expectedVersion. Starting..." } else { "DSH update did not complete (current $installedVersion). See install-0.2.2.log." }
  $toast.Popup($msg, 15, 'DSH update', 64) | Out-Null
  Log 'desktop notification shown'
} catch { Log "notification failed: $($_.Exception.Message)" }

if ($versionOk) { Log 'RESULT: update applied'; Finish 0 }
if ($asarAfter -ne $asarBefore -and $asarAfter -gt 0) { Log 'RESULT: app.asar replaced but version string differs (check installer)'; Finish 0 }
Log 'RESULT: update NOT applied'
Finish 20
