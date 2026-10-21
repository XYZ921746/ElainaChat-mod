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
rem 退出码 3 = 本项目的另一个实例已经在跑（serve.mjs 把浏览器指过去之后就退了）。
rem 这种退出没有自己的服务可看，窗口留着只会让人以为「又起了一个服务」，所以直接关掉。
if %errorlevel%==3 exit /b 0
echo.
echo Server stopped.
pause
