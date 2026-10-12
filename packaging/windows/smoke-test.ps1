<#
.SYNOPSIS
Installs the built installer silently on this (disposable, elevated) Windows machine, checks that the proxy answers,
then uninstalls it again. Used by CI; do not run it on a machine whose real proxy you care about.

.EXAMPLE
.\packaging\windows\smoke-test.ps1 -Installer dist\foundry-release-proxy-1.2.0-setup.exe
#>
[CmdletBinding()]
param([Parameter(Mandatory)][string]$Installer)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$Installer = (Resolve-Path -LiteralPath $Installer).Path
$data = Join-Path $env:ProgramData 'FoundryReleaseProxy'
$app = Join-Path $env:ProgramFiles 'FoundryReleaseProxy'

function Show-Log {
    foreach ($f in @((Join-Path $app 'install.log'), (Join-Path $data 'logs\proxy.log'), (Join-Path $env:TEMP 'frp-setup.log'))) {
        if (Test-Path -LiteralPath $f) { Write-Output "---- $f"; Get-Content -LiteralPath $f }
    }
}

function Get-Status([string]$Url) {
    try { return [int](Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 5).StatusCode }
    catch [System.Net.WebException] {
        if ($_.Exception.Response) { return [int]$_.Exception.Response.StatusCode }
        return 0
    }
}

try {
    # The token is fake: the proxy only has to be up and answer 404 for a module that is not configured.
    $env:FOUNDRY_PROXY_GITHUB_TOKEN = 'github_pat_smoke_test_not_a_real_token'
    $p = Start-Process -FilePath $Installer -Wait -PassThru -ArgumentList @(
        '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', "/LOG=$(Join-Path $env:TEMP 'frp-setup.log')",
        '/MODULEID=demo', '/REPO=octo/demo')
    if ($p.ExitCode -ne 0) { throw "installer exited with $($p.ExitCode)" }
    Remove-Item Env:FOUNDRY_PROXY_GITHUB_TOKEN

    foreach ($path in @("$app\src\server.js", "$app\scripts\install-service.ps1", "$env:ProgramFiles\FoundryReleaseProxy-Node\node.exe",
            "$data\env", "$data\config.json")) {
        if (-not (Test-Path -LiteralPath $path)) { throw "missing $path" }
    }
    if ((Get-Content -LiteralPath "$data\config.json" -Raw) -notmatch '"demo"') { throw 'config.json lacks the demo module' }
    if (-not (Get-ScheduledTask -TaskName 'FoundryReleaseProxy')) { throw 'scheduled task FoundryReleaseProxy missing' }

    $status = 0
    for ($i = 0; $i -lt 30 -and $status -ne 404; $i++) {
        $status = Get-Status 'http://localhost:8787/not-a-module/module.json'
        if ($status -ne 404) { Start-Sleep -Seconds 2 }
    }
    if ($status -ne 404) { throw "proxy did not answer 404 for an unknown module (last status $status)" }
    Write-Output 'proxy is up and answers 404 for an unknown module'

    $unins = Get-ChildItem -LiteralPath $app -Filter 'unins*.exe' | Select-Object -First 1
    if (-not $unins) { throw 'uninstaller missing' }
    $p = Start-Process -FilePath $unins.FullName -Wait -PassThru -ArgumentList @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART')
    if ($p.ExitCode -ne 0) { throw "uninstaller exited with $($p.ExitCode)" }
    Start-Sleep -Seconds 2
    if (Get-ScheduledTask -TaskName 'FoundryReleaseProxy' -ErrorAction SilentlyContinue) { throw 'scheduled task still registered' }
    if (Test-Path -LiteralPath $app) { throw "$app still exists after uninstall" }
    if (-not (Test-Path -LiteralPath "$data\env")) { throw 'a silent uninstall must keep the token and config' }
    Write-Output 'install and uninstall OK'
}
catch {
    Show-Log
    throw
}
