@echo off
setlocal
REM Pi Sat Track - start the server (installed by setup.exe). Close the window to stop.
cd /d "%~dp0"
set "NODE_EXE="
for /f "delims=" %%N in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%N"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE goto :nonode
title Pi Sat Track
echo Pi Sat Track - open http://localhost (or http://localhost:3000)
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
