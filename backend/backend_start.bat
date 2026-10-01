@echo off
REM ============================================================
REM  xCloud subscriber-console - backend (Go API) startup
REM  Windows launcher. The API service binds loopback only, so the
REM  browser entry point stays the Nginx edge. The script resolves
REM  its own directory; no absolute path is hard-coded.
REM ============================================================
setlocal
chcp 65001 >nul
cd /d "%~dp0"

echo ============================================================
echo   xCloud subscriber-console - backend (Go API)
echo ============================================================
echo.

REM ---- 1. Locate the Go toolchain ----
where go >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Go was not found in PATH.
    echo         Install Go 1.24 or newer, then run this script again.
    exit /b 1
)

set "GO_VERSION="
for /f "tokens=3" %%V in ('go version 2^>nul') do set "GO_VERSION=%%V"
set "GO_VERSION=%GO_VERSION:go=%"

set "GO_MAJOR="
set "GO_MINOR="
for /f "tokens=1,2 delims=." %%A in ("%GO_VERSION%") do (
    set "GO_MAJOR=%%A"
    set "GO_MINOR=%%B"
)
if not defined GO_MAJOR (
    echo [ERROR] Could not determine the Go version.
    exit /b 1
)
if %GO_MAJOR% LSS 1 (
    echo [ERROR] Go %GO_VERSION% is too old. Go 1.24 or newer is required.
    exit /b 1
)
if %GO_MAJOR% EQU 1 if %GO_MINOR% LSS 24 (
    echo [ERROR] Go %GO_VERSION% is too old. Go 1.24 or newer is required.
    exit /b 1
)
echo [1/4] Go %GO_VERSION%

REM ---- 2. Load the repository environment ----
set "ENV_FILE=%~dp0..\.env"
if not exist "%ENV_FILE%" (
    echo [ERROR] Environment file not found: %ENV_FILE%
    echo         Copy .env.example to .env at the repository root and set JWT_SECRET.
    exit /b 1
)
for /f "usebackq eol=# tokens=1,* delims==" %%A in ("%ENV_FILE%") do (
    if not "%%~A"=="" set "%%~A=%%~B"
)

if not defined JWT_SECRET (
    echo [ERROR] JWT_SECRET is not set in %ENV_FILE%
    echo         The Go backend fails closed without a secret of at least 32 bytes.
    exit /b 1
)
if "%JWT_SECRET%"=="replace-with-64-hex-character-secret" (
    echo [ERROR] JWT_SECRET is still the placeholder value.
    echo         Generate one with: openssl rand -hex 32
    exit /b 1
)
if "%JWT_SECRET:~31,1%"=="" (
    echo [ERROR] JWT_SECRET must be at least 32 bytes.
    echo         Generate one with: openssl rand -hex 32
    exit /b 1
)
if defined HTTP_ADDR (
    if not "%HTTP_ADDR:~0,9%"=="127.0.0.1" (
        echo [ERROR] HTTP_ADDR must bind loopback. Got: %HTTP_ADDR%
        echo         The Nginx edge is the only public origin.
        exit /b 1
    )
)
echo [2/4] Environment loaded from %ENV_FILE%

REM ---- 3. Resolve Go module dependencies ----
echo [3/4] Resolving Go module dependencies...
call go mod download
if errorlevel 1 (
    echo [ERROR] go mod download failed.
    exit /b 1
)

REM ---- 4. Start the API service ----
set "DISPLAY_ADDR=%HTTP_ADDR%"
if not defined DISPLAY_ADDR set "DISPLAY_ADDR=127.0.0.1:18888"

echo [4/4] Starting the Go API service...
echo.
echo   API service   : %DISPLAY_ADDR% ^(loopback, internal only^)
echo   Health probe  : http://%DISPLAY_ADDR%/healthz
echo   Browser entry : http://localhost ^(Nginx edge^)
echo   Stop with Ctrl+C
echo.
call go run ./cmd/server
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" (
    echo.
    echo [ERROR] The API service exited with code %EXIT_CODE%.
    exit /b %EXIT_CODE%
)
exit /b 0
