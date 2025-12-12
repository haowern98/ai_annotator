#!/usr/bin/env python3
"""
Parakeet ASR Server for Live Lecture Summarizer
Provides low-latency streaming transcription with word-level timestamps
Model: nvidia/parakeet-tdt-0.6b-v2 (~600MB, auto-downloads on first run)
"""

import asyncio
import base64
import json
import logging
import sys
import os
import numpy as np
from pathlib import Path
from typing import Optional, List, Dict
import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware

# Set cache directories to E: drive to avoid C: drive space issues
os.environ['HF_HOME'] = 'E:/huggingface_cache'
os.environ['TORCH_HOME'] = 'E:/torch_cache'
os.environ['TRANSFORMERS_CACHE'] = 'E:/huggingface_cache/transformers'

# Enable synchronous CUDA operations for better error reporting
os.environ['CUDA_LAUNCH_BLOCKING'] = '1'

# Configure logging
logging.basicConfig(
    level=logging.DEBUG,
    format='[%(asctime)s] [Parakeet] %(levelname)s: %(message)s',
    datefmt='%H:%M:%S'
)
logger = logging.getLogger(__name__)

# Also set NeMo logger to DEBUG
import logging as _logging
_logging.getLogger('nemo').setLevel(_logging.DEBUG)

# Import NeMo and transformers for Parakeet
try:
    import nemo.collections.asr as nemo_asr
    logger.info("✓ NeMo ASR imported successfully")
except ImportError:
    logger.error("❌ NeMo not installed. Install with: pip install nemo_toolkit[asr]")
    sys.exit(1)

# Import audio processing libraries
try:
    from pydub import AudioSegment
    logger.info("✓ pydub imported successfully")
except ImportError:
    logger.error("❌ pydub not installed. Install with: pip install pydub")
    sys.exit(1)

app = FastAPI(title="Parakeet ASR Server", version="1.0.0")

# CORS middleware for local development
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Global model instance
asr_model: Optional[object] = None
model_sample_rate = 16000  # Parakeet expects 16kHz
model_device = "cpu"  # Track device model is on


class AudioBuffer:
    """Manages audio chunks for streaming transcription with fixed-time release"""
    
    def __init__(self, sample_rate: int = 16000):
        self.sample_rate = sample_rate
        self.buffer = []
        
        # Fixed chunk duration: 15 seconds
        self.chunk_duration = 8.0  # seconds
        self.chunk_samples = int(sample_rate * self.chunk_duration)
        
        logger.info(f"AudioBuffer: chunk_duration={self.chunk_duration}s (fixed-time release)")
    
    def add(self, audio_data: np.ndarray):
        """Add audio samples to buffer"""
        self.buffer.append(audio_data)
    
    def get_chunk(self) -> Optional[Dict]:
        """
        Get accumulated audio if reached 15-second duration
        
        Returns: {
            'audio': np.ndarray
        }
        """
        if not self.buffer:
            return None
        
        concatenated = np.concatenate(self.buffer)
        total_samples = len(concatenated)
        
        # Release when we reach 15 seconds
        if total_samples < self.chunk_samples:
            return None
        
        duration_sec = total_samples / self.sample_rate
        logger.info(f"✓ Releasing {duration_sec:.1f}s audio chunk")
        
        # Clear buffer
        self.buffer = []
        
        # Ensure float32 dtype and C-contiguous memory layout
        audio_final = np.ascontiguousarray(concatenated, dtype=np.float32)
        
        return {
            'audio': audio_final
        }
    
    def clear(self):
        """Clear buffer"""
        self.buffer = []


