@echo off
REM ============================================================================
REM  publish.bat - interactive publish menu for vscode-proj2pdf
REM  Run from the project root. Handles:
REM    * versioning  (patch / minor / major / explicit)
REM    * local build (npm ci, compile, vsce package -> .vsix)
REM    * github flow (commit + push main, tag vX.Y.Z + push tag,
REM      which triggers .github/workflows/release.yml -> GitHub Release)
REM ============================================================================
setlocal EnableDelayedExpansion
cd /d "%~dp0"

if not exist package.json (
  echo [ERROR] package.json not found. Run publish.bat from the project root.
  exit /b 1
)
where node >nul 2>nul || ( echo [ERROR] node is not on PATH. & exit /b 1 )
where git >nul 2>nul || ( echo [ERROR] git is not on PATH. & exit /b 1 )

:MENU
call :READ_VERSION
echo.
echo ============================================================
echo  Publish - vsc-project2pdf  (version %VER%^)
echo ============================================================
git branch --show-current >nul 2>nul && (
  for /f "delims=" %%b in ('git branch --show-current') do echo  Branch: %%b
)
git status --porcelain | findstr /r "." >nul && echo  Worktree: DIRTY ^(uncommitted changes^) || echo  Worktree: clean
echo ------------------------------------------------------------
echo  [1] Status           (version, git log, tags, gh releases)
echo  [2] Bump patch       (x.y.Z  - bug fixes^)
echo  [3] Bump minor       (x.Y.0  - new features^)
echo  [4] Bump major       (X.0.0  - breaking changes^)
echo  [5] Set explicit version
echo  [6] Install deps     (npm ci^)
echo  [7] Compile          (npm run compile^)
echo  [8] Package local VSIX
echo  [9] Commit + push main
echo  [A] Tag v%VER% + push tag  (triggers GitHub Release^)
echo  [F] FULL publish     (bump -^> ci -^> compile -^> commit -^> push -^> tag^)
echo  [W] Watch latest GitHub Actions run
echo  [0] Exit
echo ------------------------------------------------------------
set /p CHOICE="Select: "
REM Trim spaces so "1 " (or pasted input) still matches.
set "CHOICE=%CHOICE: =%"

if /i "%CHOICE%"=="1" call :STATUS & goto MENU
if "%CHOICE%"=="2" call :BUMP patch & goto MENU
if "%CHOICE%"=="3" call :BUMP minor & goto MENU
if "%CHOICE%"=="4" call :BUMP major & goto MENU
if "%CHOICE%"=="5" call :SET_VERSION & goto MENU
if "%CHOICE%"=="6" call :INSTALL_DEPS & goto MENU
if "%CHOICE%"=="7" call :COMPILE & goto MENU
if "%CHOICE%"=="8" call :PACKAGE & goto MENU
if "%CHOICE%"=="9" call :COMMIT_PUSH & goto MENU
if /i "%CHOICE%"=="A" call :TAG_PUSH & goto MENU
if /i "%CHOICE%"=="F" call :FULL & goto MENU
if /i "%CHOICE%"=="W" call :WATCH & goto MENU
if "%CHOICE%"=="0" exit /b 0
echo [WARN] Unknown choice "%CHOICE%".
goto MENU

REM ---------------- helpers ----------------

:READ_VERSION
for /f "delims=" %%v in ('node -p "require('./package.json').version"') do set "VER=%%v"
exit /b 0

:STATUS
call :READ_VERSION
echo.
echo --- version --- & echo package.json: %VER%
echo. & echo --- git log --- & git log --oneline -5
echo. & echo --- tags --- & git tag --list "v*" | sort
echo. & echo --- status --- & git status --short
where gh >nul 2>nul && (
  echo. & echo --- github releases --- & gh release list --limit 5
) || echo. & echo ^(gh CLI not found - skipping release list^)
exit /b 0

:BUMP
REM %1 = patch ^| minor ^| major
call npm version %1 --no-git-tag-version
if errorlevel 1 ( echo [ERROR] version bump failed. & exit /b 1 )
call :READ_VERSION
echo [OK] Bumped to %VER% (package.json + package-lock.json, no git tag yet^)
exit /b 0

:SET_VERSION
set /p NEWVER="New version (e.g. 1.2.0): "
if "%NEWVER%"=="" ( echo [WARN] Empty - cancelled. & exit /b 0 )
call npm version %NEWVER% --no-git-tag-version --allow-same-version
if errorlevel 1 ( echo [ERROR] version set failed. & exit /b 1 )
call :READ_VERSION
echo [OK] Version is now %VER%.
exit /b 0

