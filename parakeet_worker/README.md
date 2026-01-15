## Parakeet Sidecar Worker (Local STT)

Runs a local WebSocket server that preloads NVIDIA Parakeet from a `.nemo` file and accepts streaming PCM audio.

### Requirements
- Python 3.10+ recommended
- Model file (example path from your HF cache):
  - `C:\Users\Wu Family Computer\.cache\huggingface\hub\models--nvidia--parakeet-tdt-0.6b-v3\snapshots\6d590f77001d318fb17a0b5bf7ee329a91b52598\parakeet-tdt-0.6b-v3.nemo`

### Install (first time)
```powershell
python -m pip install -r parakeet_worker/requirements.txt
```

### Run (web-only mode)
```powershell
$env:PARAKEET_MODEL_PATH="C:\path\to\parakeet-tdt-0.6b-v3.nemo"
python parakeet_worker/server.py
```

Web app / overlays will auto-connect to `ws://127.0.0.1:8765`.

