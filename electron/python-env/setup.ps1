# Python Environment Setup Script for Local AI Models
# This script downloads and configures Python 3.10 with all dependencies

param(
    [switch]$SkipPython,
    [switch]$SkipDependencies
)

$ErrorActionPreference = "Stop"

# Configuration
$PYTHON_VERSION = "3.10.11"
$PYTHON_URL = "https://www.python.org/ftp/python/$PYTHON_VERSION/python-$PYTHON_VERSION-embed-amd64.zip"
$GET_PIP_URL = "https://bootstrap.pypa.io/get-pip.py"
$PYTHON_DIR = "python"
$PYTHON_ZIP = "python-embed.zip"
$GET_PIP = "get-pip.py"

Write-Host "`n🚀 Python Environment Setup for Local AI Models" -ForegroundColor Cyan
Write-Host "=" * 60 -ForegroundColor Cyan

# Check if running in correct directory
$currentDir = Get-Location
if (-not (Test-Path "requirements.txt")) {
    Write-Host "❌ Error: requirements.txt not found!" -ForegroundColor Red
    Write-Host "Please run this script from: electron\python-env\" -ForegroundColor Yellow
    exit 1
}

# Step 1: Download Python embeddable
if (-not $SkipPython) {
    Write-Host "`n📦 Step 1: Downloading Python $PYTHON_VERSION embeddable..." -ForegroundColor Green
    
    if (Test-Path $PYTHON_DIR) {
        Write-Host "⚠️  Python directory already exists. Skipping download." -ForegroundColor Yellow
        Write-Host "   To reinstall, delete the '$PYTHON_DIR' folder first." -ForegroundColor Yellow
    } else {
        try {
            Write-Host "   Downloading from: $PYTHON_URL"
            Invoke-WebRequest -Uri $PYTHON_URL -OutFile $PYTHON_ZIP -UseBasicParsing
            
            Write-Host "   Extracting Python..." -ForegroundColor Cyan
            Expand-Archive -Path $PYTHON_ZIP -DestinationPath $PYTHON_DIR -Force
            Remove-Item $PYTHON_ZIP
            
            Write-Host "✅ Python extracted to: $PYTHON_DIR" -ForegroundColor Green
        } catch {
            Write-Host "❌ Failed to download Python: $_" -ForegroundColor Red
            exit 1
        }
    }
} else {
    Write-Host "`n⏭️  Step 1: Skipped (Python download)" -ForegroundColor Yellow
}

# Verify Python executable
$PYTHON_EXE = Join-Path $PYTHON_DIR "python.exe"
if (-not (Test-Path $PYTHON_EXE)) {
    Write-Host "❌ Error: python.exe not found at $PYTHON_EXE" -ForegroundColor Red
    exit 1
}

# Step 2: Install pip
Write-Host "`n📦 Step 2: Installing pip..." -ForegroundColor Green

try {
    # Download get-pip.py
    if (-not (Test-Path $GET_PIP)) {
        Write-Host "   Downloading get-pip.py..."
        Invoke-WebRequest -Uri $GET_PIP_URL -OutFile $GET_PIP -UseBasicParsing
    }
    
    # Install pip
    Write-Host "   Running get-pip.py..."
    & $PYTHON_EXE $GET_PIP 2>&1 | Write-Host
    
    # Enable pip in embedded Python by modifying python*._pth
    $pthFile = Get-ChildItem -Path $PYTHON_DIR -Filter "python*._pth" | Select-Object -First 1
    if ($pthFile) {
        Write-Host "   Configuring embedded Python for pip..."
        $content = Get-Content $pthFile.FullName
        $newContent = $content -replace '#import site', 'import site'
        $newContent | Set-Content $pthFile.FullName
    }
    
    Write-Host "✅ pip installed successfully" -ForegroundColor Green
} catch {
    Write-Host "❌ Failed to install pip: $_" -ForegroundColor Red
    exit 1
}

