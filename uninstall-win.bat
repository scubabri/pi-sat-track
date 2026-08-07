@echo off
setlocal EnableExtensions EnableDelayedExpansion

REM =============================================================================
REM Pi Sat Track - Windows uninstall (single file)
REM Run as Administrator.
REM
REM   uninstall-win.bat
REM   uninstall-win.bat --cache
REM   uninstall-win.bat --remove-node
REM   uninstall-win.bat --purge
REM =============================================================================

set "REMOVE_CACHE=0"
set "PURGE_APP=0"
set "FORCE_NODE=0"

if /I "%~1"=="-h" goto :help
if /I "%~1"=="--help" goto :help

:parse
if "%~1"=="" goto :parsed
if /I "%~1"=="--cache" set "REMOVE_CACHE=1"
if /I "%~1"=="--all" set "REMOVE_CACHE=1"
if /I "%~1"=="--purge" (
  set "REMOVE_CACHE=1"
  set "PURGE_APP=1"
)
if /I "%~1"=="--remove-node" set "FORCE_NODE=1"
shift
goto :parse
:parsed

set "SCRIPT_DIR=%~dp0"
if "%SCRIPT_DIR:~-1%"=="\" set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"

set "APP_DIR="
if exist "%SCRIPT_DIR%\package.json" if exist "%SCRIPT_DIR%\server.js" set "APP_DIR=%SCRIPT_DIR%"
if not defined APP_DIR (
  if exist "%SCRIPT_DIR%\..\package.json" if exist "%SCRIPT_DIR%\..\server.js" (
    pushd "%SCRIPT_DIR%\.."
    set "APP_DIR=!CD!"
    popd
  )
)

if not defined APP_DIR (
  echo ERROR: Cannot find package.json / server.js
  pause
  exit /b 1
)

net session >nul 2>&1
if errorlevel 1 (
  echo ERROR: Run as Administrator.
  echo Right-click uninstall-win.bat - Run as administrator
  pause
  exit /b 1
)

set "CACHE_DIR=%USERPROFILE%\.rpitrack"
set "NODE_MARKER=%CACHE_DIR%\.node-installed-by-sat-tracker"
set "START_BAT=%APP_DIR%\start-sat-tracker.bat"

echo.
echo =============================================================================
echo  Pi Sat Track - Windows uninstall
echo =============================================================================
echo  App:    %APP_DIR%
echo  Remove: node_modules, launcher, port 80 proxy
if exist "%NODE_MARKER%" echo          Node.js via Windows installer - will ask
if not exist "%NODE_MARKER%" if "%FORCE_NODE%"=="1" echo          Node.js --remove-node - will ask
if "%REMOVE_CACHE%"=="1" echo          cache folder
if "%PURGE_APP%"=="1" echo          entire app folder
echo =============================================================================
echo.
set /p "CONFIRM=Type YES to continue: "
if /I not "%CONFIRM%"=="YES" (
  echo Cancelled.
  pause
  exit /b 0
)
echo.

echo Stopping node.exe if running...
taskkill /F /IM node.exe >nul 2>&1
timeout /t 1 /nobreak >nul

echo Removing port 80 proxy...
netsh interface portproxy delete v4tov4 listenaddress=127.0.0.1 listenport=80 >nul 2>&1
netsh interface portproxy delete v4tov4 listenaddress=0.0.0.0 listenport=80 >nul 2>&1
netsh advfirewall firewall delete rule name="Pi Sat Track HTTP 80" >nul 2>&1
echo   done.
echo.

if exist "%APP_DIR%\node_modules\" (
  echo Removing node_modules...
  rmdir /s /q "%APP_DIR%\node_modules"
) else (
  echo node_modules not present.
)

if exist "%START_BAT%" del /f /q "%START_BAT%" >nul 2>&1

set "DO_NODE=0"
if exist "%NODE_MARKER%" set "DO_NODE=1"
if "%FORCE_NODE%"=="1" set "DO_NODE=1"

if "%DO_NODE%"=="1" goto :ask_node
echo.
echo Node.js not removed. Use: uninstall-win.bat --remove-node
goto :after_node

:ask_node
echo.
echo Node.js will be removed with the Windows installer (msiexec).
echo.
set /p "YN_NODE=Uninstall Node.js from this PC? Type YES: "
if /I not "%YN_NODE%"=="YES" (
  echo Node.js left installed.
  goto :after_node
)
call :uninstall_node_windows

