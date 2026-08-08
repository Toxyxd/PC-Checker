@echo off
setlocal EnableExtensions
title Toxy Anti-Cheat Local Server
cd /d "%~dp0"

echo ============================================
echo    Toxy Anti-Cheat - Local Dashboard
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js is not installed.
  echo Install it from https://nodejs.org then run this again.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo Installing dependencies (first run, one-time)...
  call npm install
  if errorlevel 1 (
    echo [ERROR] npm install failed.
    pause
    exit /b 1
  )
)

echo.
echo Starting server at http://localhost:3000
echo Keep this window open. Close it to stop the server.
echo.
start "" "http://localhost:3000"
node index.js

pause