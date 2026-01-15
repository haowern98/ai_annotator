import asyncio
import json
import os
import re
import tempfile
import time
import wave
import inspect
import logging
import warnings
from dataclasses import dataclass
from typing import Optional

import websockets


DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8765
SAMPLE_RATE = 16000
CHANNELS = 1
SAMPLE_WIDTH_BYTES = 2  # int16


def _now_ms() -> int:
  return int(time.time() * 1000)


def _send_json(ws, payload: dict) -> "asyncio.Future[None]":
  return ws.send(json.dumps(payload))


def _write_wav(path: str, pcm_bytes: bytes) -> None:
  with wave.open(path, "wb") as wf:
    wf.setnchannels(CHANNELS)
    wf.setsampwidth(SAMPLE_WIDTH_BYTES)
    wf.setframerate(SAMPLE_RATE)
    wf.writeframes(pcm_bytes)


class ParakeetModel:
  def __init__(self, nemo_path: str):
    self._nemo_path = nemo_path
    self._model = None

  def load(self) -> None:
    try:
      import torch  # noqa: F401
      from nemo.collections.asr.models import ASRModel
    except Exception as e:
      raise RuntimeError(
        "Missing Python deps for Parakeet. Install parakeet_worker/requirements.txt. "
        f"Import error: {e}"
      ) from e

    from nemo.collections.asr.models import ASRModel

    # Reduce noisy logs from NeMo/Torch on Windows.
    logging.getLogger().setLevel(logging.ERROR)
    for name in ("nemo", "pytorch_lightning", "torch", "websockets"):
      logging.getLogger(name).setLevel(logging.ERROR)
    warnings.filterwarnings("ignore")

    self._model = ASRModel.restore_from(restore_path=self._nemo_path, map_location="cpu")

    try:
      self._model.eval()
    except Exception:
      pass

  def transcribe_wav(self, wav_path: str) -> str:
    if self._model is None:
      raise RuntimeError("Model not loaded")

    # NeMo's transcribe() signature varies by version; pass only supported kwargs.
    kwargs = {"batch_size": 1}
    try:
      sig = inspect.signature(self._model.transcribe)
      params = sig.parameters
      if "verbose" in params:
        kwargs["verbose"] = False
      if "return_hypotheses" in params:
        kwargs["return_hypotheses"] = False
      if "logprobs" in params:
        kwargs["logprobs"] = False
    except Exception:
      pass

    out = self._model.transcribe([wav_path], **kwargs)

    def extract_text(item) -> str:
      if item is None:
        return ""
      # Some configs return nested lists (e.g., n-best hypotheses)
      while isinstance(item, (list, tuple)) and len(item) > 0:
        item = item[0]
      # NeMo RNNT/TDT often returns Hypothesis objects.
      try:
        t = getattr(item, "text", None)
        if isinstance(t, str) and t:
          return t.strip()
      except Exception:
        pass

      # Fallback: parse Hypothesis repr for text='...' or text="..."
      try:
        s = item if isinstance(item, str) else str(item)
        if "Hypothesis(" in s and "text=" in s:
          m = re.search(r"text=(['\"])(.*?)\\1", s)
          if m:
            return (m.group(2) or "").strip()
      except Exception:
        pass

      if isinstance(item, dict) and "text" in item:
        return str(item.get("text") or "").strip()
      # Final fallback: if NeMo still returns a Hypothesis repr, parse it.
      s = item if isinstance(item, str) else str(item)
      if "Hypothesis(" in s and "text=" in s:
        m = re.search(r"text=(['\"])(.*?)\\1", s)
        if m:
          return (m.group(2) or "").strip()
      return s.strip()

    if not out:
      return ""
    if isinstance(out, (list, tuple)):
      return extract_text(out[0])
    return extract_text(out)


@dataclass
class StreamState:
  stream_id: str
  pcm: bytearray
  last_text: str


async def serve():
  port = int(os.environ.get("PARAKEET_WS_PORT", str(DEFAULT_PORT)))
  host = os.environ.get("PARAKEET_WS_HOST", DEFAULT_HOST)
  model_path = os.environ.get("PARAKEET_MODEL_PATH")
  if not model_path:
    raise SystemExit("PARAKEET_MODEL_PATH is required (path to .nemo)")

  model = ParakeetModel(model_path)
  print(f"[ParakeetWorker] Loading model: {model_path}")
  model.load()
  print("[ParakeetWorker] Model ready")

  async def handler(ws):
    await _send_json(ws, {"type": "status", "state": "ready"})
    active: Optional[StreamState] = None
    transcription_task: Optional[asyncio.Task] = None

    async def transcribe_loop():
      nonlocal active
      if active is None:
        return
      while active is not None:
        await asyncio.sleep(1.0)
        if active is None:
          return
        if len(active.pcm) < SAMPLE_RATE * SAMPLE_WIDTH_BYTES:  # < 1s audio
          continue

        try:
          with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            wav_path = tmp.name
          _write_wav(wav_path, bytes(active.pcm))
          text = model.transcribe_wav(wav_path)
        except Exception as e:
          await _send_json(ws, {"type": "error", "stream_id": active.stream_id, "message": str(e)})
          continue
        finally:
          try:
            os.unlink(wav_path)
          except Exception:
            pass

        if not text:
          continue

        # Only send updates if it changed, to reduce flicker.
        if text != active.last_text:
          active.last_text = text
          await _send_json(
            ws,
            {
              "type": "partial",
              "stream_id": active.stream_id,
              "text": text,
              "t_ms": _now_ms(),
            },
          )

    try:
      async for msg in ws:
        if isinstance(msg, (bytes, bytearray)):
          if active is not None:
            active.pcm.extend(msg)
          continue

        try:
          data = json.loads(msg)
        except Exception:
          continue

        msg_type = data.get("type")
        if msg_type == "hello":
          await _send_json(ws, {"type": "status", "state": "ready"})
        elif msg_type == "ping":
          await _send_json(ws, {"type": "pong", "t": data.get("t")})
        elif msg_type == "start_stream":
          stream_id = f"stream_{_now_ms()}"
          active = StreamState(stream_id=stream_id, pcm=bytearray(), last_text="")
          await _send_json(ws, {"type": "stream_started", "stream_id": stream_id})
          if transcription_task is None or transcription_task.done():
            transcription_task = asyncio.create_task(transcribe_loop())
        elif msg_type == "stop_stream":
          active = None
          await _send_json(ws, {"type": "stream_stopped"})
        elif msg_type == "reset_stream":
          if active is not None:
            # Keep last 3 seconds of audio for context continuity
            overlap_samples = SAMPLE_RATE * SAMPLE_WIDTH_BYTES * 3  # 3 seconds
            if len(active.pcm) > overlap_samples:
              active.pcm = active.pcm[-overlap_samples:]
            else:
              active.pcm = bytearray()  # Too short, reset completely
            active.last_text = ""
            await _send_json(ws, {"type": "stream_reset", "stream_id": active.stream_id})
        elif msg_type == "audio_begin":
          # No-op: one stream per socket; binary frames follow.
          pass
    finally:
      if transcription_task is not None:
        transcription_task.cancel()

  print(f"[ParakeetWorker] Listening on ws://{host}:{port}")
  async with websockets.serve(handler, host, port, max_size=None, ping_interval=None):
    await asyncio.Future()


if __name__ == "__main__":
  asyncio.run(serve())
