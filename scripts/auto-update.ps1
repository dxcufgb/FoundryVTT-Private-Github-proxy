<#
.SYNOPSIS
Updates the installed Foundry release proxy from the latest GitHub release of this repository.

.DESCRIPTION
Normally run as SYSTEM by the scheduled task "FoundryReleaseProxy-Update" that
`install-service.ps1 -EnableAutoUpdate` registers; `install-service.ps1 -Check` and `-UpdateNow` run it by hand.

  auto-update.ps1 -Check   report whether a newer release exists (exit 0 = up to date, 10 = update available)
  auto-update.ps1 -Apply   download, verify (SHA256SUMS), install it through install-service.ps1 -Upgrade and
                           restart the proxy; on any failure the previous install is put back

The release lookup, version comparison, download and checksum check are in src\updater.js; this script only locks,
extracts, backs up, installs and rolls back. config.json and env are never touched. The GitHub token is read from
the file named in auto-update.conf and never logged. Log: C:\ProgramData\FoundryReleaseProxy\auto-update.log
#>
[CmdletBinding()]
param(
    [switch]$Check,
    [switch]$Apply
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$InformationPreference = 'Continue'

$AppName = 'FoundryReleaseProxy'
$AppDir = Join-Path $env:ProgramFiles $AppName
$BackupDir = "$AppDir.prev"
$DataDir = Join-Path $env:ProgramData $AppName
$AutoConf = Join-Path $DataDir 'auto-update.conf'
$LogFile = Join-Path $DataDir 'auto-update.log'
$TaskName = $AppName

function Write-ProxyLog([string]$Message) {
    $line = '{0} auto-update: {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
    Write-Information -MessageData $line
    try {
        if ((Test-Path -LiteralPath $LogFile) -and (Get-Item -LiteralPath $LogFile).Length -gt 1MB) {
            Move-Item -LiteralPath $LogFile -Destination "$LogFile.1" -Force
        }
        Add-Content -LiteralPath $LogFile -Value $line -Encoding UTF8
    }
    catch {
        Write-Warning "cannot write $LogFile ($($_.Exception.Message))"
    }
}

function Get-Setting([string]$Key) {
    if (-not (Test-Path -LiteralPath $AutoConf)) { return '' }
    $value = ''
    foreach ($line in [IO.File]::ReadAllLines($AutoConf)) {
        if ($line.StartsWith("$Key=")) { $value = $line.Substring($Key.Length + 1) }
    }
    $value
}

function Test-ProxyRunning {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if (-not $task -or $task.State -ne 'Running') { return $false }
    $pattern = "*$(Join-Path $AppDir 'src\server.js')*"
    $proc = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -like $pattern }
    [bool]$proc
}

# Runs an installer copy with -Upgrade in a child Windows PowerShell; returns its exit code.
function Invoke-Installer([string]$Installer, [string]$Node) {
    # Native stderr redirected with 2>&1 must not turn into a terminating error.
    $ErrorActionPreference = 'Continue'
    & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $Installer -Upgrade -NodePath $Node 2>&1 |
        ForEach-Object { Write-ProxyLog "  $_" }
    $LASTEXITCODE
}

# Every entry must sit below <top>/ with no absolute paths, drive letters or "..".
function Test-ZipLayout([string]$Zip, [string]$Top) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [IO.Compression.ZipFile]::OpenRead($Zip)
    try {
        foreach ($entry in $archive.Entries) {
            $name = $entry.FullName.Replace('\', '/')
            if (-not $name.StartsWith("$Top/") -or $name.Contains(':') -or ("/$name/").Contains('/../')) { return $false }
        }
    }
    finally { $archive.Dispose() }
    $true
}

