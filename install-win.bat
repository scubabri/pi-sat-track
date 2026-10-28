@echo off
setlocal EnableExtensions EnableDelayedExpansion

REM =============================================================================
REM Pi Sat Track - Windows install / update
REM Double-click (asks for administrator rights) or run as Administrator.
REM
REM   install-win.bat               install / update, open port 80, start server
REM   install-win.bat --no-start    do not start the server at the end
REM   install-win.bat --skip-node   never install Node.js
REM   install-win.bat --no-port80   no port 80 proxy (use http://localhost:3000)
REM
REM Re-run any time (update): safe, settings in %USERPROFILE%\.rpitrack kept.
REM No service / auto start: start-sat-tracker.bat starts the server.
REM =============================================================================

set "DO_START=1"
set "SKIP_NODE_INSTALL=0"
set "NO_PORT80=0"
set "NODE_MAJOR_MIN=22"
set "ALL_ARGS=%*"
if /I "%~1"=="-h" goto :help
if /I "%~1"=="--help" goto :help

:parse_args
if "%~1"=="" goto :args_done
if /I "%~1"=="--no-start" set "DO_START=0"
if /I "%~1"=="--start" set "DO_START=1"
if /I "%~1"=="--skip-node" set "SKIP_NODE_INSTALL=1"
if /I "%~1"=="--no-port80" set "NO_PORT80=1"
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
  echo Administrator rights are needed for the port 80 proxy and firewall rules.
  echo Asking Windows for them ...
  if defined ALL_ARGS (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -ArgumentList '!ALL_ARGS!' -Verb RunAs"
  ) else (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  )
  if errorlevel 1 (
    echo ERROR: not elevated. Right-click install-win.bat - Run as administrator
    pause
    exit /b 1
  )
  exit /b 0
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
if defined NODE_EXE call :check_node_version
if defined NODE_EXE goto have_node

if "%SKIP_NODE_INSTALL%"=="1" (
  echo ERROR: Node.js not found and --skip-node was set.
  pause
  exit /b 1
)

echo Node.js %NODE_MAJOR_MIN% or newer was not found.
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

if exist "%APP_DIR%\win-network.ps1" (
  echo Stopping a running Pi Sat Track server, if any ...
  powershell -NoProfile -ExecutionPolicy Bypass -File "%APP_DIR%\win-network.ps1" -Action Stop -AppDir "%APP_DIR%"
  echo.
)

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

set "START_BAT=%APP_DIR%\start-sat-tracker.bat"
(
  echo @echo off
  echo setlocal
  echo cd /d "%%~dp0"
  echo if exist "%%ProgramFiles%%\nodejs\node.exe" set "PATH=%%ProgramFiles%%\nodejs;%%PATH%%"
  echo where node ^>nul
  echo if errorlevel 1 ^(
  echo   echo ERROR: node.exe not found.
  echo   pause
  echo   exit /b 1
  echo ^)
  echo echo Starting Pi Sat Track...
  echo echo Open http://localhost/  ^(or http://localhost:3000/^)
  echo echo Press Ctrl+C to stop
  echo if exist "%%~dp0open-when-ready.ps1" start "" /min powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%%~dp0open-when-ready.ps1"
  echo if exist "%%USERPROFILE%%\.rpitrack\.stopping" del /q "%%USERPROFILE%%\.rpitrack\.stopping"
  echo node server.js ^& if errorlevel 1 ^(if not exist "%%USERPROFILE%%\.rpitrack\.stopping" pause^) ^& if exist "%%USERPROFILE%%\.rpitrack\.stopping" del /q "%%USERPROFILE%%\.rpitrack\.stopping" ^& exit /b 0
) > "%START_BAT%"
echo Wrote launcher: %START_BAT%
echo.

set "NET_ARGS=-Action Install -AppDir "%APP_DIR%""
if "%NO_PORT80%"=="1" set "NET_ARGS=%NET_ARGS% -NoPort80"
powershell -NoProfile -ExecutionPolicy Bypass -File "%APP_DIR%\win-network.ps1" %NET_ARGS%
echo.

echo =============================================================================
echo  Install complete. Settings / data: %CACHE_DIR%
echo  Start:     start-sat-tracker.bat  (or: cd "%APP_DIR%" ^& node server.js)
echo  Stop:      Ctrl+C in the server window (or close it)
echo  Update:    run install-win.bat again
echo  Uninstall: uninstall-win.bat   (--data also deletes %CACHE_DIR%)
echo =============================================================================
echo.

if "%DO_START%"=="1" (
  echo Starting server minimized...
  echo   Dir:  %APP_DIR%
  echo   Node: %NODE_EXE%
  if not exist "%NODE_EXE%" (
    echo ERROR: node.exe not found at %NODE_EXE%
  ) else if not exist "%APP_DIR%\server.js" (
    echo ERROR: server.js not found in %APP_DIR%
  ) else (
    start "Pi Sat Track" /min /D "%APP_DIR%" "%NODE_EXE%" server.js
    timeout /t 2 /nobreak >nul
    echo Server started minimized.
  )
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
if not defined NODE_EXE if defined ProgramW6432 if exist "%ProgramW6432%\nodejs\node.exe" set "NODE_EXE=%ProgramW6432%\nodejs\node.exe"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE for %%V in (64 32) do if not defined NODE_EXE (
  for /f "tokens=2,*" %%A in ('reg query "HKLM\SOFTWARE\Node.js" /v InstallPath /reg:%%V 2^>nul ^| find "InstallPath"') do (
    if exist "%%~B\node.exe" set "NODE_EXE=%%~B\node.exe"
  )
)
if not defined NODE_EXE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE_EXE if exist "%LocalAppData%\Programs\node\node.exe" set "NODE_EXE=%LocalAppData%\Programs\node\node.exe"
if not defined NODE_EXE exit /b 0
where node >nul 2>&1
if errorlevel 1 for %%D in ("%NODE_EXE%") do set "PATH=%%~dpD;%PATH%"
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
:check_node_version
set "NODE_MAJOR="
for /f "tokens=1 delims=." %%V in ('"%NODE_EXE%" -v') do set "NODE_MAJOR=%%V"
set "NODE_MAJOR=%NODE_MAJOR:v=%"
if not defined NODE_MAJOR exit /b 0
if %NODE_MAJOR% LSS %NODE_MAJOR_MIN% (
  echo Node.js v%NODE_MAJOR% found - Pi Sat Track needs %NODE_MAJOR_MIN% or newer.
  set "NODE_EXE="
)
exit /b 0

REM =============================================================================
:help
echo Usage: install-win.bat [--no-start] [--skip-node] [--no-port80]
echo Asks for administrator rights (port 80 proxy + firewall rules).
exit /b 0
