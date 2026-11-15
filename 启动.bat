@echo off
chcp 65001 >nul
title ElainaChat
cd /d "%~dp0"

rem 一键启动：有可用的构建产物就直接跑，没有（或源码比它新）就构建再跑。
rem 构建与启动合在这一处，避免两份脚本各自演化出不同判断。

rem 服务端是 Go 单文件二进制。安装包布局里二进制在 app\..\server\ 下；
rem 开发目录里 ..\server\ 是仓库外的路径，残留旧构建产物会被静默顶上，不能采用；
rem 回退只在安装包布局（没有 server\go.mod）生效，开发目录即使名为 app 也不用外部 exe。
set "SERVER=server\bin\elaina-server.exe"
rem 自动安装 Go 时用的版本：必须满足 server\go.mod 的 go 指令（当前要求 1.27+），
rem 否则装完照样构建失败。
set "GO_VERSION=1.27.3"
set "BATDIR=%~dp0"
if not exist "%SERVER%" if /i "%BATDIR:~-5%"=="\app\" if not exist "server\go.mod" if exist "..\server\elaina-server.exe" set "SERVER=..\server\elaina-server.exe"

rem 安装包布局没有源码目录：那里只启动、不重编。
if not exist "server\go.mod" goto ready

rem 旧进程会锁住 bin\elaina-server.exe，Windows 上无法覆盖构建产物；
rem 新进程发现端口被占又会直接退出，看起来像"构建没生效"。先停掉同路径的旧进程。
call :stop_running_server

set "NEED_BUILD=0"
if not exist "%SERVER%" (
    set "NEED_BUILD=1"
) else (
    rem 源码比二进制新就重编：双击启动不能静默跑旧服务端。
    powershell -NoProfile -ExecutionPolicy Bypass -Command "$b=(Get-Item '%SERVER%').LastWriteTimeUtc; $n=Get-ChildItem -Path 'server' -Recurse -Include *.go,go.mod,go.sum -ErrorAction SilentlyContinue | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1; if(-not $n -or $n.LastWriteTimeUtc -le $b){exit 0}; exit 1"
    if errorlevel 1 set "NEED_BUILD=1"
)
if "%NEED_BUILD%"=="0" goto ready

rem ---- 需要构建：先问一次，别让双击启动无声地编译几分钟 ----
echo.
echo ============================================================
echo  检测到尚未构建（或源码已更新），需要先构建 Go 服务端。
echo  构建耗时可能较长（首次需下载依赖）。
echo ============================================================
echo.
echo   [1] 构建新版本（没有 Go 环境会自动下载）
echo   [2] 不构建，直接退出
echo.
set "CHOICE="
set /p "CHOICE=请输入 1 或 2 后回车："
if "%CHOICE%"=="1" goto build
if "%CHOICE%"=="2" (
    echo 已取消，未做任何改动。
    timeout /t 2 >nul
    exit /b 0
)
rem 空输入（直接回车）也按取消处理：不构建就不该启动一个不存在或过期的二进制。
echo 输入无效，已取消（未做任何改动）。
timeout /t 2 >nul
exit /b 0

:build
rem 没有 Go 工具链就自动下载：用户选了「构建」就不该再让他自己去装。
where go >nul 2>nul
if errorlevel 1 (
    echo.
    echo 未检测到 Go 工具链，准备自动下载安装 Go...
    call :install_go
    if errorlevel 1 (
        echo.
        echo [ERROR] Go 工具链自动安装失败，未启动服务。
        echo         可手动安装 Go 1.27+ 后重试：https://go.dev/dl/
        echo         或手动构建：cd server ^&^& go build -o bin\elaina-server.exe .\cmd\elaina-server
        pause
        exit /b 1
    )
)

echo.
echo 正在构建 Go 服务端...
pushd server
go build -trimpath -ldflags "-s -w" -o bin\elaina-server.exe .\cmd\elaina-server
if errorlevel 1 (
    popd
    echo.
    echo [ERROR] 构建失败，未启动服务（不会退回到旧二进制）。
    pause
    exit /b 1
)
popd
echo 构建完成。
echo.

:ready
rem ===== 可选：端口 / 监听地址 / HTTPS 证书 =====
rem 服务端也读 data\config.json（port / host / https / cert / key / password / allowed_hosts）。
rem 这里的同名环境变量优先级更高；不设置就用配置文件和默认值。
rem set PORT=3999
rem set HOST=127.0.0.1
rem set ELAINA_HTTPS=1
rem set ELAINA_CERT_FILE=cert.pem
rem set ELAINA_KEY_FILE=key.pem