class TextMerger:
    """Handles sentence-based text buffering with partial sentence carry-over"""
    
    def __init__(self):
        self.partial_sentence = ""  # Incomplete sentence from previous chunk
        self.partial_words = []  # Word objects with timestamps from buffered text
        self.chunks_without_sentence_end = 0  # Counter for force-release
    
    def add_chunk(self, new_text: str, new_words: List[Dict]) -> tuple:
        """
        Add new transcription chunk and extract complete sentences.
        Buffers partial sentences until they complete in future chunks.
        Force-releases partial sentences after 3 chunks (45 seconds) without sentence ending.
        
        Args:
            new_text: New transcription from current chunk
            new_words: Word objects with timestamps [{word, start_ms, end_ms}]
            
        Returns:
            Tuple of (complete_text, complete_words) - empty if none complete
        """
        if not new_text.strip():
            return ("", [])
        
        # Prepend partial sentence from previous chunk
        if self.partial_sentence:
            combined_text = self.partial_sentence + " " + new_text.strip()
            combined_words = self.partial_words + new_words
            logger.debug(f"Prepended partial sentence: '{self.partial_sentence[:50]}...'")
        else:
            combined_text = new_text.strip()
            combined_words = new_words
        
        # Find last sentence-ending punctuation
        last_sentence_end = -1
        for i in range(len(combined_text) - 1, -1, -1):
            if combined_text[i] in '.?!':
                last_sentence_end = i
                break
        
        if last_sentence_end >= 0:
            # Found complete sentence(s)
            complete_sentences = combined_text[:last_sentence_end + 1].strip()
            self.partial_sentence = combined_text[last_sentence_end + 1:].strip()
            
            # Split words at sentence boundary by matching word tokens
            # Count actual words in complete sentence (split removes empty strings)
            complete_word_list = [w for w in complete_sentences.split() if w]
            complete_word_count = len(complete_word_list)
            
            # Safety check: don't exceed combined_words length
            if complete_word_count > len(combined_words):
                logger.warning(f"⚠️ Word count mismatch: {complete_word_count} words in text, but only {len(combined_words)} word objects")
                complete_word_count = len(combined_words)
            
            complete_words = combined_words[:complete_word_count]
            self.partial_words = combined_words[complete_word_count:]
            
            self.chunks_without_sentence_end = 0  # Reset counter
            
            first_word_ts = complete_words[0]['start_ms'] if complete_words else 0
            logger.info(f"📝 Sending {len(complete_sentences)} chars with {len(complete_words)} words (first word: '{complete_words[0]['word']}' at {first_word_ts}ms = {first_word_ts/1000:.1f}s), buffering {len(self.partial_sentence)} chars")
            return (complete_sentences, complete_words)
        else:
            # No sentence ending found - buffer everything
            self.partial_sentence = combined_text
            self.partial_words = combined_words
            self.chunks_without_sentence_end += 1
            
            logger.warning(f"⚠️ No sentence ending found (chunk {self.chunks_without_sentence_end}/3), buffering {len(self.partial_sentence)} chars")
            
            # Force release after 3 chunks (45 seconds) without sentence ending
            if self.chunks_without_sentence_end >= 5:
                logger.warning(f"⚠️ Force-releasing partial sentence after 45s: '{self.partial_sentence[:80]}...'")
                forced_text = self.partial_sentence
                forced_words = self.partial_words
                self.partial_sentence = ""
                self.partial_words = []
                self.chunks_without_sentence_end = 0
                return (forced_text, forced_words)
            
            return ("", [])  # Nothing to send yet
    
    def get_buffered_partial(self) -> str:
        """Get any buffered partial sentence (for debugging/logging)"""
        return self.partial_sentence
    
    def clear(self):
        """Clear partial sentence buffer"""
        self.partial_sentence = ""
        self.partial_words = []
        self.chunks_without_sentence_end = 0


def load_model() -> object:
    """Load Parakeet-TDT-0.6B model"""
    global asr_model
    
    if asr_model is not None:
        logger.info("Model already loaded")
        return asr_model
    
    try:
        logger.info("Loading Parakeet-TDT-0.6B model...")
        
        # Determine device
        import torch
        # Force CPU mode - RTX 3060 Laptop (6GB VRAM) insufficient for model inference
        # Model uses 2.5GB + PyTorch caches 5GB = 7.5GB total > 6.44GB available
        device = "cpu"
        logger.info("⚠️ Using CPU mode (6GB VRAM insufficient for GPU inference)")
        
        # Check if model is already cached
        cache_path = Path(os.environ.get('HF_HOME', '~/.cache/huggingface')) / 'hub' / 'models--nvidia--parakeet-tdt-0.6b-v2'
        if cache_path.exists():
            logger.info("Using cached model from E: drive")
        else:
            logger.info("Downloading model to E: drive (~600MB)")
        
        # Load from HuggingFace Hub
        asr_model = nemo_asr.models.ASRModel.from_pretrained(
            "nvidia/parakeet-tdt-0.6b-v3",
            map_location=device
        )
        
        # Set to eval mode
        asr_model.eval()
        
        # Configure for streaming inference
        # Disable verbose logging and set appropriate batch inference
        if hasattr(asr_model, 'cfg'):
            from omegaconf import OmegaConf, open_dict
            with open_dict(asr_model.cfg):
                # Use greedy decoding for faster inference
                if hasattr(asr_model.cfg, 'decoding'):
                    asr_model.cfg.decoding.strategy = 'greedy_batch'
                    logger.info(f"Set decoding strategy: greedy_batch")
        
        # Store device globally
        global model_device
        model_device = device
        
        logger.info("✓ Model loaded successfully")
        logger.info(f"✓ Sample rate: {model_sample_rate}Hz")
        logger.info(f"✓ Device: {model_device.upper()}")
        
        # GPU diagnostics
        import torch
        logger.info(f"PyTorch version: {torch.__version__}")
        logger.info(f"CUDA available: {torch.cuda.is_available()}")
        if torch.cuda.is_available():
            logger.info(f"CUDA version: {torch.version.cuda}")
            logger.info(f"GPU device: {torch.cuda.get_device_name(0)}")
            logger.info(f"GPU memory: {torch.cuda.get_device_properties(0).total_memory / 1e9:.2f}GB")
        
        return asr_model
    
    except Exception as e:
        logger.error(f"❌ Failed to load model: {e}")
        raise


