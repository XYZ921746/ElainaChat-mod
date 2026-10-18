@echo off
chcp 65001 >nul
title ElainaChat Mod Server
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js not found. Please install Node.js first.
    pause
    exit /b 1
)
rem OPEN_BROWSER=1 告诉 serve.mjs「这是用户双击启动」——它会等服务真正监听
rem 之后再打开浏览器。不能在这里直接 start：那时端口还没起来，打开的是错误页。
rem 跑检查 / 自己 node web\serve.mjs 时没有这个变量，所以不会弹窗。
set OPEN_BROWSER=1
node web\serve.mjs
echo.
echo Server stopped.
pause
