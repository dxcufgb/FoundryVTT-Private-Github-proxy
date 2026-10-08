<#
.SYNOPSIS
Installs (or removes) the Foundry release proxy on Windows as a scheduled task that starts at boot.

.DESCRIPTION
Run from an elevated Windows PowerShell 5.1 (or newer) prompt in the unpacked release folder:

  .\scripts\install-service.ps1                      install or update the code, then (re)start
  .\scripts\install-service.ps1 -AutoUpdate          same, and turn on automatic updates
  .\scripts\install-service.ps1 -EnableAutoUpdate    turn automatic updates on for an existing install
  .\scripts\install-service.ps1 -DisableAutoUpdate   turn them off again
  .\scripts\install-service.ps1 -Check               is a newer release available? (report only)
  .\scripts\install-service.ps1 -UpdateNow           install the latest release now
  .\scripts\install-service.ps1 -Uninstall           remove tasks, updater and code (keeps config and env)

Layout (config.json and env are created once and never overwritten):
  C:\Program Files\FoundryReleaseProxy\              code (replaced on every run)
  C:\Program Files\FoundryReleaseProxy.prev\         previous code, kept by the updater for rollback
  C:\ProgramData\FoundryReleaseProxy\config.json     module id -> repo mapping
  C:\ProgramData\FoundryReleaseProxy\env             GITHUB_TOKEN, PORT, ... (Administrators/SYSTEM + LOCAL SERVICE read)
  C:\ProgramData\FoundryReleaseProxy\logs\proxy.log  proxy log
  C:\ProgramData\FoundryReleaseProxy\auto-update.conf, auto-update.log, updater-token (Administrators/SYSTEM only)

The proxy runs as the scheduled task "FoundryReleaseProxy" under LOCAL SERVICE (node --env-file, Node.js >= 20.6).
The updater runs daily (random delay) as the task "FoundryReleaseProxy-Update" under SYSTEM.
Tokens come from a hidden prompt or the FOUNDRY_PROXY_GITHUB_TOKEN / UPDATER_GITHUB_TOKEN environment variables,
never from the command line.
#>
[CmdletBinding()]
param(
    [switch]$Uninstall,
    [switch]$AutoUpdate,
    [switch]$NoAutoUpdate,
    [switch]$EnableAutoUpdate,
    [switch]$DisableAutoUpdate,
    [switch]$Check,
    [switch]$UpdateNow,
    # Non-interactive re-install that keeps every setting; used by the updater.
    [switch]$Upgrade,
    [string]$NodePath
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$InformationPreference = 'Continue'

$AppName = 'FoundryReleaseProxy'
$AppDir = Join-Path $env:ProgramFiles $AppName
$BackupDir = "$AppDir.prev"
$DataDir = Join-Path $env:ProgramData $AppName
$LogDir = Join-Path $DataDir 'logs'
$EnvFile = Join-Path $DataDir 'env'
$ConfigFile = Join-Path $DataDir 'config.json'
$AutoConf = Join-Path $DataDir 'auto-update.conf'
$UpdaterTokenFile = Join-Path $DataDir 'updater-token'
$TaskName = $AppName
$UpdateTaskName = "$AppName-Update"
$UpdateRepo = 'dxcufgb/FoundryVTT-Realese-proxy'
$SrcDir = Split-Path -Parent $PSScriptRoot
$Utf8 = New-Object System.Text.UTF8Encoding $false
$IsUpgrade = [bool]$Upgrade
$NodeOverride = $NodePath

# Well-known SIDs, so nothing depends on the Windows display language.
$SidAdmins = 'S-1-5-32-544'
$SidSystem = 'S-1-5-18'
$SidLocalService = 'S-1-5-19'

function Write-ProxyLog([string]$Message) {
    Write-Information -MessageData $Message
}

function Get-AccountName([string]$Sid) {
    (New-Object System.Security.Principal.SecurityIdentifier $Sid).Translate([System.Security.Principal.NTAccount]).Value
}

function Test-Interactive {
    -not $IsUpgrade -and [Environment]::UserInteractive -and -not [Console]::IsInputRedirected
}

# KEY=value from auto-update.conf.
function Get-Setting([string]$Key) {
    if (-not (Test-Path -LiteralPath $AutoConf)) { return '' }
    $value = ''
    foreach ($line in [IO.File]::ReadAllLines($AutoConf)) {
        if ($line.StartsWith("$Key=")) { $value = $line.Substring($Key.Length + 1) }
    }
    $value
}

# Replaces the ACL of a path with exactly the given grants (icacls syntax), with inheritance from the parent cut.
function Protect-Path([string]$Path, [string[]]$Grant) {
    & icacls.exe $Path /reset /Q | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "icacls /reset failed for $Path" }
    $grantArgs = @()
    foreach ($g in $Grant) { $grantArgs += '/grant:r'; $grantArgs += $g }
    & icacls.exe $Path /inheritance:r @grantArgs /Q | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "icacls failed for $Path" }
}

