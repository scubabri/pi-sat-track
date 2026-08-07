@echo off
setlocal EnableExtensions EnableDelayedExpansion

REM =============================================================================
REM Pi Sat Track - Windows install
REM Run as Administrator.
REM
REM   install-win.bat
REM   install-win.bat --no-start
REM   install-win.bat --skip-node
REM =============================================================================

set "DO_START=1"
set "SKIP_NODE_INSTALL=0"
if /I "%~1"=="-h" goto :help
if /I "%~1"=="--help" goto :help

:parse_args
if "%~1"=="" goto :args_done
if /I "%~1"=="--no-start" set "DO_START=0"
if /I "%~1"=="--start" set "DO_START=1"
if /I "%~1"=="--skip-node" set "SKIP_NODE_INSTALL=1"
shift
goto :parse_args
:args_done

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
  echo ERROR: Cannot find package.json and server.js near %SCRIPT_DIR%
  pause
  exit /b 1
)

net session >nul 2>&1
if errorlevel 1 (
  echo ERROR: Run as Administrator.
  echo Right-click install-win.bat - Run as administrator
  pause
  exit /b 1
)

echo.
echo =============================================================================
echo  Pi Sat Track - Windows setup
echo =============================================================================
echo  App dir:  %APP_DIR%
echo  Cache:    %USERPROFILE%\.rpitrack
echo =============================================================================
echo.

call :find_node
if defined NODE_EXE goto have_node

if "%SKIP_NODE_INSTALL%"=="1" (
  echo ERROR: Node.js not found and --skip-node was set.
  pause
  exit /b 1
)

echo Node.js was not found.
echo This installer can download and install Node.js LTS.
echo.
set /p "YN=Install Node.js LTS now? [Y/N]: "
if /I not "%YN%"=="Y" if /I not "%YN%"=="YES" (
  echo Cancelled.
  pause
  exit /b 1
)

call :install_node
if errorlevel 1 (
  echo ERROR: Node.js install failed.
  pause
  exit /b 1
)

for /f "tokens=2*" %%A in ('reg query "HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment" /v Path 2^>nul') do set "MACHINE_PATH=%%B"
for /f "tokens=2*" %%A in ('reg query "HKCU\Environment" /v Path 2^>nul') do set "USER_PATH=%%B"
if defined MACHINE_PATH set "PATH=%MACHINE_PATH%;%PATH%"
if defined USER_PATH set "PATH=%USER_PATH%;%PATH%"
if exist "%ProgramFiles%\nodejs\node.exe" set "PATH=%ProgramFiles%\nodejs;%PATH%"

call :find_node
if not defined NODE_EXE (
  echo ERROR: node.exe still not found after install. Open a NEW elevated prompt and re-run.
  pause
  exit /b 1
)

:have_node
for %%I in ("%NODE_EXE%") do set "NODE_DIR=%%~dpI"
if "%NODE_DIR:~-1%"=="\" set "NODE_DIR=%NODE_DIR:~0,-1%"
set "PATH=%NODE_DIR%;%PATH%"
if exist "%NODE_DIR%\npm.cmd" (set "NPM_CMD=%NODE_DIR%\npm.cmd") else (set "NPM_CMD=npm")

for /f "tokens=*" %%V in ('"%NODE_EXE%" -v') do set "NODE_VER=%%V"
for /f "tokens=*" %%V in ('"%NPM_CMD%" -v') do set "NPM_VER=%%V"
echo Node  %NODE_VER%  (%NODE_EXE%)
echo npm   %NPM_VER%
echo.

set "CACHE_DIR=%USERPROFILE%\.rpitrack"
if not exist "%CACHE_DIR%" mkdir "%CACHE_DIR%"
echo Cache: %CACHE_DIR%
echo.

echo Running npm install...
pushd "%APP_DIR%"
if exist "package-lock.json" (
  call "%NPM_CMD%" ci --omit=dev
  if errorlevel 1 call "%NPM_CMD%" install --omit=dev
) else (
  call "%NPM_CMD%" install --omit=dev
)
if errorlevel 1 (
  echo ERROR: npm install failed.
  popd
  pause
  exit /b 1
)
popd
echo node_modules ready.
echo.

REM Launcher
set "START_BAT=%APP_DIR%\start-sat-tracker.bat"
echo @echo off> "%START_BAT%"
echo setlocal>> "%START_BAT%"
echo cd /d "%%~dp0">> "%START_BAT%"
echo if exist "%%ProgramFiles%%\nodejs\node.exe" set "PATH=%%ProgramFiles%%\nodejs;%%PATH%%">> "%START_BAT%"
echo where node ^>nul 2^>^&1>> "%START_BAT%"
echo if errorlevel 1 (>> "%START_BAT%"
echo   echo ERROR: node.exe not found.>> "%START_BAT%"
echo   pause>> "%START_BAT%"
echo   exit /b 1>> "%START_BAT%"
echo ^)>> "%START_BAT%"
echo echo Starting Pi Sat Track...>> "%START_BAT%"
echo echo Open http://127.0.0.1:3000>> "%START_BAT%"
echo echo Press Ctrl+C to stop>> "%START_BAT%"
echo node server.js>> "%START_BAT%"
echo pause>> "%START_BAT%"
echo Wrote launcher: %START_BAT%
echo.

