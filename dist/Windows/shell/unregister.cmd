@echo off
rem Remove MiniBrowser registration from Windows (HKCU only, no admin needed)
reg delete "HKCU\Software\Clients\StartMenuInternet\MiniBrowser" /f 2>nul
reg delete "HKCU\Software\RegisteredApplications" /v MiniBrowser /f 2>nul
reg delete "HKCU\Software\Classes\MiniBrowserHTML" /f 2>nul
reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\App Paths\MiniBrowser.exe" /f 2>nul
echo Registration removed.
pause