# Files only Administrators and SYSTEM may read (updater token, auto-update.conf).
function Protect-AdminFile([string]$Path) {
    Protect-Path $Path @("*${SidAdmins}:F", "*${SidSystem}:F")
}

# Files the proxy (LOCAL SERVICE) must read: config.json and env.
function Protect-ProxyFile([string]$Path) {
    Protect-Path $Path @("*${SidAdmins}:F", "*${SidSystem}:F", "*${SidLocalService}:R")
}

function Write-TextFile([string]$Path, [string]$Text) {
    [IO.File]::WriteAllText($Path, $Text, $Utf8)
}

function Read-Secret([string]$Prompt) {
    $secure = Read-Host -Prompt $Prompt -AsSecureString
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}

function Test-Admin {
    $principal = New-Object Security.Principal.WindowsPrincipal ([Security.Principal.WindowsIdentity]::GetCurrent())
    $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Resolve-NodePath {
    $node = $NodeOverride
    if (-not $node) { $node = Get-Setting 'NODE_PATH' }
    if (-not $node) {
        $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
        if ($cmd) { $node = $cmd.Source }
    }
    if (-not $node -or -not (Test-Path -LiteralPath $node)) {
        throw 'node.exe not found. Install Node.js 20.6 or newer for all users, or pass -NodePath C:\path\to\node.exe'
    }
    $node = (Resolve-Path -LiteralPath $node).Path
    $usersDir = Join-Path $env:SystemDrive 'Users'
    if ($node.StartsWith($usersDir, [StringComparison]::OrdinalIgnoreCase)) {
        throw "node.exe at $node is inside a user profile (nvm?), which LOCAL SERVICE cannot use. Install Node.js for all users or pass -NodePath."
    }
    $version = & $node -p 'process.versions.node'
    if ($LASTEXITCODE -ne 0 -or -not $version) { throw "cannot run $node to read its version" }
    $version = "$version".Trim()
    $parts = $version.Split('.') | ForEach-Object { [int]$_ }
    if ($parts[0] -lt 20 -or ($parts[0] -eq 20 -and $parts[1] -lt 6)) {
        throw "Node.js $version is too old; the Windows service needs 20.6 or newer (node --env-file)."
    }
    $node
}

function Invoke-ProxyShutdown {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($task) { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue }
    # The task runs node through cmd.exe; make sure no proxy node.exe outlives it.
    $pattern = "*$(Join-Path $AppDir 'src\server.js')*"
    Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
        Where-Object { $_.CommandLine -like $pattern } |
        ForEach-Object { Invoke-CimMethod -InputObject $_ -MethodName Terminate | Out-Null }
    Start-Sleep -Seconds 1
}

function Unregister-UpdaterTask {
    if (Get-ScheduledTask -TaskName $UpdateTaskName -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $UpdateTaskName -Confirm:$false
    }
}

function Invoke-Updater([string]$Mode) {
    $script = Join-Path $AppDir 'scripts\auto-update.ps1'
    if (-not (Test-Path -LiteralPath $script)) { throw "$AppDir has no updater; install this version first." }
    & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $script $Mode | Out-Host
    $LASTEXITCODE
}

function Write-AutoUpdateConf([string]$Enabled, [string]$TokenFile, [string]$Node) {
    Write-TextFile $AutoConf "AUTO_UPDATE=$Enabled`r`nTOKEN_FILE=$TokenFile`r`nNODE_PATH=$Node`r`n"
    Protect-AdminFile $AutoConf
}

# The updater's token: UPDATER_GITHUB_TOKEN, a prompt, or the proxy's own GITHUB_TOKEN from env.
function Get-UpdaterTokenFile {
    $current = Get-Setting 'TOKEN_FILE'
    $token = ''
    if ($env:UPDATER_GITHUB_TOKEN) {
        $token = $env:UPDATER_GITHUB_TOKEN
    }
    elseif ($current -and (Test-Path -LiteralPath $current)) {
        return $current
    }
    elseif (Test-Interactive) {
        Write-ProxyLog "The updater needs a GitHub token that can read releases of $UpdateRepo."
        Write-ProxyLog "The proxy's own GITHUB_TOKEN works if you also give it Contents: read-only on that repository."
        $answer = Read-Host -Prompt "Use the proxy's GITHUB_TOKEN from $EnvFile? [Y/n]"
        if ($answer -match '^[Nn]') {
            $token = Read-Secret "Updater token (fine-grained, Contents: read-only on $UpdateRepo)"
        }
    }
    if ($token) {
        if (-not (Test-Path -LiteralPath $UpdaterTokenFile)) { Write-TextFile $UpdaterTokenFile '' }
        Protect-AdminFile $UpdaterTokenFile
        Write-TextFile $UpdaterTokenFile "$token`r`n"
        return $UpdaterTokenFile
    }
    $EnvFile
}

function Register-UpdaterTask {
    $script = Join-Path $AppDir 'scripts\auto-update.ps1'
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' -WorkingDirectory $DataDir `
        -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$script`" -Apply"
    $trigger = New-ScheduledTaskTrigger -Daily -At '03:00' -RandomDelay (New-TimeSpan -Hours 6)
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
    $principal = New-ScheduledTaskPrincipal -UserId (Get-AccountName $SidSystem) -LogonType ServiceAccount -RunLevel Highest
    Register-ScheduledTask -TaskName $UpdateTaskName -Action $action -Trigger $trigger -Settings $settings `
        -Principal $principal -Description "Daily update check for the Foundry release proxy ($UpdateRepo)" -Force | Out-Null
}

function Enable-AutoUpdate([string]$Node) {
    $tokenFile = Get-UpdaterTokenFile
    Write-AutoUpdateConf -Enabled 'yes' -TokenFile $tokenFile -Node $Node
    Register-UpdaterTask
    Write-ProxyLog "Automatic updates on: daily check (random time) of $UpdateRepo, token from $tokenFile."
    if (-not $IsUpgrade) {
        $rc = Invoke-Updater '-Check'
        if ($rc -ne 0 -and $rc -ne 10) {
            Write-Warning "The update check failed; make sure the token in $tokenFile can read $UpdateRepo. Try: .\scripts\install-service.ps1 -Check"
        }
    }
}

function Disable-AutoUpdate([string]$Node) {
    Unregister-UpdaterTask
    if (Test-Path -LiteralPath $UpdaterTokenFile) { Remove-Item -LiteralPath $UpdaterTokenFile -Force }
    Write-AutoUpdateConf -Enabled 'no' -TokenFile '' -Node $Node
    Write-ProxyLog 'Automatic updates off.'
}

if (-not (Test-Admin)) {
    Write-Error 'Please run this from an elevated PowerShell (Run as administrator).'
    exit 1
}

if ($Uninstall) {
    Unregister-UpdaterTask
    Invoke-ProxyShutdown
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    }
    foreach ($dir in @($AppDir, $BackupDir, (Join-Path $DataDir 'update-tmp'))) {
        if (Test-Path -LiteralPath $dir) { Remove-Item -LiteralPath $dir -Recurse -Force }
    }
    foreach ($file in @($UpdaterTokenFile, $AutoConf)) {
        if (Test-Path -LiteralPath $file) { Remove-Item -LiteralPath $file -Force }
    }
    Write-ProxyLog "Removed the $TaskName tasks, the updater and $AppDir."
    Write-ProxyLog "Kept $DataDir (config.json, env with the token, logs); delete it by hand if wanted."
    exit 0
}

