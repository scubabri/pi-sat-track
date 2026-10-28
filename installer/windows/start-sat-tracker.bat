@echo off
setlocal
REM Pi Sat Track - start the server (installed by setup.exe). Close the window to stop.
cd /d "%~dp0"
call :find_node
if not defined NODE_EXE goto :nonode
title Pi Sat Track
echo Pi Sat Track - open http://localhost (or http://localhost:3000)
echo Node: %NODE_EXE%
echo Stop: close this window or press Ctrl+C
echo.
if exist "%~dp0.stopping" del /q "%~dp0.stopping" >nul 2>&1
REM Open the browser 10 s after start (then as soon as the server answers). --no-browser skips.
if /i not "%~1"=="--no-browser" call :open_browser
REM One line on purpose: cmd parses it whole, so setup replacing this file while the
REM server runs cannot make cmd resume mid-file. Pause only on a crash, not when
REM setup / Stop Pi Sat Track stopped it (they write .stopping, or close this window).
"%NODE_EXE%" server.js & if errorlevel 1 (if not exist "%~dp0.stopping" (echo. & echo Server exited with an error. & pause)) & if exist "%~dp0.stopping" del /q "%~dp0.stopping" >nul 2>&1 & exit /b 0

:nonode
echo Node.js was not found. Install Node.js 22 or newer from https://nodejs.org
pause
exit /b 1

REM Browser opener runs in the background so the server starts right away.
REM Fallback without the .ps1: plain 10 s wait (timeout /t 10 /nobreak), then open.
:open_browser
if exist "%~dp0open-when-ready.ps1" (
  start "" /min powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0open-when-ready.ps1"
) else (
  start "" /min cmd /c "timeout /t 10 /nobreak >nul & explorer http://localhost:3000/"
)
exit /b 0

REM Order: PATH, Program Files (64-bit, also from a 32-bit cmd), registry InstallPath.
REM Found outside PATH: its folder is prepended to PATH for this window (npm works too).
:find_node
set "NODE_EXE="
for /f "delims=" %%N in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%N"
if defined NODE_EXE exit /b 0
if defined ProgramW6432 if exist "%ProgramW6432%\nodejs\node.exe" set "NODE_EXE=%ProgramW6432%\nodejs\node.exe"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE for %%V in (64 32) do if not defined NODE_EXE (
  for /f "tokens=2,*" %%A in ('reg query "HKLM\SOFTWARE\Node.js" /v InstallPath /reg:%%V 2^>nul ^| find "InstallPath"') do (
    if exist "%%~B\node.exe" set "NODE_EXE=%%~B\node.exe"
  )
)
if not defined NODE_EXE exit /b 0
for %%D in ("%NODE_EXE%") do set "PATH=%%~dpD;%PATH%"
exit /b 0
