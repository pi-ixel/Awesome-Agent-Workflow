@echo off
setlocal
cd /d "%~dp0"
set HOST=127.0.0.1
set PORT=8765
if not "%~1"=="" set HOST=%~1
if not "%~2"=="" set PORT=%~2
python server.py --host %HOST% --port %PORT% --open
pause
