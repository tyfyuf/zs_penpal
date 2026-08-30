@echo off
rem ============================================================
rem  Penpal (笔伴) - double-click to launch (production build)
rem  Launches the app using the already-built "out/" artifacts.
rem ============================================================
cd /d "%~dp0"

if not exist "out\main\index.js" (
  echo [Penpal] No build found in "out\". Run "npm run build" first.
  pause
  exit /b 1
)

start "" "node_modules\electron\dist\electron.exe" "."
