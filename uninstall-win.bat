@echo off
setlocal EnableExtensions EnableDelayedExpansion

REM =============================================================================
REM Pi Sat Track - Windows uninstall / cleanup (zip distribution)
REM =============================================================================
REM Run from the app folder (next to package.json / server.js).
REM
REM Default: removes runtime install artifacts only
REM   - node_modules
REM   - start-sat-tracker.bat
REM   - local npm logs
REM
REM Optional:
REM   uninstall-win.bat --cache        also delete %USERPROFILE%\.rpitrack
REM   uninstall-win.bat --all          node_modules + launcher + cache
REM   uninstall-win.bat --remove-node  also uninstall Node.js (see below)
REM   uninstall-win.bat --purge        --all + delete app folder
REM
REM Node.js removal:
REM   If install-win.bat auto-installed Node, a marker file is left at
REM     %USERPROFILE%\.rpitrack\.node-installed-by-sat-tracker
REM   With that marker (or --remove-node), you will be asked whether to
REM   uninstall Node.js via winget / MSI product code.
REM   Node is never removed without an explicit YES.
REM =============================================================================

set "REMOVE_CACHE=0"
set "PURGE_APP=0"
set "REMOVE_NODE=0"
set "FORCE_NODE_PROMPT=0"

for %%A in (%*) do (
  if /I "%%~A"=="--cache" set "REMOVE_CACHE=1"
  if /I "%%~A"=="--all" set "REMOVE_CACHE=1"
  if /I "%%~A"=="--remove-node" (
    set "REMOVE_NODE=1"
    set "FORCE_NODE_PROMPT=1"
  )
  if /I "%%~A"=="--purge" (
    set "REMOVE_CACHE=1"
    set "PURGE_APP=1"
  )
  if /I "%%~A"=="-h"     goto :help
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
  echo ERROR: Cannot find package.json and server.js near:
  echo   %SCRIPT_DIR%
  echo Run this from the extracted app folder.
  exit /b 1
)

REM Require Administrator (port 80 proxy, firewall, optional Node install)
net session >nul 2>&1
if errorlevel 1 (
  echo.
  echo =============================================================================
  echo  ERROR: This script must be run as Administrator.
  echo =============================================================================
  echo.
  echo Right-click the script - "Run as administrator"
  echo   or open an elevated Command Prompt and run it from there.
  echo.
  pause
  exit /b 1
)


set "CACHE_DIR=%USERPROFILE%\.rpitrack"
set "START_BAT=%APP_DIR%\start-sat-tracker.bat"
set "NODE_MARKER=%CACHE_DIR%\.node-installed-by-sat-tracker"

if exist "%NODE_MARKER%" set "REMOVE_NODE=1"

echo.
echo =============================================================================
echo  Pi Sat Track - Windows uninstall
echo =============================================================================
echo  App dir:     %APP_DIR%
echo  Remove:
echo    - node_modules
echo    - start-sat-tracker.bat
echo    - local npm debug logs
if "%REMOVE_CACHE%"=="1" (
  echo    - cache %CACHE_DIR%
) else (
  echo    - cache (kept - pass --cache or --all to remove)
)
if "%REMOVE_NODE%"=="1" (
  if exist "%NODE_MARKER%" (
    echo    - Node.js (auto-installed by install-win.bat - will confirm)
  ) else (
    echo    - Node.js (--remove-node - will confirm)
  )
) else (
  echo    - Node.js (kept)
)
if "%PURGE_APP%"=="1" (
  echo    - ENTIRE app folder (--purge)
)
echo =============================================================================
echo.
echo NOTE: Stop the tracker first if it is running (Ctrl+C in its window).
echo.

set /p "CONFIRM=Type YES to continue: "
if /I not "%CONFIRM%"=="YES" (
  echo Cancelled.
  exit /b 0
)
echo.

where tasklist >nul 2>&1
if not errorlevel 1 (
  tasklist /FI "IMAGENAME eq node.exe" 2>nul | find /I "node.exe" >nul
  if not errorlevel 1 (
    echo WARNING: node.exe is running. Stop sat-tracker before removing files.
    echo.
  )
)

REM -------------------- port 80 proxy (if we added it) --------------------
echo Removing port 80 proxy (if present)...
netsh interface portproxy delete v4tov4 listenaddress=0.0.0.0 listenport=80 >nul 2>&1
netsh advfirewall firewall delete rule name="Pi Sat Track HTTP 80" >nul 2>&1
echo   port 80 proxy/firewall rule cleared (if they existed).
echo.

REM -------------------- node_modules --------------------
if exist "%APP_DIR%\node_modules\" (
  echo Removing node_modules...
  rmdir /s /q "%APP_DIR%\node_modules"
  if exist "%APP_DIR%\node_modules\" (
    echo WARNING: Could not fully delete node_modules.
  ) else (
    echo   node_modules removed.
  )
) else (
  echo   node_modules not present.
)

if exist "%START_BAT%" (
  del /f /q "%START_BAT%" >nul 2>&1
  echo   start-sat-tracker.bat removed.
) else (
  echo   start-sat-tracker.bat not present.
)

pushd "%APP_DIR%"
del /f /q npm-debug.log* 2>nul
del /f /q yarn-error.log 2>nul
if exist ".npm\" rmdir /s /q ".npm" 2>nul
popd
echo   local npm logs cleaned.

