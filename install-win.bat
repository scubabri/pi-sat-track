@echo off
setlocal EnableExtensions EnableDelayedExpansion

REM ====================================================a=========================
REM Pi Sat Track - Windows install / update (zip distribution)
REM =============================================================================
REM Place this script in the extracted app folder (next to package.json and
REM server.js). Does NOT clone the app from git.
REM
REM If Node.js is missing, this script will try to install Node.js LTS via:
REM   1) winget  2) official MSI from nodejs.org
REM
REM First install:
REM   1. Unzip the release into e.g. %USERPROFILE%\pi-sat-track
REM   2. Right-click install-win.bat -> Run as administrator  (recommended
REM      if Node is not already installed)
REM   3. Or run from an elevated Command Prompt
REM
REM Flags:
REM   install-win.bat --update       npm install only
REM   install-win.bat --start        install then start the server
REM   install-win.bat --skip-node    do not auto-install Node (fail if missing)
REM =============================================================================

set "UPDATE_ONLY=0"
set "DO_START=0"
set "SKIP_NODE_INSTALL=0"
for %%A in (%*) do (
  if /I "%%~A"=="--update"     set "UPDATE_ONLY=1"
  if /I "%%~A"=="--start"      set "DO_START=1"
  if /I "%%~A"=="--skip-node"  set "SKIP_NODE_INSTALL=1"
  if /I "%%~A"=="-h"           goto :help
  if /I "%%~A"=="--help"       goto :help
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
  echo Extract the full release zip first, then run this script from that folder.
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


echo.
echo =============================================================================
echo  Pi Sat Track - Windows setup
echo =============================================================================
echo  App dir:  %APP_DIR%
echo  Cache:    %USERPROFILE%\.rpitrack
if "%UPDATE_ONLY%"=="1" (
  echo  Mode:     UPDATE (npm only)
) else (
  echo  Mode:     INSTALL
)
echo =============================================================================
echo.

call :find_node
if defined NODE_EXE goto :have_node

if "%SKIP_NODE_INSTALL%"=="1" (
  echo ERROR: Node.js not found and --skip-node was set.
  exit /b 1
)

echo Node.js was not found on this machine.
echo.
echo This installer can download and install Node.js LTS automatically.
echo You may be prompted for administrator permission.
echo.
set /p "YN=Install Node.js LTS now? [Y/N]: "
if /I not "%YN%"=="Y" if /I not "%YN%"=="YES" (
  echo Cancelled. Install Node from https://nodejs.org/ and re-run.
  exit /b 1
)
echo.

call :install_node
if errorlevel 1 (
  echo.
  echo ERROR: Automatic Node.js install failed.
  echo Install manually from https://nodejs.org/ then re-run install-win.bat
  exit /b 1
)

REM Refresh PATH from Machine + User for this session
for /f "tokens=2*" %%A in ('reg query "HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment" /v Path 2^>nul') do set "MACHINE_PATH=%%B"
for /f "tokens=2*" %%A in ('reg query "HKCU\Environment" /v Path 2^>nul') do set "USER_PATH=%%B"
if defined MACHINE_PATH set "PATH=%MACHINE_PATH%;%PATH%"
if defined USER_PATH set "PATH=%USER_PATH%;%PATH%"
if exist "%ProgramFiles%\nodejs\" set "PATH=%ProgramFiles%\nodejs;%PATH%"

call :find_node
if not defined NODE_EXE (
  echo ERROR: Node.js was installed but node.exe still not found.
  echo Close this window, open a NEW Command Prompt, and run install-win.bat again.
  exit /b 1
)

:have_node
for %%I in ("%NODE_EXE%") do set "NODE_DIR=%%~dpI"
if "%NODE_DIR:~-1%"=="\" set "NODE_DIR=%NODE_DIR:~0,-1%"
set "PATH=%NODE_DIR%;%PATH%"

set "NPM_CMD="
if exist "%NODE_DIR%\npm.cmd" (
  set "NPM_CMD=%NODE_DIR%\npm.cmd"
) else (
  where npm >nul 2>&1
  if not errorlevel 1 set "NPM_CMD=npm"
)
if not defined NPM_CMD (
  echo ERROR: npm not found next to node at %NODE_DIR%
  exit /b 1
)

for /f "tokens=*" %%V in ('"%NODE_EXE%" -v') do set "NODE_VER=%%V"
for /f "tokens=*" %%V in ('"%NPM_CMD%" -v') do set "NPM_VER=%%V"
echo Node  %NODE_VER%  (%NODE_EXE%)
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
  call "%NPM_CMD%" ci --omit=dev
  if errorlevel 1 (
    echo npm ci failed - falling back to npm install...
    call "%NPM_CMD%" install --omit=dev
  )
) else (
  call "%NPM_CMD%" install --omit=dev
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
  echo setlocal
  echo cd /d "%%~dp0"
  echo where node ^>nul 2^>^&1
  echo if errorlevel 1 (
  echo   if exist "%%ProgramFiles%%\nodejs\node.exe" set "PATH=%%ProgramFiles%%\nodejs;%%PATH%%"
  echo   if exist "%%LocalAppData%%\Programs\node\node.exe" set "PATH=%%LocalAppData%%\Programs\node;%%PATH%%"
  echo ^)
  echo where node ^>nul 2^>^&1
  echo if errorlevel 1 (
  echo   echo ERROR: node.exe not found. Run install-win.bat again.
  echo   pause
  echo   exit /b 1
  echo ^)
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

REM -------------------- port 80 proxy (if free) --------------------
call :setup_port80

echo =============================================================================
echo  Install complete.
echo.
echo  Start the tracker:
echo    %START_BAT%
echo    or:  cd /d "%APP_DIR%" ^& node server.js
echo.
echo  Open the UI:
echo    http://127.0.0.1:3000
echo    http://127.0.0.1/        (if port 80 proxy was enabled)
echo.
echo  Port 80: enabled automatically when the port is free.
echo  Uninstall removes the port 80 proxy.
echo =============================================================================
echo.

if "%DO_START%"=="1" (
  echo Starting server...
  pushd "%APP_DIR%"
  "%NODE_EXE%" server.js
  popd
)

exit /b 0

REM =============================================================================
REM =============================================================================
:setup_port80
echo Checking TCP port 80...

REM Already have our portproxy?
netsh interface portproxy show v4tov4 2>nul | findstr /I /C:"listenport" | findstr /R /C:"\<80\>" >nul 2>&1
if not errorlevel 1 (
  netsh interface portproxy show all 2>nul | findstr /I "0.0.0.0 80" >nul 2>&1
)

REM Detect listeners on port 80 (LISTENING)
set "PORT80_BUSY=0"
netstat -ano 2>nul | findstr /R /C:":80[ ]" | findstr /I "LISTENING" >nul 2>&1
if not errorlevel 1 set "PORT80_BUSY=1"

REM Also treat IIS http.sys reservations as busy if something is bound
if "%PORT80_BUSY%"=="1" (
  echo   Port 80 is already in use - leaving it alone.
  echo   Node will be available at http://127.0.0.1:3000
  echo   To force a proxy later: enable-port80.bat ^(as Administrator^)
  echo.
  exit /b 0
)

echo   Port 80 looks free - adding proxy 80 -^> 127.0.0.1:3000 ...

REM Admin already verified at script start
netsh interface portproxy delete v4tov4 listenaddress=0.0.0.0 listenport=80 >nul 2>&1
netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=80 connectaddress=127.0.0.1 connectport=3000
if errorlevel 1 (
  echo   WARNING: netsh portproxy add failed.
  echo   Use http://127.0.0.1:3000  or re-run install-win.bat as Administrator.
  echo.
  exit /b 0
)

netsh advfirewall firewall delete rule name="Pi Sat Track HTTP 80" >nul 2>&1
netsh advfirewall firewall add rule name="Pi Sat Track HTTP 80" dir=in action=allow protocol=TCP localport=80 >nul 2>&1

echo   Port 80 proxy enabled:  http://127.0.0.1/  -^>  Node :3000
echo   ^(removed automatically by uninstall-win.bat as Admin^)
echo.
exit /b 0


:find_node
set "NODE_EXE="
where node >nul 2>&1
if not errorlevel 1 (
  for /f "delims=" %%P in ('where node 2^>nul') do (
    if not defined NODE_EXE set "NODE_EXE=%%P"
  )
)
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE_EXE if exist "%LocalAppData%\Programs\node\node.exe" set "NODE_EXE=%LocalAppData%\Programs\node\node.exe"
if not defined NODE_EXE if exist "%LocalAppData%\nvs\default\node.exe" set "NODE_EXE=%LocalAppData%\nvs\default\node.exe"
exit /b 0

REM =============================================================================
:install_node
echo Attempting to install Node.js LTS...
echo.

REM --- 1) winget (built into most Windows 11 systems) ---
where winget >nul 2>&1
if not errorlevel 1 (
  echo Using winget: OpenJS.NodeJS.LTS
  winget install -e --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
  if not errorlevel 1 (
    echo winget install finished.
    call :mark_node_installed
    exit /b 0
  )
  echo winget install did not succeed - trying MSI download...
  echo.
)