echo.
echo 服务端在前台运行：关闭此窗口即停止服务端。
echo.
set OPEN_BROWSER=1
"%SERVER%"

rem 退出码 3 = 端口已有别的 ElainaChat 实例（服务端自己打开了浏览器）。
rem 这次本脚本没启动新进程；把原因留在窗口里，别让用户以为"双击没反应"。
if %errorlevel%==3 (
    echo.
    echo 3999 端口已有另一个 ElainaChat 实例在运行，本次没有启动新服务端。
    echo 请先关闭那个实例（任务栏 / 任务管理器里的 ElainaChat.exe 或 elaina-server.exe），再运行本脚本。
    pause
    exit /b 0
)
echo.
echo 服务已停止。
pause
exit /b 0

rem ===== 旧服务端检查 =====
rem 只按本启动脚本解析出的二进制完整路径匹配：不会误杀安装版/别的副本。
:stop_running_server
for %%I in ("%SERVER%") do set "SERVER_ABS=%%~fI"
set "RUNNING_PIDS="
for /f "usebackq delims=" %%P in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "$t='%SERVER_ABS%'; $p=Get-CimInstance Win32_Process -ErrorAction SilentlyContinue; foreach($x in $p){ if($x.ExecutablePath -eq $t){ $x.ProcessId } }"`) do call set "RUNNING_PIDS=%%RUNNING_PIDS%% %%P"
if not defined RUNNING_PIDS exit /b 0
echo.
echo 检测到旧的开发服务端（PID:%RUNNING_PIDS%），先停止它再构建/启动。
echo 它在后台运行，关掉本窗口不会停止它；旧进程还会锁住构建产物。
for %%P in (%RUNNING_PIDS%) do taskkill /PID %%P /F >nul 2>nul
rem 等 Windows 释放 exe 文件锁与端口，避免紧接着的构建/监听撞上残留。
powershell -NoProfile -Command "Start-Sleep -Milliseconds 500" >nul 2>nul
echo 已停止旧服务端。
exit /b 0

rem ===== 自动安装 Go =====
rem 用 winget 优先（免去手工解压与 PATH 配置）；没有 winget 就下载官方 zip 解到 %LOCALAPPDATA%\Go，
rem 并只在本次会话的 PATH 里补上 —— 不永久改系统 PATH，脚本退出后不留痕迹。
:install_go
where winget >nul 2>nul
if not errorlevel 1 (
    echo 使用 winget 安装 Go...
    winget install --id GoLang.Go --accept-source-agreements --accept-package-agreements --silent
    if not errorlevel 1 (
        rem winget 装完当前会话 PATH 里通常还没有 go，补一下常见安装位置。
        if exist "%ProgramFiles%\Go\bin" set "PATH=%ProgramFiles%\Go\bin;%PATH%"
        where go >nul 2>nul
        if not errorlevel 1 exit /b 0
    )
    echo winget 安装未成功，改用直接下载。
)

set "GO_ZIP=%TEMP%\elaina-go.zip"
set "GO_DIR=%LOCALAPPDATA%\Go"
echo 正在下载 Go %GO_VERSION% 工具链...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ProgressPreference='SilentlyContinue'; try { Invoke-WebRequest -Uri ('https://go.dev/dl/go%GO_VERSION%.windows-amd64.zip') -OutFile '%GO_ZIP%' -UseBasicParsing } catch { Write-Host ('下载失败：' + $_.Exception.Message); exit 1 }"
if errorlevel 1 exit /b 1

echo 正在解压...
if exist "%GO_DIR%" rmdir /s /q "%GO_DIR%"
powershell -NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -Path '%GO_ZIP%' -DestinationPath '%LOCALAPPDATA%' -Force"
if errorlevel 1 exit /b 1
del "%GO_ZIP%" >nul 2>nul

rem 官方 zip 解出来是 go\ 目录，改成 Go\ 以便与 winget 的位置习惯一致。
if exist "%LOCALAPPDATA%\go" if not exist "%GO_DIR%" move "%LOCALAPPDATA%\go" "%GO_DIR%" >nul 2>nul
if not exist "%GO_DIR%\bin\go.exe" (
    echo 解压后没有找到 go.exe。
    exit /b 1
)
set "PATH=%GO_DIR%\bin;%PATH%"
where go >nul 2>nul
if errorlevel 1 exit /b 1
echo Go 工具链已就绪。
exit /b 0
