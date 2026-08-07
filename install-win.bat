@echo off
setlocal EnableExtensions EnableDelayedExpansion

REM =============================================================================
REM Pi Sat Track — Windows install / update (zip distribution)
REM =============================================================================
REM Place this script in the extracted app folder (next to package.json and
REM server.js). Does NOT clone or download the app from the internet.
REM
REM First install:
REM   1. Install Node.js LTS from https://nodejs.org/ (include npm)
REM   2. Unzip the release into e.g. %USERPROFILE%\pi-sat-track
REM   3. Double-click install-win.bat  OR  run it from cmd in that folder
REM
REM Flags (optional):
REM   install-win.bat --update     npm install only (skip intro checks noise)
REM   install-win.bat --start      install then start the server
REM =============================================================================

set "UPDATE_ONLY=0"
set "DO_START=0"
for %%A in (%*) do (
  if /I "%%~A"=="--update" set "UPDATE_ONLY=1"
  if /I "%%~A"=="--start"  set "DO_START=1"
  if /I "%%~A"=="-h"       goto :help
  if /I "%%~A"=="--help"   goto :help
)

set "SCRIPT_DIR=%~dp0"
REM strip trailing backslash for nicer echoes
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
  echo Extract the full release zip first, then run this script from that folder.
  exit /b 1
)

echo.
echo =============================================================================
echo  Pi Sat Track — Windows setup
echo =============================================================================
echo  App dir:  %APP_DIR%
echo  Cache:    %USERPROFILE%\.rpitrack
if "%UPDATE_ONLY%"=="1" (
  echo  Mode:     UPDATE ^(npm only^)
) else (
  echo  Mode:     INSTALL
)
echo =============================================================================
echo.

REM -------------------- Node.js --------------------
where node >nul 2>&1
if errorlevel 1 (
  echo ERROR: Node.js is not installed or not on PATH.
  echo.
  echo Install Node.js LTS from:
  echo   https://nodejs.org/
  echo Choose the Windows Installer ^(.msi^), accept the option to add to PATH,
  echo then close and reopen this terminal and run install-win.bat again.
  exit /b 1
)

where npm >nul 2>&1
if errorlevel 1 (
  echo ERROR: npm was not found. Reinstall Node.js LTS and ensure "npm" is on PATH.
  exit /b 1
)

for /f "tokens=*" %%V in ('node -v') do set "NODE_VER=%%V"
for /f "tokens=*" %%V in ('npm -v') do set "NPM_VER=%%V"
echo Node  %NODE_VER%
echo npm   %NPM_VER%
echo.

REM -------------------- cache dir --------------------
set "CACHE_DIR=%USERPROFILE%\.rpitrack"
echo Ensuring cache directory:
echo   %CACHE_DIR%
if not exist "%CACHE_DIR%" mkdir "%CACHE_DIR%"
if not exist "%CACHE_DIR%" (
  echo ERROR: Could not create %CACHE_DIR%
  exit /b 1
)
echo.

REM -------------------- npm install --------------------
echo Running npm install in:
echo   %APP_DIR%
echo.
pushd "%APP_DIR%"
if errorlevel 1 (
  echo ERROR: Cannot cd to %APP_DIR%
  exit /b 1
)

if exist "package-lock.json" (
  call npm ci --omit=dev
  if errorlevel 1 (
    echo npm ci failed — falling back to npm install...
    call npm install --omit=dev
  )
) else (
  call npm install --omit=dev
)

if errorlevel 1 (
  echo.
  echo ERROR: npm install failed.
  echo If serialport failed to build, install "Desktop development with C++"
  echo from Visual Studio Build Tools, then run this script again.
  popd
  exit /b 1
)
popd

echo.
echo node_modules ready.

REM -------------------- helper launchers --------------------
set "START_BAT=%APP_DIR%\start-sat-tracker.bat"
(
  echo @echo off
  echo cd /d "%%~dp0"
  echo echo Starting Pi Sat Track...
  echo echo Open http://127.0.0.1:3000 in your browser
  echo echo Press Ctrl+C to stop
  echo echo.
  echo node server.js
  echo pause
) > "%START_BAT%"

echo Wrote launcher:
echo   %START_BAT%
echo.

echo =============================================================================
echo  Install complete.
echo.
echo  Start the tracker:
echo    %START_BAT%
echo    or:  cd /d "%APP_DIR%" ^& node server.js
echo.
echo  Then open:  http://127.0.0.1:3000
echo.
echo  Serial radios/rotors: install the USB driver, note the COM port in
echo  Device Manager, and select it in Config.
echo =============================================================================
echo.

if "%DO_START%"=="1" (
  echo Starting server...
  pushd "%APP_DIR%"
  node server.js
  popd
)

exit /b 0

:help
echo.
echo Usage: install-win.bat [--update] [--start]
echo.
echo   --update   Same as a normal run ^(npm install in the app folder^)
echo   --start    After install, start node server.js
echo.
echo Prerequisites: Node.js LTS from https://nodejs.org/
echo This script does not download the application source.
echo.
exit /b 0