REM --- 2) Download official LTS MSI and silent-install ---
set "MSI_PATH=%TEMP%\node-lts-x64.msi"
echo Downloading Node.js LTS MSI from nodejs.org ...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference='Stop'; ^
  try { ^
    $idx = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json' -UseBasicParsing; ^
    $rel = $idx | Where-Object { $_.lts -ne $false } | Select-Object -First 1; ^
    if (-not $rel) { throw 'No LTS release found in index.json' } ^
    $ver = $rel.version; ^
    $url = 'https://nodejs.org/dist/' + $ver + '/node-' + $ver + '-x64.msi'; ^
    Write-Host ('  Version: ' + $ver); ^
    Write-Host ('  URL:     ' + $url); ^
    Invoke-WebRequest -Uri $url -OutFile '%MSI_PATH%' -UseBasicParsing; ^
    if (-not (Test-Path '%MSI_PATH%')) { throw 'Download failed' } ^
    Write-Host ('  Saved:   %MSI_PATH%') ^
  } catch { ^
    Write-Host ('ERROR: ' + $_.Exception.Message); ^
    exit 1 ^
  }"
if errorlevel 1 (
  echo MSI download failed.
  exit /b 1
)

echo Installing MSI silently (may prompt for UAC)...
msiexec /i "%MSI_PATH%" /qn /norestart ADDLOCAL=ALL
set "MSI_EC=%ERRORLEVEL%"
REM msiexec 0 = success, 3010 = success reboot required
if not "%MSI_EC%"=="0" if not "%MSI_EC%"=="3010" (
  echo Silent install returned %MSI_EC% - trying interactive MSI...
  msiexec /i "%MSI_PATH%"
  set "MSI_EC=%ERRORLEVEL%"
)
del /f /q "%MSI_PATH%" >nul 2>&1

if not "%MSI_EC%"=="0" if not "%MSI_EC%"=="3010" (
  echo MSI install failed with code %MSI_EC%
  exit /b 1
)

echo Node.js MSI install finished.
call :mark_node_installed
exit /b 0

REM =============================================================================
:mark_node_installed
set "MARKER=%USERPROFILE%\.rpitrack\.node-installed-by-sat-tracker"
if not exist "%USERPROFILE%\.rpitrack" mkdir "%USERPROFILE%\.rpitrack"
(
  echo installed_by=install-win.bat
  echo installed_at=%DATE% %TIME%
  echo host=%COMPUTERNAME%
) > "%MARKER%"
echo Recorded Node auto-install marker:
echo   %MARKER%
exit /b 0


:help
echo.
echo Usage: install-win.bat [--update] [--start] [--skip-node]
echo.
echo   --update      npm install in the app folder
echo   --start       After install, start node server.js
echo   --skip-node   Do not auto-install Node if missing
echo.
echo If Node is missing, installs Node.js LTS via winget or official MSI.
echo Run as Administrator if auto-install fails due to permissions.
echo.
exit /b 0
