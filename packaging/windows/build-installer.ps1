<#
.SYNOPSIS
Builds FoundryReleaseProxy-Setup-<version>.exe with Inno Setup.

.DESCRIPTION
Run on Windows with Inno Setup 6.3 or newer installed (https://jrsoftware.org/isinfo.php, or `choco install innosetup`):

  .\packaging\windows\build-installer.ps1 [-OutDir dist] [-NodeMajor 22]

It downloads the newest Node.js <NodeMajor>.x for Windows x64 from nodejs.org, checks it against the SHA-256 that
nodejs.org publishes, compiles foundry-release-proxy.iss with the version from package.json and writes the installer
plus a .sha256 file to OutDir.
#>
[CmdletBinding()]
param(
    [string]$OutDir = 'dist',
    [int]$NodeMajor = 22
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$version = (Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
if ($version -notmatch '^\d+\.\d+\.\d+$') { throw "package.json version '$version' is not MAJOR.MINOR.PATCH" }

New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
$OutDir = (Resolve-Path $OutDir).Path
$work = Join-Path ([IO.Path]::GetTempPath()) ("frp-installer-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work | Out-Null

try {
    # Node.js: newest <NodeMajor>.x win-x64 zip, verified against nodejs.org's SHASUMS256.txt.
    $dist = "https://nodejs.org/dist/latest-v$NodeMajor.x"
    $sums = (Invoke-WebRequest -UseBasicParsing -Uri "$dist/SHASUMS256.txt").Content -split "`n"
    $line = $sums | Where-Object { $_ -match ' node-v[\d.]+-win-x64\.zip\s*$' } | Select-Object -First 1
    if (-not $line) { throw "nodejs.org lists no win-x64 zip for Node.js $NodeMajor" }
    $expected, $zipName = ($line.Trim() -split '\s+')
    $zip = Join-Path $work $zipName
    Invoke-WebRequest -UseBasicParsing -Uri "$dist/$zipName" -OutFile $zip
    $actual = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash
    if ($actual -ne $expected.ToUpperInvariant()) { throw "SHA-256 mismatch for $zipName (expected $expected, got $actual)" }
    Expand-Archive -LiteralPath $zip -DestinationPath $work
    $nodeDir = Join-Path $work ([IO.Path]::GetFileNameWithoutExtension($zipName))
    $nodeExe = Join-Path $nodeDir 'node.exe'
    $nodeLicense = Join-Path $nodeDir 'LICENSE'
    if (-not (Test-Path -LiteralPath $nodeExe) -or -not (Test-Path -LiteralPath $nodeLicense)) {
        throw "$zipName does not contain node.exe and LICENSE"
    }
    Write-Information "Using $zipName" -InformationAction Continue

    $iscc = @(
        (Get-Command ISCC.exe -ErrorAction SilentlyContinue | ForEach-Object { $_.Source }),
        (Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe'),
        (Join-Path $env:ProgramFiles 'Inno Setup 6\ISCC.exe')
    ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
    if (-not $iscc) { throw 'ISCC.exe not found. Install Inno Setup 6 (choco install innosetup).' }

    & $iscc "/DAppVersion=$version" "/DNodeExe=$nodeExe" "/DNodeLicense=$nodeLicense" "/O$OutDir" `
        (Join-Path $PSScriptRoot 'foundry-release-proxy.iss')
    if ($LASTEXITCODE -ne 0) { throw "ISCC failed with exit code $LASTEXITCODE" }

    $exeName = "FoundryReleaseProxy-Setup-$version.exe"
    $exe = Join-Path $OutDir $exeName
    if (-not (Test-Path -LiteralPath $exe)) { throw "ISCC did not produce $exe" }
    $hash = (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant()
    [IO.File]::WriteAllText("$exe.sha256", "$hash  $exeName`n", (New-Object System.Text.UTF8Encoding $false))
    Write-Information "Built $exe" -InformationAction Continue
}
finally {
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}
