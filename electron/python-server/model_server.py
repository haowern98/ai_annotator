"""
Local AI Model Server for Lecture Mode
Runs Parakeet (NeMo/CPU) for transcription and Gemma 3n (GPU) for multimodal summarization
"""

import os
import sys
from pathlib import Path

# Disable torch compilation and dynamo to avoid triton requirement
os.environ['PYTORCH_ENABLE_MPS_FALLBACK'] = '1'
os.environ['TORCH_COMPILE_DISABLE'] = '1'
os.environ['TORCHINDUCTOR_DISABLE'] = '1'
os.environ['TORCHDYNAMO_DISABLE'] = '1'

# MUST set environment variables BEFORE importing torch/numpy to redirect temp/cache to E: drive
os.environ['TEMP'] = r'E:\temp'
os.environ['TMP'] = r'E:\temp'
os.environ['TMPDIR'] = r'E:\temp'
os.environ['HF_HOME'] = r'E:\huggingface_cache'
os.environ['TRANSFORMERS_CACHE'] = r'E:\huggingface_cache'
os.environ['TORCH_HOME'] = r'E:\torch_cache'

# Copy HF token from default location if it exists
default_token_path = Path.home() / '.cache' / 'huggingface' / 'token'
new_token_path = Path(r'E:\huggingface_cache') / 'token'
if default_token_path.exists() and not new_token_path.exists():
    new_token_path.parent.mkdir(parents=True, exist_ok=True)
    new_token_path.write_text(default_token_path.read_text())

# Create directories
Path(r'E:\temp').mkdir(parents=True, exist_ok=True)
Path(r'E:\huggingface_cache').mkdir(parents=True, exist_ok=True)
Path(r'E:\torch_cache').mkdir(parents=True, exist_ok=True)

import asyncio
import base64
import io
import json
import logging
from typing import Optional

import numpy as np
import torch
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from PIL import Image
from transformers import (
    AutoProcessor,
    Gemma3nForConditionalGeneration,
    TextIteratorStreamer,
)
from threading import Thread

# NeMo for Parakeet ASR
import nemo.collections.asr as nemo_asr

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# Initialize FastAPI
app = FastAPI()

# Global model instances (lazy loaded)
parakeet_model = None  # NeMo ASR model
gemma_model: Optional[Gemma3nForConditionalGeneration] = None
gemma_processor: Optional[AutoProcessor] = None

# Model configuration
PARAKEET_MODEL_PATH = r"E:\huggingface_cache\hub\models--nvidia--parakeet-tdt-0.6b-v3\snapshots\6d590f77001d318fb17a0b5bf7ee329a91b52598\parakeet-tdt-0.6b-v3.nemo"
GEMMA_MODEL_ID = r"E:\huggingface_cache\models--google--gemma-3n-e2b-it"
MAX_VRAM_GB = 3  # PLE caching constraint

# Check CUDA availability
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
logger.info(f"🔧 Device: {DEVICE}")
if DEVICE == "cuda":
    logger.info(f"🎮 GPU: {torch.cuda.get_device_name(0)}")
    logger.info(f"💾 VRAM Available: {torch.cuda.get_device_properties(0).total_memory / 1e9:.2f}GB")


def load_parakeet():
    """Load Parakeet model using NeMo on CPU for transcription"""
    global parakeet_model
    
    if parakeet_model is not None:
        return
    
    try:
        logger.info(f"📥 Loading Parakeet model (NeMo/CPU) from: {PARAKEET_MODEL_PATH}")
        print(f"DOWNLOAD_PROGRESS:parakeet:0", flush=True)
        
        # Load NeMo ASR model from .nemo file
        parakeet_model = nemo_asr.models.ASRModel.restore_from(
            restore_path=PARAKEET_MODEL_PATH,
            map_location="cpu"  # Force CPU
        )
        parakeet_model.eval()
        
        print(f"DOWNLOAD_PROGRESS:parakeet:100", flush=True)
        logger.info("✅ Parakeet model loaded successfully on CPU (NeMo)")
        
    except Exception as e:
        logger.error(f"❌ Failed to load Parakeet: {e}")
        print(f"ERROR:parakeet:{str(e)}", flush=True)
        raise


