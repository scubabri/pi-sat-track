@echo off
setlocal EnableExtensions EnableDelayedExpansion

REM =============================================================================
REM Pi Sat Track — Windows uninstall / cleanup (zip distribution)
REM =============================================================================
REM Run from the app folder (next to package.json / server.js).
REM
REM Default: removes runtime install artifacts only
REM   - node_modules
REM   - start-sat-tracker.bat (launcher written by install-win.bat)
REM   - npm logs in this folder (npm-debug.log*, etc.)
REM
REM Optional:
REM   uninstall-win.bat --cache     also delete %USERPROFILE%\.rpitrack
REM   uninstall-win.bat --all      node_modules + launcher + cache
REM   uninstall-win.bat --purge    --all PLUS delete this app folder
REM                                (script copies itself to %TEMP% first)
REM
REM Does NOT uninstall Node.js or USB serial drivers (system-wide installs).
REM =============================================================================

set "REMOVE_CACHE=0"
set "PURGE_APP=0"

for %%A in (%*) do (
  if /I "%%~A"=="--cache" set "REMOVE_CACHE=1"
  if /I "%%~A"=="--all" (
    set "REMOVE_CACHE=1"
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

set "CACHE_DIR=%USERPROFILE%\.rpitrack"
set "START_BAT=%APP_DIR%\start-sat-tracker.bat"

echo.
echo =============================================================================
echo  Pi Sat Track — Windows uninstall
echo =============================================================================
echo  App dir:     %APP_DIR%
echo  Remove:
echo    - node_modules
echo    - start-sat-tracker.bat
echo    - local npm debug logs
if "%REMOVE_CACHE%"=="1" (
  echo    - cache %CACHE_DIR%
) else (
  echo    - cache ^(kept — pass --cache or --all to remove^)
)
if "%PURGE_APP%"=="1" (
  echo    - ENTIRE app folder ^( --purge ^)
)
echo =============================================================================
echo.
echo NOTE: Stop the tracker first if it is running ^(Ctrl+C in its window^).
echo Node.js itself will NOT be uninstalled.
echo.

set /p "CONFIRM=Type YES to continue: "
if /I not "%CONFIRM%"=="YES" (
  echo Cancelled.
  exit /b 0
)
echo.

REM -------------------- stop reminder / best-effort --------------------
where tasklist >nul 2>&1
if not errorlevel 1 (
  tasklist /FI "IMAGENAME eq node.exe" 2>nul | find /I "node.exe" >nul
  if not errorlevel 1 (
    echo WARNING: node.exe is running. If that is sat-tracker, stop it now.
    echo          Continuing will remove files; a running server may error.
    echo.
  )
)

REM -------------------- node_modules --------------------
if exist "%APP_DIR%\node_modules\" (
  echo Removing node_modules...
  rmdir /s /q "%APP_DIR%\node_modules"
  if exist "%APP_DIR%\node_modules\" (
    echo WARNING: Could not fully delete node_modules — close programs using it and retry.
  ) else (
    echo   node_modules removed.
  )
) else (
  echo   node_modules not present.
)

REM -------------------- launcher --------------------
if exist "%START_BAT%" (
  del /f /q "%START_BAT%" >nul 2>&1
  echo   start-sat-tracker.bat removed.
) else (
  echo   start-sat-tracker.bat not present.
)

REM -------------------- npm clutter in app dir --------------------
pushd "%APP_DIR%"
del /f /q npm-debug.log* 2>nul
del /f /q yarn-error.log 2>nul
del /f /q package-lock.json.bak 2>nul
if exist ".npm\" rmdir /s /q ".npm" 2>nul
popd
echo   local npm logs cleaned.

REM -------------------- cache --------------------
if "%REMOVE_CACHE%"=="1" (
  if exist "%CACHE_DIR%\" (
    echo Removing cache %CACHE_DIR% ...
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

REM -------------------- optional full purge --------------------
if "%PURGE_APP%"=="1" (
  echo.
  echo Purging entire app folder:
  echo   %APP_DIR%
  set /p "CONFIRM2=Type DELETE to permanently remove the app folder: "
  if /I not "!CONFIRM2!"=="DELETE" (
    echo App folder kept. Runtime cleanup is done.
    goto :done
  )

  REM Re-launch from TEMP so we can delete the folder containing this script
  set "CLEANER=%TEMP%\pi-sat-track-purge-%RANDOM%.bat"
  (
    echo @echo off
    echo timeout /t 2 /nobreak ^>nul
    echo rmdir /s /q "%APP_DIR%"
    echo if exist "%APP_DIR%" ^(
    echo   echo WARNING: App folder still exists — delete manually:
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

:help
echo.
echo Usage: uninstall-win.bat [--cache ^| --all ^| --purge]
echo.
echo   ^(no flags^)  Remove node_modules, launcher, local npm logs
echo   --cache      Also remove %%USERPROFILE%%\.rpitrack
echo   --all        Same as --cache ^(runtime + cache^)
echo   --purge      --all and delete the application folder
echo.
echo Does not uninstall Node.js or device drivers.
echo.
exit /b 0