:after_node
if exist "%NODE_MARKER%" del /f /q "%NODE_MARKER%" >nul 2>&1

if "%REMOVE_CACHE%"=="1" (
  if exist "%CACHE_DIR%\" (
    echo Removing cache %CACHE_DIR% ...
    rmdir /s /q "%CACHE_DIR%"
  )
)

if "%PURGE_APP%"=="1" (
  echo.
  set /p "CONFIRM2=Type DELETE to remove app folder: "
  if /I "!CONFIRM2!"=="DELETE" (
    set "CLEANER=%TEMP%\pi-sat-purge.bat"
    echo @echo off> "%CLEANER%"
    echo timeout /t 2 /nobreak ^>nul>> "%CLEANER%"
    echo rmdir /s /q "%APP_DIR%">> "%CLEANER%"
    echo del /f /q "%%~f0">> "%CLEANER%"
    start "" /min cmd /c "%CLEANER%"
    echo App folder delete scheduled.
    pause
    exit /b 0
  )
)

echo.
echo Uninstall finished.
pause
exit /b 0

REM =============================================================================
:uninstall_node_windows
echo.
echo Running Windows uninstall for Node.js...
echo.

REM Write a short helper to %%TEMP%% then run it (avoids bat quoting issues;
REM still ships as one uninstall-win.bat — no extra file in the app folder).
set "PS1=%TEMP%\pi-sat-uninstall-node-%RANDOM%.ps1"

> "%PS1%" (
echo $ErrorActionPreference = 'Continue'
echo Write-Host 'Looking up Node.js in Windows installer registry...'
echo $guids = @{}
echo $paths = @(
echo   'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
echo   'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
echo   'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*'
echo ^)
echo foreach ($path in $paths^) {
echo   Get-ItemProperty $path -ErrorAction SilentlyContinue ^| Where-Object {
echo     $_.DisplayName -match 'Node\.?js'
echo   } ^| ForEach-Object {
echo     $display = $_.DisplayName
echo     $guid = $null
echo     if ($_.PSChildName -match '^\{[0-9A-Fa-f\-]{36}\}$'^) { $guid = $_.PSChildName }
echo     if (-not $guid -and $_.UninstallString -match '\{[0-9A-Fa-f\-]{36}\}'^) { $guid = $Matches[0] }
echo     if ($guid^) { $guids[$guid] = $display }
echo     Write-Host ("  Found: $display  GUID=$guid"^)
echo   }
echo }
echo if ($guids.Count -eq 0^) {
echo   Write-Host 'No Node.js MSI product found.'
echo   Write-Host 'Opening Settings - Apps so you can uninstall Node.js.'
echo   Start-Process 'ms-settings:appsfeatures'
echo   exit 2
echo }
echo foreach ($guid in @($guids.Keys^)^) {
echo   Write-Host ("Uninstalling " + $guids[$guid] + " via msiexec /x $guid"^)
echo   $p = Start-Process -FilePath 'msiexec.exe' -ArgumentList @('/x', $guid, '/passive', '/norestart'^) -Wait -PassThru
echo   Write-Host ("  msiexec exit code: " + $p.ExitCode^)
echo }
echo Start-Sleep -Seconds 2
echo if (Test-Path (Join-Path $env:ProgramFiles 'nodejs\node.exe'^)^) {
echo   Write-Host 'WARNING: node.exe still present after MSI uninstall.'
echo   Start-Process 'ms-settings:appsfeatures'
echo   exit 1
echo }
echo Write-Host 'Node.js Windows uninstall finished.'
echo exit 0
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%"
set "EC=%ERRORLEVEL%"
del /f /q "%PS1%" >nul 2>&1

if "%EC%"=="0" (
  echo Node.js removed via Windows installer.
) else if "%EC%"=="2" (
  echo Uninstall Node.js from the Settings window that opened.
) else (
  echo Check Settings - Apps for Node.js if it is still listed.
)

where winget >nul 2>&1
if not errorlevel 1 (
  if exist "%ProgramFiles%\nodejs\node.exe" (
    echo Trying winget uninstall fallback...
    winget uninstall -e --id OpenJS.NodeJS.LTS --accept-source-agreements --disable-interactivity
    winget uninstall -e --id OpenJS.NodeJS --accept-source-agreements --disable-interactivity
  )
)

echo.
exit /b 0

:help
echo Usage: uninstall-win.bat [--cache] [--remove-node] [--purge]
echo Run as Administrator.
exit /b 0