def load_gemma():
    """Load Gemma model on GPU with PLE caching (3GB VRAM limit)"""
    global gemma_model, gemma_processor
    
    if gemma_model is not None:
        return
    
    if DEVICE == "cpu":
        logger.error("❌ Gemma requires CUDA GPU. CPU inference not supported.")
        raise RuntimeError("Gemma requires NVIDIA GPU with CUDA")
    
    try:
        logger.info(f"📥 Loading Gemma model (GPU): {GEMMA_MODEL_ID}")
        print(f"DOWNLOAD_PROGRESS:gemma:0", flush=True)
        
        gemma_processor = AutoProcessor.from_pretrained(GEMMA_MODEL_ID)
        
        # Load model with PLE caching by constraining VRAM to 3GB
        gemma_model = Gemma3nForConditionalGeneration.from_pretrained(
            GEMMA_MODEL_ID,
            device_map="auto",
            max_memory={0: f'{MAX_VRAM_GB}GiB'},  # Use integer 0 for GPU 0
            torch_dtype=torch.bfloat16,
        ).eval()
        
        print(f"DOWNLOAD_PROGRESS:gemma:100", flush=True)
        logger.info("✅ Gemma model loaded successfully on GPU with PLE caching")
        
        # Warm up GPU
        logger.info("🔥 Warming up GPU...")
        dummy_inputs = gemma_processor.apply_chat_template(
            [{"role": "user", "content": [{"type": "text", "text": "Hello"}]}],
            add_generation_prompt=True,
            tokenize=True,
            return_dict=True,
            return_tensors="pt",
        ).to(gemma_model.device, dtype=torch.bfloat16)
        
        with torch.inference_mode():
            gemma_model.generate(**dummy_inputs, max_new_tokens=10)
        
        logger.info("✅ GPU warmed up")
        
    except Exception as e:
        logger.error(f"❌ Failed to load Gemma: {e}")
        print(f"ERROR:gemma:{str(e)}", flush=True)
        raise


async def transcribe_audio(audio_base64: str) -> str:
    """
    Transcribe audio using Parakeet NeMo model (CPU)
    
    Args:
        audio_base64: Base64 encoded PCM16 audio (16kHz, mono)
    
    Returns:
        Transcribed text
    """
    load_parakeet()  # Lazy load
    
    try:
        # Decode base64 to bytes
        audio_bytes = base64.b64decode(audio_base64)
        
        # Convert PCM16 bytes to float32 array
        audio_int16 = np.frombuffer(audio_bytes, dtype=np.int16)
        audio_float32 = audio_int16.astype(np.float32) / 32768.0
        
        # Log audio characteristics
        logger.info(f"🎵 Audio length: {len(audio_float32)} samples ({len(audio_float32)/16000:.2f}s)")
        logger.info(f"🎵 Audio RMS: {np.sqrt(np.mean(audio_float32**2)):.4f}")
        logger.info(f"🎵 Audio max: {np.max(np.abs(audio_float32)):.4f}")
        
        # NeMo expects audio as a list of numpy arrays or file paths
        # We'll use the transcribe method with audio array
        with torch.inference_mode():
            # NeMo's transcribe method accepts numpy arrays directly
            transcriptions = parakeet_model.transcribe([audio_float32])
        
        # NeMo returns Hypothesis objects or strings depending on config
        if transcriptions and len(transcriptions) > 0:
            result = transcriptions[0]
            # Handle both Hypothesis objects and strings
            if hasattr(result, 'text'):
                return result.text.strip()
            elif isinstance(result, str):
                return result.strip()
            else:
                # For other types, try to get text attribute or convert to string
                return str(result).strip()
        return ""
        
    except Exception as e:
        logger.error(f"❌ Transcription error: {e}")
        raise


