@echo off
chcp 65001 >nul
title RF Issue DB - http://localhost:7331
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   [ERROR] Node.js not found.
  echo   Install Node.js LTS from https://nodejs.org and run again.
  echo.
  pause
  exit /b 1
)

if not exist "data\kb.json" (
  echo.
  echo   First run - building index from the shared folder.
  echo   This can take 1-3 minutes. Please wait...
  echo.
  node "tools\build-kb.js"
)

node "server.js" --open
echo.
echo   Server stopped.
pause
