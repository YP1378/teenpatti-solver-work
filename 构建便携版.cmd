@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\build-portable.ps1"

if errorlevel 1 (
  echo.
  echo [ERROR] Portable build failed.
  pause
  exit /b 1
)

echo.
echo [INFO] Portable build completed.
pause

