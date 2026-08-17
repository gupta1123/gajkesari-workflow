@echo off
setlocal
cd /d "%~dp0..\.."
npm run installer:tally-bridge
exit /b %ERRORLEVEL%
