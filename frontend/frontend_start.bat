@echo off
REM ============================================================
REM  xCloud subscriber-console - frontend (Next.js UI) startup
REM  Windows launcher. The UI service binds loopback only, so the
REM  browser entry point stays the Nginx edge. The script resolves
REM  its own directory; no absolute path is hard-coded.
REM ============================================================
setlocal
chcp 65001 >nul
cd /d "%~dp0"

echo ============================================================
echo   xCloud subscriber-console - frontend (Next.js UI)
echo ============================================================
echo.

REM ---- 1. Locate the Node.js toolchain ----
where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js was not found in PATH.
    echo         Install Node.js 20.19.0 or newer, then run this script again.
    exit /b 1
)
where npm >nul 2>nul
if errorlevel 1 (
    echo [ERROR] npm was not found in PATH.
    echo         Install Node.js 20.19.0 or newer, then run this script again.
    exit /b 1
)

set "NODE_VERSION="
for /f "delims=" %%V in ('node -v 2^>nul') do set "NODE_VERSION=%%V"
set "NODE_VERSION=%NODE_VERSION:v=%"

set "NODE_MAJOR="
set "NODE_MINOR="
for /f "tokens=1,2 delims=." %%A in ("%NODE_VERSION%") do (
    set "NODE_MAJOR=%%A"
    set "NODE_MINOR=%%B"
)
if not defined NODE_MAJOR (
    echo [ERROR] Could not determine the Node.js version.
    exit /b 1
)
if %NODE_MAJOR% LSS 20 (
    echo [ERROR] Node.js %NODE_VERSION% is too old. 20.19.0 or newer is required.
    exit /b 1
)
if %NODE_MAJOR% EQU 20 if %NODE_MINOR% LSS 19 (
    echo [ERROR] Node.js %NODE_VERSION% is too old. 20.19.0 or newer is required.
    exit /b 1
)
echo [1/4] Node.js %NODE_VERSION%

REM ---- 2. Ensure frontend dependencies ----
if exist "node_modules" (
    echo [2/4] Dependencies already installed
) else (
    echo [2/4] Installing frontend dependencies...
    if exist "package-lock.json" (
        call npm ci
    ) else (
        call npm install
    )
    if errorlevel 1 (
        echo [ERROR] Dependency installation failed.
        exit /b 1
    )
)

REM ---- 3. Local environment file ----
if exist ".env" (
    echo [3/4] .env already present
) else (
    if exist "..\.env" (
        copy /y "..\.env" ".env" >nul
        echo [3/4] .env created from the repository root .env
    ) else (
        echo [3/4] No .env found, the UI keeps its built-in defaults
    )
)

REM ---- 4. Start the development server ----
echo [4/4] Starting the Next.js development server...
echo.
echo   UI service    : 127.0.0.1:13333 ^(loopback, internal only^)
echo   Browser entry : http://localhost ^(Nginx edge^)
echo   Stop with Ctrl+C
echo.
call npm run dev
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" (
    echo.
    echo [ERROR] The development server exited with code %EXIT_CODE%.
    exit /b %EXIT_CODE%
)
exit /b 0
