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
  .\scripts\install-service.ps1 -SetAdminPassword    (re)set the password of the administration page (/_admin/)
  .\scripts\install-service.ps1 -SetNotify           (re)enter the update-notification e-mail settings
  .\scripts\install-service.ps1 -AdminWeb            admin page in any browser here: https://<this PC>:8788/
  .\scripts\install-service.ps1 -NoAdminWeb          admin page only on this PC again
  .\scripts\install-service.ps1 -RenewAdminCert      a new self-signed certificate for that page

Layout (config.json and env are created once and never overwritten):
  C:\Program Files\FoundryReleaseProxy\              code (replaced on every run)
  C:\Program Files\FoundryReleaseProxy.prev\         previous code, kept by the updater for rollback
  C:\ProgramData\FoundryReleaseProxy\config.json     module id -> repo mapping (LOCAL SERVICE may rewrite it: admin page)
  C:\ProgramData\FoundryReleaseProxy\admin.json      admin page password hash + notification e-mail settings
                                                    (Administrators/SYSTEM + LOCAL SERVICE read/write)
  C:\ProgramData\FoundryReleaseProxy\env             GITHUB_TOKEN, PORT, ... (Administrators/SYSTEM + LOCAL SERVICE read/write:
                                                    the admin page rewrites its GITHUB_TOKEN line)
  C:\ProgramData\FoundryReleaseProxy\admin-tls.crt/.key  self-signed certificate of the admin port
  C:\ProgramData\FoundryReleaseProxy\logs\proxy.log  proxy log
  C:\ProgramData\FoundryReleaseProxy\auto-update.conf, auto-update.log, updater-token (Administrators/SYSTEM only)

