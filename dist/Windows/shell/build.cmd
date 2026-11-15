@echo off
rem Build single-file MiniBrowser.exe (.NET Framework 4.8 + embedded WebView2, no extra files)
rem Usage: build.cmd [icon.ico]   -- passing an ico embeds it as the exe file icon
setlocal
cd /d "%~dp0"

rem ---- Roslyn compiler: prefer the dev machine's dotnet SDK, fall back to the
rem   csc.exe shipped with Visual Studio / BuildTools. Same Roslyn, same args
rem   (bincore csc.dll needs `dotnet exec`; csc.exe runs directly). The code uses
rem   C# 11 syntax (raw string literals) that the legacy Framework csc cannot
rem   parse, so a Roslyn compiler is mandatory. NOTE: keep this file ASCII-only
rem   -- cmd.exe parses batch files in the OEM code page and UTF-8 comments
rem   corrupt parsing (seen: comment bytes executed as a command).
set "DOTNET="
set "CSC="
if exist "D:\222\dotnet\dotnet.exe" if exist "D:\222\dotnet\sdk\10.0.100\Roslyn\bincore\csc.dll" (
    set "DOTNET=D:\222\dotnet\dotnet.exe"
    set "CSC=D:\222\dotnet\sdk\10.0.100\Roslyn\bincore\csc.dll"
)
rem a quoted wildcard in a `for /d` set is NOT expanded (known cmd pitfall);
rem enumerate version + edition dirs with `dir /b /ad` instead.
if not defined CSC for %%v in ("C:\Program Files (x86)\Microsoft Visual Studio" "C:\Program Files\Microsoft Visual Studio") do (
    if not defined CSC for /f "delims=" %%d in ('dir /b /ad "%%~v" 2^>nul') do (
        if not defined CSC for /f "delims=" %%e in ('dir /b /ad "%%~v\%%d" 2^>nul') do (
            if not defined CSC if exist "%%~v\%%d\%%e\MSBuild\Current\Bin\Roslyn\csc.exe" set "CSC=%%~v\%%d\%%e\MSBuild\Current\Bin\Roslyn\csc.exe"
        )
    )
)
if not defined CSC echo [FAIL] Roslyn compiler not found (install VS/BuildTools or the dotnet SDK) & exit /b 1

set FX=C:\Windows\Microsoft.NET\Framework64\v4.0.30319
rem WPF managed assemblies are NOT in the FX dir (PresentationCore there is native);
rem reference the real managed copies from the GAC.
set WPF64=C:\Windows\Microsoft.NET\assembly\GAC_64\PresentationCore\v4.0_4.0.0.0__31bf3856ad364e35\PresentationCore.dll
set WPFF=C:\Windows\Microsoft.NET\assembly\GAC_MSIL\PresentationFramework\v4.0_4.0.0.0__31bf3856ad364e35\PresentationFramework.dll
set WPFB=C:\Windows\Microsoft.NET\assembly\GAC_MSIL\WindowsBase\v4.0_4.0.0.0__31bf3856ad364e35\WindowsBase.dll
set PKG=%USERPROFILE%\.nuget\packages\microsoft.web.webview2\1.0.4314.35

set ICONARG=
if not "%~1"=="" set ICONARG=-win32icon:%~1

rem ---- Output directory is OUTSIDE the repo (AGENTS.md D23): the compiled exe is a
rem   build artifact and must never land in the working tree. ELAINA_TOOLS_DIR
rem   overrides the default root; otherwise use the sibling ElainaChat-tools folder
rem   (repo root is three levels up from this script).
set "TOOLS=%ELAINA_TOOLS_DIR%"
if not defined TOOLS for %%i in ("%~dp0..\..\..\..") do set "TOOLS=%%~fi\ElainaChat-tools"
set "OUTDIR=%TOOLS%\07-windows-out\shell"
if not exist "%OUTDIR%" mkdir "%OUTDIR%"
if not exist "%OUTDIR%" echo [FAIL] cannot create output dir %OUTDIR% & exit /b 1

set "PRE="
if defined DOTNET set "PRE=%DOTNET% exec"
%PRE% "%CSC%" -noconfig -nostdlib -define:NETFRAMEWORK ^
  -target:winexe -platform:anycpu -langversion:latest -nowarn:8632 -optimize+ ^
  -out:"%OUTDIR%\MiniBrowser.exe" %ICONARG% -win32manifest:app.manifest ^
  -r:"%FX%\mscorlib.dll" ^
  -r:"%FX%\System.dll" ^
  -r:"%FX%\System.Core.dll" ^
  -r:"%FX%\System.Windows.Forms.dll" ^
  -r:"%FX%\System.Drawing.dll" ^
  -r:"%WPFF%" ^
  -r:"%WPF64%" ^
  -r:"%WPFB%" ^
  -r:"%FX%\System.Xaml.dll" ^
  -r:"%PKG%\lib\net462\Microsoft.Web.WebView2.Core.dll" ^
  -r:"%PKG%\lib\net462\Microsoft.Web.WebView2.WinForms.dll" ^
  -r:"%PKG%\lib\net462\Microsoft.Web.WebView2.Wpf.dll" ^
  -resource:"%PKG%\lib\net462\Microsoft.Web.WebView2.Core.dll",MiniBrowser.Lib.Microsoft.Web.WebView2.Core.dll ^
  -resource:"%PKG%\lib\net462\Microsoft.Web.WebView2.WinForms.dll",MiniBrowser.Lib.Microsoft.Web.WebView2.WinForms.dll ^
  -resource:"%PKG%\lib\net462\Microsoft.Web.WebView2.Wpf.dll",MiniBrowser.Lib.Microsoft.Web.WebView2.Wpf.dll ^
  -resource:"%PKG%\build\native\x64\WebView2Loader.dll",MiniBrowser.Lib.WebView2Loader.dll ^
  Program.cs Form1.cs ShellHost.cs ModWindow.cs

if %errorlevel%==0 (
  echo.
  echo Build OK: %OUTDIR%\MiniBrowser.exe
) else (
  echo Build FAILED
  exit /b 1
)