REM -------------------- Node.js (optional, confirmed) --------------------
if "%REMOVE_NODE%"=="1" (
  echo.
  echo Node.js uninstall is optional and system-wide.
  if exist "%NODE_MARKER%" (
    echo Marker found - install-win.bat previously auto-installed Node on this PC:
    echo   %NODE_MARKER%
  )
  echo.
  set /p "YN_NODE=Uninstall Node.js from this computer? Type YES: "
  if /I "!YN_NODE!"=="YES" (
    call :uninstall_node
    if exist "%NODE_MARKER%" del /f /q "%NODE_MARKER%" >nul 2>&1
  ) else (
    echo   Node.js left installed.
  )
)

REM -------------------- cache --------------------
if "%REMOVE_CACHE%"=="1" (
  if exist "%CACHE_DIR%\" (
    echo Removing cache %CACHE_DIR% ...
    REM Keep marker removal already done; wipe whole cache
    rmdir /s /q "%CACHE_DIR%"
    if exist "%CACHE_DIR%\" (
      echo WARNING: Could not fully delete cache folder.
    ) else (
      echo   cache removed.
    )
  ) else (
    echo   cache folder not present.
  )
) else (
  echo   cache kept at %CACHE_DIR%
)

if "%PURGE_APP%"=="1" (
  echo.
  echo Purging entire app folder:
  echo   %APP_DIR%
  set /p "CONFIRM2=Type DELETE to permanently remove the app folder: "
  if /I not "!CONFIRM2!"=="DELETE" (
    echo App folder kept. Runtime cleanup is done.
    goto :done
  )

  set "CLEANER=%TEMP%\pi-sat-track-purge-%RANDOM%.bat"
  (
    echo @echo off
    echo timeout /t 2 /nobreak ^>nul
    echo rmdir /s /q "%APP_DIR%"
    echo if exist "%APP_DIR%" ^(
    echo   echo WARNING: App folder still exists - delete manually:
    echo   echo   %APP_DIR%
    echo ^) else ^(
    echo   echo App folder deleted.
    echo ^)
    echo del /f /q "%%~f0"
  ) > "%CLEANER%"
  echo Scheduling folder delete...
  start "" /min cmd /c "%CLEANER%"
  echo This window can be closed. Cleanup runs in the background.
  exit /b 0
)

:done
echo.
echo =============================================================================
echo  Uninstall finished.
echo  To reinstall: run install-win.bat from an extracted release tree.
echo =============================================================================
echo.
exit /b 0

REM =============================================================================
:uninstall_node
echo.
echo Uninstalling Node.js...
echo.

REM 1) winget
where winget >nul 2>&1
if not errorlevel 1 (
  echo Trying winget uninstall OpenJS.NodeJS.LTS ...
  winget uninstall -e --id OpenJS.NodeJS.LTS --accept-source-agreements
  if not errorlevel 1 (
    echo   winget removed OpenJS.NodeJS.LTS
    goto :node_uninstalled
  )
  echo Trying winget uninstall OpenJS.NodeJS ...
  winget uninstall -e --id OpenJS.NodeJS --accept-source-agreements
  if not errorlevel 1 (
    echo   winget removed OpenJS.NodeJS
    goto :node_uninstalled
  )
  echo winget did not remove Node - trying MSI product code...
)

REM 2) MSI product uninstall via Win32_Product / registry uninstall keys is slow;
REM    use Get-Package / Uninstall-Package when available, else msiexec by name.
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference='Continue'; ^
  $removed = $false; ^
  try { ^
    $pkgs = Get-Package -Name 'Node.js*' -ErrorAction SilentlyContinue; ^
    foreach ($p in @($pkgs)) { ^
      Write-Host ('  Uninstalling package: ' + $p.Name + ' ' + $p.Version); ^
      $p | Uninstall-Package -Force -ErrorAction SilentlyContinue; ^
      $removed = $true ^
    } ^
  } catch {} ^
  if (-not $removed) { ^
    $keys = @( ^
      'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*', ^
      'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' ^
    ); ^
    foreach ($k in $keys) { ^
      Get-ItemProperty $k -ErrorAction SilentlyContinue | ^
        Where-Object { $_.DisplayName -like 'Node.js*' } | ^
        ForEach-Object { ^
          if ($_.UninstallString) { ^
            Write-Host ('  Running: ' + $_.UninstallString); ^
            $us = $_.UninstallString; ^
            if ($us -match 'msiexec') { ^
              $guid = [regex]::Match($us, '\{[0-9A-Fa-f\-]+\}').Value; ^
              if ($guid) { Start-Process msiexec.exe -ArgumentList \"/x $guid /qn /norestart\" -Wait -Verb RunAs } ^
            } else { ^
              Start-Process cmd.exe -ArgumentList \"/c $us /S\" -Wait -Verb RunAs -ErrorAction SilentlyContinue ^
            } ^
            $removed = $true ^
          } ^
        } ^
    } ^
  } ^
  if ($removed) { exit 0 } else { Write-Host '  No Node.js product found to uninstall.'; exit 1 }"

if errorlevel 1 (
  echo WARNING: Could not fully uninstall Node.js automatically.
  echo Remove it from Settings - Apps - Installed apps if it is still listed.
  exit /b 1
)

:node_uninstalled
echo   Node.js uninstall attempted.
exit /b 0

:help
echo.
echo Usage: uninstall-win.bat [--cache ^| --all ^| --remove-node ^| --purge]
echo.
echo   (no flags)     Remove node_modules, launcher, local npm logs
echo   --cache/--all  Also remove %%USERPROFILE%%\.rpitrack
echo   --remove-node  Offer to uninstall Node.js (also auto if marker present)
echo   --purge        --all and delete the application folder
echo.
echo Node.js is only removed after you type YES at the Node prompt.
echo.
exit /b 0
