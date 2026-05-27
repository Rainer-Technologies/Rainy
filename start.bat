@echo off
title Rainy Music Server
echo ==============================================
echo   🎵 Rainy Music Server Launcher 🎵
echo ==============================================
echo.

:: Check for .venv directory
if not exist ".venv" (
    echo [INFO] Virtual environment not found. Creating .venv...
    python -m venv .venv
    if errorlevel 1 (
        echo [ERROR] Failed to create virtual environment. Make sure Python is installed and in your PATH.
        pause
        exit /b 1
    )
    echo [INFO] Virtual environment created successfully.
    echo.
    echo [INFO] Installing requirements...
    .venv\Scripts\pip install -r requirements.txt
    if errorlevel 1 (
        echo [ERROR] Failed to install requirements.
        pause
        exit /b 1
    )
    echo [INFO] Requirements installed successfully.
    echo.
)

:: Check for .env file, copy from .env.example if missing
if not exist ".env" (
    if exist ".env.example" (
        echo [INFO] .env file not found. Copying from .env.example...
        copy .env.example .env
    ) else (
        echo [WARNING] Neither .env nor .env.example found!
    )
)

echo [INFO] Starting Rainy Music Server...
echo.
.venv\Scripts\python.exe app.py
if errorlevel 1 (
    echo.
    echo [ERROR] Server exited with an error.
    pause
    exit /b 1
)

pause