The proxy runs as the scheduled task "FoundryReleaseProxy" under LOCAL SERVICE (node --env-file, Node.js >= 20.6).
The updater runs daily (random delay) as the task "FoundryReleaseProxy-Update" under SYSTEM. "Update proxy now" on the
admin page starts the task "FoundryReleaseProxy-UpdateNow" (SYSTEM, no schedule; LOCAL SERVICE may only run it).
This repository is public, so the updater needs no token; it uses one when there is one (UPDATER_GITHUB_TOKEN, else
the proxy's GITHUB_TOKEN if GitHub accepts it). Tokens come from a hidden prompt or the FOUNDRY_PROXY_GITHUB_TOKEN /
UPDATER_GITHUB_TOKEN environment variables, never from the command line. The same goes for the admin page password (FOUNDRY_PROXY_ADMIN_PASSWORD) and the
notification settings (FOUNDRY_PROXY_NOTIFY_EMAILS, FOUNDRY_PROXY_SMTP_HOST, _PORT, _SECURITY, _USER, _PASSWORD, _FROM).
The browser admin port: FOUNDRY_PROXY_ADMIN_WEB=1 (first install), FOUNDRY_PROXY_ADMIN_PORT (default 8788) and
FOUNDRY_PROXY_ADMIN_PUBLIC_URL; -AdminWeb also opens the port in Windows Firewall (Domain and Private networks).
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
    [switch]$SetAdminPassword,
    [switch]$SetNotify,
    [switch]$AdminWeb,
    [switch]$NoAdminWeb,
    [switch]$RenewAdminCert,
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
$AdminFile = Join-Path $DataDir 'admin.json'
$AdminCert = Join-Path $DataDir 'admin-tls.crt'
$AdminKey = Join-Path $DataDir 'admin-tls.key'
$FirewallRule = "$AppName-Admin"
$AutoConf = Join-Path $DataDir 'auto-update.conf'
$UpdaterTokenFile = Join-Path $DataDir 'updater-token'
$TaskName = $AppName
$UpdateTaskName = "$AppName-Update"
$UpdateNowTaskName = "$AppName-UpdateNow"
$UpdateRepo = 'dxcufgb/FoundryVTT-Private-Github-proxy'
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

# Files the proxy (LOCAL SERVICE) must only read: the admin port's certificate and key.
function Protect-ProxyFile([string]$Path) {
    Protect-Path $Path @("*${SidAdmins}:F", "*${SidSystem}:F", "*${SidLocalService}:R")
}

# Files the proxy (LOCAL SERVICE) reads and rewrites in place from the admin page: config.json, admin.json and env.
# (R,W) and no DELETE: it cannot remove or replace them, and it cannot create files in the data folder.
function Protect-ProxyWritableFile([string]$Path) {
    Protect-Path $Path @("*${SidAdmins}:F", "*${SidSystem}:F", "*${SidLocalService}:(R,W)")
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

$NotifyVars = @('FOUNDRY_PROXY_NOTIFY_EMAILS', 'FOUNDRY_PROXY_SMTP_HOST', 'FOUNDRY_PROXY_SMTP_PORT',
    'FOUNDRY_PROXY_SMTP_SECURITY', 'FOUNDRY_PROXY_SMTP_USER', 'FOUNDRY_PROXY_SMTP_PASSWORD', 'FOUNDRY_PROXY_SMTP_FROM')

# Asks for a new admin page password (twice, hidden); returns '' for "no password" (the page stays off).
function Read-AdminPassword {
    while ($true) {
        $pw = Read-Secret 'Password for the administration page (at least 8 characters; Enter = page off)'
        if (-not $pw) { return '' }
        if ($pw.Length -lt 8) { Write-ProxyLog 'Too short; use at least 8 characters.'; continue }
        if ((Read-Secret 'Repeat the password') -ceq $pw) { return $pw }
        Write-ProxyLog 'The passwords do not match; try again.'
    }
}

# Asks for the notification e-mail settings and puts them into the FOUNDRY_PROXY_* variables of this process.
function Read-NotifySetting {
    Write-ProxyLog 'The proxy can e-mail you when it has updated itself or an automatic update failed.'
    $emails = Read-Host -Prompt 'E-mail addresses for these notifications (comma separated; Enter = none)'
    if (-not $emails) { return }
    $env:FOUNDRY_PROXY_NOTIFY_EMAILS = $emails
    $env:FOUNDRY_PROXY_SMTP_HOST = Read-Host -Prompt 'SMTP server (e.g. smtp.gmail.com)'
    $security = Read-Host -Prompt 'SMTP security, starttls / tls / none [starttls]'
    if (-not $security) { $security = 'starttls' }
    $env:FOUNDRY_PROXY_SMTP_SECURITY = $security
    $port = switch ($security) { 'tls' { '465' } 'none' { '25' } default { '587' } }
    $answer = Read-Host -Prompt "SMTP port [$port]"
    if ($answer) { $port = $answer }
    $env:FOUNDRY_PROXY_SMTP_PORT = $port
    $env:FOUNDRY_PROXY_SMTP_USER = Read-Host -Prompt 'SMTP user name (Enter = no login)'
    if ($env:FOUNDRY_PROXY_SMTP_USER) { $env:FOUNDRY_PROXY_SMTP_PASSWORD = Read-Secret 'SMTP password' }
    $env:FOUNDRY_PROXY_SMTP_FROM = Read-Host -Prompt 'Sender address (From)'
}

# Creates or updates admin.json through src\admin.js; secrets only travel in environment variables of this process.
# $What: first = new file (asks for everything when interactive), password / notify = change that part.
function Write-AdminSetting([string]$What, [string]$Node) {
    if (Test-Interactive) {
        if ($What -ne 'notify' -and -not $env:FOUNDRY_PROXY_ADMIN_PASSWORD) {
            $pw = Read-AdminPassword
            if ($pw) { $env:FOUNDRY_PROXY_ADMIN_PASSWORD = $pw }
        }
        if ($What -ne 'password' -and -not $env:FOUNDRY_PROXY_NOTIFY_EMAILS) { Read-NotifySetting }
    }
    if ($What -eq 'password' -and -not $env:FOUNDRY_PROXY_ADMIN_PASSWORD) {
        throw 'No password given (set FOUNDRY_PROXY_ADMIN_PASSWORD or run this in a console); nothing changed.'
    }
    if ($What -eq 'password') {
        foreach ($name in $NotifyVars) { Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue }
    }
    elseif ($What -eq 'notify') {
        Remove-Item -LiteralPath 'Env:FOUNDRY_PROXY_ADMIN_PASSWORD' -ErrorAction SilentlyContinue
    }
    # An empty file with its final ACL first, so the secrets never sit in a file with looser rights.
    if (-not (Test-Path -LiteralPath $AdminFile)) { Write-TextFile $AdminFile '' }
    Protect-ProxyWritableFile $AdminFile
    try {
        & $Node (Join-Path $AppDir 'src\admin.js') setup $AdminFile | Out-Host
        if ($LASTEXITCODE -ne 0) { throw "could not write $AdminFile (see the message above)" }
    }
    finally {
        Remove-Item -LiteralPath 'Env:FOUNDRY_PROXY_ADMIN_PASSWORD', 'Env:FOUNDRY_PROXY_SMTP_PASSWORD' -ErrorAction SilentlyContinue
    }
}

# KEY=value from env (the last line wins); '' when not set.
function Get-EnvValue([string]$Key) {
    if (-not (Test-Path -LiteralPath $EnvFile)) { return '' }
    $value = ''
    foreach ($line in [IO.File]::ReadAllLines($EnvFile)) {
        if ($line.StartsWith("$Key=")) { $value = $line.Substring($Key.Length + 1) }
    }
    $value
}

# Sets KEY=value in env (in place, so its ACL stays), or removes KEY when the value is ''.
function Write-EnvValue([string]$Key, [string]$Value) {
    $lines = @([IO.File]::ReadAllLines($EnvFile) | Where-Object { -not $_.StartsWith("$Key=") })
    if ($Value) { $lines += "$Key=$Value" }
    Write-TextFile $EnvFile (($lines -join "`r`n") + "`r`n")
}

# True when admin.json holds a password (the admin page is on).
function Test-AdminOn([string]$Node) {
    & $Node (Join-Path $AppDir 'src\admin.js') check $AdminFile | Out-Null
    $LASTEXITCODE -eq 0
}

# True when ADMIN_TLS turns HTTPS off for the admin port.
function Test-TlsOff { (Get-EnvValue 'ADMIN_TLS') -match '^(off|0|false|no)$' }

# Self-signed certificate for the admin port (made once; -Force makes a new one); LOCAL SERVICE may only read it.
function Write-AdminCert([string]$Node, [switch]$Force) {
    if ((Test-Path -LiteralPath $AdminCert) -and (Test-Path -LiteralPath $AdminKey) -and -not $Force) { return }
    $names = @()
    $public = Get-EnvValue 'ADMIN_PUBLIC_URL'
    if ($public) { $names += ([Uri]$public).Host }
    foreach ($f in @($AdminCert, $AdminKey)) {
        if (-not (Test-Path -LiteralPath $f)) { Write-TextFile $f '' }
        Protect-ProxyFile $f
    }
    & $Node (Join-Path $AppDir 'src\selfsigned.js') $AdminCert $AdminKey @names | Out-Host
    if ($LASTEXITCODE -ne 0) { throw 'could not make the admin certificate' }
    foreach ($f in @($AdminCert, $AdminKey)) { Protect-ProxyFile $f }
}

# Serve the admin page to other computers: ADMIN_PORT (FOUNDRY_PROXY_ADMIN_PORT, the current one or 8788) on all
# addresses, HTTPS with the self-signed certificate unless ADMIN_TLS=off, and a Windows Firewall rule for the port.
function Enable-AdminWeb([string]$Node) {
    $port = $env:FOUNDRY_PROXY_ADMIN_PORT
    if (-not $port) { $port = Get-EnvValue 'ADMIN_PORT' }
    if (-not $port) { $port = '8788' }
    $proxyPort = Get-EnvValue 'PORT'
    if (-not $proxyPort) { $proxyPort = '8787' }
    $n = 0
    if (-not [int]::TryParse($port, [ref]$n) -or $n -lt 1 -or $n -gt 65535 -or $port -eq $proxyPort) {
        throw "Invalid admin port '$port' (1-65535, not the proxy's port $proxyPort)."
    }
    if ($env:FOUNDRY_PROXY_ADMIN_PUBLIC_URL) {
        $uri = $null
        if (-not [Uri]::TryCreate($env:FOUNDRY_PROXY_ADMIN_PUBLIC_URL, [UriKind]::Absolute, [ref]$uri)) {
            throw "FOUNDRY_PROXY_ADMIN_PUBLIC_URL is not a URL: $($env:FOUNDRY_PROXY_ADMIN_PUBLIC_URL)"
        }
        Write-EnvValue 'ADMIN_PUBLIC_URL' $env:FOUNDRY_PROXY_ADMIN_PUBLIC_URL
    }
    Write-EnvValue 'ADMIN_PORT' $port
    if (-not (Get-EnvValue 'ADMIN_HOST')) { Write-EnvValue 'ADMIN_HOST' '0.0.0.0' }
    if (-not (Test-TlsOff)) { Write-AdminCert $Node }
    Get-NetFirewallRule -Name $FirewallRule -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    New-NetFirewallRule -Name $FirewallRule -DisplayName 'Foundry Release Proxy admin page' -Direction Inbound `
        -Protocol TCP -LocalPort $port -Action Allow -Profile Domain, Private | Out-Null
    Write-ProxyLog "Admin page for other computers on port $port (Windows Firewall: allowed on Domain and Private networks)."
}

# Serve the admin page only on this PC again: clears ADMIN_PORT and removes the firewall rule.
function Disable-AdminWeb {
    Write-EnvValue 'ADMIN_PORT' ''
    Get-NetFirewallRule -Name $FirewallRule -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    Write-ProxyLog 'Admin page only on this PC again.'
}

# Restarts the proxy task (unless it is disabled because the token is still missing).
function Invoke-ProxyRestart {
    Invoke-ProxyShutdown
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($task -and $task.State -ne 'Disabled') {
        Start-ScheduledTask -TaskName $TaskName
        Write-ProxyLog "Saved; restarted $TaskName."
    }
    else { Write-ProxyLog "Saved; $TaskName is not registered or disabled, so it was not started." }
}

# Logs where the admin page is reachable, for the end of a run.
function Write-AdminInfo([string]$Node) {
    if (-not (Test-AdminOn $Node)) {
        Write-ProxyLog 'Admin:  page off; turn it on with: .\scripts\install-service.ps1 -SetAdminPassword'
        return
    }
    $port = Get-EnvValue 'PORT'
    if (-not $port) { $port = '8787' }
    $adminPort = Get-EnvValue 'ADMIN_PORT'
    if (-not $adminPort) {
        Write-ProxyLog "Admin:  http://localhost:$port/_admin/ (on this PC; for other computers: -AdminWeb)"
        return
    }
    $scheme = 'https'
    if (Test-TlsOff) { $scheme = 'http' }
    Write-ProxyLog "Admin:  $($scheme)://$($env:COMPUTERNAME.ToLower()):$adminPort/ in a browser on any computer here"
    $public = Get-EnvValue 'ADMIN_PUBLIC_URL'
    if ($public) { Write-ProxyLog "        $public (public address)" }
    if ($scheme -eq 'https' -and (Test-Path -LiteralPath $AdminCert)) {
        try {
            $cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 -ArgumentList $AdminCert
            Write-ProxyLog "        self-signed certificate: the browser warns once; SHA-1 thumbprint $($cert.Thumbprint)"
        }
        catch { Write-ProxyLog '        self-signed certificate: the browser warns once' }
    }
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

# "Update proxy now" on the admin page: a SYSTEM task without a schedule that runs the same update as the daily task,
# whether or not daily updates are on. LOCAL SERVICE (the proxy) may read and run it, not change it; a run takes no
# arguments, so the proxy can only say "run now".
function Register-UpdateNowTask {
    $script = Join-Path $AppDir 'scripts\auto-update.ps1'
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' -WorkingDirectory $DataDir `
        -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$script`" -Apply"
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
    $principal = New-ScheduledTaskPrincipal -UserId (Get-AccountName $SidSystem) -LogonType ServiceAccount -RunLevel Highest
    Register-ScheduledTask -TaskName $UpdateNowTaskName -Action $action -Settings $settings -Principal $principal `
        -Description "Update the Foundry release proxy now (from its admin page)" -Force | Out-Null
    $scheduler = New-Object -ComObject 'Schedule.Service'
    $scheduler.Connect()
    $task = $scheduler.GetFolder('\').GetTask($UpdateNowTaskName)
    $task.SetSecurityDescriptor("D:(A;;FA;;;$SidAdmins)(A;;FA;;;$SidSystem)(A;;GRGX;;;$SidLocalService)", 0)
}

function Unregister-UpdateNowTask {
    if (Get-ScheduledTask -TaskName $UpdateNowTaskName -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $UpdateNowTaskName -Confirm:$false
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

# The updater's optional token: UPDATER_GITHUB_TOKEN, the configured one, an optional prompt, or the proxy's own
# GITHUB_TOKEN from env (the updater falls back to no token when GitHub refuses it). Never asks when non-interactive.
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
        Write-ProxyLog "$UpdateRepo is public, so the updater needs no token of its own: it uses the proxy's"
        Write-ProxyLog 'GITHUB_TOKEN when GitHub accepts it, else none (GitHub then allows 60 API requests an hour).'
        $answer = Read-Host -Prompt 'Give the updater a GitHub token of its own anyway? [y/N]'
        if ($answer -match '^[Yy]') {
            $token = Read-Secret 'Updater token (fine-grained, public repositories read-only; Enter for none)'
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
    Write-ProxyLog "Automatic updates on: daily check (random time) of $UpdateRepo (public; token, if any, from $tokenFile)."
    if (-not $IsUpgrade) {
        $rc = Invoke-Updater '-Check'
        if ($rc -eq 75) {
            Write-ProxyLog 'Another update run is in progress; check later with: .\scripts\install-service.ps1 -Check'
        }
        elseif ($rc -ne 0 -and $rc -ne 10) {
            Write-Warning 'The update check failed (GitHub unreachable, or its API rate limit reached?). Try: .\scripts\install-service.ps1 -Check'
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
    Unregister-UpdateNowTask
    Invoke-ProxyShutdown
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    }
    # Before the files: the Inno uninstaller runs from $AppDir, so removing that folder can fail below.
    Get-NetFirewallRule -Name $FirewallRule -ErrorAction SilentlyContinue | Remove-NetFirewallRule
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

if ($SetAdminPassword -or $SetNotify) {
    if (-not (Test-Path -LiteralPath (Join-Path $AppDir 'src\admin.js')) -or -not (Test-Path -LiteralPath $EnvFile)) {
        throw "The proxy is not installed (or too old for the admin page); run .\scripts\install-service.ps1 first."
    }
    if ($SetAdminPassword) { Write-AdminSetting 'password' $node } else { Write-AdminSetting 'notify' $node }
    Invoke-ProxyRestart
    exit 0
}

if ($AdminWeb -or $NoAdminWeb -or $RenewAdminCert) {
    if (-not (Test-Path -LiteralPath (Join-Path $AppDir 'src\selfsigned.js')) -or -not (Test-Path -LiteralPath $EnvFile)) {
        throw "The proxy is not installed (or too old for this); run .\scripts\install-service.ps1 first."
    }
    if ($AdminWeb) { Enable-AdminWeb $node }
    elseif ($NoAdminWeb) { Disable-AdminWeb }
    else { Write-AdminCert $node -Force }
    Invoke-ProxyRestart
    if ($AdminWeb -and -not (Test-AdminOn $node)) {
        Write-Warning 'The admin page has no password yet; set one with: .\scripts\install-service.ps1 -SetAdminPassword'
    }
    Write-AdminInfo $node
    exit 0
}

if ($EnableAutoUpdate -or $DisableAutoUpdate) {
    if (-not (Test-Path -LiteralPath (Join-Path $AppDir 'src\updater.js'))) {
        throw "$AppDir is not installed (or too old for auto-update); run .\scripts\install-service.ps1 -AutoUpdate"
    }
    if ($EnableAutoUpdate) { Enable-AutoUpdate $node } else { Disable-AutoUpdate $node }
    exit 0
}

# Data folder: Administrators and SYSTEM only; LOCAL SERVICE may list it (and rewrite config.json, admin.json, env).
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
    foreach ($item in @('src', 'scripts', 'package.json', 'README.md', 'LICENSE', 'config.example.json', '.env.example')) {
        $path = Join-Path $SrcDir $item
        if (Test-Path -LiteralPath $path) { Copy-Item -LiteralPath $path -Destination $AppDir -Recurse -Force }
    }
}

# Config + env: created once, never overwritten.
if (-not (Test-Path -LiteralPath $ConfigFile)) {
    Copy-Item -LiteralPath (Join-Path $SrcDir 'config.example.json') -Destination $ConfigFile
    Write-ProxyLog "Wrote example config $ConfigFile - edit it to list your modules."
}
Protect-ProxyWritableFile $ConfigFile
# admin.json: created once (asks for the admin password and notification e-mails), never overwritten here.
$adminNew = -not (Test-Path -LiteralPath $AdminFile)
if ($adminNew) { Write-AdminSetting 'first' $node }
Protect-ProxyWritableFile $AdminFile
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
    Protect-ProxyWritableFile $EnvFile
    Write-TextFile $EnvFile ("GITHUB_TOKEN=$token`r`nCONFIG_FILE=$ConfigFile`r`nHOST=127.0.0.1`r`n" +
        "PORT=8787`r`nPUBLIC_BASE_URL=http://localhost:8787`r`n")
    Write-ProxyLog "Wrote $EnvFile."
}
Protect-ProxyWritableFile $EnvFile

# A new admin page: offer it to the browsers of other computers (like Webmin), once.
if ($adminNew -and -not (Get-EnvValue 'ADMIN_PORT') -and (Test-AdminOn $node)) {
    $web = $env:FOUNDRY_PROXY_ADMIN_WEB
    if (-not $web -and (Test-Interactive)) {
        $answer = Read-Host -Prompt "Open the admin page to browsers on other computers (https://$($env:COMPUTERNAME.ToLower()):8788/, like Webmin)? [Y/n]"
        if ($answer -match '^[Nn]') { $web = 'no' } else { $web = 'yes' }
    }
    if ($web -match '^(yes|1|true)$') { Enable-AdminWeb $node }
}
# The certificate of an admin port that was turned on by hand.
if ((Get-EnvValue 'ADMIN_PORT') -and -not (Test-TlsOff)) { Write-AdminCert $node }

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
Register-UpdateNowTask

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
Write-AdminInfo $node
exit 0
