<#
.SYNOPSIS
    Build the MATRIX release APK on Windows.

.DESCRIPTION
    Wraps `gradlew assembleRelease` and handles the two things that otherwise
    make this repository fail to build on Windows:

      1. React Native's Android toolchain cannot build from a path containing
         spaces, and this project lives under
         "Dead Reaconking system\Pre ppt round prototype". A directory junction
         does NOT help — Gradle resolves it back to the real path — so the app
         is mirrored to a space-free staging directory and built there.

      2. In a .properties file a single backslash is an escape character, so
         `sdk.dir=C:\Users\...` is parsed as `C:Users...` and the SDK is not
         found. local.properties is written with forward slashes.

    The finished APK is copied back next to the project.

.PARAMETER Staging
    Space-free directory to build in. Default D:\matrix-build.

.PARAMETER SdkDir
    Android SDK location. Defaults to %LOCALAPPDATA%\Android\Sdk.

.PARAMETER Clean
    Run `expo prebuild --clean` and a Gradle clean first.

.EXAMPLE
    ./scripts/build-apk.ps1
    ./scripts/build-apk.ps1 -Clean
#>
[CmdletBinding()]
param(
    [string]$Staging = 'D:\matrix-build',
    [string]$SdkDir = "$env:LOCALAPPDATA\Android\Sdk",
    [switch]$Clean
)

$ErrorActionPreference = 'Stop'
$app = Split-Path -Parent $PSScriptRoot

if ($app -notmatch ' ') {
    Write-Host "Project path has no spaces; building in place." -ForegroundColor Green
    $Staging = $app
}

if (-not (Test-Path $SdkDir)) {
    throw "Android SDK not found at $SdkDir. Install it, or pass -SdkDir."
}

# --- 1. generate the native project -----------------------------------------
Push-Location $app
try {
    if ($Clean) {
        Write-Host '==> expo prebuild --clean' -ForegroundColor Cyan
        npx expo prebuild --platform android --clean
    } elseif (-not (Test-Path (Join-Path $app 'android'))) {
        Write-Host '==> expo prebuild' -ForegroundColor Cyan
        npx expo prebuild --platform android
    }
} finally {
    Pop-Location
}

# --- 2. mirror to a space-free path -----------------------------------------
if ($Staging -ne $app) {
    Write-Host "==> mirroring to $Staging" -ForegroundColor Cyan
    # NOTE: do NOT exclude directories named "build" here. Several npm packages
    # (expo-modules-autolinking among them) ship real source in a build/ folder,
    # and excluding it breaks Gradle autolinking with a confusing
    # "Cannot find module '../build'".
    robocopy $app $Staging /MIR /XD '.gradle' '.expo' '.git' /NFL /NDL /NJH /NJS /NP /R:1 /W:1 | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy failed with exit code $LASTEXITCODE" }
    $global:LASTEXITCODE = 0
}

# --- 3. point Gradle at the SDK ---------------------------------------------
$localProps = Join-Path $Staging 'android\local.properties'
$sdkForward = $SdkDir -replace '\\', '/'
$propsText = @"
## Written by scripts/build-apk.ps1.
## Forward slashes on purpose: a single backslash is an escape character in a
## .properties file, so C:\Users\... would parse as C:Users... and the SDK would
## not be found.
sdk.dir=$sdkForward
"@
# WriteAllText with UTF8Encoding($false), NOT Set-Content -Encoding utf8:
# Windows PowerShell 5.1 writes a BOM, which makes the first key parse as
# "<BOM>sdk.dir" and Gradle then reports "SDK location not found".
[System.IO.File]::WriteAllText(
    $localProps, $propsText, (New-Object System.Text.UTF8Encoding($false)))

# --- 4. build ----------------------------------------------------------------
Push-Location (Join-Path $Staging 'android')
try {
    if ($Clean) {
        Write-Host '==> gradlew clean' -ForegroundColor Cyan
        ./gradlew clean --no-daemon
    }
    Write-Host '==> gradlew assembleRelease' -ForegroundColor Cyan
    ./gradlew assembleRelease --no-daemon
    if ($LASTEXITCODE -ne 0) { throw "Gradle build failed with exit code $LASTEXITCODE" }
} finally {
    Pop-Location
}

# --- 5. collect the artifact -------------------------------------------------
$apk = Join-Path $Staging 'android\app\build\outputs\apk\release\app-release.apk'
if (-not (Test-Path $apk)) { throw "Build reported success but $apk is missing." }

$out = Join-Path $app 'build-output'
New-Item -ItemType Directory -Force -Path $out | Out-Null
Copy-Item $apk (Join-Path $out 'matrix-release.apk') -Force

$size = (Get-Item $apk).Length / 1MB
Write-Host ''
Write-Host ("APK built: {0}" -f (Join-Path $out 'matrix-release.apk')) -ForegroundColor Green
Write-Host ("Size: {0:N1} MB" -f $size) -ForegroundColor Green
Write-Host ''
Write-Host 'Install with:  adb install -r "' -NoNewline
Write-Host (Join-Path $out 'matrix-release.apk') -NoNewline
Write-Host '"'
Write-Host ''
Write-Host 'NOTE: expo prebuild signs release builds with the DEBUG keystore.' -ForegroundColor Yellow
Write-Host '      Fine for a demo; generate your own keystore before shipping.' -ForegroundColor Yellow
