@echo off
title Front Desk Assistant
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js isn't installed on this computer yet.
  echo   Download the LTS version from https://nodejs.org, install it, then double-click start.bat again.
  echo.
  pause
  exit /b
)
node scripts\dev.js --office
pause
