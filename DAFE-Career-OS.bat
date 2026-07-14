@echo off
title DAFE Career OS Dashboard
cd /d "%~dp0"

where node >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo ERROR: Node.js not found. Please install Node.js from https://nodejs.org
    pause
    exit /b 1
)

REM If a dashboard is ALREADY serving on 3456 (e.g. another launcher
REM instance, or one already running), just open it instead of starting
REM a second server that would fail to bind the port and loop forever.
netstat -ano | findstr ":3456" | findstr "LISTENING" >nul 2>nul
if %ERRORLEVEL%==0 (
    echo Dashboard already running on port 3456.
    echo Opening it in your browser...
    start "" http://127.0.0.1:3456
    echo.
    echo (Close this window any time; the server keeps running.)
    pause >nul
    exit /b 0
)

echo.
echo  +==============================================+
echo  ^|     DAFE Career OS Control Dashboard            ^|
echo  +==============================================+
echo.
echo  Starting server...
echo  Your browser will open automatically.
echo  Keep this window open while using the dashboard.
echo  (The server auto-restarts if it crashes.)
echo.

:start
start "" http://127.0.0.1:3456
node dashboard.mjs
echo.
echo  Server stopped (exit code %ERRORLEVEL%).
echo  Restarting in 5 seconds... Press Ctrl+C to exit completely.
timeout /t 5 >nul
goto start
