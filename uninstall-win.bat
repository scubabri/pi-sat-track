@echo off
setlocal EnableExtensions EnableDelayedExpansion

REM =============================================================================
REM Pi Sat Track - Windows uninstall
REM =============================================================================
REM Run as Administrator (required).
REM
REM   uninstall-win.bat              remove app runtime (+ Node if marker)
REM   uninstall-win.bat --cache      also delete %USERPROFILE%\.rpitrack
REM   uninstall-win.bat --all        same as --cache
REM   uninstall-win.bat --remove-node  force offer Node uninstall
REM   uninstall-win.bat --purge      --all + delete app folder
REM =============================================================================

set "REMOVE_CACHE=0"
set "PURGE_APP=0"
set "FORCE_NODE=0"
for %%A in (%*) do (
  if /I "%%~A"=="--cache" set "REMOVE_CACHE=1"
  if /I "%%~A"=="--all" set "REMOVE_CACHE=1"
  if /I "%%~A"=="--purge" (
    set "REMOVE_CACHE=1"
    set "PURGE_APP=1"
  )
  if /I "%%~A"=="--remove-node" set "FORCE_NODE=1"
  if /I "%%~A"=="-h" goto :help
  if /I "%%~A"=="--help" goto :help
)

set "SCRIPT_DIR=%~dp0"
if "%SCRIPT_DIR:~-1%"=="\" set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"

set "APP_DIR="
if exist "%SCRIPT_DIR%\package.json" if exist "%SCRIPT_DIR%\server.js" (
  set "APP_DIR=%SCRIPT_DIR%"
) else if exist "%SCRIPT_DIR%\..\package.json" if exist "%SCRIPT_DIR%\..\server.js" (
  pushd "%SCRIPT_DIR%\.."
  set "APP_DIR=!CD!"
  popd
)

if not defined APP_DIR (
  echo ERROR: Cannot find package.json / server.js near %SCRIPT_DIR%
  pause
  exit /b 1
)

net session >nul 2>&1
if errorlevel 1 (
  echo ERROR: This script must be run as Administrator.
  echo Right-click uninstall-win.bat - "Run as administrator"
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
if exist "%NODE_MARKER%" (
  echo          Node.js (auto-installed by install-win - will ask)
) else if "%FORCE_NODE%"=="1" (
  echo          Node.js (--remove-node - will ask)
)
if "%REMOVE_CACHE%"=="1" echo          cache %CACHE_DIR%
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

REM Stop node processes that may lock node_modules (best effort)
echo Stopping node.exe processes (if any)...
taskkill /F /IM node.exe >nul 2>&1
timeout /t 1 /nobreak >nul

echo Removing port 80 proxy...
netsh interface portproxy delete v4tov4 listenaddress=127.0.0.1 listenport=80 >nul 2>&1
netsh interface portproxy delete v4tov4 listenaddress=0.0.0.0 listenport=80 >nul 2>&1
for /f "tokens=2 delims=:" %%I in ('ipconfig ^| findstr /R /C:"IPv4 Address"') do (
  set "IP=%%I"
  set "IP=!IP: =!"
  if defined IP netsh interface portproxy delete v4tov4 listenaddress=!IP! listenport=80 >nul 2>&1
)
netsh advfirewall firewall delete rule name="Pi Sat Track HTTP 80" >nul 2>&1
echo   done.
echo.

if exist "%APP_DIR%\node_modules\" (
  echo Removing node_modules...
  rmdir /s /q "%APP_DIR%\node_modules"
  if exist "%APP_DIR%\node_modules\" (
    echo WARNING: Could not fully delete node_modules
  ) else (
    echo   removed.
  )
) else (
  echo   node_modules not present.
)

if exist "%START_BAT%" (
  del /f /q "%START_BAT%" >nul 2>&1
  echo   start-sat-tracker.bat removed.
)

pushd "%APP_DIR%"
del /f /q npm-debug.log* 2>nul
popd

REM ---- Node.js uninstall ----
set "DO_NODE=0"
if exist "%NODE_MARKER%" set "DO_NODE=1"
if "%FORCE_NODE%"=="1" set "DO_NODE=1"

