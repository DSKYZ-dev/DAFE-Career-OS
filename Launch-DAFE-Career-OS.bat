@echo off
title DAFE Career OS
cd /d "%~dp0"
echo.
echo   ============================================================
echo      D A F E   C A R E E R   O S
echo   ============================================================
echo.
echo   Starting... your browser will open automatically.
echo   Keep this window open while using DAFE Career OS.
echo   Close this window to stop the app.
echo.
start "" http://127.0.0.1:3456
node dashboard.mjs
pause
