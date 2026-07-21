@echo off
title DAFE Career OS - RESET
cd /d "%~dp0"

echo.
echo   ============================================================
echo      D A F E   C A R E E R   O S   —   H A R D   R E S E T
echo   ============================================================
echo.

echo   Killing dashboard on port 3456...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr "0.0.0.0:3456" ^| findstr LISTENING') do (
  taskkill /F /PID %%a >nul 2>&1
)
timeout /t 2 /nobreak >nul

echo   Cleaning stale state...
if exist "data\continuous-status.json" del "data\continuous-status.json"
if exist "data\server.pid" del "data\server.pid"
if exist "data\pipeline.pid" del "data\pipeline.pid"
if exist "data\pipeline-events.log" del "data\pipeline-events.log"

echo   Ready. Starting fresh...
echo.
timeout /t 1 /nobreak >nul

start "" http://127.0.0.1:3456
node dashboard.mjs
pause