if ($Check) { exit (Invoke-Updater '-Check') }
if ($UpdateNow) { exit (Invoke-Updater '-Apply') }

$node = Resolve-NodePath

if ($EnableAutoUpdate -or $DisableAutoUpdate) {
    if (-not (Test-Path -LiteralPath (Join-Path $AppDir 'src\updater.js'))) {
        throw "$AppDir is not installed (or too old for auto-update); run .\scripts\install-service.ps1 -AutoUpdate"
    }
    if ($EnableAutoUpdate) { Enable-AutoUpdate $node } else { Disable-AutoUpdate $node }
    exit 0
}

# Data folder: Administrators and SYSTEM only; LOCAL SERVICE may list it and reads config.json and env.
if (-not (Test-Path -LiteralPath $DataDir)) { New-Item -ItemType Directory -Path $DataDir | Out-Null }
Protect-Path $DataDir @("*${SidAdmins}:(OI)(CI)F", "*${SidSystem}:(OI)(CI)F", "*${SidLocalService}:RX")
if (-not (Test-Path -LiteralPath $LogDir)) { New-Item -ItemType Directory -Path $LogDir | Out-Null }
Protect-Path $LogDir @("*${SidAdmins}:(OI)(CI)F", "*${SidSystem}:(OI)(CI)F", "*${SidLocalService}:(OI)(CI)M")

