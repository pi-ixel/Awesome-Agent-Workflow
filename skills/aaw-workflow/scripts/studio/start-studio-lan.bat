@echo off
setlocal
cd /d "%~dp0"
set HOST=0.0.0.0
set PORT=8765
if not "%~1"=="" set PORT=%~1
set /p AAW_STUDIO_TOKEN=Set access token for LAN editing:
if "%AAW_STUDIO_TOKEN%"=="" (
  echo A token is required for LAN mode.
  pause
  exit /b 1
)
python server.py --host %HOST% --port %PORT% --token "%AAW_STUDIO_TOKEN%" --open
pause
