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

function setupFileUtilsHandlers(ipcMain) {
  // File helpers used by batch upload pipeline.
  ipcMain.handle('fs:getUserDataPath', async () => {
    return getUserDataPath();
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
}

module.exports = { setupFileUtilsHandlers };