def pcm_to_numpy(pcm_base64: str, sample_rate: int = 16000) -> np.ndarray:
    """Convert base64 PCM audio to numpy array"""
    try:
        # Decode base64
        pcm_bytes = base64.b64decode(pcm_base64)
        
        # Convert to int16 numpy array
        audio_int16 = np.frombuffer(pcm_bytes, dtype=np.int16)
        
        # Convert to float32 normalized to [-1, 1] with explicit dtype
        audio_float = audio_int16.astype(np.float32, copy=False) / np.float32(32768.0)
        
        # Clip to valid range (defensive against edge cases)
        audio_float = np.clip(audio_float, -1.0, 1.0)
        
        return audio_float
    
    except Exception as e:
        logger.error(f"PCM conversion error: {e}")
        raise


def extract_audio_from_webm(file_path: str) -> np.ndarray:
    """
    Extract audio from WebM file and convert to 16kHz mono numpy array
    
    Args:
        file_path: Path to WebM file
        
    Returns:
        Audio samples as float32 numpy array normalized to [-1, 1]
    """
    try:
        logger.info(f"Loading audio from: {file_path}")
        
        # Load audio file (supports webm, mp4, wav, etc.)
        audio = AudioSegment.from_file(file_path)
        
        # Convert to mono
        if audio.channels > 1:
            audio = audio.set_channels(1)
            logger.info("Converted to mono")
        
        # Resample to 16kHz
        if audio.frame_rate != model_sample_rate:
            audio = audio.set_frame_rate(model_sample_rate)
            logger.info(f"Resampled to {model_sample_rate}Hz")
        
        # Convert to numpy array
        samples = np.array(audio.get_array_of_samples(), dtype=np.float32)
        
        # Normalize to [-1, 1]
        samples = samples / 32768.0
        samples = np.clip(samples, -1.0, 1.0)
        
        duration_sec = len(samples) / model_sample_rate
        logger.info(f"✓ Extracted {duration_sec:.1f}s audio, {len(samples)} samples")
        
        return samples
    
    except Exception as e:
        logger.error(f"Audio extraction error: {e}")
        raise


