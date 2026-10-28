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
"%NODE_EXE%" server.js
echo.
echo Server stopped.
pause
exit /b 0

:nonode
echo Node.js was not found. Install Node.js 22 or newer from https://nodejs.org
pause
exit /b 1

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
