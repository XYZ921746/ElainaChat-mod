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

rem ===== 可选：端口 / 监听地址 / HTTPS 证书 =====
rem 服务端也读 data\config.json（port / host / https / cert / key / password / allowed_hosts）。
rem 这里的同名环境变量优先级更高；不设置就用配置文件和默认值。
rem set PORT=3999
rem set HOST=127.0.0.1
rem set ELAINA_HTTPS=1
rem set ELAINA_CERT_FILE=cert.pem
rem set ELAINA_KEY_FILE=key.pem

set OPEN_BROWSER=1
node web/serve.mjs

if %errorlevel%==3 exit /b 0
echo.
echo Server stopped.
pause