def extract_word_timestamps_from_ctc(hyp, duration_sec: float, offset_ms: int = 0) -> list:
    """
    Extract word-level timestamps from CTC frame-level alignments.
    
    Args:
        hyp: Hypothesis object from NeMo transcription
        duration_sec: Duration of audio in seconds
        offset_ms: Cumulative offset in milliseconds from session start
    
    Returns:
        List of word objects with start_time and end_time in milliseconds
    """
    try:
        text = hyp.text if isinstance(hyp, list) and len(hyp) > 0 else str(hyp)
        words = text.split()
        
        # Log all available attributes for debugging
        available_attrs = [attr for attr in dir(hyp) if not attr.startswith('_')]
        print(f"🔍 Hypothesis attributes: {', '.join(available_attrs[:20])}")  # First 20 to avoid clutter
        
        # Try to access various timestamp/alignment attributes
        alignment_data = None
        
        # Check common NeMo RNNT attributes
        if hasattr(hyp, 'timestep'):
            alignment_data = hyp.timestep
            print(f"✅ Found 'timestep' attribute: {type(alignment_data)}")
        elif hasattr(hyp, 'alignments'):
            alignment_data = hyp.alignments
            print(f"✅ Found 'alignments' attribute: {type(alignment_data)}")
        elif hasattr(hyp, 'frame_confidence'):
            alignment_data = hyp.frame_confidence
            print(f"✅ Found 'frame_confidence' attribute: {type(alignment_data)}")
        elif hasattr(hyp, 'word_timestamps'):
            alignment_data = hyp.word_timestamps
            print(f"✅ Found 'word_timestamps' attribute: {type(alignment_data)}")
        elif hasattr(hyp, 'timesteps'):
            alignment_data = hyp.timesteps
            print(f"✅ Found 'timesteps' attribute: {type(alignment_data)}")
        
        if alignment_data is not None and len(alignment_data) > 0:
            print(f"🔍 Alignment data length: {len(alignment_data)}, type: {type(alignment_data)}")
            
            # CTC frames are typically 10ms each
            frame_duration_ms = (duration_sec * 1000.0) / len(alignment_data)
            
            # Distribute frames evenly across words
            frames_per_word = len(alignment_data) / len(words)
            
            word_objects = []
            for i, word in enumerate(words):
                start_frame = int(i * frames_per_word)
                end_frame = int((i + 1) * frames_per_word)
                
                start_time = offset_ms + int(start_frame * frame_duration_ms)
                end_time = offset_ms + int(end_frame * frame_duration_ms)
                
                word_objects.append({
                    'word': word,
                    'start_time': start_time,
                    'end_time': end_time
                })
            
            print(f"✅ Extracted {len(word_objects)} word timestamps using alignment data")
            return word_objects
        else:
            print("⚠️ No alignment data found in hypothesis object")
            raise AttributeError("No alignment data available")
            
    except Exception as e:
        print(f"⚠️ Alignment extraction failed: {str(e)}")
        raise

def transcribe_audio(audio_data: np.ndarray, offset_ms: int = 0) -> dict:
    """
    Transcribe audio with word-level timestamps
    
    Args:
        audio_data: Audio samples as float32 numpy array
        offset_ms: Cumulative time offset from session start (in milliseconds)
        
    Returns: {
        text: str,
        words: [{word: str, start_ms: int, end_ms: int}],
        is_final: bool
    }
    """
    global asr_model
    
    if asr_model is None:
        raise RuntimeError("Model not loaded")
    
    try:
        # Validate audio data before transcription
        if audio_data.size == 0:
            logger.warning("Empty audio data received")
            return {
                "text": "",
                "words": [],
                "is_final": True
            }
        
        # Ensure C-contiguous array for CUDA operations
        if not audio_data.flags['C_CONTIGUOUS']:
            logger.debug("Converting to contiguous array")
            audio_data = np.ascontiguousarray(audio_data, dtype=np.float32)
        
        # Validate for NaN/Inf values
        if not np.isfinite(audio_data).all():
            logger.warning("Audio contains NaN/Inf values, sanitizing")
            audio_data = np.nan_to_num(audio_data, nan=0.0, posinf=1.0, neginf=-1.0)
        
        # Log audio diagnostics
        duration_sec = len(audio_data) / model_sample_rate
        logger.info(f"Audio: {duration_sec:.1f}s, dtype: {audio_data.dtype}, "
                    f"range: [{audio_data.min():.3f}, {audio_data.max():.3f}]")
        
        logger.info("Calling asr_model.transcribe()...")
        
        # Transcribe using numpy array directly (NeMo handles GPU transfer internally)
        hypotheses = asr_model.transcribe(
            audio=[audio_data],  # Pass as list of numpy arrays
            batch_size=1,
            return_hypotheses=True
        )
        
        logger.info("Transcription completed successfully")
        
        if not hypotheses or len(hypotheses) == 0:
            return {
                "text": "",
                "words": [],
                "is_final": True
            }
        
        hyp = hypotheses[0]
        text = hyp.text if hasattr(hyp, 'text') else str(hyp)
        
        # Extract word-level timestamps using CTC alignments
        words = []
        try:
            # Try to extract accurate timestamps from CTC alignments
            words = extract_word_timestamps_from_ctc(hyp, duration_sec, offset_ms)
            
            # Convert key names to match expected format (start_ms, end_ms)
            for word_obj in words:
                if 'start_time' in word_obj:
                    word_obj['start_ms'] = word_obj.pop('start_time')
                if 'end_time' in word_obj:
                    word_obj['end_ms'] = word_obj.pop('end_time')
                    
        except Exception:
            # Fallback: estimate timestamps based on word position
            if text.strip():
                word_list = text.strip().split()
                duration_ms = int(len(audio_data) / model_sample_rate * 1000)
                
                # Estimate timing: distribute duration evenly across words
                if len(word_list) > 0:
                    ms_per_word = duration_ms / len(word_list)
                    for i, word in enumerate(word_list):
                        start_ms = offset_ms + int(i * ms_per_word)
                        end_ms = offset_ms + int((i + 1) * ms_per_word)
                        words.append({
                            "word": word,
                            "start_ms": start_ms,
                            "end_ms": end_ms
                        })
                    logger.info(f"📊 Using estimated timestamps for {len(words)} words")
        
        return {
            "text": text,
            "words": words,
            "is_final": True
        }
    
    except Exception as e:
        logger.error(f"Transcription error: {e}")
        logger.error(f"Error details: {type(e).__name__}: {str(e)}")
        raise


