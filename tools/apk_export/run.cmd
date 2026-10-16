@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Export-KakaoApk.ps1" %*
set "apkExportExit=%errorlevel%"
if "%~1"=="" pause
exit /b %apkExportExit%
