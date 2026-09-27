@echo off
setlocal
cd /d "%~dp0.."

echo ================================================================
echo  BLUE LETTER BIBLE SUITE - LOCAL TEST RUNNER
echo ================================================================
echo.

echo [1/3] Static validation...
call npm run test:static
if errorlevel 1 (
  echo.
  echo STATIC VALIDATION FAILED. STOPPING.
  exit /b 1
)

echo.
echo [2/3] Automated Playwright browser tests...
if not exist node_modules\@playwright\test (
  echo Playwright is not installed. Installing dependencies...
  call npm install
  if errorlevel 1 exit /b 1
  call npx playwright install chromium
  if errorlevel 1 exit /b 1
)
call npm test
set TEST_RESULT=%ERRORLEVEL%

echo.
echo [3/3] Local Brave-native runner...
echo The existing Brave runner remains available under:
echo   local-runner\Legacy-Brave-E2E-Runner\BLB-Test.bat

echo It is intentionally separate because native permission prompts, context menus,
echo trusted gestures, and file:// access need the real Brave UI.

echo.
echo Automated Playwright exit code: %TEST_RESULT%
echo ================================================================
exit /b %TEST_RESULT%