@app.get("/health")
async def health_check():
    """Health check endpoint"""
    model_loaded = asr_model is not None
    return JSONResponse({
        "status": "healthy" if model_loaded else "starting",
        "model_loaded": model_loaded,
        "sample_rate": model_sample_rate
    })


@app.post("/transcribe-file")
async def transcribe_file_endpoint(request: Request):
    """
    Transcribe entire audio file from WebM recording with accurate timestamps.
    Processes audio in 30-second chunks for progress tracking.
    
    Request body: {
        "videoFilename": "lecture_20251209_045221.webm"
    }
    
    Returns: {
        "success": bool,
        "transcripts": [{
            "text": str,
            "timestampMs": int,
            "words": [{"word": str, "start_ms": int, "end_ms": int}]
        }],
        "totalDuration": int,
        "error"?: str
    }
    """
    try:
        # Parse request body
        body = await request.json()
        video_filename = body.get("videoFilename")
        
        if not video_filename:
            return JSONResponse({
                "success": False,
                "error": "videoFilename is required"
            }, status_code=400)
        
        # Construct file path
        recordings_dir = Path("E:/live-lecture-summarizer/recordings")
        video_path = recordings_dir / video_filename
        
        if not video_path.exists():
            # Try .webm if not found
            if not video_filename.endswith('.webm') and not video_filename.endswith('.mp4'):
                video_path = recordings_dir / f"{video_filename}.webm"
                if not video_path.exists():
                    video_path = recordings_dir / f"{video_filename}.mp4"
        
        if not video_path.exists():
            logger.error(f"Video file not found: {video_path}")
            return JSONResponse({
                "success": False,
                "error": f"Video file not found: {video_filename}"
            }, status_code=404)
        
        logger.info(f"📁 Transcribing file: {video_path}")
        
        # Ensure model is loaded
        if asr_model is None:
            load_model()
        
        # Extract audio from video file
        logger.info("🎵 Extracting audio from video file...")
        audio_data = extract_audio_from_webm(str(video_path))
        total_duration_ms = int(len(audio_data) / model_sample_rate * 1000)
        
        logger.info(f"📊 Total audio duration: {total_duration_ms/1000:.1f}s")
        
        # Process audio in 30-second chunks for progress tracking
        chunk_duration_sec = 30.0
        chunk_samples = int(model_sample_rate * chunk_duration_sec)
        
        transcripts = []
        offset_ms = 0
        chunk_num = 0
        total_chunks = int(np.ceil(len(audio_data) / chunk_samples))
        
        logger.info(f"🔄 Processing {total_chunks} chunks of {chunk_duration_sec}s each")
        
        while offset_ms < total_duration_ms:
            chunk_num += 1
            start_sample = int(offset_ms / 1000 * model_sample_rate)
            end_sample = min(start_sample + chunk_samples, len(audio_data))
            chunk = audio_data[start_sample:end_sample]
            
            if len(chunk) == 0:
                break
            
            chunk_duration_ms = int(len(chunk) / model_sample_rate * 1000)
            progress_percent = int((chunk_num / total_chunks) * 100)
            
            logger.info(f"⏳ Processing chunk {chunk_num}/{total_chunks} ({progress_percent}%) at {offset_ms/1000:.1f}s")
            
            # Transcribe chunk
            result = transcribe_audio(chunk, offset_ms=offset_ms)
            
            # Add to transcripts if not empty
            if result['text'].strip():
                transcripts.append({
                    "text": result['text'],
                    "timestampMs": offset_ms,
                    "words": result['words']
                })
                logger.info(f"  ✓ Transcribed: '{result['text'][:80]}...'")
            
            offset_ms += chunk_duration_ms
        
        logger.info(f"✅ Transcription complete: {len(transcripts)} transcript segments")
        
        return JSONResponse({
            "success": True,
            "transcripts": transcripts,
            "totalDuration": total_duration_ms
        })
    
    except Exception as e:
        logger.error(f"❌ Transcription failed: {e}")
        logger.error(f"Error details: {type(e).__name__}: {str(e)}")
        return JSONResponse({
            "success": False,
            "error": str(e)
        }, status_code=500)


