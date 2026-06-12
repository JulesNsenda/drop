@echo off
:: DROP install / upgrade script for Windows
:: Usage:
::   install.bat                        fresh install to %USERPROFILE%\drop
::   install.bat --upgrade              force upgrade of existing install
::   install.bat --dir "C:\drop"        custom install directory
::   install.bat --branch develop       install from a specific branch
::
:: Requires: Node.js 20+, Git  (both available from https://nodejs.org / https://git-scm.com)
:: Run from a normal Command Prompt — no Administrator required unless npm link fails.
setlocal enabledelayedexpansion

set "REPO_URL=https://github.com/JulesNsenda/drop.git"
set "INSTALL_DIR=%USERPROFILE%\drop"
set "BRANCH=main"
set "UPGRADE=false"

:: ── argument parsing ────────────────────────────────────────────────────────
:parse
if "%~1"=="" goto :check_node
if /i "%~1"=="--upgrade"  set "UPGRADE=true"  & shift & goto :parse
if /i "%~1"=="--dir"      set "INSTALL_DIR=%~2" & shift & shift & goto :parse
if /i "%~1"=="--branch"   set "BRANCH=%~2"    & shift & shift & goto :parse
echo [DROP] Unknown option: %~1
exit /b 1

:: ── Node.js check ───────────────────────────────────────────────────────────
:check_node
where node >nul 2>&1
if errorlevel 1 (
  echo [DROP] ERROR: Node.js not found.
  echo [DROP]   Download and install Node.js 20+ from https://nodejs.org
  exit /b 1
)
for /f "tokens=*" %%v in ('node -e "console.log(parseInt(process.version.slice(1)))"') do set "NODE_VER=%%v"
if !NODE_VER! LSS 20 (
  echo [DROP] ERROR: Node.js !NODE_VER! found but 20+ is required.
  echo [DROP]   Download the latest LTS from https://nodejs.org
  exit /b 1
)
echo [DROP] Node.js !NODE_VER! found

:: ── Git check ───────────────────────────────────────────────────────────────
where git >nul 2>&1
if errorlevel 1 (
  echo [DROP] ERROR: Git not found.
  echo [DROP]   Download and install Git from https://git-scm.com
  exit /b 1
)

:: ── auto-detect upgrade ─────────────────────────────────────────────────────
if exist "%INSTALL_DIR%\.git" set "UPGRADE=true"

:: ── clone or pull ───────────────────────────────────────────────────────────
if "%UPGRADE%"=="true" (
  echo [DROP] Existing installation found — upgrading...
  git -C "%INSTALL_DIR%" fetch origin
  if errorlevel 1 goto :error
  git -C "%INSTALL_DIR%" checkout %BRANCH%
  if errorlevel 1 goto :error
  git -C "%INSTALL_DIR%" pull origin %BRANCH%
  if errorlevel 1 goto :error
) else (
  echo [DROP] Cloning DROP into %INSTALL_DIR%...
  git clone --branch %BRANCH% %REPO_URL% "%INSTALL_DIR%"
  if errorlevel 1 goto :error
)

cd /d "%INSTALL_DIR%"

:: ── install + build ─────────────────────────────────────────────────────────
echo [DROP] Installing dependencies...
call npm ci
if errorlevel 1 goto :error

echo [DROP] Building...
call npm run build:server
if errorlevel 1 goto :error

echo [DROP] Linking CLI ^(drop command^)...
call npm link
if errorlevel 1 (
  echo [DROP] WARN: npm link failed — try re-running this script from an
  echo [DROP]       Administrator command prompt, or run 'npm link' manually.
)

:: ── done ────────────────────────────────────────────────────────────────────
echo.
echo [DROP] Done!
echo.
if "%UPGRADE%"=="true" (
  echo   Restart DROP to apply the update:
  echo     drop server stop
  echo     drop serve
) else (
  echo   Start DROP:
  echo     drop serve
  echo.
  echo   Or with a custom data directory:
  echo     drop serve --root "%USERPROFILE%\drop-data"
  echo.
  echo   Dashboard: http://localhost:3000/dashboard
  echo   On first start DROP prints a one-time admin password -- copy it.
)
echo.
goto :eof

:error
echo.
echo [DROP] Installation failed. Check the output above.
exit /b 1