# Code: replaced on each run (stop the proxy first so nothing holds the folder).
Invoke-ProxyShutdown
$appFull = [IO.Path]::GetFullPath($AppDir).TrimEnd('\')
if ([IO.Path]::GetFullPath($SrcDir).TrimEnd('\') -ne $appFull) {
    if (Test-Path -LiteralPath $AppDir) { Remove-Item -LiteralPath $AppDir -Recurse -Force }
    New-Item -ItemType Directory -Path $AppDir | Out-Null
    foreach ($item in @('src', 'scripts', 'package.json', 'README.md', 'config.example.json', '.env.example')) {
        $path = Join-Path $SrcDir $item
        if (Test-Path -LiteralPath $path) { Copy-Item -LiteralPath $path -Destination $AppDir -Recurse -Force }
    }
}

# Config + env: created once, never overwritten.
if (-not (Test-Path -LiteralPath $ConfigFile)) {
    Copy-Item -LiteralPath (Join-Path $SrcDir 'config.example.json') -Destination $ConfigFile
    Write-ProxyLog "Wrote example config $ConfigFile - edit it to list your modules."
}
Protect-ProxyFile $ConfigFile
if (-not (Test-Path -LiteralPath $EnvFile)) {
    $token = 'REPLACE_ME'
    if ($env:FOUNDRY_PROXY_GITHUB_TOKEN) {
        $token = $env:FOUNDRY_PROXY_GITHUB_TOKEN
    }
    elseif (Test-Interactive) {
        $entered = Read-Secret 'GitHub token (fine-grained, Contents: read-only; Enter to fill in later)'
        if ($entered) { $token = $entered }
    }
    Write-TextFile $EnvFile ''
    Protect-ProxyFile $EnvFile
    Write-TextFile $EnvFile ("GITHUB_TOKEN=$token`r`nCONFIG_FILE=$ConfigFile`r`nHOST=127.0.0.1`r`n" +
        "PORT=8787`r`nPUBLIC_BASE_URL=http://localhost:8787`r`n")
    Write-ProxyLog "Wrote $EnvFile."
}
Protect-ProxyFile $EnvFile

# Launcher: rotates the log at 5 MB, then runs node with the env file.
$launcher = Join-Path $AppDir 'run-proxy.cmd'
$log = Join-Path $LogDir 'proxy.log'
Write-TextFile $launcher (@(
        '@echo off',
        "for %%F in (`"$log`") do if %%~zF GTR 5000000 move /y `"$log`" `"$log.1`" >nul",
        "`"$node`" --env-file=`"$EnvFile`" `"$(Join-Path $AppDir 'src\server.js')`" >> `"$log`" 2>&1"
    ) -join "`r`n")

# Proxy task: at boot, plus every 5 minutes so a crashed proxy comes back (IgnoreNew skips it while running).
$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/d /c `"$launcher`"" -WorkingDirectory $DataDir
$triggers = @(
    (New-ScheduledTaskTrigger -AtStartup),
    (New-ScheduledTaskTrigger -Once -At (Get-Date).Date -RepetitionInterval (New-TimeSpan -Minutes 5))
)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero)
$principal = New-ScheduledTaskPrincipal -UserId (Get-AccountName $SidLocalService) -LogonType ServiceAccount -RunLevel Limited
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $triggers -Settings $settings -Principal $principal `
    -Description 'Foundry VTT private-release proxy' -Force | Out-Null

$placeholder = [IO.File]::ReadAllLines($EnvFile) | Where-Object { $_ -eq 'GITHUB_TOKEN=REPLACE_ME' }
if ($placeholder) {
    Disable-ScheduledTask -TaskName $TaskName | Out-Null
    Write-ProxyLog "Task registered but NOT started: put your token in $EnvFile, then run:"
    Write-ProxyLog "  Enable-ScheduledTask $TaskName; Start-ScheduledTask $TaskName"
}
else {
    Start-ScheduledTask -TaskName $TaskName
    Write-ProxyLog "Installed task $TaskName (account: LOCAL SERVICE, code: $AppDir, config: $DataDir)."
}

# Automatic updates: the command line wins, then the saved choice, then (first install only) a prompt.
$saved = Get-Setting 'AUTO_UPDATE'
$choice = ''
if ($AutoUpdate) { $choice = 'yes' }
elseif ($NoAutoUpdate) { $choice = 'no' }
elseif ($saved) { $choice = $saved }
elseif (Test-Interactive) {
    $answer = Read-Host -Prompt 'Turn on automatic updates (daily check for new releases of this proxy)? [y/N]'
    if ($answer -match '^[Yy]') { $choice = 'yes' } else { $choice = 'no' }
}
else { $choice = 'no' }

if ($choice -eq 'yes') { Enable-AutoUpdate $node }
elseif ($saved -eq 'yes' -or (Get-ScheduledTask -TaskName $UpdateTaskName -ErrorAction SilentlyContinue)) { Disable-AutoUpdate $node }
else { Write-AutoUpdateConf -Enabled 'no' -TokenFile '' -Node $node }

Write-ProxyLog "Status: Get-ScheduledTask $TaskName | Select-Object State"
Write-ProxyLog "Logs:   Get-Content -Wait $log"
exit 0
