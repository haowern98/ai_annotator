const { app } = require('electron');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const { spawn } = require('child_process');
const { setupRecordingHandlers } = require('./recording.cjs');

function resolveInside(root, p) {
  const resolvedRoot = path.resolve(root);
  const resolvedPath = path.resolve(p);
  if (resolvedPath === resolvedRoot) return resolvedPath;
  if (!resolvedPath.startsWith(resolvedRoot + path.sep)) {
    throw new Error('Path is not allowed');
  }
  return resolvedPath;
}

function getUserDataPath() {
  return app.getPath('userData');
}

function getRecordingsRootFallback() {
  // Keep this in sync with electron/ipc/recording.cjs default.
  return path.join(__dirname, '..', '..', '.recordings');
}

async function safeResolve(p) {
  const userData = getUserDataPath();
  const recordings = getRecordingsRootFallback();
  try {
    return resolveInside(userData, p);
  } catch {
    return resolveInside(recordings, p);
  }
}

function findFfmpegExe() {
  const fromEnv = process.env.FFMPEG_EXE || process.env.VIDEOCONTEXT_FFMPEG_EXE;
  if (fromEnv && fsSync.existsSync(fromEnv)) return fromEnv;

  // Prefer Qwen worker shim if present (created by qwen_worker/server.py on startup).
  const shim = path.join(__dirname, '..', '..', 'qwen_worker', '.ffmpeg_shim', 'ffmpeg.exe');
  if (fsSync.existsSync(shim)) return shim;

  // Fall back to system PATH.
  try {
    const { spawnSync } = require('child_process');
    const res = spawnSync('where', ['ffmpeg'], { encoding: 'utf8' });
    if (res.status === 0) {
      const first = String(res.stdout || '').split(/\r?\n/).find(Boolean);
      if (first && fsSync.existsSync(first.trim())) return first.trim();
    }
  } catch {
    // ignore
  }

  return null;
}

function findFfprobeExe() {
  const ffmpegExe = findFfmpegExe();
  if (ffmpegExe && typeof ffmpegExe === 'string' && /ffmpeg\.exe$/i.test(ffmpegExe)) {
    const candidate = ffmpegExe.replace(/ffmpeg\.exe$/i, 'ffprobe.exe');
    if (fsSync.existsSync(candidate)) return candidate;
  }

  // Try system PATH.
  try {
    const { spawnSync } = require('child_process');
    const res = spawnSync('where', ['ffprobe'], { encoding: 'utf8' });
    if (res.status === 0) {
      const first = String(res.stdout || '').split(/\r?\n/).find(Boolean);
      if (first && fsSync.existsSync(first.trim())) return first.trim();
    }
  } catch {
    // ignore
  }

  return null;
}

async function runFfmpeg(args) {
  const ffmpegExe = findFfmpegExe();
  if (!ffmpegExe) {
    throw new Error('ffmpeg not found (set FFMPEG_EXE or start qwen_worker first)');
  }

  return await new Promise((resolve, reject) => {
    const child = spawn(ffmpegExe, args, { windowsHide: true });
    let stderr = '';

    child.stderr.on('data', (buf) => {
      stderr = (stderr + String(buf)).slice(-4000);
    });

    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      if (code === 0) return resolve({ ok: true });
      reject(new Error(stderr || `ffmpeg exited with code ${code}`));
    });
  });
}

