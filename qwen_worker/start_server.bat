@echo off
REM qwen_worker Startup Script
REM Activates conda environment and starts FastAPI server

echo [QwenWorker] Starting qwen_worker server...

REM Environment variables (defaults can be overridden by caller)
if not defined QWEN_HOST set QWEN_HOST=127.0.0.1
if not defined QWEN_PORT set QWEN_PORT=7556
if not defined LLAMA_SERVER_PORT set LLAMA_SERVER_PORT=8080
if not defined QWEN_ENV set QWEN_ENV=qwen_worker

REM Display configuration
echo [QwenWorker] Configuration:
echo [QwenWorker]   - Host: %QWEN_HOST%
echo [QwenWorker]   - Port: %QWEN_PORT%
echo [QwenWorker]   - Llama Server Port: %LLAMA_SERVER_PORT%
echo [QwenWorker]   - Conda Environment: %QWEN_ENV%

REM Activate conda environment
call conda activate %QWEN_ENV%
if errorlevel 1 (
    echo [QwenWorker] ERROR: Failed to activate conda environment '%QWEN_ENV%'
    echo [QwenWorker] Make sure conda is installed and environment exists
    exit /b 1
)

echo [QwenWorker] Model ready
echo [QwenWorker] Starting uvicorn server on %QWEN_HOST%:%QWEN_PORT%...

REM Start uvicorn server
python -m uvicorn server:app --host %QWEN_HOST% --port %QWEN_PORT% --log-level info

REM Capture exit code
set EXIT_CODE=%errorlevel%
echo [QwenWorker] Server stopped with exit code %EXIT_CODE%
exit /b %EXIT_CODE%
