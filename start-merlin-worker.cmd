@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
cd /d "%SCRIPT_DIR%"

if not exist ".env" (
  echo [merlin-worker] Missing .env in "%SCRIPT_DIR%"
  exit /b 1
)

where node >nul 2>&1
if errorlevel 1 (
  echo [merlin-worker] Node.js was not found in PATH
  exit /b 1
)

if not exist "logs" mkdir "logs"

echo [merlin-worker] Launch requested at %date% %time%>>"logs\worker-lifecycle.log"
powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command ^
  "$existing = Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*merlin-worker*server.js*' }; if ($existing) { exit 0 }; Start-Process -FilePath 'node.exe' -ArgumentList 'server.js' -WorkingDirectory '%SCRIPT_DIR%' -WindowStyle Hidden -RedirectStandardOutput '%SCRIPT_DIR%logs\stdout.log' -RedirectStandardError '%SCRIPT_DIR%logs\stderr.log'"
set "EXITCODE=%ERRORLEVEL%"
echo [merlin-worker] Launch command finished at %date% %time% with code %EXITCODE%>>"logs\worker-lifecycle.log"

exit /b %EXITCODE%