:INSTALL_DEPS
if not exist node_modules (
  echo [INFO] node_modules missing - running npm ci...
)
call npm ci
if errorlevel 1 ( echo [ERROR] npm ci failed. & exit /b 1 )
echo [OK] Dependencies installed.
exit /b 0

:COMPILE
call npm run compile
if errorlevel 1 ( echo [ERROR] compile failed. & exit /b 1 )
echo [OK] TypeScript compiled to out/.
exit /b 0

:PACKAGE
where npx >nul 2>nul || ( echo [ERROR] npx not found. & exit /b 1 )
call npx vsce package
if errorlevel 1 ( echo [ERROR] vsce package failed. & exit /b 1 )
echo [OK] Local VSIX created:
dir /b *.vsix
exit /b 0

:CONFIRM_DIRTY
REM Warns if the worktree is dirty; sets DIRTY=1/0. Never blocks - just asks.
set "DIRTY=0"
git status --porcelain | findstr /r "." >nul && set "DIRTY=1"
if "%DIRTY%"=="1" (
  echo [WARN] Worktree has uncommitted changes:
  git status --short
  set /p ANSWER="Continue anyway? (y/N): "
  if /i not "!ANSWER!"=="y" exit /b 1
)
exit /b 0

:COMMIT_PUSH
call :CONFIRM_DIRTY
if errorlevel 1 ( echo [INFO] Cancelled. & exit /b 0 )
git status --porcelain | findstr /r "." >nul
if errorlevel 1 (
  echo [INFO] Nothing to commit - worktree clean.
) else (
  set /p MSG="Commit message: "
  if "!MSG!"=="" set "MSG=Release prep"
  git add -A
  git commit -m "!MSG!"
  if errorlevel 1 ( echo [ERROR] commit failed. & exit /b 1 )
)
for /f "delims=" %%b in ('git branch --show-current') do set "BR=%%b"
echo [INFO] Pushing !BR! to origin...
git push origin !BR!
if errorlevel 1 ( echo [ERROR] push failed. & exit /b 1 )
echo [OK] Pushed !BR!.
exit /b 0

:TAG_PUSH
call :READ_VERSION
git rev-parse "v%VER%" >nul 2>nul
if not errorlevel 1 (
  echo [ERROR] Tag v%VER% already exists. Bump the version first (options 2-5^).
  exit /b 1
)
call :CONFIRM_DIRTY
if errorlevel 1 ( echo [INFO] Cancelled. & exit /b 0 )
set /p TAGMSG="Tag message [v%VER%]: "
if "!TAGMSG!"=="" set "TAGMSG=v%VER%"
git tag -a "v%VER%" -m "!TAGMSG!"
if errorlevel 1 ( echo [ERROR] tag creation failed. & exit /b 1 )
git push origin "v%VER%"
if errorlevel 1 ( echo [ERROR] tag push failed - removing local tag... & git tag -d "v%VER%" & exit /b 1 )
echo [OK] Tag v%VER% pushed - release.yml is building the GitHub Release.
exit /b 0

:WATCH
where gh >nul 2>nul || ( echo [ERROR] gh CLI not found. & exit /b 1 )
gh run list --limit 5
set /p W="Watch the latest run until it finishes? (y/N): "
if /i "%W%"=="y" gh run watch --exit-status
exit /b 0

:FULL
echo --- [1/6] version ---
echo Current: %VER%
echo Bump: [2] patch  [3] minor  [4] major  [Enter] keep %VER%
set /p BKIND="Choice: "
if "%BKIND%"=="2" call :BUMP patch
if "%BKIND%"=="3" call :BUMP minor
if "%BKIND%"=="4" call :BUMP major
if errorlevel 1 ( echo [ERROR] bump failed - aborting. & exit /b 1 )
echo --- [2/6] install --- & call :INSTALL_DEPS
if errorlevel 1 exit /b 1
echo --- [3/6] compile --- & call :COMPILE
if errorlevel 1 exit /b 1
echo --- [4/6] commit+push --- & call :COMMIT_PUSH
if errorlevel 1 exit /b 1
echo --- [5/6] tag+push --- & call :TAG_PUSH
if errorlevel 1 exit /b 1
echo --- [6/6] release status ---
call :WATCH
exit /b 0
