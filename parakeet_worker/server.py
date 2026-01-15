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
DEFAULT_SEGMENT_SECONDS = 5.0


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

  def transcribe_wav_words(self, wav_path: str) -> dict:
    if self._model is None:
      raise RuntimeError("Model not loaded")

    kwargs = {"batch_size": 1}
    try:
      sig = inspect.signature(self._model.transcribe)
      params = sig.parameters
      if "verbose" in params:
        kwargs["verbose"] = False
      if "return_hypotheses" in params:
        kwargs["return_hypotheses"] = True
      if "timestamps" in params:
        kwargs["timestamps"] = True
      if "return_timestamps" in params:
        kwargs["return_timestamps"] = True
      if "compute_timestamps" in params:
        kwargs["compute_timestamps"] = True
      if "logprobs" in params:
        kwargs["logprobs"] = False
    except Exception:
      # Best effort: at least request hypotheses.
      kwargs["return_hypotheses"] = True

    out = self._model.transcribe([wav_path], **kwargs)
    if not out:
      return {"text": "", "words": []}

    hyp = out[0] if isinstance(out, (list, tuple)) else out
    while isinstance(hyp, (list, tuple)) and len(hyp) > 0:
      hyp = hyp[0]

    text = ""
    try:
      t = getattr(hyp, "text", None)
      if isinstance(t, str):
        text = t.strip()
    except Exception:
      pass
    if not text:
      # Fallback to existing robust text extraction.
      text = self.transcribe_wav(wav_path)

    def add_word(words, w, start, end):
      try:
        words.append({"w": str(w), "start": float(start), "end": float(end)})
      except Exception:
        pass

    words = []
    ts = None
    for attr in ("word_timestamps", "timestamps", "timestamp", "word_ts"):
      try:
        v = getattr(hyp, attr, None)
        if v:
          ts = v
          break
      except Exception:
        pass

    # Common NeMo shapes:
    # - dict with "word" -> list of (word, start, end)
    # - list of tuples (word, start, end)
    # - list of dicts {word,start,end}
    if isinstance(ts, dict):
      for key in ("word", "words", "word_timestamps"):
        v = ts.get(key)
        if v:
          ts = v
          break

    if isinstance(ts, (list, tuple)):
      for item in ts:
        if isinstance(item, dict):
          w = item.get("word") or item.get("w")
          if w is None:
            continue
          start = item.get("start") or item.get("start_time") or item.get("s")
          end = item.get("end") or item.get("end_time") or item.get("e")
          if start is None or end is None:
            continue
          add_word(words, w, start, end)
        elif isinstance(item, (list, tuple)) and len(item) >= 3:
          add_word(words, item[0], item[1], item[2])

    if not words and text:
      # As a last resort, provide word list without timing so callers can fail loudly.
      # (We don't fake timing here because the user explicitly wants word timestamps.)
      raise RuntimeError("Word timestamps not available from model output")

    return {"text": text, "words": words}


def _read_wav_duration_s(wav_path: str) -> float:
  with wave.open(wav_path, "rb") as wf:
    frames = wf.getnframes()
    rate = wf.getframerate() or SAMPLE_RATE
    return float(frames) / float(rate)


def _segments_from_words_fixed(words: list, duration_s: float, segment_s: float) -> list:
  segment_s = max(1.0, float(segment_s))
  n = int((duration_s + segment_s - 1e-9) // segment_s) + 1
  segments = []
  for k in range(n):
    start = k * segment_s
    end = min((k + 1) * segment_s, duration_s)
    if end <= start:
      break
    seg_words = []
    for w in words:
      try:
        ws = float(w.get("start", 0.0))
        we = float(w.get("end", 0.0))
      except Exception:
        continue
      if we >= start and ws < end:
        seg_words.append(str(w.get("w") or "").strip())
    text = " ".join([x for x in seg_words if x]).strip()
    segments.append({"start": float(start), "end": float(end), "text": text, "is_final": True})
  # Ensure at least one segment exists.
  if not segments:
    segments.append({"start": 0.0, "end": float(duration_s), "text": "", "is_final": True})
  return segments

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
        elif msg_type == "batch_transcribe":
          # Batch transcription with word timestamps (offline/batch mode).
          wav_path = str(data.get("wav_path") or "").strip()
          segment_seconds = float(data.get("segment_seconds") or DEFAULT_SEGMENT_SECONDS)
          if not wav_path:
            await _send_json(ws, {"type": "error", "message": "wav_path is required"})
            continue
          try:
            duration_s = _read_wav_duration_s(wav_path)
            result = model.transcribe_wav_words(wav_path)
            segments = _segments_from_words_fixed(result.get("words") or [], duration_s, segment_seconds)
            await _send_json(
              ws,
              {
                "type": "batch_result",
                "ok": True,
                "duration_s": duration_s,
                "text": result.get("text") or "",
                "words": result.get("words") or [],
                "segments": segments,
              },
            )
          except Exception as e:
            await _send_json(ws, {"type": "batch_result", "ok": False, "error": str(e)})
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
