#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
Qwen Video Analysis Worker v4.0
-------------------------
Author: dolphin-creator (https://github.com/dolphin-creator)
Project: VideoContext Engine
License: MIT

Description:
Windows-only video analysis service using Qwen3-VL (accepts pre-computed transcripts for lecture mode).

-------------------------
INSTALLATION (Windows only):
   python -m pip install --upgrade pip
   pip install -r requirements.txt

Note: Uses llama.cpp binaries (llama-server.exe / llama-cli.exe)
No PyTorch/Whisper needed - transcripts provided by Parakeet service.
-------------------------
- Prompts techniques (structure JSON, etc.) figés dans le code.
- L'utilisateur ne modifie que des "user prompts" qui s'ajoutent par-dessus.
- 1 seul appel VLM par scène (description + tags en JSON).
- Nombre de keyframes par scène paramétrable (1 à 5), 1 par défaut.
- Audio_features activés par défaut, désactivables.
- Résumé global activé par défaut, désactivable.
- Chronos détaillés (Whisper + VLM + total).
- max_tokens VLM réglables avec valeurs par défaut (220 / 260).
- safe_json_parse robuste (réparation JSON) pour scènes + résumé global.
- Nettoyage du texte brut quand le JSON échoue (on extrait la valeur de "description" / "summary").
- Mode RAM :
    - RAM_MODE = "ram+" (par env VIDEOCONTEXT_RAM_MODE) :
        * précharge VLM par défaut + Whisper small
        * garde tout en RAM
    - RAM_MODE = "ram-":
        * charge/décharge Whisper et VLM à chaque requête
- Swagger patché pour afficher de grands textarea pour les prompts utilisateur.
"""

import math
import os
import gc
import cv2
import time
import shutil
import base64
import asyncio
import platform
import numpy as np
import json
import re
import subprocess
import tempfile
import sys
import logging
import urllib.request
import urllib.error
import shlex
import threading
from dataclasses import dataclass

from typing import Optional, Dict, Any, List, Union, Literal
from io import BytesIO
from pathlib import Path
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import PlainTextResponse
from fastapi.responses import JSONResponse
from fastapi.openapi.utils import get_openapi
from PIL import Image


# Optional (fallbacks if missing)
try:
    from skimage.metrics import structural_similarity as ssim  # type: ignore
except Exception:
    ssim = None

# ---------- LOGGING ----------
LOG_LEVEL = os.getenv("VIDEOCONTEXT_LOG_LEVEL", "INFO").upper()
logging.basicConfig(
    level=getattr(logging, LOG_LEVEL, logging.INFO),
    format="%(asctime)s | %(levelname)s | %(message)s",
)
logger = logging.getLogger("videocontext")

# Optionnel : supprimer le warning HF tokenizers
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

# Windows consoles often default to cp1252; avoid crashes when printing emoji / accented chars.
try:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

# FFmpeg backend selection:
# - "auto": use system ffmpeg if available, else fallback to imageio-ffmpeg
# - "system": require system ffmpeg on PATH
# - "imageio": always use imageio-ffmpeg-provided ffmpeg binary (recommended for portable installs)
FFMPEG_BACKEND = os.getenv("VIDEOCONTEXT_FFMPEG_BACKEND", "auto").strip().lower()

# Whisper relies on `ffmpeg` being available on PATH. If it's not installed system-wide,
# fall back to the bundled ffmpeg from `imageio-ffmpeg` (pip package).
try:
    use_system_ffmpeg = (FFMPEG_BACKEND in ("auto", "system")) and (shutil.which("ffmpeg") is not None)
    if FFMPEG_BACKEND == "system" and not use_system_ffmpeg:
        raise RuntimeError("VIDEOCONTEXT_FFMPEG_BACKEND=system but ffmpeg was not found on PATH.")

    if not use_system_ffmpeg:
        import imageio_ffmpeg  # type: ignore

        ffmpeg_exe = imageio_ffmpeg.get_ffmpeg_exe()
        # The bundled binary is versioned (e.g. ffmpeg-win-x86_64-v7.1.exe). Whisper invokes `ffmpeg`,
        # so provide an actual `ffmpeg.exe` on PATH.
        shim_dir = Path(__file__).resolve().parent / ".ffmpeg_shim"
        shim_dir.mkdir(exist_ok=True)
        shim_exe = shim_dir / "ffmpeg.exe"
        if not shim_exe.exists():
            shutil.copyfile(ffmpeg_exe, shim_exe)
        os.environ["PATH"] = str(shim_dir) + os.pathsep + os.environ.get("PATH", "")
except Exception:
    pass

# --- MODE RAM ---

RAM_MODE = os.getenv("VIDEOCONTEXT_RAM_MODE", "ram-").lower()  # "ram+" ou "ram-"

# --- CONFIGURATION GLOBALE ---

PORT_SERVEUR = 7556

# Path where the most recent analysis result is persisted for "history" retrieval.
LAST_RESULT_PATH = Path(__file__).resolve().parent / "local_test_output.json"

DEFAULT_VLM_MODEL_MLX = "mlx-community/Qwen3-VL-2B-Instruct-4bit"
DEFAULT_VLM_REPO_GGUF = "bartowski/Qwen3-VL-2B-Instruct-GGUF"

# --- Local hardcoded paths (Windows llama.cpp binaries + local Qwen3-VL 8B GGUF) ---
LOCAL_TEST_VIDEO_PATH = r"C:\Users\Wu Family Computer\Downloads\New folder\test.mp4"
LOCAL_LLAMA_CLI_EXE = r"C:\Users\Wu Family Computer\Downloads\llama-b7524-bin-win-cuda-12.4-x64\llama-cli.exe"
LOCAL_VLM_MODEL_DIR = r"C:\Users\Wu Family Computer\Downloads\Qwen3VL-8B-Instruct-Q4_L_M"

DEFAULT_VLM_MODEL_GGUF = os.path.join(LOCAL_VLM_MODEL_DIR, "Qwen3VL-8B-Instruct-Q4_K_M.gguf")
DEFAULT_MMPROJ_GGUF = os.path.join(LOCAL_VLM_MODEL_DIR, "mmproj-Qwen3VL-8B-Instruct-Q8_0.gguf")
# Whisper removed - transcripts provided externally

LLAMA_API_BASE_URL = os.getenv("LLAMA_API_BASE_URL", "").strip()
LLAMA_API_MODEL = os.getenv("LLAMA_API_MODEL", "").strip()
LLAMA_API_KEY = os.getenv("LLAMA_API_KEY", "").strip()
LLAMA_API_TIMEOUT_S = float(os.getenv("LLAMA_API_TIMEOUT_S", "180"))
LLAMA_API_CHAT_ENDPOINT = os.getenv("LLAMA_API_CHAT_ENDPOINT", "/v1/chat/completions").strip()

LLAMA_SERVER_AUTOSTART = os.getenv("LLAMA_SERVER_AUTOSTART", "1").strip().lower() in ("1", "true", "yes", "on")
LLAMA_SERVER_HOST = os.getenv("LLAMA_SERVER_HOST", "127.0.0.1").strip() or "127.0.0.1"
LLAMA_SERVER_PORT = int(os.getenv("LLAMA_SERVER_PORT", "8080"))
LLAMA_SERVER_MMPROJ = os.getenv("LLAMA_SERVER_MMPROJ", "").strip()
LLAMA_SERVER_EXTRA_ARGS = os.getenv("LLAMA_SERVER_EXTRA_ARGS", "").strip()
LLAMA_SERVER_STARTUP_TIMEOUT_S = float(os.getenv("LLAMA_SERVER_STARTUP_TIMEOUT_S", "120"))
LLAMA_SERVER_STOP_ON_UNLOAD = os.getenv("LLAMA_SERVER_STOP_ON_UNLOAD", "0").strip().lower() in ("1", "true", "yes", "on")
LLAMA_SERVER_PRESTART = os.getenv("LLAMA_SERVER_PRESTART", "1").strip().lower() in ("1", "true", "yes", "on")

DEFAULT_SCENE_THRESHOLD = 0.35
DEFAULT_MIN_DURATION = 2.0
DEFAULT_MAX_DURATION = 60.0
DEFAULT_RESOLUTION = 768
MAX_TOTAL_VIDEO_DURATION = 4 * 60 * 60  # 4h max

DEFAULT_KEYFRAMES_PER_SCENE = 3

DEFAULT_VLM_MAX_TOKENS_SCENE = 1220
DEFAULT_VLM_MAX_TOKENS_SUMMARY = 580

# Windows only - always use GGUF
ACTIVE_DEFAULT_VLM = DEFAULT_VLM_MODEL_GGUF

ALLOWED_EXTENSIONS = {".mp4", ".mov", ".avi", ".mkv", ".webm", ".m4v"}

gpu_lock = asyncio.Lock()

# --- PROMPTS SYSTÈME ---

# Whisper removed - transcripts provided by Parakeet


BASE_VISUAL_PROMPT = """
You are an assistant that analyzes one or several frames from the SAME video scene.

You MUST answer with VALID JSON using EXACTLY this structure:
{
  "title": "short title (3-8 words) capturing what the scene is about",
  "scene_summary": "1-2 sentence summary of the scene in plain English",
  "description": "short and factual description of what happens in the scene (gestures, posture, general situation)",
  "tags": {
    "people_count": <approximate number of visible people>,
    "place_type": "studio | tv_set | classroom | office | home | outdoor | nature | stage | other",
    "main_action": "short description of the main action",
    "emotional_tone": "calm | neutral | tense | conflictual | joyful | sad | enthusiastic | serious | other",
    "movement_level": "low | medium | high"
  }
}

Rules:
- Do NOT add any text outside of this JSON.
- Do NOT change field names.
- The description and tag values should be in the same language as the user instructions if any, otherwise in English.
- Keep title concise (no punctuation). Keep scene_summary short (max ~35 words).
""".strip()

BASE_SUMMARY_PROMPT = """
You are summarizing a video based on scene-level notes (audio + visual context).

Write a global summary of the video, answering:
- What is it about (main topic / content)?
- In what context does it happen (place, type of situation)?
- What is the overall tone (calm, tense, professional, intimate, etc.)?

Rules:
- Use clear, natural language.
- Use the same language as the user instructions if any, otherwise English.
- If you return JSON, use exactly: {"summary": "..."} and nothing else.
""".strip()

ROUTER_PROMPT = """
You are a classifier for lecture/screen recording frames.

You MUST answer with VALID JSON using EXACTLY this structure:
{
  "content_type": "code | table | slides_text | ui_app | talking_head | other",
  "confidence": 0.0,
  "signals": ["signal 1", "signal 2"]
}

Rules (decide content_type):
- If you see a table/grid with rows+columns => "table"
- If you see source code / IDE / terminal with code => "code"
- If it is a presentation slide with paragraphs/bullets => "slides_text"
- If it's mainly a person speaking / webcam => "talking_head"
- "ui_app" for general software UI that is not clearly code/table/slide text
- confidence between 0.0 and 1.0
- signals: short strings describing what you saw (max 5)

STRICT OUTPUT:
- JSON only, no markdown, no prose.
""".strip()

EXTRACT_CODE_PROMPT = """
Extract the visible code as faithfully as possible.
Return ONLY JSON:
{
  "language": "best guess (python/js/cpp/bash/etc) or empty",
  "code": "the code text exactly as seen (use \\n). If uncertain, mark unclear parts with ???"
}
No extra text.
""".strip()

EXTRACT_TABLE_PROMPT = """
Extract the visible table as faithfully as possible.
Return ONLY JSON:
{
  "format": "markdown",
  "table": "a markdown table. Preserve headers and rows as seen. Use ??? for unreadable cells."
}
No extra text.
""".strip()


# --- MOTEUR VLM ---

class VLMProvider:
    def __init__(self):
        self.current_model_path = None
        self.last_load_time: float = 0.0

    def load_model(self, model_path: str):
        raise NotImplementedError

    def describe_scene(
        self,
        images: List[Image.Image],
        prompt: str,
        max_tokens: int,
    ) -> str:
        raise NotImplementedError

    def unload_model(self):
        pass


class LlamaCliEngine(VLMProvider):
    def __init__(self):
        super().__init__()
        self.llama_cli_exe = LOCAL_LLAMA_CLI_EXE
        self.mmproj_path = DEFAULT_MMPROJ_GGUF

        # Increased context window for more frames per batch
        self.n_ctx = 24000
        self.n_gpu_layers = -1  # all layers to GPU when possible

    def load_model(self, model_path: str):
        t0 = time.time()

        if not os.path.exists(self.llama_cli_exe):
            raise RuntimeError(f"llama-cli.exe introuvable: {self.llama_cli_exe}")
        if not os.path.exists(model_path):
            raise RuntimeError(f"Modèle GGUF introuvable: {model_path}")
        if not os.path.exists(self.mmproj_path):
            raise RuntimeError(f"Fichier mmproj introuvable: {self.mmproj_path}")

        self.current_model_path = model_path
        self.last_load_time = time.time() - t0

    def describe_scene(
        self,
        images: List[Image.Image],
        prompt: str,
        max_tokens: int,
    ) -> str:
        if not self.current_model_path:
            raise RuntimeError("Modèle VLM non chargé (llama-cli).")

        llama_dir = os.path.dirname(self.llama_cli_exe) or None

        with tempfile.TemporaryDirectory(prefix="videocontext_vlm_") as tmp:
            image_paths: List[str] = []
            for i, img in enumerate(images):
                p = os.path.join(tmp, f"frame_{i:02d}.jpg")
                img.save(p, format="JPEG", quality=85)
                image_paths.append(p)

            cmd = [
                self.llama_cli_exe,
                "--log-disable",
                "--simple-io",
                "--single-turn",
                "--no-display-prompt",
                "--color",
                "off",
                "--flash-attn",
                "on",
                "-m",
                self.current_model_path,
                "--mmproj",
                self.mmproj_path,
                "-c",
                str(self.n_ctx),
                "-n",
                str(max_tokens),
                "-ngl",
                str(self.n_gpu_layers),
                "--temp",
                "0.0",
                "-p",
                prompt,
            ]

            if image_paths:
                cmd.extend(["--image", ",".join(image_paths)])

            proc = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                cwd=llama_dir,
            )

            if proc.returncode != 0:
                stderr = (proc.stderr or "").strip()
                stdout = (proc.stdout or "").strip()
                detail = stderr or stdout or f"exit code {proc.returncode}"
                raise RuntimeError(f"Erreur llama-cli: {detail}")

            raw = (proc.stdout or "").strip()
            cleaned = _clean_llama_stdout(raw)
            
            # Parse stderr for actual token counts
            stderr = (proc.stderr or "").strip()
            prompt_tokens = 0
            completion_tokens = 0
            
            # Extract prompt eval tokens: "prompt eval time = ... / XXX tokens"
            import re
            prompt_match = re.search(r'prompt eval time.*?/(\s*\d+)\s+tokens', stderr)
            if prompt_match:
                prompt_tokens = int(prompt_match.group(1).strip())
            
            # Extract completion tokens: "eval time = ... / XXX tokens"
            completion_match = re.search(r'eval time.*?/(\s*\d+)\s+tokens', stderr)
            if completion_match:
                completion_tokens = int(completion_match.group(1).strip())
            
            return (cleaned, prompt_tokens, completion_tokens)

    def unload_model(self):
        self.current_model_path = None
        gc.collect()


class LlamaApiEngine(VLMProvider):
    """
    HTTP client for an OpenAI-compatible llama server (e.g., llama.cpp `llama-server`).
    Supports multimodal inputs via `image_url` (data: URLs).
    """

    def __init__(self):
        super().__init__()
        self.base_url = LLAMA_API_BASE_URL
        self.model = LLAMA_API_MODEL
        self.api_key = LLAMA_API_KEY
        self.timeout_s = LLAMA_API_TIMEOUT_S
        self.chat_endpoint = LLAMA_API_CHAT_ENDPOINT
        self.server_process: Optional[subprocess.Popen] = None
        self.server_log_path: Optional[str] = None
        self._server_log_file = None
        self._start_lock = threading.Lock()

    def load_model(self, model_path: str):
        self._ensure_server_running(model_path=model_path)
        self.current_model_path = model_path

    def _server_base_url(self) -> str:
        if (self.base_url or "").strip():
            return self.base_url.strip()
        return f"http://{LLAMA_SERVER_HOST}:{LLAMA_SERVER_PORT}"

    def _is_server_ready(self) -> bool:
        base = self._server_base_url()
        headers: Dict[str, str] = {"Accept": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        models_url = _join_url(base, "/v1/models")
        data = _http_get_json(models_url, headers=headers, timeout_s=min(self.timeout_s, 5.0))
        return bool(data)

    def _start_llama_server(self, model_path: str):
        if not LLAMA_SERVER_AUTOSTART:
            raise RuntimeError(
                "Llama server is not reachable and autostart is disabled. "
                "Set LLAMA_SERVER_AUTOSTART=1 or start llama-server manually."
            )

        llama_dir = os.path.dirname(LOCAL_LLAMA_CLI_EXE)
        default_server_exe = os.path.join(llama_dir, "llama-server.exe") if llama_dir else "llama-server.exe"
        llama_server_exe = os.getenv("LLAMA_SERVER_EXE", default_server_exe).strip() or default_server_exe
        if not os.path.exists(llama_server_exe):
            raise RuntimeError(f"llama-server.exe introuvable: {llama_server_exe}")

        if not os.path.exists(model_path):
            raise RuntimeError(f"Modèle GGUF introuvable: {model_path}")

        mmproj = (LLAMA_SERVER_MMPROJ or "").strip() or DEFAULT_MMPROJ_GGUF
        if mmproj and not os.path.exists(mmproj):
            raise RuntimeError(f"Fichier mmproj introuvable: {mmproj}")

        extra_args = []
        if LLAMA_SERVER_EXTRA_ARGS:
            try:
                extra_args = shlex.split(LLAMA_SERVER_EXTRA_ARGS, posix=False)
            except Exception:
                extra_args = LLAMA_SERVER_EXTRA_ARGS.split()

        self.server_log_path = os.path.join(
            tempfile.gettempdir(),
            f"videocontext_llama_server_{int(time.time())}.log",
        )
        self._server_log_file = open(self.server_log_path, "w", encoding="utf-8", errors="replace")

        cmd = [
            llama_server_exe,
            "--host",
            LLAMA_SERVER_HOST,
            "--port",
            str(LLAMA_SERVER_PORT),
            "-m",
            model_path,
            "--mmproj",
            mmproj,
        ]
        cmd.extend(extra_args)

        creationflags = 0
        if platform.system() == "Windows":
            creationflags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)

        self.server_process = subprocess.Popen(
            cmd,
            stdout=self._server_log_file,
            stderr=self._server_log_file,
            text=True,
            encoding="utf-8",
            errors="replace",
            cwd=llama_dir or None,
            creationflags=creationflags,
        )

    def _ensure_server_running(self, model_path: str):
        with self._start_lock:
            if self._is_server_ready():
                return

            t0 = time.time()
            self._start_llama_server(model_path=model_path)

            deadline = time.time() + LLAMA_SERVER_STARTUP_TIMEOUT_S
            while time.time() < deadline:
                if self.server_process and self.server_process.poll() is not None:
                    break
                if self._is_server_ready():
                    self.last_load_time = time.time() - t0
                    return
                time.sleep(0.5)

            detail = ""
            if self.server_log_path and os.path.exists(self.server_log_path):
                try:
                    with open(self.server_log_path, "r", encoding="utf-8", errors="replace") as f:
                        tail = f.readlines()[-60:]
                    detail = "\n".join(tail).strip()
                except Exception:
                    detail = ""

            self._stop_server()
            raise RuntimeError(
                "Llama server failed to start or become ready. "
                f"base_url={self._server_base_url()} log={self.server_log_path or '(none)'} "
                + (f"\n--- log tail ---\n{detail}" if detail else "")
            )

    def _stop_server(self):
        proc = self.server_process
        self.server_process = None
        if self._server_log_file:
            try:
                self._server_log_file.close()
            except Exception:
                pass
            self._server_log_file = None
        if not proc:
            return
        try:
            proc.terminate()
            proc.wait(timeout=10)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass

    def describe_scene(
        self,
        images: List[Image.Image],
        prompt: str,
        max_tokens: int,
    ) -> tuple[str, int, int]:
        self._ensure_server_running(model_path=self.current_model_path or DEFAULT_VLM_MODEL_GGUF)

        contents: List[Dict[str, Any]] = []
        for img in images:
            buffered = BytesIO()
            img.save(buffered, format="JPEG", quality=85)
            img_str = base64.b64encode(buffered.getvalue()).decode("utf-8")
            contents.append(
                {
                    "type": "image_url",
                    "image_url": {"url": f"data:image/jpeg;base64,{img_str}"},
                }
            )
        contents.append({"type": "text", "text": prompt})

        headers: Dict[str, str] = {"Accept": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"

        model = self.model or (self.current_model_path or "") or "local"
        payload = {
            "model": model,
            "messages": [{"role": "user", "content": contents}],
            "max_tokens": int(max_tokens),
            "temperature": 0.0,
            "stream": False,
        }

        url = _join_url(self._server_base_url(), self.chat_endpoint)
        response = _http_post_json(url, payload, headers=headers, timeout_s=self.timeout_s)

        try:
            content = response["choices"][0]["message"]["content"]
            usage = response.get("usage", {})
            prompt_tokens = usage.get("prompt_tokens", 0)
            completion_tokens = usage.get("completion_tokens", 0)
        except Exception:
            raise RuntimeError(f"Unexpected Llama API response: {response}")

        if isinstance(content, str):
            result = content.strip()
        elif isinstance(content, list):
            parts: List[str] = []
            for item in content:
                if isinstance(item, dict) and item.get("type") == "text" and isinstance(item.get("text"), str):
                    parts.append(item["text"])
            result = "\n".join(parts).strip()
        else:
            result = str(content).strip()
        
        return (result, prompt_tokens, completion_tokens)

    def unload_model(self):
        self.current_model_path = None
        if LLAMA_SERVER_STOP_ON_UNLOAD:
            self._stop_server()
        gc.collect()


def get_vlm_engine() -> VLMProvider:
    """
    Windows-only VLM engine selection.
    Uses LlamaApiEngine (llama-server) or LlamaCliEngine (llama-cli) for Qwen3-VL.
    """
    # Prefer API engine with autostart
    engine = LlamaApiEngine()
    if (LLAMA_API_BASE_URL or "").strip():
        logger.info("VLM Engine: LlamaApiEngine (remote API)")
    else:
        logger.info(
            "VLM Engine: LlamaApiEngine (llama-server %s:%s, autostart=%s)",
            LLAMA_SERVER_HOST,
            LLAMA_SERVER_PORT,
            "on" if LLAMA_SERVER_AUTOSTART else "off",
        )
    return engine


# --- UTILS SCÈNES & VIDÉO ---

def compute_hsv_histogram(frame_bgr: np.ndarray) -> np.ndarray:
    hsv = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2HSV)
    hist = cv2.calcHist(
        [hsv],
        [0, 1],
        None,
        [50, 60],
        [0, 180, 0, 256],
    )
    cv2.normalize(hist, hist, alpha=0, beta=1, norm_type=cv2.NORM_MINMAX)
    return hist.flatten()


@dataclass
class Scene:
    start: float
    end: float


def _merge_short_scenes(scenes: List[Scene], min_len: float) -> List[Scene]:
    """Merge adjacent scenes if they are too short (common in screen recordings)."""
    if not scenes:
        return []
    merged = [scenes[0]]
    for sc in scenes[1:]:
        if (merged[-1].end - merged[-1].start) < min_len:
            merged[-1] = Scene(start=merged[-1].start, end=sc.end)
        else:
            merged.append(sc)
    if len(merged) >= 2 and (merged[-1].end - merged[-1].start) < min_len:
        merged[-2] = Scene(start=merged[-2].start, end=merged[-1].end)
        merged.pop()
    return merged


def detect_scenes(
    video_path: str,
    threshold: float,
    min_duration: float,
    max_duration: float,
) -> List[Dict[str, float]]:
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise ValueError("Erreur lecture vidéo")

    fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
    frame_interval = int(fps)
    scenes = []
    last_hist = None
    start_sec = 0.0
    prev_sec = 0.0
    frame_idx = 0

    while True:
        ret, frame = cap.read()
        if not ret:
            break

        if frame_idx % frame_interval == 0:
            curr_sec = frame_idx / fps
            hist = compute_hsv_histogram(frame)
            is_visual_change = False

            if last_hist is not None:
                score = cv2.compareHist(last_hist, hist, cv2.HISTCMP_CORREL)
                if (1.0 - score) > threshold:
                    is_visual_change = True

            duration_ok = (curr_sec - start_sec) >= min_duration
            force_cut = (curr_sec - start_sec) >= max_duration

            if (is_visual_change and duration_ok) or force_cut:
                scenes.append({"start": start_sec, "end": prev_sec})
                start_sec = curr_sec

            last_hist = hist
            prev_sec = curr_sec

        frame_idx += 1

    if prev_sec > start_sec:
        scenes.append({"start": start_sec, "end": prev_sec})

    cap.release()
    return scenes


def detect_scenes_step_a(
    video_path: str,
    threshold: float,
    min_duration: float,
    max_duration: float,
) -> List[Dict[str, float]]:
    """
    STEP A: Scene boundaries.
    - Prefer PySceneDetect if available (good baseline).
    - Fallback to histogram-based detect_scenes() if not.
    - Merge tiny scenes.
    - Enforce max_duration by splitting long scenes.
    """
    logger.info("[STEP A] Detecting scenes...")

    scenes: List[Scene] = []

    # Try PySceneDetect
    try:
        from scenedetect import open_video  # type: ignore
        from scenedetect.scene_manager import SceneManager  # type: ignore
        from scenedetect.detectors import ContentDetector  # type: ignore

        video = open_video(video_path)
        scene_manager = SceneManager()
        sd_thresh = float(os.getenv("VIDEOCONTEXT_SCENEDETECT_THRESHOLD", "27"))
        scene_manager.add_detector(ContentDetector(threshold=sd_thresh))
        scene_manager.detect_scenes(video=video)
        sd_list = scene_manager.get_scene_list()

        for start_t, end_t in sd_list:
            scenes.append(Scene(start=start_t.get_seconds(), end=end_t.get_seconds()))

        logger.info(f"[STEP A] PySceneDetect produced {len(scenes)} scenes (raw).")

    except Exception as e:
        logger.warning(f"[STEP A] PySceneDetect unavailable/failed ({e}). Falling back to HSV histogram detector.")
        fallback = detect_scenes(video_path, threshold=threshold, min_duration=min_duration, max_duration=max_duration)
        scenes = [Scene(start=s['start'], end=s['end']) for s in fallback]
        logger.info(f"[STEP A] Fallback detector produced {len(scenes)} scenes (raw).")

    merge_min = float(os.getenv("VIDEOCONTEXT_MERGE_MIN_SCENE", str(max(2.5, min_duration))))
    before = len(scenes)
    scenes = _merge_short_scenes(scenes, min_len=merge_min)
    logger.info(f"[STEP A] Merged tiny scenes (<{merge_min:.2f}s): {before} -> {len(scenes)} scenes.")

    enforced: List[Scene] = []
    for sc in scenes:
        dur = sc.end - sc.start
        if dur <= max_duration:
            enforced.append(sc)
        else:
            n = int(np.ceil(dur / max_duration))
            step = dur / n
            for i in range(n):
                s0 = sc.start + i * step
                s1 = sc.start + (i + 1) * step
                enforced.append(Scene(start=s0, end=s1))

    if len(enforced) != len(scenes):
        logger.info(f"[STEP A] Split long scenes (> {max_duration:.1f}s): {len(scenes)} -> {len(enforced)} scenes.")

    return [{"start": sc.start, "end": sc.end} for sc in enforced]


def download_video_from_url(url: str, output_template: str) -> str:
    try:
        import yt_dlp  # type: ignore
    except Exception as e:
        raise RuntimeError(
            "Erreur: dépendance manquante 'yt-dlp'. Installez-la avec: pip install yt-dlp"
        ) from e

    ydl_opts = {
        "format": "best[ext=mp4]/best",
        "outtmpl": output_template,
        "quiet": True,
        "no_warnings": True,
        "match_filter": yt_dlp.utils.match_filter_func(
            f"duration < {MAX_TOTAL_VIDEO_DURATION}"
        ),
    }
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        try:
            info = ydl.extract_info(url, download=True)
            return ydl.prepare_filename(info)
        except yt_dlp.utils.DownloadError as e:
            if "video is too long" in str(e).lower():
                raise ValueError("Vidéo trop longue")
            raise e


def sanitize_filename(filename: str) -> str:
    name = os.path.basename(filename)
    safe_name = "".join(
        [c for c in name if c.isalnum() or c in (" ", ".", "_", "-")]
    )
    return safe_name.strip()[:60] or "video_output"


def validate_video_file(file_path: str) -> float:
    cap = cv2.VideoCapture(file_path)
    if not cap.isOpened():
        raise HTTPException(400, "Fichier vidéo invalide")

    fps = cap.get(cv2.CAP_PROP_FPS) or 0.0
    frames = cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0.0
    cap.release()

    duration = frames / fps if fps > 0 else 0
    if duration > MAX_TOTAL_VIDEO_DURATION:
        raise HTTPException(
            400, f"Vidéo trop longue ({duration/60:.1f} min)"
        )
    return duration


def sample_keyframes_for_scene(
    cap: cv2.VideoCapture,
    scene: Dict[str, float],
    base_res: int,
    max_frames: int,
) -> List[Dict[str, Any]]:
    start = scene["start"]
    end = scene["end"]
    duration = max(0.001, end - start)

    n = max(1, min(max_frames, 5))

    if n == 1:
        times = [start + 0.5 * duration]
    else:
        times = [start + (k / (n + 1)) * duration for k in range(1, n + 1)]

    frames = []
    for t in times:
        cap.set(cv2.CAP_PROP_POS_MSEC, t * 1000)
        ret, frame = cap.read()
        if not ret:
            continue
        frame = cv2.resize(frame, (base_res, base_res))
        pil_img = Image.fromarray(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
        frames.append({"time": round(t, 2), "image": pil_img})

    return frames


def _laplacian_sharpness(gray: np.ndarray) -> float:
    return float(cv2.Laplacian(gray, cv2.CV_64F).var())


def _frame_motion_score(prev_gray: Optional[np.ndarray], gray: np.ndarray) -> float:
    """
    Lower is better (less motion).
    Uses SSIM if available, else simple mean abs diff.
    """
    if prev_gray is None:
        return 0.0
    if ssim is not None:
        try:
            val = ssim(prev_gray, gray)
            return float(1.0 - val)
        except Exception:
            pass
    diff = cv2.absdiff(prev_gray, gray)
    return float(np.mean(diff) / 255.0)


def sample_candidate_frames(
    cap: cv2.VideoCapture,
    scene: Dict[str, float],
    base_res: int,
    n_candidates: int,
) -> List[Dict[str, Any]]:
    start = scene["start"]
    end = scene["end"]
    duration = max(0.001, end - start)

    n = max(2, min(int(n_candidates), 60))
    times = [start + (k / (n + 1)) * duration for k in range(1, n + 1)]

    out = []
    for t in times:
        cap.set(cv2.CAP_PROP_POS_MSEC, t * 1000)
        ret, frame = cap.read()
        if not ret:
            continue
        frame = cv2.resize(frame, (base_res, base_res))
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        pil = Image.fromarray(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
        out.append({"time": round(t, 2), "frame": frame, "gray": gray, "image": pil})
    return out


def pick_best_keyframes_step_b(
    cap: cv2.VideoCapture,
    scene: Dict[str, float],
    base_res: int,
    max_pick: int,
    n_candidates: int = 10,
) -> List[Dict[str, Any]]:
    """
    STEP B: stability + sharpness keyframe selection
    - Sample 8–12 candidates (configurable)
    - Score: low motion + high sharpness
    - Pick top 1–3 frames (configurable)
    """
    logger.info("[STEP B] Selecting best keyframes (stability + sharpness)...")

    candidates = sample_candidate_frames(cap, scene, base_res=base_res, n_candidates=n_candidates)
    if not candidates:
        logger.warning("[STEP B] No candidates extracted; falling back to midpoint frame.")
        return sample_keyframes_for_scene(cap, scene, base_res=base_res, max_frames=1)

    prev = None
    scored = []
    for c in candidates:
        gray = c["gray"]
        motion = _frame_motion_score(prev, gray)
        sharp = _laplacian_sharpness(gray)
        prev = gray
        score = (sharp / 1000.0) - (motion * 2.0)
        scored.append((score, motion, sharp, c))

    scored.sort(key=lambda x: x[0], reverse=True)
    k = max(1, min(max_pick, 3))
    picked = [s[3] for s in scored[:k]]

    logger.info(
        f"[STEP B] Picked {len(picked)} frames from {len(candidates)} candidates "
        f"(top score={scored[0][0]:.3f}, motion={scored[0][1]:.3f}, sharp={scored[0][2]:.1f})."
    )
    return [{"time": p["time"], "image": p["image"]} for p in picked]


def _router_fallback_from_text(raw: str) -> Dict[str, Any]:
    """
    If the model doesn't return JSON, guess content_type from raw text.
    This keeps the pipeline functional even when the router is flaky.
    """
    t = (raw or "").lower()
    if re.search(r"\b(table|spreadsheet|grid|rows|columns)\b", t):
        return {"content_type": "table", "confidence": 0.35, "signals": ["fallback:table_keywords"]}
    if re.search(r"\b(code|terminal|ide|function|class|import|def|console|stack trace)\b", t):
        return {"content_type": "code", "confidence": 0.35, "signals": ["fallback:code_keywords"]}
    if re.search(r"\b(slide|presentation|bullet|title)\b", t):
        return {"content_type": "slides_text", "confidence": 0.35, "signals": ["fallback:slide_keywords"]}
    if re.search(r"\b(talking head|webcam|person speaking|face)\b", t):
        return {"content_type": "talking_head", "confidence": 0.35, "signals": ["fallback:talking_head_keywords"]}
    if re.search(r"\b(ui|window|menu|toolbar|app)\b", t):
        return {"content_type": "ui_app", "confidence": 0.25, "signals": ["fallback:ui_keywords"]}
    return {"content_type": "other", "confidence": 0.1, "signals": ["fallback:unknown"]}


def classify_scene_content_step_c(vlm_engine: VLMProvider, images: List[Image.Image]) -> Dict[str, Any]:
    logger.info("[STEP C] Routing scene by content type (code/table/slides/UI/talking-head)...")

    strict_prompt = (
        "You MUST output JSON only.\n"
        "Do NOT output markdown.\n"
        "Do NOT output explanations.\n\n"
        + ROUTER_PROMPT
    )

    raw = vlm_engine.describe_scene(images, strict_prompt, max_tokens=220)
    data = safe_json_parse(raw)
    if not data or "content_type" not in data:
        snippet = (raw or "").strip().replace("\n", " ")
        if len(snippet) > 180:
            snippet = snippet[:180] + "..."
        logger.warning(f"[STEP C] Router failed JSON. Raw snippet: {snippet}")
        return _router_fallback_from_text(raw)

    ct = str(data.get("content_type") or "other").strip()
    if ct not in ("code", "table", "slides_text", "ui_app", "talking_head", "other"):
        ct = "other"
    conf = data.get("confidence", 0.0)
    try:
        conf = float(conf)
    except Exception:
        conf = 0.0
    conf = max(0.0, min(1.0, conf))

    sig = data.get("signals", [])
    if not isinstance(sig, list):
        sig = []

    return {"content_type": ct, "confidence": conf, "signals": sig}


def _scroll_or_change_spike(cap: cv2.VideoCapture, scene: Dict[str, float], base_res: int) -> bool:
    samples = sample_candidate_frames(cap, scene, base_res=base_res, n_candidates=6)
    if len(samples) < 3:
        return False
    diffs = []
    prev = None
    for s in samples:
        d = _frame_motion_score(prev, s["gray"])
        diffs.append(d)
        prev = s["gray"]
    spikes = sum(1 for d in diffs if d > 0.12)
    return spikes >= 2


def dense_frames_for_scene(
    cap: cv2.VideoCapture,
    scene: Dict[str, float],
    base_res: int,
    n_candidates: int,
) -> List[Dict[str, Any]]:
    logger.info(f"[STEP C] Dense sampling enabled: {n_candidates} candidates for reconstruction.")
    return sample_candidate_frames(cap, scene, base_res=base_res, n_candidates=n_candidates)


def merge_text_blocks_by_overlap(blocks: List[str]) -> str:
    def norm_lines(t: str) -> List[str]:
        return [ln.rstrip() for ln in (t or "").splitlines() if ln.strip() != ""]

    merged: List[str] = []
    for b in blocks:
        lines = norm_lines(b)
        if not lines:
            continue
        if not merged:
            merged = lines
            continue
        max_k = min(len(merged), len(lines), 20)
        best_k = 0
        for k in range(1, max_k + 1):
            if merged[-k:] == lines[:k]:
                best_k = k
        merged.extend(lines[best_k:])
    return "\n".join(merged).strip()


def extract_code_or_table_step_c(
    vlm_engine: VLMProvider,
    content_type: str,
    images: List[Image.Image],
) -> Dict[str, Any]:
    if content_type == "code":
        prompt = EXTRACT_CODE_PROMPT
    elif content_type == "table":
        prompt = EXTRACT_TABLE_PROMPT
    else:
        return {}
    raw = vlm_engine.describe_scene(images, prompt, max_tokens=900)
    data = safe_json_parse(raw)
    if not data:
        logger.warning("[STEP C] Extraction returned non-JSON; skipping artifact.")
        return {}
    return data


def semantic_change_points_step_d(video_path: str) -> List[float]:
    enabled = os.getenv("VIDEOCONTEXT_ENABLE_STEP_D", "0") == "1"
    if not enabled:
        logger.info("[STEP D] Skipped (disabled). Set VIDEOCONTEXT_ENABLE_STEP_D=1 to enable.")
        return []
    logger.info("[STEP D] Running semantic change point detection (EXPERIMENTAL)...")
    logger.warning("[STEP D] Not implemented in this patch. Returning no change points.")
    return []


# --- AUDIO FEATURES ---

def compute_audio_features_for_scene(
    scene: Dict[str, float],
    transcript_segments: List[Dict[str, Any]],
) -> Dict[str, float]:
    start = scene["start"]
    end = scene["end"]
    duration = max(0.001, end - start)

    segs = [
        s
        for s in transcript_segments
        if s["start"] < end and s["end"] > start
    ]

    if not segs:
        return {
            "speech_duration": 0.0,
            "speaking_rate_wpm": 0.0,
            "speech_ratio": 0.0,
            "silence_ratio": 1.0,
        }

    speech_duration = 0.0
    word_count = 0

    for s in segs:
        seg_start = max(start, s["start"])
        seg_end = min(end, s["end"])
        overlap = max(0.0, seg_end - seg_start)
        speech_duration += overlap

        text = s.get("text", "") or ""
        word_count += len(text.strip().split())

    speech_ratio = min(1.0, speech_duration / duration)
    silence_ratio = max(0.0, 1.0 - speech_ratio)

    if speech_duration > 0:
        speaking_rate_wpm = (word_count / speech_duration) * 60.0
    else:
        speaking_rate_wpm = 0.0

    return {
        "speech_duration": round(speech_duration, 3),
        "speaking_rate_wpm": round(speaking_rate_wpm, 2),
        "speech_ratio": round(speech_ratio, 3),
        "silence_ratio": round(silence_ratio, 3),
    }


def analyze_emotion_from_frame(frame_rgb: np.ndarray) -> Dict[str, Any]:
    return {}


# --- JSON ROBUSTE + NETTOYAGE ---

def safe_json_parse(text: str) -> Dict[str, Any]:
    text = (text or "").strip()
    if not text:
        return {}

    try:
        return json.loads(text)
    except Exception:
        pass

    start = text.find("{")
    if start == -1:
        return {}

    candidate = text[start:].strip()

    try:
        return json.loads(candidate)
    except Exception:
        pass

    for _ in range(3):
        open_curly = candidate.count("{")
        close_curly = candidate.count("}")
        if close_curly < open_curly:
            candidate += "}" * (open_curly - close_curly)

        open_brack = candidate.count("[")
        close_brack = candidate.count("]")
        if close_brack < open_brack:
            candidate += "]" * (open_brack - close_brack)

        last_brace = max(candidate.rfind("}"), candidate.rfind("]"))
        if last_brace != -1:
            candidate = candidate[: last_brace + 1].strip()

        try:
            return json.loads(candidate)
        except Exception:
            continue

    return {}


def _extract_field_loose(raw: str, field: str) -> str:
    """
    Essaie d'extraire la valeur d'un champ JSON (ex: "summary", "description")
    dans un texte potentiellement tronqué et/ou entouré de ```json, {, } etc.
    """
    if not raw:
        return ""

    text = raw.strip()
    text = re.sub(r"^```[a-zA-Z]*\s*", "", text)

    m = re.search(r'"%s"\s*:\s*(.*)' % re.escape(field), text, flags=re.DOTALL)
    if not m:
        return ""

    value = m.group(1)
    value = re.sub(r'^[\s`"{]+', "", value)

    for sep in ["```", "\n\n", "\n}", "}\n", "\n]", "]"]:
        pos = value.find(sep)
        if pos != -1:
            value = value[:pos]
            break

    value = value.rstrip("`}\n\r\t ")
    return value.strip()


def clean_raw_visual_text(raw: str) -> str:
    if not raw:
        return ""
    desc = _extract_field_loose(raw, "description")
    if desc:
        return desc
    text = raw.strip().lstrip("{").rstrip("}")
    return text.strip()


def clean_raw_summary_text(raw: str) -> str:
    if not raw:
        return ""
    s = _extract_field_loose(raw, "summary")
    if s:
        return s
    s = _extract_field_loose(raw, "description")
    if s:
        return s
    text = raw.strip().lstrip("{").rstrip("}")
    return text.strip()


def _clean_llama_stdout(text: str) -> str:
    """
    Remove llama-cli banners / loading noise.
    Keep only the final model response.
    """
    if not text:
        return ""

    lines = text.splitlines()
    cleaned = []

    for line in lines:
        l = line.strip()
        if not l:
            continue

        # Skip known llama-cli / CUDA noise
        if (
            "loading model" in l.lower()
            or "llama" in l.lower()
            or "cuda" in l.lower()
            or "██" in l
            or "▄▄" in l
        ):
            continue

        cleaned.append(line)

    return "\n".join(cleaned).strip()


def _router_fallback_from_text(raw: str) -> Dict[str, Any]:
    """
    If the model doesn't return JSON, guess content_type from raw text.
    Keeps the pipeline functional even when the router is flaky.
    """
    t = (raw or "").lower()
    if re.search(r"\b(table|spreadsheet|grid|rows|columns)\b", t):
        return {"content_type": "table", "confidence": 0.35, "signals": ["fallback:table_keywords"]}
    if re.search(r"\b(code|terminal|ide|function|class|import|def|console|stack trace)\b", t):
        return {"content_type": "code", "confidence": 0.35, "signals": ["fallback:code_keywords"]}
    if re.search(r"\b(slide|presentation|bullet|title)\b", t):
        return {"content_type": "slides_text", "confidence": 0.35, "signals": ["fallback:slide_keywords"]}
    if re.search(r"\b(talking head|webcam|person speaking|face)\b", t):
        return {"content_type": "talking_head", "confidence": 0.35, "signals": ["fallback:talking_head_keywords"]}
    if re.search(r"\b(ui|window|menu|toolbar|app)\b", t):
        return {"content_type": "ui_app", "confidence": 0.25, "signals": ["fallback:ui_keywords"]}
    return {"content_type": "other", "confidence": 0.1, "signals": ["fallback:unknown"]}


def classify_scene_content_step_c(vlm_engine: Any, images: List[Image.Image]) -> Dict[str, Any]:
    """
    STEP C: Route scene by content type (code/table/slides/UI/talking-head).
    """
    if not images:
        return {"content_type": "other", "confidence": 0.0, "signals": []}
    
    logger.info("[STEP C] Routing scene by content type (code/table/slides/UI/talking-head)...")
    
    strict_prompt = (
        "You MUST output JSON only.\n"
        "Do NOT output markdown.\n"
        "Do NOT output explanations.\n\n"
        + ROUTER_PROMPT
    )
    
    try:
        raw = vlm_engine.describe_scene(images, strict_prompt, max_tokens=220)
        data = safe_json_parse(raw)
        
        if not data or "content_type" not in data:
            snippet = (raw or "").strip().replace("\n", " ")
            if len(snippet) > 180:
                snippet = snippet[:180] + "..."
            logger.warning(f"[STEP C] Router failed JSON. Raw snippet: {snippet}")
            return _router_fallback_from_text(raw)
        
        ct = str(data.get("content_type") or "other").strip()
        if ct not in ("code", "table", "slides_text", "ui_app", "talking_head", "other"):
            ct = "other"
        
        conf = data.get("confidence", 0.0)
        try:
            conf = float(conf)
        except Exception:
            conf = 0.0
        conf = max(0.0, min(1.0, conf))
        
        sig = data.get("signals", [])
        if not isinstance(sig, list):
            sig = []
        
        logger.info(f"[STEP C] Content type: {ct} (confidence={conf:.2f})")
        return {"content_type": ct, "confidence": conf, "signals": sig}
    
    except Exception as e:
        logger.error(f"[STEP C] Classification error: {e}")
        return {"content_type": "other", "confidence": 0.0, "signals": [f"error:{str(e)[:50]}"]}


def sample_candidate_frames(
    image_list: List[Image.Image],
    n_candidates: int = 10,
) -> List[Dict[str, Any]]:
    """
    Return candidate frames from the provided image list.
    Used for dense sampling in code/table scenes.
    """
    if not image_list:
        return []
    
    n = max(1, min(len(image_list), n_candidates))
    
    if n >= len(image_list):
        return [{"index": i, "image": img} for i, img in enumerate(image_list)]
    
    # Evenly sample n frames from the list
    indices = [int(i * len(image_list) / n) for i in range(n)]
    return [{"index": idx, "image": image_list[idx]} for idx in indices]


def extract_code_or_table_step_c(
    vlm_engine: Any,
    content_type: str,
    images: List[Image.Image],
) -> Dict[str, Any]:
    """
    STEP C: Extract code or table artifacts from dense frames.
    """
    if not images or content_type not in ("code", "table"):
        return {}
    
    prompt = EXTRACT_CODE_PROMPT if content_type == "code" else EXTRACT_TABLE_PROMPT
    
    try:
        # Use the first 3 frames for extraction (they're already selected by density)
        frames_to_analyze = images[:min(3, len(images))]
        raw = vlm_engine.describe_scene(frames_to_analyze, prompt, max_tokens=900)
        data = safe_json_parse(raw)
        
        if not data:
            logger.warning(f"[STEP C] Extraction returned non-JSON; skipping artifact.")
            return {}
        
        logger.info(f"[STEP C] Successfully extracted {content_type} artifact")
        return data
    
    except Exception as e:
        logger.warning(f"[STEP C] Artifact extraction failed: {e}")
        return {}


def _join_url(base_url: str, path: str) -> str:
    base = (base_url or "").rstrip("/")
    p = (path or "").lstrip("/")
    return f"{base}/{p}" if base and p else (base or f"/{p}")


def _http_post_json(url: str, payload: Dict[str, Any], headers: Dict[str, str], timeout_s: float) -> Dict[str, Any]:
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url=url,
        data=data,
        headers={**headers, "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout_s) as resp:
            body = resp.read().decode("utf-8", errors="replace")
            return json.loads(body) if body else {}
    except urllib.error.HTTPError as e:
        body = ""
        try:
            body = e.read().decode("utf-8", errors="replace")
        except Exception:
            pass
        detail = body.strip() or str(e)
        raise RuntimeError(f"Llama API HTTP {getattr(e, 'code', '?')}: {detail}")
    except urllib.error.URLError as e:
        raise RuntimeError(f"Llama API connection error: {e}")


def _http_get_json(url: str, headers: Dict[str, str], timeout_s: float) -> Dict[str, Any]:
    req = urllib.request.Request(
        url=url,
        headers=headers,
        method="GET",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout_s) as resp:
            body = resp.read().decode("utf-8", errors="replace")
            return json.loads(body) if body else {}
    except Exception:
        return {}


def generate_text_report(
    filename: str,
    duration: float,
    segments: List[Dict[str, Any]],
    process_time: float,
    params: Dict[str, Any],
    global_summary: str = "",
) -> str:
    lines = [
        "### CONTEXTE VIDEO (VideoContext v3.19)",
        f"Source : {filename}",
        f"Durée : {duration:.2f}s | Traitement : {process_time:.2f}s",
        f"Config : Res={params['resolution']}px | Seuil={params['threshold']} "
        f"| Min={params['min_duration']}s | Max={params['max_duration']}s "
        f"| Keyframes/scene={params['keyframes_per_scene']} | RAM_MODE={params['ram_mode']}",
        "",
    ]

    if global_summary:
        lines.append("--- RÉSUMÉ GLOBAL ---")
        lines.append(global_summary)
        lines.append("")
        lines.append("-" * 40)
        lines.append("")

    for seg in segments:
        lines.append(f"⏱️ [{seg['start']:.2f} - {seg['end']:.2f}] SCÈNE {seg['scene_id']}")

        if seg.get("audio_transcript"):
            lines.append(f"   🎙️ TEXTE : \"{seg['audio_transcript']}\"")

        af = seg.get("audio_features") or {}
        if af:
            lines.append(
                f"   🔊 AudioFeatures : speech={af.get('speech_ratio', 0):.2f}, "
                f"silence={af.get('silence_ratio', 0):.2f}, "
                f"wpm={af.get('speaking_rate_wpm', 0):.1f}"
            )

        if seg.get("visual_description"):
            lines.append(f"   👀 VISUEL : {seg['visual_description']}")

        vt = seg.get("visual_tags") or {}
        if vt:
            lines.append(
                "   🧩 Tags : "
                f"people={vt.get('people_count', '?')}, "
                f"place={vt.get('place_type', '?')}, "
                f"action={vt.get('main_action', '?')}, "
                f"tone={vt.get('emotional_tone', '?')}, "
                f"movement={vt.get('movement_level', '?')}"
            )

        lines.append("")

    return "\n".join(lines)


# --- API FASTAPI ---

vlm_engine: Optional[VLMProvider] = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global vlm_engine, WHISPER_CACHE
    vlm_engine = get_vlm_engine()

    if isinstance(vlm_engine, LlamaApiEngine) and LLAMA_SERVER_AUTOSTART and LLAMA_SERVER_PRESTART:
        try:
            vlm_engine.load_model(ACTIVE_DEFAULT_VLM)
        except Exception as e:
            print(f"Warning: could not start llama-server: {e}")

    if RAM_MODE == "ram+":
        print("RAM+ mode: preloading VLM...")
        try:
            vlm_engine.load_model(ACTIVE_DEFAULT_VLM)
        except Exception as e:
            print(f"Warning: could not preload default VLM: {e}")

    yield

    if vlm_engine:
        vlm_engine.unload_model()
    gc.collect()


app = FastAPI(
    title="Qwen Video Analysis Worker",
    description="Windows-only video analysis for lecture mode v4.0 (Qwen3-VL + external transcripts)",
    version="4.0",
    lifespan=lifespan,
)

# Allow browser-based frontends (e.g. Vite/React) to call this API through a different origin (Cloudflare Tunnel URL).
# No credentials/cookies are used, so allow_origins="*" is OK for this use case.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

def custom_openapi():
    if app.openapi_schema:
        return app.openapi_schema

    openapi_schema = get_openapi(
        title=app.title,
        version=app.version,
        description=app.description,
        routes=app.routes,
    )

    try:
        paths = openapi_schema["paths"]
        for path, methods in paths.items():
            for method, operation in methods.items():
                request_body = operation.get("requestBody", {})
                content = request_body.get("content", {})
                form_schema = content.get(
                    "application/x-www-form-urlencoded", {}
                ).get("schema", {})
                props = form_schema.get("properties", {})

                for field_name in ["visual_user_prompt", "summary_user_prompt"]:
                    if field_name in props:
                        props[field_name]["format"] = "textarea"
    except Exception as e:
        print("Warning: error patching OpenAPI for textareas:", e)

    app.openapi_schema = openapi_schema
    return app.openapi_schema

app.openapi = custom_openapi


@app.get("/api/v1/last")
async def get_last_analysis():
    if not LAST_RESULT_PATH.exists():
        raise HTTPException(404, "No previous analysis found.")
    try:
        data = json.loads(LAST_RESULT_PATH.read_text(encoding="utf-8"))
    except Exception as e:
        raise HTTPException(500, f"Could not read last analysis: {e}")
    return JSONResponse(content=data)


@app.get("/health")
async def health_check():
    """Health check endpoint for service monitoring."""
    return {"status": "healthy", "service": "qwen_worker", "port": PORT_SERVEUR}


@app.post("/api/v1/analyze")
async def analyze_video(
    video_file: Union[UploadFile, str, None] = File(
        None, description="Fichier vidéo local (Optionnel)"
    ),
    video_url: str = Form(
        "", description="URL YouTube ou direct (laisser vide si upload)"
    ),

    visual_user_prompt: str = Form(
        "Describe factually what happens in the scene from the images, focusing on gestures, posture, mood, and context. "
        "Max 80 words. Respond in English.",
        max_length=1500,
        description=(
            "Instructions supplémentaires pour la description visuelle et le nombre de mot max "
            "(style, ce qu'il faut mettre en avant). Laisse vide pour utiliser "
            "le comportement par défaut."
        ),
    ),

    summary_user_prompt: str = Form(
        "Summarize the video clearly and concisely based on all scenes, as if explaining it to someone who hasn't seen it. "
        "Max 120 words. Respond in English.",
        max_length=2000,
        description=(
            "Instructions supplémentaires pour le résumé global (ton, niveau de détail...). et le nombre de mot max"
            "Laisse vide pour utiliser le comportement par défaut."
        ),
    ),

    vlm_model: str = Form(
        ACTIVE_DEFAULT_VLM,
        description="Modèle VLM",
    ),
    transcripts_json: Optional[str] = Form(
        None,
        description="Pre-computed transcripts JSON: [{\"start\": 0.0, \"end\": 5.2, \"text\": \"...\"}]. If provided, audio transcription is skipped.",
    ),

    response_format: Literal["json", "text"] = Form(
        "json", description="Format de sortie"
    ),

    vlm_resolution: int = Form(
        DEFAULT_RESOLUTION, ge=128, le=2048, description="Résolution pour le VLM"
    ),
    scene_threshold: float = Form(
        DEFAULT_SCENE_THRESHOLD, ge=0.01, le=1.0, description="Seuil de changement de scène"
    ),
    min_scene_duration: float = Form(
        DEFAULT_MIN_DURATION, ge=0.5, le=60.0, description="Durée minimale de scène (s)"
    ),
    max_scene_duration: float = Form(
        DEFAULT_MAX_DURATION, ge=5.0, le=300.0, description="Durée maximale de scène (s)"
    ),

    keyframes_per_scene: int = Form(
        DEFAULT_KEYFRAMES_PER_SCENE,
        ge=1,
        le=5,
        description="Nombre de keyframes par scène (1 à 5). 1 = plus rapide.",
    ),

    vlm_max_tokens_scene: int = Form(
        DEFAULT_VLM_MAX_TOKENS_SCENE,
        ge=16,
        le=2048,
        description=(
            "Nombre max de tokens générés par le VLM pour chaque scène "
            f"(par défaut {DEFAULT_VLM_MAX_TOKENS_SCENE})."
        ),
    ),
    vlm_max_tokens_summary: int = Form(
        DEFAULT_VLM_MAX_TOKENS_SUMMARY,
        ge=16,
        le=2048,
        description="Nombre max de tokens générés par le VLM pour le résumé global (par défaut 260).",
    ),

    skip_audio: bool = Form(True, description="Skip audio processing (transcripts provided externally)"),
    skip_visual: bool = Form(False),
    generate_txt: bool = Form(False),

    enable_audio_features: bool = Form(
        True, description="Calculer les audio_features par scène ? (True par défaut)"
    ),
    generate_summary: bool = Form(
        True, description="Générer un résumé global de la vidéo ? (True par défaut)"
    ),
):
    if isinstance(video_file, str):
        video_file = None

    if not video_file and not video_url.strip():
        raise HTTPException(
            400, "Veuillez fournir soit un fichier vidéo, soit une URL."
        )

    request_start_time = time.time()

    # Whisper timing removed
    vlm_infer_time = 0.0
    # Whisper timing removed

    # Whisper removed
    target_vlm = vlm_model
    temp_path = None
    source_name = "Inconnu"

    try:
        if video_url.strip():
            source_name = video_url
            clean_title = sanitize_filename(video_url)
            try:
                temp_path = download_video_from_url(
                    video_url,
                    f"temp_{int(time.time())}_{clean_title}.%(ext)s",
                )
            except ValueError as ve:
                raise HTTPException(400, str(ve))
        elif video_file:
            ext = Path(video_file.filename).suffix.lower()
            if ext not in ALLOWED_EXTENSIONS:
                raise HTTPException(400, f"Extension interdite: {ext}")
            source_name = video_file.filename
            clean_name = sanitize_filename(video_file.filename)
            temp_path = os.path.abspath(f"temp_{int(time.time())}_{clean_name}")
            with open(temp_path, "wb") as buffer:
                shutil.copyfileobj(video_file.file, buffer)

        video_duration = validate_video_file(temp_path)
        start_process = time.time()
        final_segments: List[Dict[str, Any]] = []
        global_summary_text = ""

        logger.info("Detecting scenes...")
        scenes_raw = detect_scenes_step_a(
            temp_path,
            threshold=scene_threshold,
            min_duration=min_scene_duration,
            max_duration=max_scene_duration,
        )
        _ = semantic_change_points_step_d(temp_path)

        if skip_audio and skip_visual:
            for idx, scene in enumerate(scenes_raw):
                final_segments.append(
                    {
                        "scene_id": idx + 1,
                        "start": round(scene["start"], 2),
                        "end": round(scene["end"], 2),
                        "audio_transcript": "",
                        "audio_features": {},
                        "visual_description": "",
                        "visual_tags": {},
                        "emotion": {},
                        "artifacts": {},
                    }
                )
        else:
            async with gpu_lock:
                print("GPU lock acquired.")

                # Parse external transcripts (from Parakeet or other source)
                transcript_segments: List[Dict[str, Any]] = []
                if transcripts_json and transcripts_json.strip():
                    try:
                        transcript_segments = json.loads(transcripts_json)
                        logger.info(f"Loaded {len(transcript_segments)} transcript segments from input.")
                    except Exception as e:
                        logger.warning(f"Failed to parse transcripts_json: {e}")
                        transcript_segments = []

                if not skip_visual or generate_summary:
                    t0 = time.time()
                    vlm_engine.load_model(target_vlm)
                    t1 = time.time()
                    vlm_load_time = vlm_engine.last_load_time or (t1 - t0)
                else:
                    vlm_load_time = 0.0

                cap = cv2.VideoCapture(temp_path)

                resize_tuple = (vlm_resolution, vlm_resolution)
                first_frame_img = None
                cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
                ret, f_frame = cap.read()
                if ret:
                    f_frame = cv2.resize(f_frame, resize_tuple)
                    first_frame_img = Image.fromarray(
                        cv2.cvtColor(f_frame, cv2.COLOR_BGR2RGB)
                    )

                for idx, scene in enumerate(scenes_raw):
                    scene_id = idx + 1
                    start_s = scene["start"]
                    end_s = scene["end"]

                    audio_parts = []
                    if not skip_audio and transcript_segments:
                        for s in transcript_segments:
                            if s["start"] < end_s and s["end"] > start_s:
                                txt = (s.get("text") or "").strip()
                                if txt:
                                    audio_parts.append(txt)

                    audio_text = " ".join(audio_parts).strip()

                    audio_features = {}
                    if (
                        not skip_audio
                        and transcript_segments
                        and enable_audio_features
                    ):
                        audio_features = compute_audio_features_for_scene(
                            scene, transcript_segments
                        )

                    visual_description = ""
                    visual_tags: Dict[str, Any] = {}
                    scene_title = ""
                    scene_summary = ""
                    emotion_info_scene: Dict[str, Any] = {}
                    artifacts: Dict[str, Any] = {}

                    if not skip_visual:
                        n_candidates = int(os.getenv("VIDEOCONTEXT_KEYFRAME_CANDIDATES", "10"))
                        keyframes = pick_best_keyframes_step_b(
                            cap,
                            scene,
                            base_res=vlm_resolution,
                            max_pick=keyframes_per_scene,
                            n_candidates=n_candidates,
                        )

                        if keyframes:
                            images = [kf["image"] for kf in keyframes]

                            route = classify_scene_content_step_c(vlm_engine, images)
                            content_type = (route.get("content_type") or "other").strip()
                            conf = float(route.get("confidence") or 0.0)
                            logger.info(f"[STEP C] Scene {scene_id} routed as '{content_type}' (conf={conf:.2f}).")

                            if content_type == "other" and conf <= 0.2:
                                logger.info(
                                    f"[STEP C] Scene {scene_id} weak classification. signals={route.get('signals', [])}"
                                )

                            full_visual_prompt = BASE_VISUAL_PROMPT
                            if visual_user_prompt.strip():
                                full_visual_prompt += (
                                    "\n\nAdditional user instructions (follow them if possible):\n"
                                    + visual_user_prompt.strip()
                                )

                            t_vlm_start = time.time()
                            raw = vlm_engine.describe_scene(
                                images,
                                full_visual_prompt,
                                max_tokens=vlm_max_tokens_scene,
                            )
                            t_vlm_end = time.time()
                            vlm_infer_time += t_vlm_end - t_vlm_start

                            data = safe_json_parse(raw)

                            if data and isinstance(data, dict) and "description" in data:
                                scene_title = (data.get("title") or "").strip()
                                scene_summary = (data.get("scene_summary") or "").strip()
                                visual_description = (data.get("description") or "").strip()
                                tags = data.get("tags") or {}
                                if isinstance(tags, dict):
                                    visual_tags = tags
                                else:
                                    visual_tags = {}
                            else:
                                scene_title = ""
                                scene_summary = ""
                                visual_description = clean_raw_visual_text(raw)
                                visual_tags = {}

                            # If code/table, do dense sampling + extraction in chunks to avoid context overflow
                            if content_type in ("code", "table"):
                                needs_dense = _scroll_or_change_spike(cap, scene, base_res=vlm_resolution)
                                dense_n = int(os.getenv("VIDEOCONTEXT_DENSE_CANDIDATES", "30")) if needs_dense else int(os.getenv("VIDEOCONTEXT_DENSE_CANDIDATES", "20"))
                                dense = dense_frames_for_scene(cap, scene, base_res=vlm_resolution, n_candidates=dense_n)

                                dense_scored = []
                                prev_gray = None
                                for d in dense:
                                    motion = _frame_motion_score(prev_gray, d["gray"])
                                    sharp = _laplacian_sharpness(d["gray"])
                                    prev_gray = d["gray"]
                                    score = (sharp / 1000.0) - (motion * 1.5)
                                    dense_scored.append((score, d))
                                dense_scored.sort(key=lambda x: x[0], reverse=True)

                                top_k = int(os.getenv("VIDEOCONTEXT_RECON_FRAMES", "6"))
                                recon_imgs = [x[1]["image"] for x in dense_scored[:top_k]]
                                logger.info(f"[STEP C] Reconstruction frames picked: {len(recon_imgs)} (type={content_type}).")

                                chunk_size = int(os.getenv("VIDEOCONTEXT_RECON_CHUNK", "3"))
                                extracted_blocks = []
                                for i in range(0, len(recon_imgs), chunk_size):
                                    chunk = recon_imgs[i:i+chunk_size]
                                    art = extract_code_or_table_step_c(vlm_engine, content_type, chunk)
                                    if content_type == "code" and art.get("code"):
                                        extracted_blocks.append(art["code"])
                                    if content_type == "table" and art.get("table"):
                                        extracted_blocks.append(art["table"])

                                if content_type == "code":
                                    merged_code = merge_text_blocks_by_overlap(extracted_blocks)
                                    artifacts["code"] = {"language": "", "code": merged_code}
                                elif content_type == "table":
                                    artifacts["tables"] = extracted_blocks

                            visual_tags = visual_tags or {}
                            visual_tags["_router"] = {
                                "content_type": content_type,
                                "confidence": conf,
                                "signals": route.get("signals", []),
                            }

                    final_segments.append(
                        {
                            "scene_id": scene_id,
                            "start": round(start_s, 2),
                            "end": round(end_s, 2),
                            "scene_title": scene_title,
                            "scene_summary": scene_summary,
                            "audio_transcript": audio_text,
                            "audio_features": audio_features,
                            "visual_description": visual_description,
                            "visual_tags": visual_tags,
                            "emotion": emotion_info_scene,
                            "artifacts": artifacts,
                        }
                    )

                if generate_summary:
                    print("Generating global summary...")
                    context_lines = []
                    for s in final_segments:
                        parts = []
                        if s.get("audio_transcript"):
                            parts.append(f"Audio: {s['audio_transcript']}")
                        vt = s.get("visual_tags") or {}
                        if vt:
                            parts.append(
                                "Visual: "
                                f"people={vt.get('people_count', '?')}, "
                                f"place={vt.get('place_type', '?')}, "
                                f"action={vt.get('main_action', '?')}, "
                                f"tone={vt.get('emotional_tone', '?')}, "
                                f"movement={vt.get('movement_level', '?')}"
                            )
                        elif s.get("visual_description"):
                            parts.append(f"Visual: {s['visual_description']}")

                        if parts:
                            context_lines.append(
                                f"- Scene {s['scene_id']} "
                                f"({s['start']:.1f}-{s['end']:.1f}s): "
                                + " | ".join(parts)
                            )

                    context_log = "\n".join(context_lines)

                    full_summary_prompt = (
                        "Here are notes about the scenes of a video.\n"
                        "For each scene, you have an audio transcript (what is said) and visual context (gestures, place, mood, tone).\n\n"
                        f"{context_log}\n\n"
                        f"{BASE_SUMMARY_PROMPT}"
                    )

                    if summary_user_prompt.strip():
                        full_summary_prompt += (
                            "\n\nUser instructions (apply if possible):\n"
                            + summary_user_prompt.strip()
                        )

                    if not skip_visual and first_frame_img is not None:
                        t_vlm_start = time.time()
                        raw_summary = vlm_engine.describe_scene(
                            [first_frame_img],
                            full_summary_prompt,
                            max_tokens=vlm_max_tokens_summary,
                        )
                        t_vlm_end = time.time()
                        vlm_infer_time += t_vlm_end - t_vlm_start

                        data_sum = safe_json_parse(raw_summary)
                        if data_sum and isinstance(data_sum, dict) and (
                            "summary" in data_sum or "description" in data_sum
                        ):
                            global_summary_text = (
                                data_sum.get("summary")
                                or data_sum.get("description")
                                or ""
                            ).strip()
                        else:
                            global_summary_text = clean_raw_summary_text(raw_summary)
                    else:
                        global_summary_text = context_log[:2000]

                cap.release()
                print("GPU lock released.")

                if RAM_MODE == "ram-":
                    print("RAM- mode: unloading VLM after processing.")
                    vlm_engine.unload_model()
                    gc.collect()

        process_duration = time.time() - start_process
        total_request_time = time.time() - request_start_time

        vlm_load_time = getattr(vlm_engine, "last_load_time", 0.0) if vlm_engine else 0.0

        print("===== TIMING PROFILE (v3.19) =====")
        print(f"Total processing time: {process_duration:.2f}s")
        print(f"Total request time:    {total_request_time:.2f}s")
        # Whisper removed - using external transcripts
        print(f"VLM:    load={vlm_load_time:.2f}s, infer={vlm_infer_time:.2f}s")
        print(f"RAM_MODE = {RAM_MODE}")
        print("================================")

        params = {
            "threshold": scene_threshold,
            "min_duration": min_scene_duration,
            "max_duration": max_scene_duration,
            "vlm": target_vlm,
            # "whisper": removed (external transcripts)
            "resolution": vlm_resolution,
            "keyframes_per_scene": keyframes_per_scene,
            "vlm_max_tokens_scene": vlm_max_tokens_scene,
            "vlm_max_tokens_summary": vlm_max_tokens_summary,
            "ram_mode": RAM_MODE,
        }

        text_report_content = generate_text_report(
            source_name,
            video_duration,
            final_segments,
            process_duration,
            params,
            global_summary_text,
        )

        txt_output_name = None
        if generate_txt:
            safe_name = sanitize_filename(source_name)
            txt_output_name = f"{safe_name}_context.txt"
            txt_path = os.path.abspath(txt_output_name)
            with open(txt_path, "w", encoding="utf-8") as f:
                f.write(text_report_content)

        timings = {
            "total_process_time": round(process_duration, 3),
            "total_request_time": round(total_request_time, 3),
            "vlm": {
                "model": target_vlm,
                "load_time": round(vlm_load_time, 3),
                "inference_time": round(vlm_infer_time, 3),
            },
            "ram_mode": RAM_MODE,
        }

        if response_format == "text":
            download_name = f"{sanitize_filename(source_name)}_context.txt"
            return PlainTextResponse(
                content=text_report_content,
                headers={
                    "Content-Disposition": f'attachment; filename=\"{download_name}\"'
                },
            )
        else:
            result_payload = {
                "meta": {
                    "source": source_name,
                    "duration": round(video_duration, 2),
                    "process_time": round(process_duration, 2),
                    "global_summary": global_summary_text,
                    "scene_count": len(final_segments),
                    "models": {
                        "vlm": target_vlm,
                        # "whisper": removed (external transcripts)
                    },
                    "skipped": {
                        "audio": skip_audio,
                        "visual": skip_visual,
                    },
                    "params": {
                        "keyframes_per_scene": keyframes_per_scene,
                        "enable_audio_features": enable_audio_features,
                        "generate_summary": generate_summary,
                        "vlm_max_tokens_scene": vlm_max_tokens_scene,
                        "vlm_max_tokens_summary": vlm_max_tokens_summary,
                        "ram_mode": RAM_MODE,
                    },
                    "timings": timings,
                },
                "segments": final_segments,
                "txt_filename": txt_output_name,
            }

            try:
                tmp_path = LAST_RESULT_PATH.with_suffix(".tmp")
                tmp_path.write_text(json.dumps(result_payload, ensure_ascii=False, indent=2), encoding="utf-8")
                os.replace(tmp_path, LAST_RESULT_PATH)
            except Exception as e:
                print(f"Warning: could not persist last analysis to {LAST_RESULT_PATH}: {e}")

            return result_payload

    except HTTPException as he:
        raise he
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(500, f"Erreur interne: {str(e)}")
    finally:
        # Ensure all file handles are released
        try:
            if 'cap' in locals():
                cap.release()
        except Exception:
            pass
        
        if temp_path and os.path.exists(temp_path):
            try:
                os.remove(temp_path)
            except PermissionError:
                # File still in use, wait and retry
                time.sleep(0.1)
                try:
                    os.remove(temp_path)
                except Exception:
                    pass  # Temp file cleanup failed, ignore


# ==================== NEW ENDPOINT: Sequential Frame Analysis (Phase 1) ====================

@app.post("/api/v1/analyze_sequential")
async def analyze_sequential(
    frames_json: str = Form(..., description="JSON array of {timestamp_ms: int, image_base64: str}"),
    transcripts_json: str = Form(..., description="Transcripts JSON: [{start: float, end: float, text: str, is_final: bool}]"),
    previous_context_json: str = Form(
        "",
        description="Optional JSON object containing previous context to carry across requests",
    ),
    
    config_json: str = Form(
        '{"batch_size": 5, "duration_seconds": 120}',
        description="Configuration JSON"
    ),
    
    vlm_model: str = Form(ACTIVE_DEFAULT_VLM),
    vlm_max_tokens: int = Form(500, ge=100, le=2048, description="Max tokens per batch"),
):
    """
    Sequential frame analysis endpoint.
    
    Receives pre-captured frames (1 per second) and processes in batches of 5.
    Passes context between batches for topic continuity.
    Prints token usage and context to console.
    """
    start_time_total = time.time()
    
    try:
        # Parse inputs
        frames_data = json.loads(frames_json)
        transcripts_data = json.loads(transcripts_json)
        config = json.loads(config_json)
        
        batch_size = config.get("batch_size", 5)
        duration_seconds = config.get("duration_seconds", 120)
        
        total_frames = len(frames_data)
        total_batches = math.ceil(total_frames / batch_size)
        
        logger.info(f"[Sequential] Received {total_frames} frames, {len(transcripts_data)} transcripts")
        logger.info(f"[Sequential] Processing in {total_batches} batches of {batch_size}")
        
        # Decode all frames to PIL Images
        pil_frames = []
        for frame_info in frames_data:
            try:
                img_data = base64.b64decode(frame_info["image_base64"])
                img = Image.open(BytesIO(img_data)).convert("RGB")
                # Resize for efficiency
                max_dim = 768
                if max(img.size) > max_dim:
                    ratio = max_dim / max(img.size)
                    new_size = (int(img.size[0] * ratio), int(img.size[1] * ratio))
                    img = img.resize(new_size, Image.LANCZOS)
                pil_frames.append({
                    "timestamp_ms": frame_info["timestamp_ms"],
                    "image": img
                })
            except Exception as e:
                logger.warning(f"[Sequential] Failed to decode frame: {e}")
        
        logger.info(f"[Sequential] Decoded {len(pil_frames)} frames successfully")
        
        # Get VLM engine
        vlm_engine = get_vlm_engine()
        vlm_engine.load_model(vlm_model)
        
        # Process batches with context passing
        batch_results = []
        previous_context = None
        if previous_context_json and str(previous_context_json).strip():
            try:
                previous_context = json.loads(previous_context_json)
                if not isinstance(previous_context, dict):
                    previous_context = None
            except Exception:
                previous_context = None
        total_prompt_tokens = 0
        total_completion_tokens = 0
        
        for batch_idx in range(total_batches):
            batch_start = batch_idx * batch_size
            batch_end = min(batch_start + batch_size, len(pil_frames))
            batch_frames = pil_frames[batch_start:batch_end]
            
            if not batch_frames:
                continue
            
            # Get time range for this batch
            time_start_ms = batch_frames[0]["timestamp_ms"]
            time_end_ms = batch_frames[-1]["timestamp_ms"]
            time_start_sec = time_start_ms / 1000.0
            time_end_sec = time_end_ms / 1000.0
            
            # Get transcripts for this time range (both final and in-progress)
            batch_transcripts = [
                t for t in transcripts_data
                if t.get("start", 0) * 1000 <= time_end_ms and t.get("end", 0) * 1000 >= time_start_ms
            ]
            transcript_text = " ".join([t.get("text", "") for t in batch_transcripts]) if batch_transcripts else "(no transcript)"
            
            # Build prompt with or without context
            if batch_idx == 0 and not previous_context:
                # First batch - no context
                prompt = f"""Analyze this lecture segment ({time_start_sec:.1f}s - {time_end_sec:.1f}s).

TRANSCRIPT: "{transcript_text[:500]}"

Provide analysis in JSON format:
{{
  "topic": "main topic being discussed (3-8 words)",
  "content_type": "code|table|slides_text|talking_head|ui_app|diagram|whiteboard|other",
  "description": "2-3 sentence description of what's being explained (focus on content, not visual details)",
  "has_structured_content": true/false,
  "structured_hints": ["python code", "data table", etc.] or [],
  "is_topic_complete": true/false
}}

                Do NOT mention frames, images, or screenshots. Describe the lecture content naturally.
                Output valid JSON only."""
            else:
                # Subsequent batches - include context
                ctx = previous_context
                prompt = f"""Analyze this lecture segment ({time_start_sec:.1f}s - {time_end_sec:.1f}s).

PREVIOUS CONTEXT:
- Topic: "{ctx.get('topic', 'unknown')}"
- Content: {ctx.get('content_type', 'unknown')}
- Status: {"Topic ongoing" if not ctx.get('is_topic_complete', True) else "Topic completed"}
- Previous summary: "{ctx.get('description', '')[:150]}"

CURRENT TRANSCRIPT: "{transcript_text[:500]}"

Provide analysis in JSON format:
{{
  "is_same_topic": true/false,
  "topic": "topic name (use previous if same topic, or new name if different)",
  "content_type": "code|table|slides_text|talking_head|ui_app|diagram|whiteboard|other",
  "description": "2-3 sentences describing NEW information only (don't repeat previous)",
  "has_structured_content": true/false,
  "structured_hints": ["python code", "data table", etc.] or [],
  "is_topic_complete": true/false
}}

Do NOT mention frames, images, or screenshots. Describe the lecture content naturally.
Output valid JSON only."""
            
            # ===== PRINT CONTEXT TO CONSOLE =====
            print("\n" + "="*80)
            print(f"[BATCH {batch_idx + 1}/{total_batches}] Time: {time_start_sec:.1f}s - {time_end_sec:.1f}s")
            print(f"[BATCH {batch_idx + 1}] Frames: {len(batch_frames)}, Transcripts: {len(batch_transcripts)}")
            if previous_context:
                print(f"[BATCH {batch_idx + 1}] CONTEXT PASSED FROM PREVIOUS:")
                print(f"  - Topic: {previous_context.get('topic', 'N/A')}")
                print(f"  - Content Type: {previous_context.get('content_type', 'N/A')}")
                print(f"  - Is Complete: {previous_context.get('is_topic_complete', 'N/A')}")
                print(f"  - Description: {previous_context.get('description', 'N/A')[:100]}...")
            else:
                print(f"[BATCH {batch_idx + 1}] NO PREVIOUS CONTEXT (first batch)")
            print("-"*80)
            
            # Extract PIL images for VLM
            batch_images = [f["image"] for f in batch_frames]
            
            # Call VLM
            batch_start_time = time.time()
            async with gpu_lock:
                raw_response, prompt_tokens_actual, completion_tokens_actual = vlm_engine.describe_scene(
                    batch_images,
                    prompt,
                    max_tokens=vlm_max_tokens
                )
            batch_inference_time = time.time() - batch_start_time
            
            # Use actual tokens from llama-cli
            total_prompt_tokens += prompt_tokens_actual
            total_completion_tokens += completion_tokens_actual
            
            # ===== PRINT TOKEN USAGE TO CONSOLE =====
            print(f"[BATCH {batch_idx + 1}] INFERENCE TIME: {batch_inference_time:.2f}s")
            print(f"[BATCH {batch_idx + 1}] TOKENS (actual from llama-cli):")
            print(f"  - Prompt tokens: {prompt_tokens_actual}")
            print(f"  - Completion tokens: {completion_tokens_actual}")
            print(f"  - Running total: {total_prompt_tokens + total_completion_tokens} tokens")
            print("="*80 + "\n")
            
            # Parse response
            try:
                # Clean response and parse JSON
                cleaned = raw_response.strip()
                # Try to extract JSON from response
                json_match = re.search(r'\{[^{}]*\}', cleaned, re.DOTALL)
                if json_match:
                    result = json.loads(json_match.group())
                else:
                    result = json.loads(cleaned)
            except json.JSONDecodeError as e:
                logger.warning(f"[Sequential] Batch {batch_idx + 1} JSON parse failed: {e}")
                result = {
                    "topic": "unknown",
                    "content_type": "other",
                    "description": raw_response[:200],
                    "has_structured_content": False,
                    "structured_hints": [],
                    "is_topic_complete": True
                }
            
            # Add batch metadata
            result["batch_id"] = batch_idx
            result["time_start"] = time_start_sec
            result["time_end"] = time_end_sec
            result["inference_time"] = batch_inference_time
            result["tokens_actual"] = {
                "prompt": prompt_tokens_actual,
                "completion": completion_tokens_actual
            }
            
            batch_results.append(result)
            
            # Prepare context for next batch
            previous_context = {
                "topic": result.get("topic", "unknown"),
                "content_type": result.get("content_type", "other"),
                "description": result.get("description", "")[:200],
                "is_topic_complete": result.get("is_topic_complete", True),
                "has_structured_content": result.get("has_structured_content", False),
                "batch_id": batch_idx
            }
            
            logger.info(f"[Sequential] Batch {batch_idx + 1}/{total_batches} complete: {result.get('topic', 'unknown')}")
        
        processing_time = time.time() - start_time_total
        
        # ===== PRINT FINAL SUMMARY TO CONSOLE =====
        print("\n" + "="*80)
        print("[SEQUENTIAL ANALYSIS COMPLETE]")
        print(f"  Total batches: {total_batches}")
        print(f"  Total frames: {total_frames}")
        print(f"  Total processing time: {processing_time:.2f}s")
        print(f"  Total tokens (actual): {total_prompt_tokens + total_completion_tokens}")
        print(f"    - Prompt tokens: {total_prompt_tokens}")
        print(f"    - Completion tokens: {total_completion_tokens}")
        print("="*80 + "\n")
        
        return JSONResponse(content={
            "status": "success",
            "analysis": {
                "batches": batch_results,
                "total_batches": total_batches,
                "total_frames": total_frames,
                "processing_time": processing_time,
                "next_context": previous_context,
                "tokens_total": {
                    "prompt": total_prompt_tokens,
                    "completion": total_completion_tokens,
                    "total": total_prompt_tokens + total_completion_tokens
                },
                "model_info": {
                    "model_name": vlm_model,
                    "engine": "llama_cpp"
                }
            }
        })
        
    except Exception as e:
        logger.error(f"[Sequential] Error: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


# ==================== NEW ENDPOINT: Topic Summary (Map-Reduce Reduce Step) ====================

@app.post("/api/v1/summarize_topics")
async def summarize_topics(
    batches_json: str = Form(..., description="JSON array of batch analysis objects from /analyze_sequential"),
    vlm_model: str = Form(ACTIVE_DEFAULT_VLM),
    max_tokens: int = Form(-1, description="Max tokens for the final summary"),
):
    """
    Reduce step: given per-batch (5-frame) analyses, produce a single coherent summary of topics.
    This is text-only (no images), using the same VLM model as a regular LLM call.
    """
    try:
        batches = json.loads(batches_json)
        if not isinstance(batches, list):
            raise ValueError("batches_json must be a JSON array")
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid batches_json: {e}")

    # Build a compact log for the model (avoid huge prompts).
    lines = []
    for b in batches:
        if not isinstance(b, dict):
            continue
        ts0 = b.get("time_start")
        ts1 = b.get("time_end")
        topic = str(b.get("topic", "unknown"))
        desc = str(b.get("description", "")).strip().replace("\n", " ")
        if len(desc) > 220:
            desc = desc[:220] + "…"
        try:
            if ts0 is not None and ts1 is not None:
                lines.append(f"- [{float(ts0):.1f}s–{float(ts1):.1f}s] {topic}: {desc}")
            else:
                lines.append(f"- {topic}: {desc}")
        except Exception:
            lines.append(f"- {topic}: {desc}")

    context_log = "\n".join(lines[:500])  # hard cap

    prompt = f"""You are given sequential batch analyses of a lecture video.
Each line contains an approximate time window, a detected topic, and a short description of NEW information.

TASK:
1) Merge adjacent/related batches into distinct TOPICS.
2) For each topic, summarize the key points (bullets) and list the time ranges where it occurs.
3) Produce an overall high-level summary at the end.

OUTPUT FORMAT (Markdown):
## Topics
### <Topic Name>
- Time ranges: ...
- Key points:
  - ...

## Overall Summary
<3-8 bullet points, concise>

BATCH LOG:
{context_log}
"""

    try:
        vlm_engine = get_vlm_engine()
        vlm_engine.load_model(vlm_model)

        async with gpu_lock:
            raw, prompt_tokens, completion_tokens = vlm_engine.describe_scene([], prompt, max_tokens=int(max_tokens))

        summary_md = (raw or "").strip()
        return JSONResponse(content={
            "status": "success",
            "summary_markdown": summary_md,
            "tokens_actual": {
                "prompt": prompt_tokens,
                "completion": completion_tokens,
                "total": prompt_tokens + completion_tokens,
            },
            "model_info": {"model_name": vlm_model, "engine": "llama_cpp"},
        })
    except Exception as e:
        logger.error(f"[SummarizeTopics] Error: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


# ==================== NEW ENDPOINT: Analyze Pre-Extracted Keyframes ====================

@app.post("/api/v1/analyze_keyframes")
async def analyze_keyframes(
    keyframes: List[UploadFile] = File(..., description="Keyframe images (JPEG)"),
    scenes_metadata: str = Form(..., description="Scene metadata JSON"),
    transcripts_json: Optional[str] = Form(None, description="Transcripts JSON"),
    
    visual_user_prompt: str = Form(
        "Describe factually what happens in the scene from the images, focusing on gestures, posture, mood, and context. "
        "Max 80 words. Respond in English.",
        max_length=1500,
    ),
    
    vlm_model: str = Form(ACTIVE_DEFAULT_VLM),
    vlm_resolution: int = Form(DEFAULT_RESOLUTION, ge=128, le=2048),
    vlm_max_tokens_scene: int = Form(DEFAULT_VLM_MAX_TOKENS_SCENE, ge=16, le=2048),
    
    skip_visual: bool = Form(False),
):
    """
    Analyze pre-extracted keyframes (skips scene detection step).
    Used by keyframe_worker pipeline for faster processing.
    
    Request body:
    - keyframes: Array of JPEG images
    - scenes_metadata: JSON array with scene timing info
    - transcripts_json: Optional transcripts
    
    Response: Same format as /api/v1/analyze
    """
    start_time_total = time.time()
    
    try:
        # Parse scene metadata
        scenes_meta = json.loads(scenes_metadata)
        logger.info(f"[AnalyzeKeyframes] Processing {len(keyframes)} keyframes for {len(scenes_meta)} scenes")
        
        # Parse transcripts if provided
        transcript_segments = []
        if transcripts_json:
            try:
                trans_data = json.loads(transcripts_json)
                transcript_segments = [
                    {"start": float(t.get("start_time", 0)), "end": float(t.get("end_time", 0)), "text": str(t.get("text", ""))}
                    for t in trans_data
                ]
            except Exception as e:
                logger.warning(f"[AnalyzeKeyframes] Failed to parse transcripts: {e}")
        
        # Use global VLM engine
        global vlm_engine
        if vlm_engine is None:
            vlm_engine = get_vlm_engine()
        
        async with gpu_lock:
            vlm_engine.load_model(vlm_model)
        
        # Process each scene with its keyframes
        scene_analyses = []
        keyframe_index = 0
        
        for scene_meta in scenes_meta:
            scene_id = scene_meta["scene_id"]
            start_time_sec = scene_meta["start_time"]
            end_time_sec = scene_meta["end_time"]
            duration = scene_meta["duration"]
            keyframe_times = scene_meta["keyframe_times"]
            
            # Extract keyframes for this scene
            scene_keyframes = []
            for kf_time in keyframe_times:
                if keyframe_index >= len(keyframes):
                    logger.warning(f"[AnalyzeKeyframes] Not enough keyframes provided (expected {len(keyframe_times)}, got {keyframe_index})")
                    break
                    
                # Read keyframe image
                kf_file = keyframes[keyframe_index]
                kf_data = await kf_file.read()
                img = Image.open(BytesIO(kf_data))
                
                # Resize if needed
                if img.width > vlm_resolution or img.height > vlm_resolution:
                    img.thumbnail((vlm_resolution, vlm_resolution), Image.Resampling.LANCZOS)
                
                scene_keyframes.append(img)
                keyframe_index += 1
            
            if not scene_keyframes:
                logger.warning(f"[AnalyzeKeyframes] No keyframes for scene {scene_id}, skipping")
                continue
            
            # Get transcripts for this scene
            scene_transcripts = [
                t for t in transcript_segments
                if t["start"] <= end_time_sec and t["end"] >= start_time_sec
            ]
            
            # Classify scene content
            content_classification = classify_scene_content_step_c(vlm_engine, scene_keyframes)
            content_type = content_classification.get("content_type", "other")
            confidence = content_classification.get("confidence", 0.0)
            
            # Generate description with VLM
            if skip_visual:
                description = "[Visual analysis skipped by user]"
                artifacts = {"code_blocks": [], "tables": [], "diagrams": []}
            else:
                # Build prompt with transcripts
                if scene_transcripts:
                    transcript_text = " ".join([t["text"] for t in scene_transcripts])
                    full_prompt = f"{visual_user_prompt}\n\nTranscript: {transcript_text}"
                else:
                    full_prompt = visual_user_prompt
                
                # Call VLM
                async with gpu_lock:
                    raw_description = vlm_engine.describe_scene(
                        scene_keyframes,
                        full_prompt,
                        max_tokens=vlm_max_tokens_scene
                    )
                
                description = raw_description.strip()
                
                # Extract artifacts based on content type
                artifacts = {
                    "code_blocks": [],
                    "tables": [],
                    "diagrams": []
                }
                
                # If code or table detected with high confidence, perform dense sampling + extraction
                if content_type in ("code", "table") and confidence > 0.5:
                    logger.info(f"[STEP C] Dense sampling for {content_type} extraction...")
                    # Get more candidate frames for dense analysis (8-10 frames)
                    dense_candidates = sample_candidate_frames(scene_keyframes, n_candidates=10)
                    if dense_candidates:
                        dense_images = [c["image"] for c in dense_candidates]
                        extracted = extract_code_or_table_step_c(vlm_engine, content_type, dense_images)
                        
                        if content_type == "code" and extracted:
                            artifacts["code_blocks"].append({
                                "language": extracted.get("language", ""),
                                "code": extracted.get("code", ""),
                                "confidence": confidence,
                            })
                        elif content_type == "table" and extracted:
                            artifacts["tables"].append({
                                "format": extracted.get("format", "markdown"),
                                "content": extracted.get("table", ""),
                                "confidence": confidence,
                            })
            
            # Build scene analysis
            scene_analyses.append({
                "scene_id": scene_id,
                "start_frame": int(start_time_sec * 25),  # Assume 25fps
                "end_frame": int(end_time_sec * 25),
                "start_time": start_time_sec,
                "end_time": end_time_sec,
                "keyframes": [int(t * 25) for t in keyframe_times],
                "content_type": content_type,
                "confidence": confidence,
                "description": description,
                "artifacts": artifacts,
            })
        
        processing_time = time.time() - start_time_total
        
        logger.info(f"[AnalyzeKeyframes] Completed {len(scene_analyses)} scenes in {processing_time:.2f}s")
        
        return {
            "status": "success",
            "analysis": {
                "scenes": scene_analyses,
                "processing_time": processing_time,
                "model_info": {
                    "model_name": vlm_model,
                    "engine": "llama_cpp",
                    "inference_time": processing_time,
                },
            },
        }
        
    except Exception as e:
        logger.error(f"[AnalyzeKeyframes] Error: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/v1/receive_client_video")
async def receive_client_video(
    video_file: UploadFile = File(..., description="Video file from client")
):
    """
    Receive video from client, process server-side with sequential pipeline,
    return transcripts and batches.
    """
    temp_path = None
    try:
        logger.info(f"[ReceiveClientVideo] Receiving video: {video_file.filename}")
        
        # Save uploaded file to temp location
        ext = Path(video_file.filename).suffix.lower() if video_file.filename else '.mp4'
        if ext not in ALLOWED_EXTENSIONS:
            raise HTTPException(400, f"Extension interdite: {ext}")
        
        clean_name = sanitize_filename(video_file.filename or "upload")
        temp_path = os.path.abspath(f"temp_client_{int(time.time())}_{clean_name}")
        
        with open(temp_path, "wb") as f:
            shutil.copyfileobj(video_file.file, f)
        
        logger.info(f"[ReceiveClientVideo] Saved to: {temp_path}")
        
        # Spawn processing script
        repo_root = Path(__file__).parent.parent
        script_path = repo_root / "scripts" / "process_client_upload.py"
        
        if not script_path.exists():
            raise HTTPException(500, f"Processing script not found: {script_path}")
        
        # Get venv python
        venv_python = repo_root / ".venv" / "Scripts" / "python.exe"
        if not venv_python.exists():
            venv_python = "python"
        
        # Run processing script
        logger.info(f"[ReceiveClientVideo] Running processing script...")
        result = subprocess.run(
            [str(venv_python), str(script_path), "--video-path", temp_path],
            capture_output=True,
            text=True,
            timeout=1800  # 30 minute timeout
        )
        
        if result.returncode != 0:
            logger.error(f"[ReceiveClientVideo] Script failed: {result.stderr}")
            raise HTTPException(500, f"Processing failed: {result.stderr}")
        
        # Parse JSON output
        try:
            output_data = json.loads(result.stdout)
        except json.JSONDecodeError as e:
            logger.error(f"[ReceiveClientVideo] Failed to parse output: {result.stdout}")
            raise HTTPException(500, f"Invalid JSON output: {e}")
        
        logger.info(f"[ReceiveClientVideo] Processing complete")
        
        return {
            "status": "success",
            "transcripts": output_data.get("transcripts", []),
            "batches": output_data.get("batches", []),
            "words": output_data.get("words", []),
        }
        
    except subprocess.TimeoutExpired:
        logger.error("[ReceiveClientVideo] Processing timeout")
        raise HTTPException(504, "Processing timeout (30 minutes)")
    except Exception as e:
        logger.error(f"[ReceiveClientVideo] Error: {str(e)}", exc_info=True)
        raise HTTPException(500, str(e))
    finally:
        # Cleanup temp file
        if temp_path and os.path.exists(temp_path):
            try:
                os.remove(temp_path)
                logger.info(f"[ReceiveClientVideo] Cleaned up: {temp_path}")
            except Exception as e:
                logger.warning(f"[ReceiveClientVideo] Cleanup failed: {e}")


# ==================== Server Startup ====================

if __name__ == "__main__":
    import uvicorn
    
    # Start FastAPI server
    uvicorn.run(app, host="0.0.0.0", port=PORT_SERVEUR)
