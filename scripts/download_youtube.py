import argparse
import json
import os
import re
import shutil
import sys
import argparse
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse
from typing import Any, Dict, Optional


MAX_DURATION_SECONDS = 60 * 60  # 1 hour cap


def sanitize_filename(name: str) -> str:
    name = (name or "").strip()
    name = re.sub(r"\s+", " ", name)
    # Keep Windows-safe characters similar to OriEngine.
    safe = "".join(c for c in name if c.isalnum() or c in (" ", ".", "_", "-"))
    safe = safe.strip().strip(".")
    return safe[:120] or "youtube_video"


def emit(payload: Dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def normalize_youtube_url(url: str) -> str:
    """
    Strip start-time parameters so yt_dlp downloads the full asset reliably.
    (The app will handle seeking on playback; batch processing needs the full file.)
    """
    try:
        u = urlparse(url)
        q = [(k, v) for (k, v) in parse_qsl(u.query, keep_blank_values=True) if k.lower() not in ("t", "start")]
        return urlunparse((u.scheme, u.netloc, u.path, u.params, urlencode(q), u.fragment))
    except Exception:
        return url


def find_ffmpeg_location() -> Optional[str]:
    for key in ("FFMPEG_EXE", "VIDEOCONTEXT_FFMPEG_EXE"):
        p = os.getenv(key)
        if p and os.path.exists(p):
            return p

    # Prefer qwen_worker shim if present
    repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    shim = os.path.join(repo_root, "qwen_worker", ".ffmpeg_shim", "ffmpeg.exe")
    if os.path.exists(shim):
        return shim

    found = shutil.which("ffmpeg")
    return found


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument(
        "--output-base",
        default="",
        help="Optional base filename (without extension) to force output naming (e.g. lecture_YYYYMMDD_HHMMSS_youtube).",
    )
    args = parser.parse_args()

    try:
        import yt_dlp  # type: ignore
    except Exception as e:
        emit(
            {
                "type": "error",
                "message": "Missing Python dependency 'yt-dlp'. Install it in .venv: pip install yt-dlp",
                "detail": str(e),
            }
        )
        return 2

    url = normalize_youtube_url(str(args.url).strip())
    out_dir = os.path.abspath(str(args.output_dir))
    os.makedirs(out_dir, exist_ok=True)

    def progress_hook(d: Dict[str, Any]) -> None:
        status = d.get("status")
        if status == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
            downloaded = d.get("downloaded_bytes") or 0
            pct: Optional[float] = None
            if total:
                try:
                    pct = float(downloaded) / float(total) * 100.0
                except Exception:
                    pct = None
            emit(
                {
                    "type": "progress",
                    "phase": "downloading",
                    "percent": pct,
                    "downloaded_bytes": downloaded,
                    "total_bytes": total,
                    "eta": d.get("eta"),
                    "speed": d.get("speed"),
                }
            )
        elif status == "finished":
            emit({"type": "progress", "phase": "finished", "filename": d.get("filename")})

    # Metadata first (duration check, title for filename).
    meta_opts = {
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
    }
    with yt_dlp.YoutubeDL(meta_opts) as ydl:
        info = ydl.extract_info(url, download=False)

    duration = info.get("duration") or 0
    if duration and float(duration) > MAX_DURATION_SECONDS:
        emit(
            {
                "type": "error",
                "message": f"Video too long: {int(duration)}s (max {MAX_DURATION_SECONDS}s)",
                "duration_s": float(duration),
            }
        )
        return 3

    title = sanitize_filename(info.get("title") or "youtube_video")
    video_id = sanitize_filename(info.get("id") or "id")
    forced_base = sanitize_filename(str(args.output_base or "").strip())
    if forced_base:
        outtmpl = os.path.join(out_dir, f"{forced_base}.%(ext)s")
    else:
        outtmpl = os.path.join(out_dir, f"{title}_{video_id}.%(ext)s")

    ffmpeg_loc = find_ffmpeg_location()

    ydl_opts = {
        # Prefer H.264/AAC for maximum Chromium compatibility (Electron frame extraction needs seeking/decoding).
        # Fallback to generic MP4, then best as last resort.
        "format": (
            "bv*[ext=mp4][vcodec^=avc1]+ba[ext=m4a][acodec^=mp4a]/"
            "bv*[ext=mp4]+ba[ext=m4a]/"
            "b[ext=mp4]/"
            "best"
        ),
        "outtmpl": outtmpl,
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "progress_hooks": [progress_hook],
        # Avoid Windows-invalid filenames from extractor.
        "windowsfilenames": True,
        "restrictfilenames": False,
        # Allow yt_dlp to merge formats (requires ffmpeg).
        "merge_output_format": "mp4",
    }
    if ffmpeg_loc:
        ydl_opts["ffmpeg_location"] = ffmpeg_loc

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info2 = ydl.extract_info(url, download=True)
            file_path = ydl.prepare_filename(info2)
    except Exception as e:
        emit(
            {
                "type": "error",
                "message": "yt_dlp download failed",
                "detail": str(e),
                "ffmpeg_found": bool(ffmpeg_loc),
                "ffmpeg_location": ffmpeg_loc or "",
            }
        )
        return 4

    file_path = os.path.abspath(file_path)
    try:
        size = os.path.getsize(file_path)
    except Exception:
        size = 0

    if not size:
        emit(
            {
                "type": "error",
                "message": "Downloaded file is empty",
                "file_path": file_path,
                "ffmpeg_found": bool(ffmpeg_loc),
                "ffmpeg_location": ffmpeg_loc or "",
            }
        )
        return 5

    emit(
        {
            "type": "done",
            "file_path": file_path,
            "file_name": os.path.basename(file_path),
            "title": title,
            "duration_s": float(duration or 0),
            "size": int(size),
            "output_base": forced_base or "",
        }
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
