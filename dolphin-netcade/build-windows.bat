@echo off
rem Double-click to build Netcade's Dolphin on this PC. See build-windows.ps1 for what it needs.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0build-windows.ps1" %*
echo.
pause
