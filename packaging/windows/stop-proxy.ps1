<#
.SYNOPSIS
Stops the Foundry release proxy and keeps its scheduled task from restarting it, so the installer can replace node.exe.
install-service.ps1 registers the task again (enabled) when the installer runs it afterwards.
#>
$ErrorActionPreference = 'SilentlyContinue'
$TaskName = 'FoundryReleaseProxy'
$server = Join-Path (Join-Path $env:ProgramFiles 'FoundryReleaseProxy') 'src\server.js'

if (Get-ScheduledTask -TaskName $TaskName) {
    Disable-ScheduledTask -TaskName $TaskName | Out-Null
    Stop-ScheduledTask -TaskName $TaskName
}
# The task runs node through cmd.exe; make sure no proxy node.exe outlives it.
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
    Where-Object { $_.CommandLine -like "*$server*" } |
    ForEach-Object { Invoke-CimMethod -InputObject $_ -MethodName Terminate | Out-Null }
for ($i = 0; $i -lt 20; $i++) {
    $left = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -like "*$server*" }
    if (-not $left) { break }
    Start-Sleep -Milliseconds 500
}
exit 0
