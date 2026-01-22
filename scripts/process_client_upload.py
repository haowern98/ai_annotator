#!/usr/bin/env python3
"""
Process Client Upload Script
Receives video path, extracts frames at 1 FPS, calls Parakeet for transcription,
POSTs to /api/v1/analyze_sequential, outputs JSON result.
"""

import argparse
import json
import sys
import os
import base64
import asyncio
import websockets
import cv2
import tempfile
from pathlib import Path
from typing import List, Dict, Any
import requests


def extract_frames_at_1fps(video_path: str) -> List[Dict[str, Any]]:
    """Extract frames at 1 FPS and encode as base64 JPEG."""
    frames = []
    cap = cv2.VideoCapture(video_path)
    
    if not cap.isOpened():
        raise RuntimeError(f"Failed to open video: {video_path}")
    
    fps = cap.get(cv2.CAP_PROP_FPS)
    if fps <= 0:
        fps = 25  # Default fallback
    
    frame_interval = int(fps)  # Extract every N frames for 1 FPS
    frame_count = 0
    timestamp_ms = 0
    
    while True:
        ret, frame = cap.read()
        if not ret:
            break
        
        if frame_count % frame_interval == 0:
            # Encode frame as JPEG
            success, buffer = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, 85])
            if success:
                image_base64 = base64.b64encode(buffer).decode('utf-8')
                frames.append({
                    "timestamp_ms": timestamp_ms,
                    "image_base64": image_base64
                })
                timestamp_ms += 1000  # Increment by 1 second
        
        frame_count += 1
    
    cap.release()
    return frames


async def transcribe_with_parakeet(video_path: str) -> tuple[List[Dict], List[Dict]]:
    """Call Parakeet worker for transcription via WebSocket."""
    # Extract audio to temp WAV file
    temp_wav = tempfile.NamedTemporaryFile(suffix='.wav', delete=False)
    temp_wav_path = temp_wav.name
    temp_wav.close()
    
    try:
        # Use ffmpeg to extract audio
        import subprocess
        result = subprocess.run(
            ['ffmpeg', '-i', video_path, '-vn', '-acodec', 'pcm_s16le', '-ar', '16000', '-ac', '1', temp_wav_path, '-y'],
            capture_output=True,
            text=True
        )
        
        if result.returncode != 0:
            raise RuntimeError(f"ffmpeg audio extraction failed: {result.stderr}")
        
        # Connect to Parakeet WebSocket
        uri = "ws://127.0.0.1:8765"
        
        async with websockets.connect(uri) as websocket:
            # Send batch transcription request
            request = {
                "type": "batch_transcribe",
                "wav_path": temp_wav_path,
                "segment_seconds": 5.0
            }
            
            await websocket.send(json.dumps(request))
            
            # Receive response
            response_text = await websocket.recv()
            response = json.loads(response_text)
            
            if response.get("type") != "batch_result" or not response.get("ok"):
                raise RuntimeError(f"Parakeet transcription failed: {response.get('error', 'Unknown error')}")
            
            segments = response.get("segments", [])
            words = response.get("words", [])
            
            # Convert to expected format
            transcripts = []
            for seg in segments:
                transcripts.append({
                    "start": seg.get("start", 0.0),
                    "end": seg.get("end", 0.0),
                    "text": seg.get("text", ""),
                    "is_final": seg.get("is_final", True)
                })
            
            return transcripts, words
            
    finally:
        # Cleanup temp WAV
        if os.path.exists(temp_wav_path):
            os.remove(temp_wav_path)


def analyze_with_qwen(frames: List[Dict], transcripts: List[Dict]) -> List[Dict]:
    """POST frames to /api/v1/analyze_sequential."""
    url = "http://127.0.0.1:7556/api/v1/analyze_sequential"
    
    # Prepare FormData
    frames_json = json.dumps(frames)
    transcripts_json = json.dumps(transcripts)
    config_json = json.dumps({"batch_size": 5, "duration_seconds": len(frames)})
    
    form_data = {
        "frames_json": frames_json,
        "transcripts_json": transcripts_json,
        "config_json": config_json
    }
    
    # Send request with 30 minute timeout
    response = requests.post(url, data=form_data, timeout=1800)
    
    if response.status_code != 200:
        raise RuntimeError(f"Qwen analysis failed ({response.status_code}): {response.text}")
    
    result = response.json()
    
    if result.get("status") != "success":
        raise RuntimeError(f"Qwen analysis error: {result.get('message', 'Unknown error')}")
    
    return result.get("analysis", {}).get("batches", [])


async def main_async():
    parser = argparse.ArgumentParser(description="Process client video upload")
    parser.add_argument("--video-path", required=True, help="Path to video file")
    args = parser.parse_args()
    
    video_path = args.video_path
    
    if not os.path.exists(video_path):
        print(json.dumps({"error": f"Video file not found: {video_path}"}))
        sys.exit(1)
    
    try:
        # Step 1: Extract frames at 1 FPS
        print(f"Extracting frames from {video_path}...", file=sys.stderr)
        frames = extract_frames_at_1fps(video_path)
        print(f"Extracted {len(frames)} frames", file=sys.stderr)
        
        # Step 2: Transcribe with Parakeet
        print("Transcribing audio with Parakeet...", file=sys.stderr)
        transcripts, words = await transcribe_with_parakeet(video_path)
        print(f"Transcribed {len(transcripts)} segments", file=sys.stderr)
        
        # Step 3: Analyze with Qwen
        print("Analyzing with Qwen VLM...", file=sys.stderr)
        batches = analyze_with_qwen(frames, transcripts)
        print(f"Analyzed {len(batches)} batches", file=sys.stderr)
        
        # Output JSON result to stdout
        output = {
            "transcripts": transcripts,
            "batches": batches,
            "words": words
        }
        
        print(json.dumps(output, ensure_ascii=False))
        sys.exit(0)
        
    except Exception as e:
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        sys.exit(1)


def main():
    asyncio.run(main_async())


if __name__ == "__main__":
    main()
