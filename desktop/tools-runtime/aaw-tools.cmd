@echo off
"%~dp0electron.exe" --aaw-cli %*
exit /b %ERRORLEVEL%