async function probeDurationMs(videoPath) {
  const input = String(videoPath || '').trim();
  if (!input) throw new Error('Missing videoPath');

  const errors = [];

  // Try method 1: Read format duration (fast, works for most files)
  const ffprobeExe = findFfprobeExe();
  if (ffprobeExe) {
    try {
      const seconds = await new Promise((resolve, reject) => {
        const child = spawn(
          ffprobeExe,
          [
            '-v',
            'error',
            '-show_entries',
            'format=duration',
            '-of',
            'default=noprint_wrappers=1:nokey=1',
            input,
          ],
          { windowsHide: true }
        );
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (buf) => {
          stdout += String(buf || '');
        });
        child.stderr.on('data', (buf) => {
          stderr += String(buf || '');
        });
        child.on('error', (err) => reject(err));
        child.on('close', (code) => {
          if (code !== 0) return reject(new Error(stderr || `ffprobe exited with code ${code}`));
          const s = Number(String(stdout || '').trim());
          if (!Number.isFinite(s) || s <= 0) return reject(new Error('Invalid format duration'));
          resolve(s);
        });
      });
      return Math.round(seconds * 1000);
    } catch (err1) {
      const msg1 = err1 instanceof Error ? err1.message : String(err1);
      errors.push(`Method 1 (format): ${msg1}`);
      console.log('[probeDurationMs] Method 1 failed:', msg1);
    }

    // Try method 2: Read stream duration (works for WebM without container duration)
    try {
      const seconds = await new Promise((resolve, reject) => {
        const child = spawn(
          ffprobeExe,
          [
            '-v',
            'error',
            '-select_streams',
            'v:0',
            '-show_entries',
            'stream=duration',
            '-of',
            'default=noprint_wrappers=1:nokey=1',
            input,
          ],
          { windowsHide: true }
        );
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (buf) => {
          stdout += String(buf || '');
        });
        child.stderr.on('data', (buf) => {
          stderr += String(buf || '');
        });
        child.on('error', (err) => reject(err));
        child.on('close', (code) => {
          if (code !== 0) return reject(new Error(stderr || `ffprobe stream probe exited with code ${code}`));
          const s = Number(String(stdout || '').trim());
          if (!Number.isFinite(s) || s <= 0) return reject(new Error('Invalid stream duration'));
          resolve(s);
        });
      });
      return Math.round(seconds * 1000);
    } catch (err2) {
      const msg2 = err2 instanceof Error ? err2.message : String(err2);
      errors.push(`Method 2 (stream): ${msg2}`);
      console.log('[probeDurationMs] Method 2 failed:', msg2);
    }
  }

  // Try method 3: parse ffmpeg -i stderr ("Duration: HH:MM:SS.xx")
  const ffmpegExe = findFfmpegExe();
  if (!ffmpegExe) {
    errors.push('Method 3 (ffmpeg): ffmpeg not found');
    console.log('[probeDurationMs] Method 3 failed: ffmpeg not found');
    throw new Error(`All duration methods failed: ${errors.join('; ')}`);
  }

  try {
    const ms = await new Promise((resolve, reject) => {
      const child = spawn(ffmpegExe, ['-hide_banner', '-i', input], { windowsHide: true });
      let stderr = '';
      child.stderr.on('data', (buf) => {
        stderr += String(buf || '');
        if (stderr.length > 20000) stderr = stderr.slice(-20000);
      });
      child.on('error', (err) => reject(err));
      child.on('close', () => {
        const m = stderr.match(/Duration:\s*(\d+):(\d{2}):(\d{2})(?:\.(\d+))?/);
        if (!m) return reject(new Error('Duration not found in ffmpeg output'));
        const hh = Number(m[1]);
        const mm = Number(m[2]);
        const ss = Number(m[3]);
        const frac = m[4] ? Number(`0.${m[4]}`) : 0;
        if (![hh, mm, ss].every(Number.isFinite)) return reject(new Error('Invalid Duration parse'));
        const totalMs = Math.round(((hh * 3600 + mm * 60 + ss) + frac) * 1000);
        resolve(totalMs);
      });
    });
    return ms;
  } catch (err3) {
    const msg3 = err3 instanceof Error ? err3.message : String(err3);
    errors.push(`Method 3 (ffmpeg): ${msg3}`);
    console.log('[probeDurationMs] Method 3 failed:', msg3);
    throw new Error(`All duration methods failed: ${errors.join('; ')}`);
  }
}

