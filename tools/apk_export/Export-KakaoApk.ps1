[CmdletBinding()]
param(
    [string]$DeviceSerial,
    [string]$AdbEndpoint,
    [string]$AdbPath,
    [switch]$PrepareOnly
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$kitRoot = [IO.Path]::GetFullPath($PSScriptRoot)
$packageName = 'com.kakao.talk'
$archiveSha256 = '45f4d63113e895ebde0c90f194099a4676b6ac653bd28d54314a9e022bbc1a99'
$binaryHashes = @{
    'adb.exe' = 'b4a6b455702684652cccf7b46258b29e653538904359a58fd4931cf3ef286b3f'
    'AdbWinApi.dll' = 'c1d653030b4bde65d3e07e4d0b0979e17be56df1436cdd15528630f27808050d'
    'AdbWinUsbApi.dll' = '0710e894d9b40f71a670c13c694079d564c92c1279da382cfe4850983aaebe1b'
}

function Invoke-Adb {
    param([string[]]$Arguments, [switch]$AllowFailure)
    $previousPreference = $ErrorActionPreference
    try {
        # ADB can write daemon startup notices to stderr even on success.
        $ErrorActionPreference = 'Continue'
        $lines = @(& $script:adbExecutable @Arguments 2>&1)
        $code = $LASTEXITCODE
    } finally { $ErrorActionPreference = $previousPreference }
    if ($code -ne 0) {
        if ($AllowFailure) { return '' }
        throw ('ADB operation failed (exit ' + $code + '). No automatic retry.')
    }
    return (($lines | ForEach-Object { $_.ToString() }) -join "`n")
}

try {
    if ($AdbEndpoint -and $AdbEndpoint -notmatch '^127\.0\.0\.1:([1-9][0-9]{0,4})$') {
        throw 'AdbEndpoint must be the emulator-provided 127.0.0.1:PORT. Port scanning is not used.'
    }
    if ($AdbEndpoint -and [int]($AdbEndpoint.Split(':')[-1]) -gt 65535) { throw 'Invalid emulator port.' }
    if ($DeviceSerial -and $DeviceSerial -notmatch '^[A-Za-z0-9_.:-]+$') { throw 'Invalid device selector.' }

    if ($AdbPath) {
        $script:adbExecutable = (Resolve-Path -LiteralPath $AdbPath).Path
    } else {
        $archivePath = Join-Path $kitRoot 'platform-tools-37.0.1-windows.zip'
        if (!(Test-Path -LiteralPath $archivePath -PathType Leaf)) { throw 'Bundled Google Platform-Tools ZIP is missing.' }
        if ((Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $archiveSha256) { throw 'Google Platform-Tools ZIP checksum mismatch.' }
        $toolsRoot = Join-Path $kitRoot 'platform-tools'
        if (!(Test-Path -LiteralPath (Join-Path $toolsRoot 'adb.exe') -PathType Leaf)) {
            Add-Type -AssemblyName System.IO.Compression.FileSystem
            $archive = [IO.Compression.ZipFile]::OpenRead($archivePath)
            try {
                foreach ($entry in $archive.Entries) {
                    $target = [IO.Path]::GetFullPath((Join-Path $kitRoot $entry.FullName))
                    if (!$target.StartsWith($kitRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe ZIP member path.' }
                }
            } finally { $archive.Dispose() }
            Expand-Archive -LiteralPath $archivePath -DestinationPath $kitRoot
        }
        foreach ($name in $binaryHashes.Keys) {
            if ((Get-FileHash -LiteralPath (Join-Path $toolsRoot $name) -Algorithm SHA256).Hash.ToLowerInvariant() -ne $binaryHashes[$name]) { throw ('ADB binary checksum mismatch: ' + $name) }
        }
        $script:adbExecutable = Join-Path $toolsRoot 'adb.exe'
    }
    $adbVersion = Invoke-Adb -Arguments @('version')
    if ($PrepareOnly) {
        Write-Output 'ADB preparation passed. No devices contacted.'
        exit 0
    }
    if ($AdbEndpoint) { $null = Invoke-Adb -Arguments @('connect', $AdbEndpoint) }
    $deviceText = Invoke-Adb -Arguments @('devices')
    $devices = @($deviceText -split "`r?`n" | ForEach-Object {
        if ($_ -match '^([A-Za-z0-9_.:-]+)\s+(device|offline|unauthorized)(?:\s|$)') {
            [PSCustomObject]@{ Serial = $Matches[1]; State = $Matches[2] }
        }
    })
    if (!$DeviceSerial) {
        if ($devices.Count -ne 1) { throw 'Expected one Android device. Start the emulator and its ADB, or select one with -DeviceSerial. No device was chosen.' }
        $DeviceSerial = $devices[0].Serial
    }
    $selected = @($devices | Where-Object { $_.Serial -eq $DeviceSerial })
    if ($selected.Count -ne 1 -or $selected[0].State -ne 'device') { throw 'Selected Android device is not ready. Check its ADB authorization.' }

    $pathText = Invoke-Adb -Arguments @('-s', $DeviceSerial, 'shell', 'pm', 'path', $packageName)
    $paths = @($pathText -split "`r?`n" | Where-Object { $_.StartsWith('package:') } | ForEach-Object { $_.Substring(8).Trim() })
    if ($paths.Count -lt 1 -or $paths.Count -gt 128) { throw 'KakaoTalk APK paths were not found or exceed the limit. Install the Android app first; login is not required.' }
    $seen = @{}
    foreach ($remote in $paths) {
        if ($remote -notmatch '^/(data/app|mnt/expand/[^/]+/app)/[^\r\n]+\.apk$') { throw 'Unexpected installed APK path; private app data will not be read.' }
        if ($remote -match '(?:^|/)(?:\.|\.\.)(?:/|$)' -or $remote.Contains('\')) { throw 'Unexpected APK path traversal.' }
        $name = [IO.Path]::GetFileName($remote)
        if ($name -notmatch '^[A-Za-z0-9_.-]+\.apk$' -or $seen.ContainsKey($name)) { throw 'Unsupported or duplicate APK filename.' }
        $seen[$name] = $true
    }
    $outputRoot = Join-Path $kitRoot 'output'
    $null = New-Item -ItemType Directory -Path $outputRoot -Force
    $runName = 'kakao-apks-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N').Substring(0,8)
    $runRoot = Join-Path $outputRoot $runName
    $null = New-Item -ItemType Directory -Path $runRoot
    $files = @(); $totalBytes = 0L
    foreach ($remote in $paths) {
        $name = [IO.Path]::GetFileName($remote)
        $local = Join-Path $runRoot $name
        $null = Invoke-Adb -Arguments @('-s', $DeviceSerial, 'pull', $remote, $local)
        $item = Get-Item -LiteralPath $local
        $totalBytes += $item.Length
        if ($item.Length -le 0 -or $item.Length -gt 1GB -or $totalBytes -gt 2GB) { throw 'APK export size limit exceeded.' }
        $files += [PSCustomObject]@{ name = $name; bytes = $item.Length; sha256 = (Get-FileHash -LiteralPath $local -Algorithm SHA256).Hash.ToLowerInvariant() }
    }
    $info = Invoke-Adb -Arguments @('-s', $DeviceSerial, 'shell', 'dumpsys', 'package', $packageName) -AllowFailure
    $versionName = $null; $versionCode = $null
    if ($info -match '(?m)^\s*versionName=([^\r\n]+)') { $versionName = $Matches[1].Trim() }
    if ($info -match '(?m)^\s*versionCode=([0-9]+)') { $versionCode = $Matches[1] }
    $record = [ordered]@{
        package = $packageName; versionName = $versionName; versionCode = $versionCode
        files = $files; signatureVerified = $false; completePmPathSetCopied = $true
        accountLoginPerformed = $false; appLaunched = $false; privateAppDataRead = $false
    }
    $manifest = Join-Path $runRoot 'apk-manifest.json'
    [IO.File]::WriteAllText($manifest, ($record | ConvertTo-Json -Depth 6), (New-Object Text.UTF8Encoding($false)))
    $zipPath = Join-Path $outputRoot ($runName + '.zip')
    Compress-Archive -LiteralPath @(@($paths | ForEach-Object { Join-Path $runRoot ([IO.Path]::GetFileName($_)) }) + @($manifest)) -DestinationPath $zipPath
    Write-Output ('Export complete. APK files: ' + $files.Count)
    Write-Output ('Copy this ZIP to the analysis laptop: ' + $zipPath)
} catch {
    Write-Error $_.Exception.Message -ErrorAction Continue
    exit 1
}
