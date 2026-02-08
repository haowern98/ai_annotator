const http = require('http');
const path = require('path');
const fs = require('fs');
const fsp = require('fs').promises;
const { spawn, spawnSync } = require('child_process');

function safeDecodePath(p) {
  try {
    return decodeURIComponent(p);
  } catch {
    return p;
  }
}

function guessContentType(filePath) {
  const ext = String(path.extname(filePath) || '').toLowerCase();
  if (ext === '.html') return 'text/html; charset=utf-8';
  if (ext === '.css') return 'text/css; charset=utf-8';
  if (ext === '.js') return 'application/javascript; charset=utf-8';
  if (ext === '.map') return 'application/json; charset=utf-8';
  if (ext === '.svg') return 'image/svg+xml';
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.ico') return 'image/x-icon';
  if (ext === '.woff') return 'font/woff';
  if (ext === '.woff2') return 'font/woff2';
  if (ext === '.mp4') return 'video/mp4';
  if (ext === '.webm') return 'video/webm';
  return 'application/octet-stream';
}

function findFfmpegExe() {
  const fromEnv = process.env.FFMPEG_EXE || process.env.VIDEOCONTEXT_FFMPEG_EXE;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;

  const shim = path.join(__dirname, '..', '..', 'qwen_worker', '.ffmpeg_shim', 'ffmpeg.exe');
  if (fs.existsSync(shim)) return shim;

  try {
    const res = spawnSync('where', ['ffmpeg'], { encoding: 'utf8' });
    if (res.status === 0) {
      const first = String(res.stdout || '').split(/\r?\n/).find(Boolean);
      if (first && fs.existsSync(first.trim())) return first.trim();
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
    if (fs.existsSync(candidate)) return candidate;
  }

  try {
    const res = spawnSync('where', ['ffprobe'], { encoding: 'utf8' });
    if (res.status === 0) {
      const first = String(res.stdout || '').split(/\r?\n/).find(Boolean);
      if (first && fs.existsSync(first.trim())) return first.trim();
    }
  } catch {
    // ignore
  }

  return null;
}

async function probeDurationMs(videoPath) {
  const input = String(videoPath || '').trim();
  if (!input) throw new Error('Missing videoPath');

  const errors = [];
  const ffprobeExe = findFfprobeExe();
  if (ffprobeExe) {
    try {
      const seconds = await new Promise((resolve, reject) => {
        const child = spawn(
          ffprobeExe,
          ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', input],
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
      errors.push(`format: ${msg1}`);
    }

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
            'default=nw=1:nk=1',
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
      errors.push(`stream: ${msg2}`);
    }
  }

  const ffmpegExe = findFfmpegExe();
  if (!ffmpegExe) throw new Error(`ffmpeg not found; duration probe failed: ${errors.join('; ')}`);

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
        resolve(Math.round(((hh * 3600 + mm * 60 + ss) + frac) * 1000));
      });
    });
    return ms;
  } catch (err3) {
    const msg3 = err3 instanceof Error ? err3.message : String(err3);
    throw new Error(`All duration methods failed: ${errors.join('; ')}; ffmpeg: ${msg3}`);
  }
}

