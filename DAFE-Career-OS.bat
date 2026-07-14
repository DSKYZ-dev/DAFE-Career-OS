@echo off
title DAFE Career OS Dashboard
cd /d "%~dp0"

where node >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo ERROR: Node.js not found. Please install Node.js from https://nodejs.org
    pause
    exit /b 1
)

REM Stop any previously-running dashboard from an earlier launch so we always
REM start exactly ONE fresh server on 3456 (avoids a stale/empty server
REM holding the port while we do nothing).
if exist "data\server.pid" (
    for /f "delims=" %%i in (data\server.pid) do taskkill /pid %%i /f >nul 2>nul
    del /q "data\server.pid" >nul 2>nul
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
