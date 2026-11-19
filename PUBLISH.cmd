@echo off
rem Double-click to publish Nexorum: GitHub (organization + repository) first, then the npm package.
rem You only click buttons and sign in when a browser window asks.
setlocal
cd /d "%~dp0"
set REPO=https://github.com/usenexorum/nexorum

echo.
echo  ================= NEXORUM PUBLISH =================
echo.
git ls-remote %REPO%.git >nul 2>&1
if not errorlevel 1 goto push

echo  STEP 1 of 4 - GitHub organization "usenexorum" (free)
echo  A browser page opens to create an organization.
echo    Organization name: usenexorum
echo    Plan: Free
echo  Finish the form, then come back here. Skip this if the organization already exists.
echo.
start "" "https://github.com/account/organizations/new?plan=free"
pause

echo.
echo  STEP 2 of 4 - GitHub repository
echo  A browser page opens with the repository already filled in
echo  (owner usenexorum, name nexorum, public). Click the green "Create repository" button,
echo  then come back here.
echo.
start "" "https://github.com/new?owner=usenexorum&name=nexorum&visibility=public&description=Long-term%%20memory%%20for%%20AI%%20coding%%20agents"
pause

:push
git remote get-url origin >nul 2>&1 || git remote add origin %REPO%.git
echo.
echo  Uploading the code. If a GitHub sign-in window opens, sign in there.
git push -u origin main
if errorlevel 1 (
  echo.
  echo  [X] Upload to GitHub failed. Check that github.com/usenexorum/nexorum exists and that you signed in,
  echo      then double-click PUBLISH.cmd again. Nothing was published to npm.
  pause
  exit /b 1
)
echo  [OK] Code is on GitHub: %REPO%

echo.
echo  STEP 3 of 4 - npm
cd cli
echo  Running the tests once before publishing...
call npm test >"%TEMP%\nexorum-test.log" 2>&1
if errorlevel 1 (
  echo  [X] Tests failed, so nothing was published. Log: %TEMP%\nexorum-test.log
  pause
  exit /b 1
)
echo  [OK] Tests passed.
call npm view nexorum version >nul 2>&1
if not errorlevel 1 (
  echo  [OK] nexorum is already on npm. Skipping publish.
  cd ..
  goto done
)
call npm whoami >nul 2>&1
if errorlevel 1 (
  echo  Sign in to npm: a browser window opens. Create a free account there if you have none.
  call npm login
)
call npm publish --access public
if errorlevel 1 (
  echo.
  echo  [X] npm publish failed. Read the message above, then double-click PUBLISH.cmd again.
  echo      GitHub is already done, so it only redoes the npm part.
  pause
  exit /b 1
)
cd ..

:done
echo.
echo  STEP 4 of 4 - done
echo  [OK] npm: https://www.npmjs.com/package/nexorum
echo  Opening GitHub Actions: wait for the green check (Linux, macOS, Windows tests).
start "" "%REPO%/actions"
start "" "https://www.npmjs.com/package/nexorum"
echo.
echo  Tell Claude "udah publish" so it can test  npx -y nexorum  from npm.
pause
