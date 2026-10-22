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
    $adminPassword = 'smoke-test-admin-password'
    $env:FOUNDRY_PROXY_ADMIN_PASSWORD = $adminPassword
    $p = Start-Process -FilePath $Installer -Wait -PassThru -ArgumentList @(
        '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', "/LOG=$(Join-Path $env:TEMP 'frp-setup.log')",
        '/MODULEID=demo', '/REPO=octo/demo')
    if ($p.ExitCode -ne 0) { throw "installer exited with $($p.ExitCode)" }
    Remove-Item Env:FOUNDRY_PROXY_GITHUB_TOKEN, Env:FOUNDRY_PROXY_ADMIN_PASSWORD

    foreach ($path in @("$app\src\server.js", "$app\scripts\install-service.ps1", "$app\LICENSE", "$env:ProgramFiles\FoundryReleaseProxy-Node\node.exe",
            "$data\env", "$data\config.json", "$data\admin.json")) {
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

    # Admin page: log in and add a module, which the proxy (LOCAL SERVICE) writes into config.json.
    $base = 'http://localhost:8787/_admin/api'
    $login = Invoke-WebRequest -UseBasicParsing -Uri "$base/login" -Method Post -ContentType 'application/json' `
        -Body (@{ password = $adminPassword } | ConvertTo-Json) -SessionVariable admin
    $csrf = ($login.Content | ConvertFrom-Json).csrf
    if (-not $csrf) { throw 'admin login returned no CSRF token' }
    Invoke-WebRequest -UseBasicParsing -Uri "$base/modules" -Method Post -ContentType 'application/json' -WebSession $admin `
        -Headers @{ 'X-CSRF-Token' = $csrf } -Body (@{ id = 'smoke'; repo = 'octo/smoke' } | ConvertTo-Json) | Out-Null
    if ((Get-Content -LiteralPath "$data\config.json" -Raw) -notmatch '"smoke"') { throw 'the admin page did not write config.json' }
    # LOCAL SERVICE may rewrite env, where a GitHub token changed on the admin page is saved.
    $state = (Invoke-WebRequest -UseBasicParsing -Uri "$base/state" -WebSession $admin).Content | ConvertFrom-Json
    if (-not $state.token.canChange) { throw "the admin page cannot change the token: $($state.token.problem)" }
    Write-Output 'admin page logs in, saves modules and may change the token'

    # "Update proxy now": the proxy (LOCAL SERVICE) may start the SYSTEM task (it installs nothing: CI builds the
    # installer with a version newer than any release).
    $before = (Get-ScheduledTaskInfo -TaskName 'FoundryReleaseProxy-UpdateNow').LastRunTime
    Invoke-WebRequest -UseBasicParsing -Uri "$base/update" -Method Post -ContentType 'application/json' -WebSession $admin `
        -Headers @{ 'X-CSRF-Token' = $csrf } -Body '{}' | Out-Null
    $ran = $false
    for ($i = 0; $i -lt 30 -and -not $ran; $i++) {
        Start-Sleep -Seconds 2
        $ran = (Get-ScheduledTaskInfo -TaskName 'FoundryReleaseProxy-UpdateNow').LastRunTime -ne $before
    }
    if (-not $ran) { throw 'the admin page could not start the FoundryReleaseProxy-UpdateNow task' }
    Write-Output 'admin page starts the update task'

    # The browser admin port (the wizard's default): HTTPS with the self-signed certificate, firewall rule present.
    $node = "$env:ProgramFiles\FoundryReleaseProxy-Node\node.exe"
    $probe = "require('https').get({host:'localhost',port:8788,path:'/_admin/',rejectUnauthorized:false}," +
        "r=>console.log(r.statusCode)).on('error',e=>console.log(e.message))"
    $code = "$(& $node -e $probe)".Trim()
    if ($code -ne '200') { throw "the admin port https://localhost:8788/_admin/ answered: $code" }
    if (-not (Get-NetFirewallRule -Name 'FoundryReleaseProxy-Admin' -ErrorAction SilentlyContinue)) { throw 'firewall rule missing' }
    Write-Output 'admin port answers over HTTPS'

    $unins = Get-ChildItem -LiteralPath $app -Filter 'unins*.exe' | Select-Object -First 1
    if (-not $unins) { throw 'uninstaller missing' }
    $p = Start-Process -FilePath $unins.FullName -Wait -PassThru -ArgumentList @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART')
    if ($p.ExitCode -ne 0) { throw "uninstaller exited with $($p.ExitCode)" }
    Start-Sleep -Seconds 2
    if (Get-ScheduledTask -TaskName 'FoundryReleaseProxy' -ErrorAction SilentlyContinue) { throw 'scheduled task still registered' }
    if (Get-ScheduledTask -TaskName 'FoundryReleaseProxy-UpdateNow' -ErrorAction SilentlyContinue) { throw 'update task still registered' }
    if (Test-Path -LiteralPath $app) { throw "$app still exists after uninstall" }
    if (Get-NetFirewallRule -Name 'FoundryReleaseProxy-Admin' -ErrorAction SilentlyContinue) { throw 'firewall rule left behind' }
    if (-not (Test-Path -LiteralPath "$data\env")) { throw 'a silent uninstall must keep the token and config' }
    Write-Output 'install and uninstall OK'
}
catch {
    Show-Log
    throw
}