call :setup_port80

echo =============================================================================
echo  Install complete.
echo  Open:  http://127.0.0.1:3000
echo         http://127.0.0.1/     (if port 80 proxy enabled)
echo =============================================================================
echo.

if "%DO_START%"=="1" (
  echo Starting server in a new window...
  start "Pi Sat Track" "%START_BAT%"
  timeout /t 2 /nobreak >nul
  echo Server window launched.
) else (
  echo Server not started. Run start-sat-tracker.bat when ready.
)

echo.
pause
exit /b 0

REM =============================================================================
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
exit /b 0

REM =============================================================================
:install_node
echo Attempting to install Node.js LTS...
where winget >nul 2>&1
if not errorlevel 1 (
  echo Using winget OpenJS.NodeJS.LTS ...
  winget install -e --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
  if not errorlevel 1 (
    call :mark_node_installed
    exit /b 0
  )
  echo winget failed - trying MSI download...
)

set "MSI_PATH=%TEMP%\node-lts-x64.msi"
echo Downloading Node.js LTS MSI...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $idx=Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json' -UseBasicParsing; $rel=$idx | Where-Object { $_.lts -ne $false } | Select-Object -First 1; if(-not $rel){throw 'No LTS'}; $ver=$rel.version; $url='https://nodejs.org/dist/'+$ver+'/node-'+$ver+'-x64.msi'; Write-Host $url; Invoke-WebRequest -Uri $url -OutFile $env:TEMP\node-lts-x64.msi -UseBasicParsing"
if errorlevel 1 exit /b 1

echo Installing MSI...
msiexec /i "%MSI_PATH%" /qn /norestart ADDLOCAL=ALL
set "MSI_EC=%ERRORLEVEL%"
if not "%MSI_EC%"=="0" if not "%MSI_EC%"=="3010" (
  msiexec /i "%MSI_PATH%"
  set "MSI_EC=%ERRORLEVEL%"
)
del /f /q "%MSI_PATH%" >nul 2>&1
if not "%MSI_EC%"=="0" if not "%MSI_EC%"=="3010" exit /b 1
call :mark_node_installed
exit /b 0

REM =============================================================================
:mark_node_installed
if not exist "%USERPROFILE%\.rpitrack" mkdir "%USERPROFILE%\.rpitrack"
echo installed_by=install-win.bat> "%USERPROFILE%\.rpitrack\.node-installed-by-sat-tracker"
echo installed_at=%DATE% %TIME%>> "%USERPROFILE%\.rpitrack\.node-installed-by-sat-tracker"
echo Marked Node as installed by this installer.
exit /b 0

REM =============================================================================
:setup_port80
echo Checking TCP port 80...
sc config iphlpsvc start= auto >nul 2>&1
net start iphlpsvc >nul 2>&1

set "PORT80_BUSY=0"
netstat -ano 2>nul | findstr /I "LISTENING" | findstr /R /C:":80 " >nul 2>&1
if not errorlevel 1 set "PORT80_BUSY=1"

if "%PORT80_BUSY%"=="1" (
  echo Port 80 in use - skip proxy. Use http://127.0.0.1:3000
  echo.
  exit /b 0
)

echo Adding portproxy 80 to 127.0.0.1:3000 ...
netsh interface portproxy delete v4tov4 listenaddress=127.0.0.1 listenport=80 >nul 2>&1
netsh interface portproxy delete v4tov4 listenaddress=0.0.0.0 listenport=80 >nul 2>&1
netsh interface portproxy add v4tov4 listenaddress=127.0.0.1 listenport=80 connectaddress=127.0.0.1 connectport=3000
if errorlevel 1 (
  echo WARNING: portproxy add for 127.0.0.1 failed
) else (
  echo   127.0.0.1:80 OK
)
netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=80 connectaddress=127.0.0.1 connectport=3000 >nul 2>&1

for /f "tokens=2 delims=:" %%I in ('ipconfig ^| findstr /R /C:"IPv4 Address"') do (
  set "IP=%%I"
  set "IP=!IP: =!"
  if defined IP (
    if not "!IP!"=="127.0.0.1" (
      netsh interface portproxy delete v4tov4 listenaddress=!IP! listenport=80 >nul 2>&1
      netsh interface portproxy add v4tov4 listenaddress=!IP! listenport=80 connectaddress=127.0.0.1 connectport=3000 >nul 2>&1
    )
  )
)

netsh advfirewall firewall delete rule name="Pi Sat Track HTTP 80" >nul 2>&1
netsh advfirewall firewall add rule name="Pi Sat Track HTTP 80" dir=in action=allow protocol=TCP localport=80 >nul 2>&1

echo Portproxy status:
netsh interface portproxy show all
echo.
exit /b 0

REM =============================================================================
:help
echo Usage: install-win.bat [--no-start] [--skip-node]
echo Run as Administrator.
exit /b 0
