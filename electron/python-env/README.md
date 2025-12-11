# Python Environment for Local AI Models

This directory contains the bundled Python runtime and dependencies for Windows.

## Setup (Development)

1. Download Python 3.10 embeddable package for Windows:
   ```
   https://www.python.org/ftp/python/3.10.11/python-3.10.11-embed-amd64.zip
   ```

2. Extract to `electron/python-env/python/`

3. Install pip (download get-pip.py):
   ```
   python/python.exe get-pip.py
   ```

4. Install dependencies:
   ```
   python/python.exe -m pip install -r requirements.txt --extra-index-url https://download.pytorch.org/whl/cu118
   ```

## Production (Electron Build)

The Python environment is automatically bundled in the Electron app via `electron-builder.yml` extraResources.

## Size Information

- Python embeddable: ~15MB
- PyTorch + CUDA: ~2.5GB
- Transformers + deps: ~200MB
- Total: ~2.7GB

## Models (Auto-downloaded on first run)

Models are downloaded to:
- Windows: `%USERPROFILE%\.cache\huggingface\hub\`

Models:
1. `nvidia/parakeet-tdt-0.6b-v3` (~600MB) - CPU transcription
2. `google/gemma-3n-e2b-it` (~11GB) - GPU summarization

Total model storage: ~12GB