# Step 3: Install dependencies
if (-not $SkipDependencies) {
    Write-Host "`n📦 Step 3: Installing Python dependencies..." -ForegroundColor Green
    Write-Host "   This may take 10-15 minutes (downloading ~3GB of packages)" -ForegroundColor Yellow
    Write-Host "   Packages: PyTorch (CUDA 11.8), Transformers, FastAPI, etc." -ForegroundColor Cyan
    
    try {
        $pipArgs = @(
            "-m", "pip", "install",
            "-r", "requirements.txt",
            "--extra-index-url", "https://download.pytorch.org/whl/cu118",
            "--no-warn-script-location"
        )
        
        Write-Host "`n   Running: python.exe -m pip install -r requirements.txt --extra-index-url https://download.pytorch.org/whl/cu118" -ForegroundColor Cyan
        & $PYTHON_EXE $pipArgs 2>&1 | Write-Host
        
        Write-Host "`n✅ Dependencies installed successfully" -ForegroundColor Green
    } catch {
        Write-Host "❌ Failed to install dependencies: $_" -ForegroundColor Red
        exit 1
    }
} else {
    Write-Host "`n⏭️  Step 3: Skipped (dependency installation)" -ForegroundColor Yellow
}

# Step 4: Verify installation
Write-Host "`n🔍 Step 4: Verifying installation..." -ForegroundColor Green

try {
    Write-Host "   Checking Python version..."
    & $PYTHON_EXE --version
    
    Write-Host "   Checking pip..."
    & $PYTHON_EXE -m pip --version
    
    Write-Host "   Checking PyTorch..."
    $torchCheck = @"
import torch
print(f'PyTorch version: {torch.__version__}')
print(f'CUDA available: {torch.cuda.is_available()}')
if torch.cuda.is_available():
    print(f'CUDA version: {torch.version.cuda}')
    print(f'GPU device: {torch.cuda.get_device_name(0)}')
"@
    
    $torchCheck | & $PYTHON_EXE 2>&1 | Write-Host
    
    Write-Host "`n✅ Installation verified successfully" -ForegroundColor Green
} catch {
    Write-Host "⚠️  Verification failed: $_" -ForegroundColor Yellow
    Write-Host "   Dependencies may still be functional" -ForegroundColor Yellow
}

# Summary
Write-Host "`n" + "=" * 60 -ForegroundColor Cyan
Write-Host "✅ Python Environment Setup Complete!" -ForegroundColor Green
Write-Host "=" * 60 -ForegroundColor Cyan

Write-Host "`n📊 Installation Summary:" -ForegroundColor Cyan
Write-Host "   • Python: $PYTHON_VERSION (embedded)" -ForegroundColor White
Write-Host "   • Location: $(Resolve-Path $PYTHON_DIR)" -ForegroundColor White
Write-Host "   • Size: ~2.7GB (Python + PyTorch + dependencies)" -ForegroundColor White

Write-Host "`n📁 Model Storage:" -ForegroundColor Cyan
Write-Host "   • Parakeet (~600MB): Auto-downloads on first run" -ForegroundColor White
Write-Host "   • Gemma 3n (~11GB): Auto-downloads on first run" -ForegroundColor White
Write-Host "   • Cache location: E:\huggingface_cache" -ForegroundColor White

Write-Host "`n🧪 Testing:" -ForegroundColor Cyan
Write-Host "   To test the Python server:" -ForegroundColor White
Write-Host "   cd ..\python-server" -ForegroundColor Yellow
Write-Host "   ..\python-env\python\python.exe model_server.py" -ForegroundColor Yellow

Write-Host "`n🚀 Next Steps:" -ForegroundColor Cyan
Write-Host "   1. Run 'npm run dev' to start the Electron app" -ForegroundColor White
Write-Host "   2. Python server will auto-start and download models" -ForegroundColor White
Write-Host "   3. First run may take 10-15 minutes (model download)" -ForegroundColor White

Write-Host "`n"
