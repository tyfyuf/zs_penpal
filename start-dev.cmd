@echo off
rem ============================================================
rem  WritingAgent - double-click to launch (dev mode with HMR)
rem  Keep this console window open while developing.
rem ============================================================
cd /d "%~dp0"
call npm run dev
