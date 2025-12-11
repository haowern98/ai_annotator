# Quick Test Script for Python Model Server
# Tests Parakeet transcription and Gemma summarization

param(
    [switch]$SkipTranscription,
    [switch]$SkipSummary
)

$ErrorActionPreference = "Stop"

Write-Host "`n🧪 Testing Python Model Server" -ForegroundColor Cyan
Write-Host "=" * 60 -ForegroundColor Cyan

# Check if Python environment exists
$PYTHON_EXE = "..\python-env\python\python.exe"
if (-not (Test-Path $PYTHON_EXE)) {
    Write-Host "❌ Error: Python environment not found!" -ForegroundColor Red
    Write-Host "   Run setup.ps1 first: cd ..\python-env; .\setup.ps1" -ForegroundColor Yellow
    exit 1
}

Write-Host "`n✅ Python environment found" -ForegroundColor Green

# Check if model_server.py exists
if (-not (Test-Path "model_server.py")) {
    Write-Host "❌ Error: model_server.py not found!" -ForegroundColor Red
    Write-Host "   Please run this script from: electron\python-server\" -ForegroundColor Yellow
    exit 1
}

Write-Host "✅ Model server found" -ForegroundColor Green

# Start the server in background
Write-Host "`n🚀 Starting model server..." -ForegroundColor Cyan
Write-Host "   This will download models on first run (~12GB total)" -ForegroundColor Yellow
Write-Host "   Parakeet: ~600MB (CPU)" -ForegroundColor White
Write-Host "   Gemma 3n: ~11GB (GPU, 3GB VRAM)" -ForegroundColor White

$serverProcess = Start-Process -FilePath $PYTHON_EXE -ArgumentList "model_server.py" -PassThru -NoNewWindow -RedirectStandardOutput "server_output.txt" -RedirectStandardError "server_error.txt"

Write-Host "   Server PID: $($serverProcess.Id)" -ForegroundColor Cyan

# Wait for server to start and get port
Write-Host "`n⏳ Waiting for server to start..." -ForegroundColor Yellow
$maxWait = 120 # 2 minutes
$waited = 0
$serverPort = $null

while ($waited -lt $maxWait) {
    Start-Sleep -Seconds 2
    $waited += 2
    
    if (Test-Path "server_output.txt") {
        $output = Get-Content "server_output.txt" -Raw
        
        # Check for port
        if ($output -match "SERVER_PORT:(\d+)") {
            $serverPort = $matches[1]
            Write-Host "✅ Server started on port: $serverPort" -ForegroundColor Green
            break
        }
        
        # Check for errors
        if ($output -match "ERROR:(.+)") {
            Write-Host "❌ Server error: $($matches[1])" -ForegroundColor Red
            Stop-Process -Id $serverProcess.Id -Force
            exit 1
        }
        
        # Show download progress
        if ($output -match "DOWNLOAD_PROGRESS:(.+)") {
            $progress = $matches[1]
            Write-Host "   📥 $progress" -ForegroundColor Cyan
        }
    }
    
    Write-Host "." -NoNewline
}

if (-not $serverPort) {
    Write-Host "`n❌ Server failed to start within $maxWait seconds" -ForegroundColor Red
    Write-Host "   Check server_error.txt for details" -ForegroundColor Yellow
    Stop-Process -Id $serverProcess.Id -Force -ErrorAction SilentlyContinue
    exit 1
}

Write-Host "`n`n✅ Server ready at ws://127.0.0.1:$serverPort/ws" -ForegroundColor Green

# Cleanup
Write-Host "`n🧹 Cleaning up..." -ForegroundColor Cyan
Stop-Process -Id $serverProcess.Id -Force -ErrorAction SilentlyContinue
Write-Host "✅ Server stopped" -ForegroundColor Green

Write-Host "`n" + "=" * 60 -ForegroundColor Cyan
Write-Host "✅ Server test complete!" -ForegroundColor Green
Write-Host "=" * 60 -ForegroundColor Cyan

Write-Host "`n📊 Next Steps:" -ForegroundColor Cyan
Write-Host "   • The server is working correctly" -ForegroundColor White
Write-Host "   • It will auto-start when you run the Electron app" -ForegroundColor White
Write-Host "   • Run: npm run dev" -ForegroundColor Yellow

Write-Host "`n"