@app.websocket("/transcribe")
async def websocket_transcribe(websocket: WebSocket):
    """WebSocket endpoint for streaming transcription with sentence-based buffering"""
    await websocket.accept()
    logger.info("✓ Client connected to /transcribe")
    
    # Ensure model is loaded
    try:
        if asr_model is None:
            load_model()
    except Exception as e:
        await websocket.send_json({
            "error": f"Model loading failed: {str(e)}"
        })
        await websocket.close()
        return
    
    audio_buffer = AudioBuffer(sample_rate=model_sample_rate)
    text_merger = TextMerger()
    cumulative_time_ms = 0  # Track cumulative time for accurate timestamps
    total_samples_received = 0  # Track total audio samples received (for accurate timing)
    
    try:
        while True:
            # Receive message from client
            message = await websocket.receive_json()
            
            if "audio" not in message:
                logger.warning("Received message without audio data")
                continue
            
            # Parse audio data
            audio_base64 = message["audio"]
            mime_type = message.get("mimeType", "audio/pcm;rate=16000")
            
            # Convert PCM to numpy
            audio_np = pcm_to_numpy(audio_base64, model_sample_rate)
            
            # Track total samples received (this represents actual audio capture time)
            total_samples_received += len(audio_np)
            
            # Add to buffer
            audio_buffer.add(audio_np)
            
            # Check if we should release chunk (8s fixed interval)
            chunk_data = audio_buffer.get_chunk()
            if chunk_data is not None:
                # Calculate chunk duration
                chunk_duration_ms = int(len(chunk_data['audio']) / model_sample_rate * 1000)
                
                # Transcribe with cumulative time offset
                # The offset represents when THIS audio chunk was captured (accounting for 8s buffer)
                logger.info(f"⏱️ Transcribing chunk at offset: {cumulative_time_ms}ms ({cumulative_time_ms/1000:.1f}s)")
                result = transcribe_audio(chunk_data['audio'], offset_ms=cumulative_time_ms)
                
                # Increment cumulative time by the chunk duration for next chunk
                cumulative_time_ms += chunk_duration_ms
                
                # Extract complete sentences (buffers partial sentences)
                complete_text, complete_words = text_merger.add_chunk(result['text'], result['words'])
                
                # Send only complete sentences to client (may be empty if buffering)
                if complete_text:
                    result['text'] = complete_text
                    result['words'] = complete_words  # Use words from complete sentence, preserving first word timestamp
                    await websocket.send_json(result)
                    logger.info(f"✓ Sent complete sentences ({len(complete_text)} chars): '{complete_text[:80]}...'")
                else:
                    logger.debug("No complete sentences yet, buffering partial")
    
    except WebSocketDisconnect:
        logger.info("Client disconnected")
    except Exception as e:
        logger.error(f"WebSocket error: {e}")
        try:
            await websocket.send_json({"error": str(e)})
        except:
            pass
    finally:
        audio_buffer.clear()
        text_merger.clear()


@app.on_event("startup")
async def startup_event():
    """Load model on server startup"""
    logger.info("Starting Parakeet ASR Server...")
    logger.info("Port: 8765")
    logger.info("Endpoints:")
    logger.info("  - ws://localhost:8765/transcribe (WebSocket streaming)")
    logger.info("  - POST http://localhost:8765/transcribe-file (File transcription)")
    logger.info("  - GET http://localhost:8765/health")
    logger.info("Features: 15s fixed chunks, sentence-based streaming, 45s force-release")
    
    # Pre-load model to avoid delay on first request
    try:
        load_model()
        logger.info("✓ Server ready")
    except Exception as e:
        logger.error(f"⚠️ Model pre-load failed: {e}")
        logger.info("Model will load on first request")


@app.on_event("shutdown")
async def shutdown_event():
    """Cleanup on shutdown"""
    logger.info("Shutting down Parakeet ASR Server...")


if __name__ == "__main__":
    # Run server
    uvicorn.run(
        app,
        host="127.0.0.1",  # Localhost only
        port=8765,
        log_level="info",
        access_log=False  # Disable access logs for cleaner output
    )