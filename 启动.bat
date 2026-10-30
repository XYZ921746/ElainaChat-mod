@echo off
chcp 65001 >nul
title ElainaChat Redesign
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js not found. Please install Node.js first.
    pause
    exit /b 1
)

set OPEN_BROWSER=1
node start.mjs

if %errorlevel%==3 exit /b 0
echo.
echo Server stopped.
pause
