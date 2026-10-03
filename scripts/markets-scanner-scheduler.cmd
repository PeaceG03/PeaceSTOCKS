@echo off
setlocal
set "REPO_ROOT=%~dp0.."
if /I "%~1"=="--probe" set "PEACEAI_MARKETS_SCHEDULER_PROBE=1"
pnpm --dir "%REPO_ROOT%" scheduler
exit /b %ERRORLEVEL%