function setupFileUtilsHandlers(ipcMain) {
  // File helpers used by batch upload pipeline.
  ipcMain.handle('fs:getUserDataPath', async () => {
    return getUserDataPath();
  });

  ipcMain.handle('fs:copyFile', async (_event, srcPath, dstPath) => {
    const src = await safeResolve(srcPath);
    const dst = await safeResolve(dstPath);
    await fs.mkdir(path.dirname(dst), { recursive: true });
    await fs.copyFile(src, dst);
    return true;
  });

  ipcMain.handle('fs:renameFile', async (_event, srcPath, dstPath) => {
    const src = await safeResolve(srcPath);
    const dst = await safeResolve(dstPath);
    await fs.mkdir(path.dirname(dst), { recursive: true });
    await fs.rename(src, dst);
    return true;
  });

  ipcMain.handle('fs:writeBinary', async (_event, targetPath, base64) => {
    const p = await safeResolve(targetPath);
    const buf = Buffer.from(String(base64 || ''), 'base64');
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, buf);
    return true;
  });

  ipcMain.handle('fs:readBinary', async (_event, targetPath) => {
    const p = await safeResolve(targetPath);
    const buf = await fs.readFile(p);
    return buf.toString('base64');
  });

  ipcMain.handle('fs:writeFile', async (_event, targetPath, content) => {
    const p = await safeResolve(targetPath);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, String(content ?? ''), 'utf8');
    return true;
  });

  ipcMain.handle('fs:readFile', async (_event, targetPath) => {
    const p = await safeResolve(targetPath);
    return await fs.readFile(p, 'utf8');
  });

  ipcMain.handle('fs:deleteFile', async (_event, targetPath) => {
    const p = await safeResolve(targetPath);
    try {
      await fs.unlink(p);
      return true;
    } catch (err) {
      // Treat missing files as already-deleted to keep cleanup idempotent.
      if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return true;
      throw err;
    }
  });

  // Video helpers.
  ipcMain.handle('video:extractAudioFromVideo', async (_event, videoPath) => {
    const input = await safeResolve(videoPath);
    const outPath = path.join(getUserDataPath(), `audio_${Date.now()}.wav`);
    const output = await safeResolve(outPath);

    // WAV (PCM16LE), mono, 16 kHz.
    await runFfmpeg(['-y', '-i', input, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', output]);
    const st = await fs.stat(output);
    return { success: true, audioPath: output, size: st.size };
  });

  // Extract a time-sliced WAV segment from an existing WAV file.
  // Used to chunk long transcriptions without changing ASR segmentation.
  ipcMain.handle('audio:extractWavSegment', async (_event, wavPath, startSeconds, durationSeconds) => {
    const input = await safeResolve(wavPath);
    const start = Number(startSeconds ?? 0);
    const dur = Number(durationSeconds ?? 0);
    if (!Number.isFinite(start) || start < 0) throw new Error('Invalid startSeconds');
    if (!Number.isFinite(dur) || dur <= 0) throw new Error('Invalid durationSeconds');

    const outPath = path.join(getUserDataPath(), `audio_chunk_${Date.now()}_${Math.random().toString(36).slice(2)}.wav`);
    const output = await safeResolve(outPath);

    // Re-encode to a known format (PCM16LE), mono, 16 kHz.
    await runFfmpeg([
      '-y',
      '-ss',
      String(start),
      '-t',
      String(dur),
      '-i',
      input,
      '-ac',
      '1',
      '-ar',
      '16000',
      '-c:a',
      'pcm_s16le',
      output,
    ]);
    const st = await fs.stat(output);
    return { success: true, audioPath: output, size: st.size };
  });

  ipcMain.handle('video:convertVideoToWebM', async (_event, videoPath) => {
    const input = await safeResolve(videoPath);
    const outPath = path.join(getUserDataPath(), `video_${Date.now()}.webm`);
    const output = await safeResolve(outPath);

    // VP9 + Opus is widely supported by ffmpeg builds (including imageio-ffmpeg).
    await runFfmpeg([
      '-y',
      '-i',
      input,
      '-c:v',
      'libvpx-vp9',
      '-crf',
      '35',
      '-b:v',
      '0',
      '-c:a',
      'libopus',
      '-b:a',
      '64k',
      output,
    ]);
    const st = await fs.stat(output);
    return { success: true, outputPath: output, size: st.size };
  });

  // Remux a video in-place to improve seekability/duration metadata without re-encoding.
  // Primary use: MediaRecorder WebM chunks uploaded from remote overlay mode.
  ipcMain.handle('video:remuxInPlace', async (_event, videoPathRaw) => {
    const input = await safeResolve(videoPathRaw);
    const ext = path.extname(String(input || '')).toLowerCase();
    if (!ext) throw new Error('Missing file extension');

    const tmpOutPath = path.join(getUserDataPath(), `remux_${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`);
    const tmpOut = await safeResolve(tmpOutPath);

    try {
      // -fflags +genpts helps some timestamp edge cases; copy stream to avoid quality loss.
      await runFfmpeg(['-y', '-fflags', '+genpts', '-i', input, '-map', '0', '-c', 'copy', tmpOut]);
    } catch (e) {
      // Some WebM chunks can fail stream-copy; fall back to re-encode to a seekable WebM.
      if (ext === '.webm') {
        await runFfmpeg([
          '-y',
          '-i',
          input,
          '-c:v',
          'libvpx-vp9',
          '-crf',
          '35',
          '-b:v',
          '0',
          '-c:a',
          'libopus',
          '-b:a',
          '64k',
          tmpOut,
        ]);
      } else {
        throw e;
      }
    }

    // Replace original file atomically.
    try {
      await fs.rename(tmpOut, input);
    } catch (e) {
      // Windows rename across volumes can fail; fall back to copy+unlink.
      await fs.copyFile(tmpOut, input);
      await fs.unlink(tmpOut);
    }

    const st = await fs.stat(input);
    return { success: true, videoPath: input, fileSize: st.size };
  });

  // Get the duration of a video file in milliseconds (fast header probe).
  // Used by overlay mode to align transcript timestamps to the recorded media timeline.
  ipcMain.handle('video:getDurationMs', async (_event, videoPathRaw) => {
    try {
      const input = await safeResolve(videoPathRaw);
      const ms = await probeDurationMs(input);
      return { success: true, durationMs: ms };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error('[video:getDurationMs] Error:', errorMsg);
      return { success: false, error: errorMsg, durationMs: 0 };
    }
  });

  // Concatenate multiple WebM files into a single WebM using ffmpeg concat demuxer.
  // Requires identical codecs/params across inputs (true for chunks from one MediaRecorder session).
  ipcMain.handle('video:concatWebm', async (_event, inputPathsRaw, outputPathRaw) => {
    const inputsRaw = Array.isArray(inputPathsRaw) ? inputPathsRaw : [];
    if (inputsRaw.length === 0) throw new Error('Missing inputPaths');

    const outputRequested = String(outputPathRaw || '').trim();
    if (!outputRequested) throw new Error('Missing outputPath');

    const inputs = [];
    for (const p of inputsRaw) {
      const resolved = await safeResolve(String(p || '').trim());
      inputs.push(resolved);
    }
    const output = await safeResolve(outputRequested);

    // Create concat list file in userData (always writable).
    const listPath = path.join(getUserDataPath(), `concat_${Date.now()}_${Math.random().toString(36).slice(2)}.txt`);
    const listResolved = await safeResolve(listPath);

    // ffmpeg concat demuxer expects "file '<path>'" lines.
    const lines = inputs.map((p) => `file '${String(p).replace(/'/g, "'\\''")}'`).join('\n') + '\n';
    await fs.writeFile(listResolved, lines, 'utf8');

    try {
      await runFfmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', listResolved, '-c', 'copy', output]);
    } finally {
      try {
        await fs.unlink(listResolved);
      } catch {
        // ignore
      }
    }

    const st = await fs.stat(output);
    return { success: true, outputPath: output, size: st.size };
  });
}

module.exports = { setupFileUtilsHandlers };