async def summarize_lecture(transcripts: list[str], images_base64: list[str], system_prompt: str, websocket: WebSocket, user_prompt: str = None):
    """
    Generate lecture summary using Gemma (GPU) with streaming
    
    Args:
        transcripts: List of transcript text chunks from past window
        images_base64: List of base64 encoded JPEG images
        system_prompt: System instruction for summarization
        websocket: WebSocket for streaming response
        user_prompt: Optional user prompt (overrides default transcript formatting)
    """
    load_gemma()  # Lazy load
    
    try:
        # Prepare content with text and images
        content = []
        
        # Add transcript text (use user_prompt if provided, else default formatting)
        if user_prompt:
            full_transcript = " ".join(transcripts)
            content.append({"type": "text", "text": f"{user_prompt}\n\nTranscript:\n{full_transcript}"})
        else:
            full_transcript = " ".join(transcripts)
            content.append({"type": "text", "text": f"Transcript: {full_transcript}"})
        
        # Add images (convert base64 to PIL Images)
        for img_b64 in images_base64:
            # Remove data URL prefix if present
            if img_b64.startswith('data:image'):
                img_b64 = img_b64.split(',')[1]
            
            img_bytes = base64.b64decode(img_b64)
            img = Image.open(io.BytesIO(img_bytes))
            content.append({"type": "image", "image": img})
        
        # Build messages
        messages = [
            {"role": "system", "content": [{"type": "text", "text": system_prompt}]},
            {"role": "user", "content": content}
        ]
        
        # Prepare inputs
        inputs = gemma_processor.apply_chat_template(
            messages,
            add_generation_prompt=True,
            tokenize=True,
            return_dict=True,
            return_tensors="pt",
        ).to(gemma_model.device, dtype=torch.bfloat16)
        
        # Send start signal
        await websocket.send_json({"type": "summary_start"})
        
        # Stream generation
        streamer = TextIteratorStreamer(
            gemma_processor.tokenizer,
            skip_special_tokens=True,
            skip_prompt=True
        )
        
        generation_kwargs = {
            **inputs,
            "max_new_tokens": 500,
            "do_sample": False,
            "streamer": streamer,
        }
        
        # Generate in separate thread
        thread = Thread(target=gemma_model.generate, kwargs=generation_kwargs)
        thread.start()
        
        # Stream tokens
        full_text = ""
        for text_chunk in streamer:
            full_text += text_chunk
            await websocket.send_json({
                "type": "summary_chunk",
                "text": text_chunk
            })
        
        thread.join()
        
        # Send complete signal
        await websocket.send_json({
            "type": "summary_complete",
            "full_text": full_text.strip()
        })
        
    except Exception as e:
        logger.error(f"❌ Summarization error: {e}")
        await websocket.send_json({
            "type": "error",
            "message": f"Summarization failed: {str(e)}"
        })
        raise


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    """WebSocket endpoint for bidirectional communication"""
    await websocket.accept()
    logger.info("🔗 WebSocket connected")
    
    try:
        while True:
            # Receive message
            data = await websocket.receive_json()
            message_type = data.get("type")
            
            if message_type == "transcribe":
                # Transcribe audio
                audio_base64 = data.get("audio")
                chunk_id = data.get("chunk_id", 0)
                
                try:
                    text = await transcribe_audio(audio_base64)
                    await websocket.send_json({
                        "type": "transcript",
                        "text": text,
                        "chunk_id": chunk_id,
                        "is_final": True
                    })
                except Exception as e:
                    await websocket.send_json({
                        "type": "error",
                        "message": f"Transcription failed: {str(e)}"
                    })
            
            elif message_type == "summarize":
                # Generate summary
                transcripts = data.get("transcripts", [])
                images = data.get("images", [])
                system_prompt = data.get("system_prompt", "")
                user_prompt = data.get("user_prompt")
                
                try:
                    await summarize_lecture(transcripts, images, system_prompt, websocket, user_prompt)
                except Exception as e:
                    logger.error(f"Summary error: {e}")
            
            elif message_type == "ping":
                await websocket.send_json({"type": "pong"})
            
            else:
                await websocket.send_json({
                    "type": "error",
                    "message": f"Unknown message type: {message_type}"
                })
    
    except WebSocketDisconnect:
        logger.info("🔌 WebSocket disconnected")
    except Exception as e:
        logger.error(f"❌ WebSocket error: {e}")
        try:
            await websocket.send_json({
                "type": "error",
                "message": str(e)
            })
        except:
            pass


@app.get("/health")
async def health_check():
    """Health check endpoint"""
    return {
        "status": "ok",
        "cuda_available": torch.cuda.is_available(),
        "parakeet_loaded": parakeet_model is not None,
        "gemma_loaded": gemma_model is not None
    }


def preload_models():
    """Preload models at startup to check availability and download if needed"""
    logger.info("🔄 Preloading models at startup...")
    
    # Load Parakeet (CPU)
    try:
        load_parakeet()
    except Exception as e:
        logger.error(f"❌ Failed to preload Parakeet: {e}")
    
    # Load Gemma (GPU) - this will download if not cached
    try:
        load_gemma()
    except Exception as e:
        logger.error(f"❌ Failed to preload Gemma: {e}")
    
    logger.info("✅ Model preloading complete")


if __name__ == "__main__":
    import uvicorn
    
    # Get random port
    port = int(os.environ.get("PORT", 0))
    if port == 0:
        import socket
        sock = socket.socket()
        sock.bind(('', 0))
        port = sock.getsockname()[1]
        sock.close()
    
    # Print port for Electron to capture
    print(f"SERVER_PORT:{port}", flush=True)
    logger.info(f"🚀 Starting server on port {port}")
    
    # Preload models before starting server
    preload_models()
    
    # Run server
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="info")