function formatLectureFromMetadata(rec, index, baseId) {
  const baseFromMetadataFile = String(baseId || '').trim().replace(/\.(json|webm|mp4)$/i, '');

  const rawVideoFilename =
    rec?.videoFilename ||
    (typeof rec?.videoPath === 'string' && rec.videoPath ? String(rec.videoPath).split(/[\\/]/).pop() || '' : '') ||
    '';

  // Extract filename without extension - support both .mp4 and .webm.
  const derivedFromVideo = rawVideoFilename ? rawVideoFilename.replace(/\.(webm|mp4)$/i, '') : '';

  // Prefer the metadata file base name for stable IDs (so /api/lectures/:id always maps to <id>.json).
  let filename = baseFromMetadataFile || derivedFromVideo || '';

  // If the filename isn't in the expected lecture_YYYYMMDD_HHMMSS format, fall back to savedAt (for display only).
  if ((!filename || String(filename).split('_')[1]?.length !== 8) && rec?.savedAt) {
    const d = new Date(rec.savedAt);
    if (!Number.isNaN(d.getTime())) {
      const yyyy = String(d.getFullYear());
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      const hh = String(d.getHours()).padStart(2, '0');
      const mi = String(d.getMinutes()).padStart(2, '0');
      const ss = String(d.getSeconds()).padStart(2, '0');
      filename = filename || `lecture_${yyyy}${mm}${dd}_${hh}${mi}${ss}`;
    }
  }

  if (!filename) {
    filename = `lecture_unknown_${index}`;
  }

  const titleParts = String(filename).split('_');
  const dateStr = titleParts[1] || '';
  const timeStr = titleParts[2] || '';

  // Format date: YYYYMMDD -> Mon DD, YYYY
  let formattedDate = 'Unknown Date';
  let formattedTime = 'Unknown Time';
  if (dateStr.length === 8) {
    const year = dateStr.substring(0, 4);
    const month = dateStr.substring(4, 6);
    const day = dateStr.substring(6, 8);
    const date = new Date(Number(year), Number(month) - 1, Number(day));
    formattedDate = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  // Format time: HHMMSS -> HH:MM AM/PM
  if (timeStr.length === 6) {
    const hours = Number(timeStr.substring(0, 2));
    const minutes = timeStr.substring(2, 4);
    const ampm = hours >= 12 ? 'PM' : 'AM';
    const displayHours = hours % 12 || 12;
    formattedTime = `${displayHours}:${minutes} ${ampm}`;
  }

  // Format duration: milliseconds -> Xh Ym or Xm Ys
  let formattedDuration = '0s';
  const durationMs = Number(rec?.duration || 0);
  if (Number.isFinite(durationMs) && durationMs > 0) {
    const totalSeconds = Math.floor(durationMs / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    if (hours > 0) formattedDuration = `${hours}h ${minutes}m`;
    else if (minutes > 0) formattedDuration = `${minutes}m ${seconds}s`;
    else formattedDuration = `${seconds}s`;
  }

  // Format file size: bytes -> MB
  const fileSize = Number(rec?.fileSize || 0);
  const fileSizeMB = fileSize > 0 ? (fileSize / 1024 / 1024).toFixed(2) : '0';

  // Format quality display
  let qualityDisplay = 'N/A';
  const qualityRaw = rec?.quality;
  if (qualityRaw) {
    if (qualityRaw === 'low') qualityDisplay = '480p';
    else if (qualityRaw === 'medium') qualityDisplay = '1280p';
    else if (qualityRaw === 'high') qualityDisplay = 'Original';
    else qualityDisplay = String(qualityRaw);
  }

  // Format last modified
  let lastModified;
  try {
    const savedDate = new Date(rec?.savedAt);
    if (!Number.isNaN(savedDate.getTime())) {
      lastModified =
        savedDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) +
        ' | ' +
        savedDate.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
    }
  } catch {
    // ignore
  }

  const hasVideo = Boolean(rec?.videoPath && fileSize > 0);

  const transcriptsArray = Array.isArray(rec?.transcripts) ? rec.transcripts : [];
  const summariesArray = Array.isArray(rec?.summaries) ? rec.summaries : [];

  const transcriptCount = Number.isFinite(Number(rec?.transcriptCount))
    ? Number(rec.transcriptCount)
    : transcriptsArray.length;

  const summaryCount = Number.isFinite(Number(rec?.summaryCount))
    ? Number(rec.summaryCount)
    : summariesArray.length;

  return {
    id: filename,
    title: `Lecture ${formattedDate}`,
    date: formattedDate,
    time: formattedTime,
    duration: formattedDuration,
    transcriptCount,
    summaryCount,
    recordingEnabled: hasVideo,
    quality: qualityDisplay,
    fileSize: `${fileSizeMB} MB`,
    lastModified,
  };
}

async function readJsonFile(filePath) {
  const text = await fsp.readFile(filePath, 'utf8');
  return JSON.parse(text);
}

function setupWebViewerHandlers(ipcMain, options) {
  const { getRecordingsDir, distDir: distDirOverride, defaultPort = 7558, sendToRenderer } = options || {};

  const state = {
    running: false,
    port: defaultPort,
    lastError: null,
  };

  let server = null;

  const transcode = {
    jobs: new Map(),
    queue: [],
    runningLectureId: null,
    runningChild: null,
  };

  const emitTranscodeEvent = (payload) => {
    if (typeof sendToRenderer !== 'function') return;
    try {
      sendToRenderer('webviewer:transcode', payload);
    } catch {
      // ignore
    }
  };

  const getDistDir = () => {
    if (distDirOverride) return distDirOverride;
    return path.join(__dirname, '..', '..', 'dist');
  };

  const getRecordingsDirResolved = () => {
    if (typeof getRecordingsDir === 'function') return getRecordingsDir();
    return path.join(__dirname, '..', '..', '.recordings');
  };

  const getTranscodeJobSummary = (job) => {
    const state = String(job?.state || 'idle');
    const cancelRequested = Boolean(job?.cancelRequested);
    const phase =
      state === 'queued'
        ? 'Queued'
        : state === 'running'
          ? cancelRequested
            ? 'Cancelling…'
            : 'Transcoding to MP4'
          : state === 'complete'
            ? 'Complete'
            : state === 'cancelled'
              ? 'Cancelled'
              : state === 'error'
                ? 'Error'
                : 'Idle';

    return {
      lectureId: String(job?.lectureId || ''),
      state,
      phase,
      percent: Number.isFinite(Number(job?.percent)) ? Number(job.percent) : 0,
      error: job?.error ? String(job.error) : null,
      updatedAt: Number(job?.updatedAt || Date.now()),
    };
  };

  const listTranscodeJobs = () => {
    return Array.from(transcode.jobs.values()).map(getTranscodeJobSummary);
  };

  const sendTranscodeUpdate = (job) => {
    const summary = getTranscodeJobSummary(job);
    emitTranscodeEvent({ type: 'update', job: summary });
  };

  const removeFromQueue = (lectureId) => {
    const id = String(lectureId || '').trim();
    if (!id) return;
    transcode.queue = transcode.queue.filter((x) => x !== id);
  };

  const resolveVideoPathForLecture = async (lectureId, rec) => {
    const recordingsDir = getRecordingsDirResolved();

    const candidates = [];
    if (rec?.videoFilename) candidates.push(String(rec.videoFilename));
    if (rec?.videoPath) candidates.push(String(rec.videoPath).split(/[\\/]/).pop() || '');
    candidates.push(`${lectureId}.webm`);

    for (const c of candidates) {
      const base = String(c || '').trim();
      if (!base) continue;
      const p = path.join(recordingsDir, path.basename(base));
      try {
        const st = await fsp.stat(p);
        if (st.isFile()) return p;
      } catch {
        // ignore
      }
    }

    return '';
  };

  const getMp4PathForLecture = (lectureId) => {
    const recordingsDir = getRecordingsDirResolved();
    return path.join(recordingsDir, `${lectureId}.mp4`);
  };

  const hasFile = async (filePath) => {
    try {
      const st = await fsp.stat(filePath);
      return st.isFile() && st.size > 0;
    } catch {
      return false;
    }
  };

  const startNextTranscode = () => {
    if (transcode.runningChild || transcode.runningLectureId) return;

    // Pick the next queued job in FIFO order.
    while (transcode.queue.length > 0) {
      const nextId = String(transcode.queue.shift() || '').trim();
      if (!nextId) continue;
      const job = transcode.jobs.get(nextId);
      if (!job || job.state !== 'queued') continue;
      void runTranscodeJob(job);
      return;
    }
  };

  const finalizeTranscodeJob = async (job, finalState, errorMessage) => {
    job.state = finalState;
    job.updatedAt = Date.now();
    if (errorMessage) job.error = String(errorMessage);

    if (finalState !== 'complete') {
      try {
        await fsp.unlink(job.outputPath);
      } catch {
        // ignore
      }
    }

    sendTranscodeUpdate(job);
  };

  const runTranscodeJob = async (job) => {
    const ffmpegExe = findFfmpegExe();
    if (!ffmpegExe) {
      await finalizeTranscodeJob(job, 'error', 'ffmpeg not found');
      startNextTranscode();
      return;
    }

    job.state = 'running';
    job.error = null;
    job.cancelRequested = false;
    job.percent = 0;
    job.updatedAt = Date.now();
    sendTranscodeUpdate(job);

    try {
      if (!Number.isFinite(Number(job.durationMs)) || job.durationMs <= 0) {
        job.durationMs = await probeDurationMs(job.inputPath);
      }
    } catch (e) {
      // Duration is only for progress percentage; allow transcode to proceed without it.
      job.durationMs = 0;
    }

    const recordingsDir = getRecordingsDirResolved();
    await fsp.mkdir(recordingsDir, { recursive: true });

    // Overwrite any partial output from a previous attempt.
    try {
      await fsp.unlink(job.outputPath);
    } catch {
      // ignore
    }

    const args = [
      '-hide_banner',
      '-y',
      '-i',
      job.inputPath,
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '23',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-movflags',
      '+faststart',
      '-progress',
      'pipe:1',
      '-nostats',
      job.outputPath,
    ];

    const child = spawn(ffmpegExe, args, { windowsHide: true });
    transcode.runningChild = child;
    transcode.runningLectureId = job.lectureId;

    let stdoutBuf = '';
    let stderrTail = '';
    let lastEmitAt = 0;

    const maybeEmitProgress = () => {
      const now = Date.now();
      if (now - lastEmitAt < 400) return;
      lastEmitAt = now;
      job.updatedAt = now;
      sendTranscodeUpdate(job);
    };

    child.stdout.on('data', (buf) => {
      stdoutBuf += String(buf || '');
      const lines = stdoutBuf.split(/\r?\n/);
      stdoutBuf = lines.pop() || '';

      for (const line of lines) {
        const idx = line.indexOf('=');
        if (idx <= 0) continue;
        const key = line.slice(0, idx).trim();
        const value = line.slice(idx + 1).trim();

        if (key === 'out_time_ms' || key === 'out_time_us') {
          const outMs = key === 'out_time_us' ? Math.floor(Number(value) / 1000) : Number(value);
          if (Number.isFinite(outMs) && outMs >= 0) {
            job.outTimeMs = outMs;
            if (Number.isFinite(Number(job.durationMs)) && job.durationMs > 0) {
              const pct = Math.max(0, Math.min(100, (outMs / job.durationMs) * 100));
              job.percent = Math.floor(pct);
            }
            maybeEmitProgress();
          }
        }

        if (key === 'progress' && value === 'end') {
          maybeEmitProgress();
        }
      }
    });

    child.stderr.on('data', (buf) => {
      stderrTail = (stderrTail + String(buf || '')).slice(-4000);
    });

    child.on('close', async (code) => {
      const wasCancelled = Boolean(job.cancelRequested);

      transcode.runningChild = null;
      transcode.runningLectureId = null;

      if (wasCancelled) {
        await finalizeTranscodeJob(job, 'cancelled');
        startNextTranscode();
        return;
      }

      if (code === 0 && (await hasFile(job.outputPath))) {
        job.percent = 100;
        await finalizeTranscodeJob(job, 'complete');
        startNextTranscode();
        return;
      }

      await finalizeTranscodeJob(job, 'error', stderrTail || `ffmpeg exited with code ${code}`);
      startNextTranscode();
    });

    child.on('error', async (err) => {
      transcode.runningChild = null;
      transcode.runningLectureId = null;
      await finalizeTranscodeJob(job, 'error', String(err?.message || err));
      startNextTranscode();
    });
  };

  const ensureTranscodeJob = async (lectureId, rec) => {
    const id = String(lectureId || '').trim();
    if (!id) return { success: false, error: 'Missing lecture id' };

    const outputPath = getMp4PathForLecture(id);
    if (await hasFile(outputPath)) {
      const existing = transcode.jobs.get(id);
      if (existing) {
        existing.state = 'complete';
        existing.percent = 100;
        existing.updatedAt = Date.now();
        sendTranscodeUpdate(existing);
      }
      return { success: true, job: { lectureId: id, state: 'complete', percent: 100, phase: 'Complete' } };
    }

    const existingJob = transcode.jobs.get(id);
    if (existingJob && (existingJob.state === 'queued' || existingJob.state === 'running')) {
      return { success: true, job: getTranscodeJobSummary(existingJob) };
    }

    const inputPath = await resolveVideoPathForLecture(id, rec);
    if (!inputPath || !String(inputPath).toLowerCase().endsWith('.webm')) {
      return { success: false, error: 'No WebM source found to transcode' };
    }

    const job = {
      lectureId: id,
      inputPath,
      outputPath,
      state: 'queued',
      percent: 0,
      durationMs: 0,
      outTimeMs: 0,
      cancelRequested: false,
      error: null,
      updatedAt: Date.now(),
    };

    transcode.jobs.set(id, job);
    removeFromQueue(id);
    transcode.queue.push(id);
    sendTranscodeUpdate(job);
    startNextTranscode();

    return { success: true, job: getTranscodeJobSummary(job) };
  };

  const cancelTranscodeJob = async (lectureId) => {
    const id = String(lectureId || '').trim();
    if (!id) return { success: false, error: 'Missing lecture id' };

    const job = transcode.jobs.get(id);
    if (!job) return { success: false, error: 'Job not found' };

    if (job.state === 'queued') {
      removeFromQueue(id);
      await finalizeTranscodeJob(job, 'cancelled');
      startNextTranscode();
      return { success: true };
    }

    if (job.state === 'running') {
      job.cancelRequested = true;
      job.updatedAt = Date.now();
      sendTranscodeUpdate(job);
      try {
        transcode.runningChild?.kill();
      } catch {
        // ignore
      }
      return { success: true };
    }

    return { success: true };
  };

  const respondJson = (res, statusCode, payload) => {
    res.writeHead(statusCode, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-cache',
    });
    res.end(JSON.stringify(payload));
  };

  const serveFile = async (res, filePath) => {
    const st = await fsp.stat(filePath);
    const ct = guessContentType(filePath);
    res.writeHead(200, {
      'Content-Type': ct,
      'Content-Length': String(st.size),
      'Cache-Control': ct.startsWith('text/html') ? 'no-cache' : 'public, max-age=3600',
    });
    fs.createReadStream(filePath).pipe(res);
  };

  const serveVideoWithRange = async (req, res, filePath) => {
    const st = await fsp.stat(filePath);
    const fileSize = st.size;
    const ct = guessContentType(filePath);

    const range = req.headers.range;
    if (!range) {
      res.writeHead(200, {
        'Content-Type': ct,
        'Content-Length': String(fileSize),
        'Accept-Ranges': 'bytes',
      });
      fs.createReadStream(filePath).pipe(res);
      return;
    }

    const m = String(range).match(/bytes=(\d+)-(\d*)/);
    if (!m) {
      res.writeHead(416, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Invalid Range');
      return;
    }

    const start = Number(m[1]);
    const end = m[2] ? Number(m[2]) : fileSize - 1;

    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start < 0 || end >= fileSize) {
      res.writeHead(416, {
        'Content-Range': `bytes */${fileSize}`,
      });
      res.end();
      return;
    }

    const chunkSize = end - start + 1;
    res.writeHead(206, {
      'Content-Type': ct,
      'Content-Length': String(chunkSize),
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
  };

  const handleApi = async (req, res, pathname) => {
    const method = String(req.method || '').toUpperCase();

    if (method === 'GET' && pathname === '/api/health') {
      respondJson(res, 200, { success: true, status: 'ok' });
      return;
    }

    if (method === 'GET' && pathname === '/api/lectures') {
      const recordingsDir = getRecordingsDirResolved();
      await fsp.mkdir(recordingsDir, { recursive: true });
      const files = await fsp.readdir(recordingsDir);

      const metadataFiles = files.filter((f) => {
        const name = String(f || '');
        const lower = name.toLowerCase();
        if (!lower.endsWith('.json')) return false;
        if (!lower.startsWith('lecture_')) return false;
        if (lower.endsWith('_words.json')) return false;
        if (lower.endsWith('_manifest.json')) return false;
        if (/_overlay_remote_chunk_\d{4}\.json$/i.test(name)) return false;
        return true;
      });

      const lecturesWithSortKey = [];
      for (let i = 0; i < metadataFiles.length; i++) {
        const filename = metadataFiles[i];
        const baseId = String(filename || '').replace(/\.json$/i, '');
        try {
          const metadataPath = path.join(recordingsDir, filename);
          const rec = await readJsonFile(metadataPath);
          const sortMs = Date.parse(String(rec?.savedAt || '')) || 0;
          lecturesWithSortKey.push({ lecture: formatLectureFromMetadata(rec, i, baseId), sortMs });
        } catch {
          // ignore broken entries
        }
      }

      lecturesWithSortKey.sort((a, b) => {
        if (b.sortMs !== a.sortMs) return b.sortMs - a.sortMs;
        return String(b.lecture.id).localeCompare(String(a.lecture.id));
      });

      respondJson(res, 200, { success: true, lectures: lecturesWithSortKey.map((x) => x.lecture) });
      return;
    }

    // /api/lectures/:id or /api/lectures/:id/video or /api/lectures/:id/transcode
    const lecturePrefix = '/api/lectures/';
    if (pathname.startsWith(lecturePrefix)) {
      const rest = pathname.slice(lecturePrefix.length);
      const [idRaw, sub] = rest.split('/').filter(Boolean);
      const lectureId = String(idRaw || '').trim();
      if (!lectureId) {
        respondJson(res, 400, { success: false, error: 'Missing lecture id' });
        return;
      }

      const recordingsDir = getRecordingsDirResolved();
      const metadataPath = path.join(recordingsDir, `${lectureId}.json`);

      let rec;
      try {
        rec = await readJsonFile(metadataPath);
      } catch {
        respondJson(res, 404, { success: false, error: 'Lecture not found' });
        return;
      }

      if (sub === 'transcode') {
        if (method === 'POST') {
          const result = await ensureTranscodeJob(lectureId, rec);
          respondJson(res, result.success ? 200 : 400, result);
          return;
        }

        if (method === 'DELETE') {
          const result = await cancelTranscodeJob(lectureId);
          respondJson(res, result.success ? 200 : 400, result);
          return;
        }

        if (method === 'GET') {
          const outputPath = getMp4PathForLecture(lectureId);
          const outputExists = await hasFile(outputPath);
          const job = transcode.jobs.get(lectureId);
          if (outputExists) {
            respondJson(res, 200, { success: true, job: { lectureId, state: 'complete', percent: 100, phase: 'Complete' } });
            return;
          }
          if (!job) {
            respondJson(res, 200, { success: true, job: { lectureId, state: 'idle', percent: 0, phase: 'Idle' } });
            return;
          }
          respondJson(res, 200, { success: true, job: getTranscodeJobSummary(job) });
          return;
        }

        respondJson(res, 405, { success: false, error: 'Method not allowed' });
        return;
      }

      if (sub === 'video') {
        if (method !== 'GET') {
          respondJson(res, 405, { success: false, error: 'Method not allowed' });
          return;
        }
        const candidates = [];
        // Prefer MP4 cache if present (Safari-friendly), then fall back to metadata candidates.
        // Do not serve the MP4 while it is actively being generated (it may be incomplete).
        const tj = transcode.jobs.get(lectureId);
        const mp4InProgress = tj && (tj.state === 'queued' || tj.state === 'running');
        if (!mp4InProgress) candidates.push(`${lectureId}.mp4`);
        if (rec?.videoFilename) candidates.push(String(rec.videoFilename));
        if (rec?.videoPath) candidates.push(String(rec.videoPath).split(/[\\/]/).pop() || '');
        candidates.push(`${lectureId}.webm`);

        let videoPath = '';
        for (const c of candidates) {
          const base = String(c || '').trim();
          if (!base) continue;
          const p = path.join(recordingsDir, path.basename(base));
          try {
            const st = await fsp.stat(p);
            if (st.isFile()) {
              videoPath = p;
              break;
            }
          } catch {
            // ignore
          }
        }

        if (!videoPath) {
          respondJson(res, 404, { success: false, error: 'Video not found' });
          return;
        }

        await serveVideoWithRange(req, res, videoPath);
        return;
      }

      if (sub) {
        respondJson(res, 404, { success: false, error: 'Not found' });
        return;
      }

      if (method !== 'GET') {
        respondJson(res, 405, { success: false, error: 'Method not allowed' });
        return;
      }

      const hasMp4 = await hasFile(path.join(recordingsDir, `${lectureId}.mp4`));
      const hasWebm = await hasFile(path.join(recordingsDir, `${lectureId}.webm`));

      const lecture = {
        ...formatLectureFromMetadata(rec, 0, lectureId),
        transcripts: Array.isArray(rec?.transcripts) ? rec.transcripts : [],
        summaries: Array.isArray(rec?.summaries) ? rec.summaries : [],
        hasVideo: Boolean(rec?.videoPath && Number(rec?.fileSize || 0) > 0),
        hasMp4,
        hasWebm,
      };

      respondJson(res, 200, { success: true, lecture });
      return;
    }

    respondJson(res, 404, { success: false, error: 'Not found' });
  };

  const handleStatic = async (req, res, pathname) => {
    const distDir = getDistDir();
    const distRoot = path.resolve(distDir);

    const send404 = () => {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
    };

    // Map "/" -> webviewer.html
    let rel = pathname === '/' ? 'webviewer.html' : pathname.replace(/^\//, '');
    if (!rel) rel = 'webviewer.html';

    // SPA fallback: if the request doesn't look like a file, serve webviewer.html.
    if (!path.extname(rel) && !rel.startsWith('api/')) {
      rel = 'webviewer.html';
    }

    const filePath = path.resolve(path.join(distRoot, rel));
    if (!filePath.startsWith(distRoot + path.sep) && filePath !== distRoot) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Forbidden');
      return;
    }

    try {
      const st = await fsp.stat(filePath);
      if (!st.isFile()) return send404();
      await serveFile(res, filePath);
    } catch {
      // If webviewer.html doesn't exist (e.g., dev without build), return a helpful message.
      if (rel === 'webviewer.html') {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Web viewer UI not built. Run `npm run build` and try again.');
        return;
      }
      send404();
    }
  };

  const start = async (portOverride) => {
    if (server) return { success: true, port: state.port };

    const port = Number(portOverride ?? state.port ?? defaultPort);
    if (!Number.isFinite(port) || port <= 0) return { success: false, error: 'Invalid port' };

    state.port = port;
    state.lastError = null;

    server = http.createServer(async (req, res) => {
      const method = String(req.method || '').toUpperCase();
      const urlObj = new URL(String(req.url || ''), 'http://127.0.0.1');
      const pathname = safeDecodePath(urlObj.pathname || '/');

      try {
        if (method === 'GET' && (pathname === '/health' || pathname === '/webviewer/health')) {
          respondJson(res, 200, { success: true, status: 'ok', port });
          return;
        }

        if (pathname.startsWith('/api/')) {
          await handleApi(req, res, pathname);
          return;
        }

        await handleStatic(req, res, pathname);
      } catch (e) {
        state.lastError = String(e?.message || e);
        respondJson(res, 500, { success: false, error: state.lastError });
      }
    });

    return await new Promise((resolve) => {
      server.on('error', (err) => {
        state.lastError = String(err?.message || err);
        try {
          server.close();
        } catch {
          // ignore
        }
        server = null;
        state.running = false;
        resolve({ success: false, error: state.lastError });
      });

      server.listen(port, '0.0.0.0', () => {
        state.running = true;
        resolve({ success: true, port });
      });
    });
  };

  const stop = async () => {
    if (!server) {
      state.running = false;
      return { success: true };
    }

    const srv = server;
    server = null;

    return await new Promise((resolve) => {
      try {
        srv.close(() => {
          state.running = false;
          resolve({ success: true });
        });
      } catch (e) {
        state.running = false;
        resolve({ success: false, error: String(e?.message || e) });
      }
    });
  };

  const status = () => ({ success: true, ...state });

  ipcMain.handle('webviewer:start', async (_event, portOverride) => {
    return await start(portOverride);
  });

  ipcMain.handle('webviewer:stop', async () => {
    return await stop();
  });

  ipcMain.handle('webviewer:status', async () => {
    return status();
  });

  ipcMain.handle('webviewer:transcodeList', async () => {
    return { success: true, jobs: listTranscodeJobs() };
  });

  ipcMain.handle('webviewer:transcodeCancel', async (_event, lectureId) => {
    return await cancelTranscodeJob(lectureId);
  });

  return { start, stop, status };
}

module.exports = { setupWebViewerHandlers };
