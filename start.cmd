@echo off
setlocal
cd /d "%~dp0"

set "APP_DIR=%~dp0"
set "ELECTRON_EXE=%~dp0node_modules\electron\dist\electron.exe"

if not exist "%APP_DIR%out\main\index.js" (
  echo [Penpal] No build found in "%APP_DIR%out". Run "npm run build" first.
  pause
  exit /b 1
)

if not exist "%ELECTRON_EXE%" (
  echo [Penpal] Electron executable not found: "%ELECTRON_EXE%"
  pause
  exit /b 1
)

start "" "%ELECTRON_EXE%" "%APP_DIR%"
endlocal
exit /b 0