if "%DO_NODE%"=="1" (
  echo.
  echo Node.js was installed by install-win.bat or --remove-node was specified.
  echo This removes Node.js AND npm system-wide.
  echo.
  set /p "YN_NODE=Uninstall Node.js / npm from this PC? Type YES: "
  if /I "!YN_NODE!"=="YES" (
    call :uninstall_node
  ) else (
    echo   Node.js left installed.
  )
) else (
  echo.
  echo Node.js not removed (no installer marker). Use --remove-node to force offer.
)

if exist "%NODE_MARKER%" del /f /q "%NODE_MARKER%" >nul 2>&1

if "%REMOVE_CACHE%"=="1" (
  if exist "%CACHE_DIR%\" (
    echo Removing cache %CACHE_DIR% ...
    rmdir /s /q "%CACHE_DIR%"
  )
)

if "%PURGE_APP%"=="1" (
  echo.
  set /p "CONFIRM2=Type DELETE to remove app folder %APP_DIR%: "
  if /I "!CONFIRM2!"=="DELETE" (
    set "CLEANER=%TEMP%\pi-sat-purge-%RANDOM%.bat"
    (
      echo @echo off
      echo timeout /t 2 /nobreak ^>nul
      echo rmdir /s /q "%APP_DIR%"
      echo del /f /q "%%~f0"
    ) > "%CLEANER%"
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
:uninstall_node
echo.
echo Uninstalling Node.js / npm...
echo.

set "REMOVED=0"

where winget >nul 2>&1
if not errorlevel 1 (
  echo winget uninstall OpenJS.NodeJS.LTS ...
  winget uninstall -e --id OpenJS.NodeJS.LTS --accept-source-agreements
  if not errorlevel 1 set "REMOVED=1"
  echo winget uninstall OpenJS.NodeJS ...
  winget uninstall -e --id OpenJS.NodeJS --accept-source-agreements
  if not errorlevel 1 set "REMOVED=1"
)

REM MSI uninstall via registry UninstallString
echo Searching registry for Node.js products...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference='Continue'; $n=0; ^
  $paths = @( ^
    'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*', ^
    'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*', ^
    'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' ^
  ); ^
  foreach ($path in $paths) { ^
    Get-ItemProperty $path -ErrorAction SilentlyContinue | ^
      Where-Object { $_.DisplayName -match '^Node.js' } | ^
      ForEach-Object { ^
        Write-Host ('  Found: ' + $_.DisplayName + ' ' + $_.DisplayVersion); ^
        if ($_.UninstallString) { ^
          $us = $_.UninstallString; ^
          if ($us -match '\{[0-9A-Fa-f\-]{36}\}') { ^
            $guid = $Matches[0]; ^
            Write-Host ('  msiexec /x ' + $guid); ^
            $p = Start-Process -FilePath 'msiexec.exe' -ArgumentList \"/x $guid /qn /norestart\" -Wait -PassThru; ^
            if ($p.ExitCode -eq 0 -or $p.ExitCode -eq 3010) { $n++ } ^
          } else { ^
            Write-Host ('  UninstallString: ' + $us); ^
          } ^
        } ^
      } ^
  } ^
  exit $(if ($n -gt 0) { 0 } else { 1 })"

if not errorlevel 1 set "REMOVED=1"

if exist "%ProgramFiles%\nodejs\" (
  echo WARNING: %ProgramFiles%\nodejs still exists - may need reboot or manual remove.
)
if exist "%ProgramFiles%\nodejs\node.exe" (
  echo WARNING: node.exe still present.
) else (
  if "%REMOVED%"=="1" echo   Node.js uninstall completed.
)

if "%REMOVED%"=="0" (
  echo.
  echo Could not auto-remove Node.js.
  echo Remove manually: Settings - Apps - search "Node.js" - Uninstall
  echo Or: winget uninstall OpenJS.NodeJS.LTS
)

echo.
exit /b 0

:help
echo Usage: uninstall-win.bat [--cache^|--all] [--remove-node] [--purge]
echo Run as Administrator.
exit /b 0
