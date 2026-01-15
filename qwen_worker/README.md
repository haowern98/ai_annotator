# Qwen Video Analysis Worker

Windows-only video analysis service for lecture mode using Qwen3-VL vision-language model.

## Overview

This service replaces Gemini in lecture mode by providing:
- **Scene detection** with adaptive thresholds
- **Keyframe extraction** using stability + sharpness scoring
- **Content routing** (classifies as code/table/slides/talking-head/UI/other)
- **Code/table extraction** with dense sampling and OCR-like capabilities
- **Scene summarization** using Qwen3-VL multimodal LLM

## Key Differences from OriEngine

| Feature | OriEngine | Qwen Worker |
|---------|-----------|-------------|
| **Audio** | Whisper (local CUDA) | External transcripts (from Parakeet) |
| **Port** | 7555 | 7556 |
| **Platforms** | macOS + Windows + Linux | Windows only |
| **VLM Engines** | MLX, llama.cpp, llama-cli, llama-server | llama-cli, llama-server only |
| **Version** | v3.19 | v4.0 |

## Installation

### Prerequisites

1. **Python 3.10+** with pip
2. **llama.cpp binaries** (Windows CUDA build):
   - `llama-server.exe`
   - `llama-cli.exe`
   - Get from: https://github.com/ggerganov/llama.cpp/releases
3. **Qwen3-VL model files**:
   - `Qwen3VL-8B-Instruct-Q4_K_M.gguf`
   - `mmproj-Qwen3VL-8B-Instruct-Q8_0.gguf`

### Setup

```bash
cd qwen_worker
pip install -r requirements.txt
```

### Configuration

Edit `server.py` hardcoded paths (lines 158-164):

```python
LOCAL_LLAMA_CLI_EXE = r"C:\path\to\llama-cli.exe"
LOCAL_VLM_MODEL_DIR = r"C:\path\to\Qwen3VL-8B-Instruct-Q4_L_M"
```

Or use environment variables:

```bash
set LLAMA_SERVER_EXE=C:\path\to\llama-server.exe
set LLAMA_SERVER_HOST=127.0.0.1
set LLAMA_SERVER_PORT=8080
set LLAMA_SERVER_AUTOSTART=1
```

## Usage

### Start the Server

```bash
python server.py --server
```

Server runs on `http://127.0.0.1:7556`

### API Endpoint

**POST** `/api/v1/analyze`

**Parameters** (multipart/form-data):
- `video_file`: Video file upload (or use `video_url`)
- `video_url`: YouTube or direct video URL
- `transcripts_json`: **NEW** - JSON array of transcript segments from Parakeet:
  ```json
  [
    {"start": 0.0, "end": 5.2, "text": "Hello everyone..."},
    {"start": 5.2, "end": 12.1, "text": "Today we'll discuss..."}
  ]
  ```
- `visual_user_prompt`: Custom instructions for scene description
- `summary_user_prompt`: Custom instructions for global summary
- `vlm_resolution`: Image resolution (default: 768px)
- `scene_threshold`: Scene change sensitivity (default: 0.35)
- `min_scene_duration`: Minimum scene length in seconds (default: 2.0)
- `max_scene_duration`: Maximum scene length in seconds (default: 60.0)
- `keyframes_per_scene`: Number of keyframes per scene (1-5, default: 3)
- `skip_audio`: Skip audio processing (default: True, since transcripts are provided)
- `skip_visual`: Skip visual analysis (default: False)
- `generate_summary`: Generate global summary (default: True)

**Response** (JSON):
```json
{
  "meta": {
    "source": "lecture_recording.mp4",
    "duration": 300.5,
    "process_time": 45.2,
    "global_summary": "A lecture about Python asyncio...",
    "scene_count": 12,
    "models": {
      "vlm": "Qwen3VL-8B-Instruct-Q4_K_M.gguf"
    }
  },
  "segments": [
    {
      "scene_id": 1,
      "start": 0.0,
      "end": 15.3,
      "scene_title": "Introduction to asyncio",
      "scene_summary": "Presenter introduces the topic...",
      "audio_transcript": "Hello everyone, today we'll...",
      "visual_description": "Person speaking at desk with code editor visible",
      "visual_tags": {
        "people_count": 1,
        "place_type": "office",
        "main_action": "presenting code",
        "emotional_tone": "professional",
        "movement_level": "low",
        "_router": {
          "content_type": "code",
          "confidence": 0.85,
          "signals": ["IDE visible", "syntax highlighting"]
        }
      },
      "artifacts": {
        "code": {
          "language": "python",
          "code": "import asyncio\n\nasync def main():\n    ..."
        }
      }
    }
  ]
}
```

## Integration with Lecture Mode

Every 5 minutes, your lecture mode frontend should:

1. **Collect video chunk**: Extract last 5 minutes of recorded video
2. **Collect transcripts**: Get all transcript segments from Parakeet
3. **POST to qwen_worker**:
   ```typescript
   const formData = new FormData();
   formData.append('video_file', videoBlob, `lecture_${timestamp}.mp4`);
   formData.append('transcripts_json', JSON.stringify(transcriptSegments));
   formData.append('skip_audio', 'true');
   
   const response = await fetch('http://localhost:7556/api/v1/analyze', {
     method: 'POST',
     body: formData
   });
   
   const analysis = await response.json();
   ```

4. **Display results**: Show detected scenes with summaries, code/table extractions, etc.

## Performance

**Typical 5-minute video chunk**:
- Scene detection: ~2-5 seconds
- VLM analysis: ~3-8 seconds per scene
- Code/table extraction: ~5-15 seconds (if detected)
- **Total**: ~30-120 seconds depending on scene count and content type

**RAM requirements**:
- Qwen3-VL 8B Q4_K_M: ~5GB VRAM
- OpenCV + video processing: ~500MB RAM

## Troubleshooting

### llama-server won't start
- Check `LLAMA_SERVER_EXE` path is correct
- Verify model files exist at configured paths
- Check port 8080 is not in use
- Look at logs in temp folder (path printed on error)

### Scene detection too sensitive/not sensitive enough
- Adjust `scene_threshold` (lower = more scenes, higher = fewer scenes)
- Adjust `min_scene_duration` and `max_scene_duration`

### Code/table extraction not working
- Ensure Qwen3-VL 8B model (not 2B) for better accuracy
- Check `VIDEOCONTEXT_DENSE_CANDIDATES` env var (default: 20-30 frames)
- Increase `VIDEOCONTEXT_RECON_FRAMES` for more sampling (default: 6)

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `VIDEOCONTEXT_RAM_MODE` | `ram-` | `ram+` preloads VLM, `ram-` loads per request |
| `VIDEOCONTEXT_LOG_LEVEL` | `INFO` | Logging verbosity |
| `LLAMA_SERVER_AUTOSTART` | `1` | Auto-start llama-server if not running |
| `LLAMA_SERVER_HOST` | `127.0.0.1` | llama-server bind address |
| `LLAMA_SERVER_PORT` | `8080` | llama-server port |
| `LLAMA_API_TIMEOUT_S` | `180` | API request timeout (seconds) |

## Next Steps

- [ ] Add `/api/v1/analyze_batch` endpoint for streamlined 5-minute chunk processing
- [ ] Add WebSocket support for real-time streaming
- [ ] Implement session state to track lecture progression
- [ ] Add frame caching to avoid re-analyzing overlapping content
