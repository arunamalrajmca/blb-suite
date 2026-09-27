@echo off
setlocal
title BLB Suite - Brave End-to-End Automated Test Runner
set "ROOT=%~dp0"
if not exist "%ROOT%BUILD" mkdir "%ROOT%BUILD"
if not exist "%ROOT%REPORTS" mkdir "%ROOT%REPORTS"
powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%test-runner.ps1"
set "RC=%ERRORLEVEL%"
echo.
echo ================================================
echo BLB END-TO-END TEST RUNNER FINISHED - EXIT CODE %RC%
echo ================================================
echo.
pause
exit /b %RC%
