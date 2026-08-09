@echo off
setlocal
title Rainy Music Server
echo ==============================================
echo   Rainy Music Server Launcher
echo ==============================================
echo.

:: Use absolute paths to avoid "No se esperaba . en este momento" when quoted
:: dot-paths appear inside IF (...) blocks (cmd parser bug with ".\.venv").
set "ROOT=%~dp0"
set "VENV_PY=%ROOT%.venv\Scripts\python.exe"
set "VENV_PIP=%ROOT%.venv\Scripts\pip.exe"

:: Resolve python executable (prefer 'python', fall back to 'py')
set "PYTHON=python"
where python >nul 2>nul
if errorlevel 1 (
    where py >nul 2>nul
    if errorlevel 1 (
        echo [ERROR] Python not found. Install Python 3.11+ and add it to PATH.
        echo         Download: https://www.python.org/downloads/
        pause
        exit /b 1
    ) else (
        set "PYTHON=py"
    )
)

:: Check for .venv directory
if not exist "%ROOT%.venv" (
    echo [INFO] Virtual environment not found. Creating .venv...
    %PYTHON% -m venv "%ROOT%.venv"
    if errorlevel 1 (
        echo [ERROR] Failed to create virtual environment. Make sure Python is installed and in your PATH.
        pause
        exit /b 1
    )
    echo [INFO] Virtual environment created successfully.
    echo.
)

:: Keep dependencies in sync (fast no-op when already satisfied)
echo [INFO] Checking requirements...
"%VENV_PY%" -m pip install -q -r requirements.txt
if errorlevel 1 (
    echo [ERROR] Failed to install requirements.
    echo         Try running manually: "%VENV_PY%" -m pip install -r requirements.txt
    pause
    exit /b 1
)

:: --- Optional: AI DJ voice (Kokoro TTS) ---
:: The DJ works as text without this. Voice needs a local TTS engine.
:: We do NOT auto-install kokoro here because it is heavy (~1GB model download)
:: and optional. Just inform the user. Avoid IF (...) blocks with redirections
:: and dot-paths (cmd parser bug).
set "TTS_FOUND=0"
"%VENV_PY%" -m pip show kokoro >nul 2>nul
if not errorlevel 1 set "TTS_FOUND=1"
"%VENV_PY%" -m pip show kokoro-onnx >nul 2>nul
if not errorlevel 1 set "TTS_FOUND=1"
"%VENV_PY%" -m pip show kokoro-tts >nul 2>nul
if not errorlevel 1 set "TTS_FOUND=1"
if "%TTS_FOUND%"=="0" echo [INFO] TTS voice not installed -- DJ will be text-only (no audio).
if "%TTS_FOUND%"=="0" echo        To enable voice: "%VENV_PY%" -m pip install kokoro
if "%TTS_FOUND%"=="0" echo        (or: "%VENV_PY%" -m pip install kokoro-onnx for lighter ONNX version)
if "%TTS_FOUND%"=="1" echo [INFO] TTS voice engine found.
echo.

:: Check for .env file, copy from .env.example if missing
if exist "%ROOT%.env" goto :have_env
if not exist "%ROOT%.env.example" (
    echo [WARNING] Neither .env nor .env.example found!
    goto :have_env
)
echo [INFO] .env file not found. Copying from .env.example...
copy /Y "%ROOT%.env.example" "%ROOT%.env" >nul
:have_env

echo [INFO] Starting Rainy Music Server...
echo.
"%VENV_PY%" app.py
if errorlevel 1 (
    echo.
    echo [ERROR] Server exited with an error.
    pause
    exit /b 1
)

pause
endlocal