if ($Check -eq $Apply) {
    Write-Error 'Use -Check or -Apply.'
    exit 1
}
$principal = New-Object Security.Principal.WindowsPrincipal ([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Error 'Run this as administrator (the scheduled task runs it as SYSTEM).'
    exit 1
}

$node = Get-Setting 'NODE_PATH'
if (-not $node -or -not (Test-Path -LiteralPath $node)) {
    Write-ProxyLog "ERROR: node.exe from $AutoConf not found; re-run install-service.ps1"
    exit 1
}
if (-not (Test-Path -LiteralPath (Join-Path $AppDir 'src\updater.js'))) {
    Write-ProxyLog "ERROR: $AppDir\src\updater.js not found; is the proxy installed?"
    exit 1
}
$tokenFile = Get-Setting 'TOKEN_FILE'
if (-not $tokenFile) { $tokenFile = Join-Path $DataDir 'env' }
if (-not (Test-Path -LiteralPath $tokenFile)) {
    Write-ProxyLog "ERROR: token file $tokenFile is missing"
    exit 1
}

$mutex = New-Object System.Threading.Mutex($false, "Global\$AppName-Update")
$locked = $false
try { $locked = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $locked = $true }
if (-not $locked) {
    Write-ProxyLog 'another update run is in progress; nothing to do'
    exit 0
}

$work = Join-Path (Join-Path $DataDir 'update-tmp') ([Guid]::NewGuid().ToString('N'))

# Returns the exit code; throws on failure.
function Invoke-Update {
    New-Item -ItemType Directory -Path (Join-Path $work 'download') -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $work 'extract') -Force | Out-Null

    $mode = if ($Check) { '--check' } else { "--download `"$(Join-Path $work 'download')`"" }
    $argLine = "`"$(Join-Path $AppDir 'src\updater.js')`" $mode --format zip --app-dir `"$AppDir`" --token-file `"$tokenFile`""
    $outFile = Join-Path $work 'updater.out'
    $errFile = Join-Path $work 'updater.err'
    $proc = Start-Process -FilePath $node -ArgumentList $argLine -NoNewWindow -Wait -PassThru `
        -RedirectStandardOutput $outFile -RedirectStandardError $errFile
    $out = @(Get-Content -LiteralPath $outFile)
    foreach ($line in $out + @(Get-Content -LiteralPath $errFile)) {
        if ($line -and $line -notmatch '^(ARCHIVE|VERSION)=') { Write-ProxyLog $line }
    }
    $rc = $proc.ExitCode
    if ($Check -or $rc -eq 0) { return $rc }
    if ($rc -ne 10) { throw "update check failed (exit $rc); the installed version is unchanged" }

    $archive = ($out | Where-Object { $_ -like 'ARCHIVE=*' } | Select-Object -First 1) -replace '^ARCHIVE=', ''
    $version = ($out | Where-Object { $_ -like 'VERSION=*' } | Select-Object -First 1) -replace '^VERSION=', ''
    if (-not $archive -or -not (Test-Path -LiteralPath $archive) -or $version -notmatch '^\d+\.\d+\.\d+$') {
        throw 'updater gave no archive'
    }
    $top = "foundry-release-proxy-$version"
    if (-not (Test-ZipLayout $archive $top)) { throw 'archive contains an unexpected path; refusing it' }
    Expand-Archive -LiteralPath $archive -DestinationPath (Join-Path $work 'extract')
    $new = Join-Path $work "extract\$top"
    $newInstaller = Join-Path $new 'scripts\install-service.ps1'
    if (-not (Test-Path -LiteralPath $newInstaller) -or -not (Test-Path -LiteralPath (Join-Path $new 'src\server.js'))) {
        throw 'archive is missing the installer or server'
    }
    $newVersion = (Get-Content -LiteralPath (Join-Path $new 'package.json') -Raw | ConvertFrom-Json).version
    if ($newVersion -ne $version) { throw "archive package.json is not version $version" }

    $installed = (Get-Content -LiteralPath (Join-Path $AppDir 'package.json') -Raw | ConvertFrom-Json).version
    $wasRunning = Test-ProxyRunning
    if (Test-Path -LiteralPath $BackupDir) { Remove-Item -LiteralPath $BackupDir -Recurse -Force }
    Copy-Item -LiteralPath $AppDir -Destination $BackupDir -Recurse
    Write-ProxyLog "backed up $installed to $BackupDir; installing $version"

    $ok = (Invoke-Installer $newInstaller $node) -eq 0
    if ($ok -and $wasRunning) {
        Start-Sleep -Seconds 10
        $ok = Test-ProxyRunning
    }
    if ($ok) {
        Write-ProxyLog "updated $installed -> $version"
        return 0
    }

    Write-ProxyLog "install of $version failed or the proxy did not come back; restoring $installed"
    $restore = Join-Path $work 'restore'
    Copy-Item -LiteralPath $BackupDir -Destination $restore -Recurse
    $restoreInstaller = Join-Path $restore 'scripts\install-service.ps1'
    if (Test-Path -LiteralPath $restoreInstaller) {
        Invoke-Installer $restoreInstaller $node | Out-Null
    }
    else {
        if (Test-Path -LiteralPath $AppDir) { Remove-Item -LiteralPath $AppDir -Recurse -Force }
        Copy-Item -LiteralPath $BackupDir -Destination $AppDir -Recurse
        if ($wasRunning) { Start-ScheduledTask -TaskName $TaskName }
    }
    throw "update to $version rolled back; see the log above"
}

$exitCode = 1
try {
    $exitCode = Invoke-Update
}
catch {
    Write-ProxyLog "ERROR: $($_.Exception.Message)"
    $exitCode = 1
}
finally {
    if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue }
    $mutex.ReleaseMutex()
    $mutex.Dispose()
}
exit $exitCode
