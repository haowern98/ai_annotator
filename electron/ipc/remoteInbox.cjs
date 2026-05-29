const http = require('http');
const path = require('path');
const fs = require('fs');
const fsp = require('fs').promises;
const { spawn } = require('child_process');

function readRequestBody(req, maxBytes = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];

    req.on('data', (buf) => {
      total += buf.length;
      if (total > maxBytes) {
        reject(new Error('Request body too large'));
        try {
          req.destroy();
        } catch {
          // ignore
        }
        return;
      }
      chunks.push(buf);
    });
    req.on('error', (e) => reject(e));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

function generateFilename() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  return `lecture_${year}${month}${day}_${hours}${minutes}${seconds}`;
}

function sanitizeFilename(name) {
  const raw = String(name || '').trim();
  const base = raw.split(/[\\/]/).pop() || 'video';
  const safe = base.replace(/[^\w.\- ]+/g, '').trim().slice(0, 140);
  return safe || 'video';
}

function sanitizeBaseFilename(name) {
  const raw = String(name || '').trim();
  const base = raw.split(/[\\/]/).pop() || '';
  const safe = base.replace(/[^\w.\- ]+/g, '').trim().slice(0, 180);
  return safe || generateFilename();
}

function guessContentType(filePath) {
  const lower = String(filePath || '').toLowerCase();
  if (lower.endsWith('.mp4')) return 'video/mp4';
  if (lower.endsWith('.webm')) return 'video/webm';
  if (lower.endsWith('.json')) return 'application/json; charset=utf-8';
  return 'application/octet-stream';
}

function metaPathForId(dir, baseId) {
  const safe = String(baseId || '').trim().replace(/\.(json|webm|mp4)$/i, '');
  return path.join(dir, `${safe}.meta.json`);
}

function sanitizeTitle(title) {
  const t = String(title ?? '').trim().replace(/\s+/g, ' ');
  if (!t) return null;
  return t.slice(0, 80);
}

async function readTitleOverride(dir, baseId) {
  const p = metaPathForId(dir, baseId);
  try {
    const content = await fsp.readFile(p, 'utf8');
    const obj = JSON.parse(content);
    return sanitizeTitle(obj?.title);
  } catch {
    return null;
  }
}

async function readJsonFile(filePath) {
  const content = await fsp.readFile(filePath, 'utf8');
  return JSON.parse(content);
}

function baseNameNoExt(p) {
  const b = path.basename(String(p || ''));
  return b.replace(/\.(json|webm|mp4)$/i, '');
}

function jobMatchesLectureId(job, lectureId) {
  const id = String(lectureId || '').trim();
  if (!id) return false;

  const overlayBase = String(job?.overlayBase || '').trim();
  if (overlayBase && overlayBase === id) return true;

  const metadataPath = String(job?.metadataPath || '').trim();
  if (metadataPath && baseNameNoExt(metadataPath) === id) return true;

  const savedVideoPath = String(job?.savedVideoPath || '').trim();
  if (savedVideoPath) {
    const bn = path.basename(savedVideoPath);
    if (baseNameNoExt(bn) === id) return true;
    if (bn.startsWith(`${id}_chunk_`) || bn === `${id}_manifest.json`) return true;
  }

  const storedFileName = String(job?.storedFileName || '').trim();
  if (storedFileName) {
    if (baseNameNoExt(storedFileName) === id) return true;
    if (storedFileName.startsWith(`${id}_chunk_`) || storedFileName === `${id}_manifest.json`) return true;
  }

  return false;
}

function isTerminalJobState(stateRaw) {
  const s = String(stateRaw || '').trim().toLowerCase();
  return s === 'complete' || s === 'error';
}

async function safeRemovePath(targetPath) {
  const p = String(targetPath || '').trim();
  if (!p) return false;
  try {
    await fsp.rm(p, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

async function serveVideoWithRange(req, res, filePath) {
  const st = await fsp.stat(filePath);
  const fileSize = st.size;
  const ct = guessContentType(filePath);
  const method = String(req.method || '').toUpperCase();
  const isHead = method === 'HEAD';

  const range = req.headers.range;
  if (!range) {
    res.writeHead(200, {
      'Content-Type': ct,
      'Content-Length': String(fileSize),
      'Accept-Ranges': 'bytes',
    });
    if (isHead) {
      res.end();
      return;
    }
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  const failRange = (message) => {
    res.writeHead(416, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Range': `bytes */${fileSize}`,
      'Accept-Ranges': 'bytes',
    });
    if (isHead) {
      res.end();
      return;
    }
    res.end(String(message || 'Range Not Satisfiable'));
  };

  // Support "bytes=start-end", "bytes=start-" and Safari-style suffix ranges "bytes=-N".
  const raw = String(range || '').split(',')[0].trim().replace(/\s+/g, '');
  let start = null;
  let end = null;

  let m = raw.match(/^bytes=(\d+)-(\d*)$/i);
  if (m) {
    start = Number(m[1]);
    end = m[2] ? Number(m[2]) : fileSize - 1;
  } else {
    m = raw.match(/^bytes=-(\d+)$/i);
    if (m) {
      const suffixLen = Number(m[1]);
      if (!Number.isFinite(suffixLen) || suffixLen <= 0) {
        failRange('Invalid Range');
        return;
      }
      start = Math.max(0, fileSize - suffixLen);
      end = fileSize - 1;
    }
  }

  if (!Number.isFinite(start) || !Number.isFinite(end) || start === null || end === null) {
    failRange('Invalid Range');
    return;
  }

  if (end >= fileSize) end = fileSize - 1;

  if (start < 0 || start >= fileSize || end < 0 || start > end) {
    failRange('Range Not Satisfiable');
    return;
  }

  const chunkSize = end - start + 1;
  res.writeHead(206, {
    'Content-Type': ct,
    'Content-Length': String(chunkSize),
    'Content-Range': `bytes ${start}-${end}/${fileSize}`,
    'Accept-Ranges': 'bytes',
  });
  if (isHead) {
    res.end();
    return;
  }
  fs.createReadStream(filePath, { start, end }).pipe(res);
}

function safeExtFromName(name) {
  const n = String(name || '').toLowerCase().trim();
  const ext = path.extname(n);
  if (!ext) return '.mp4';
  if (!/^\.[a-z0-9]{1,6}$/.test(ext)) return '.mp4';
  return ext;
}

function parseClientIp(req) {
  // If behind a proxy, X-Forwarded-For may be present; otherwise fall back to socket address.
  const xff = req.headers['x-forwarded-for'];
  const first = Array.isArray(xff) ? xff[0] : xff;
  const fromHeader = String(first || '').split(',')[0].trim();
  const fromSocket = req.socket?.remoteAddress || '';
  const ip = fromHeader || fromSocket || '';
  return ip.replace(/^::ffff:/, '');
}

function findFfmpegExe() {
  const fromEnv = process.env.FFMPEG_EXE || process.env.VIDEOCONTEXT_FFMPEG_EXE;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;

  const shim = path.join(__dirname, '..', '..', 'qwen_worker', '.ffmpeg_shim', 'ffmpeg.exe');
  if (fs.existsSync(shim)) return shim;

  try {
    const { spawnSync } = require('child_process');
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

async function runFfmpeg(args) {
  const ffmpegExe = findFfmpegExe();
  if (!ffmpegExe) throw new Error('ffmpeg not found');

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

async function concatWebmFiles(recordingsDir, inputPaths, outputPath) {
  if (!Array.isArray(inputPaths) || inputPaths.length === 0) throw new Error('Missing inputPaths');
  const out = String(outputPath || '').trim();
  if (!out) throw new Error('Missing outputPath');

  const listPath = path.join(recordingsDir, `concat_${Date.now()}_${Math.random().toString(36).slice(2)}.txt`);
  const lines = inputPaths.map((p) => `file '${String(p).replace(/'/g, "'\\''")}'`).join('\n') + '\n';
  await fsp.writeFile(listPath, lines, 'utf8');
  try {
    await runFfmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', out]);
  } finally {
    try {
      await fsp.unlink(listPath);
    } catch {
      // ignore
    }
  }
}

function getVenvPythonPath() {
  const repoRoot = path.join(__dirname, '..', '..');
  const venvPython = path.join(repoRoot, '.venv', 'Scripts', 'python.exe');
  if (fs.existsSync(venvPython)) return venvPython;
  return 'python';
}

function scriptPathDownloadYouTube() {
  return path.join(__dirname, '..', '..', 'scripts', 'download_youtube.py');
}

function setupRemoteInboxHandlers(ipcMain, options) {
  const {
    getRecordingsDir,
    sendToRenderer,
    defaultPort = 7557,
  } = options || {};

  // Job tracking for remote uploads. Keyed by jobId (provided by client).
  // Used by clients to poll status and fetch final metadata JSON.
  const jobs = new Map();

  const state = {
    running: false,
    port: defaultPort,
    active: false,
    clientIp: null,
    fileName: null,
    receivedBytes: 0,
    totalBytes: 0,
    progressPercent: 0,
    lastError: null,
    savedPath: null,
    updatedAt: 0,
  };

  let server = null;

  const broadcast = () => {
    state.updatedAt = Date.now();
    try {
      sendToRenderer?.('inbox:activity', { ...state });
    } catch {
      // ignore
    }
  };

  const setState = (partial) => {
    Object.assign(state, partial);
    broadcast();
  };

  const reset = () => {
    setState({
      active: false,
      clientIp: null,
      fileName: null,
      receivedBytes: 0,
      totalBytes: 0,
      progressPercent: 0,
      lastError: null,
      savedPath: null,
    });
  };

  const start = async (portOverride) => {
    if (server) return { success: true, port: state.port };
    const port = Number(portOverride ?? state.port ?? defaultPort);
    if (!Number.isFinite(port) || port <= 0) return { success: false, error: 'Invalid port' };

    const recordingsDir = typeof getRecordingsDir === 'function' ? getRecordingsDir() : null;
    if (!recordingsDir) return { success: false, error: 'Recordings directory not available' };

    await fsp.mkdir(recordingsDir, { recursive: true });

    server = http.createServer(async (req, res) => {
      try {
        const method = String(req.method || '').toUpperCase();
        const url = String(req.url || '');
        const pathname = url.split('?')[0];

        if (method === 'GET' && (pathname === '/inbox/health' || pathname === '/health')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok', service: 'remote_inbox', port }));
          return;
        }

        // Auth removed (remote inbox and library are currently unauthenticated).

        // Remote library mutations: set title (display-only) and delete lecture.
        if (pathname.startsWith('/library/lectures/')) {
          const rest = pathname.slice('/library/lectures/'.length);
          const parts = rest.split('/').filter(Boolean);
          const lectureId = decodeURIComponent(parts[0] || '').trim().replace(/\.(json|webm|mp4)$/i, '');
          const sub = parts[1] || '';

          // POST /library/lectures/:lectureId/title { title }
          if (lectureId && method === 'POST' && sub === 'title') {
            try {
              const body = await readRequestBody(req, 64 * 1024);
              const parsed = JSON.parse(String(body || ''));
              const title = sanitizeTitle(parsed?.title);
              if (!title) {
                res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ success: false, error: 'Missing title' }));
                return;
              }

              const metadataPath = path.join(recordingsDir, `${lectureId}.json`);
              try {
                await fsp.stat(metadataPath);
              } catch {
                res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ success: false, error: 'Lecture not found' }));
                return;
              }

              const metaPath = metaPathForId(recordingsDir, lectureId);
              await fsp.writeFile(metaPath, JSON.stringify({ title }, null, 2), 'utf8');
              res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
              res.end(JSON.stringify({ success: true }));
              return;
            } catch (e) {
              res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
              res.end(JSON.stringify({ success: false, error: String(e.message || e) }));
              return;
            }
          }

          // DELETE /library/lectures/:lectureId
          if (lectureId && method === 'DELETE' && !sub) {
            try {
              // Block deletion while processing.
              for (const job of jobs.values()) {
                if (!jobMatchesLectureId(job, lectureId)) continue;
                if (!isTerminalJobState(job?.state)) {
                  res.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
                  res.end(JSON.stringify({ success: false, error: "Can't delete while processing" }));
                  return;
                }
              }

              const metadataPath = path.join(recordingsDir, `${lectureId}.json`);
              let metadata = null;
              try {
                metadata = await readJsonFile(metadataPath);
              } catch {
                res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ success: false, error: 'Lecture not found' }));
                return;
              }

              const targets = new Set();
              targets.add(path.join(recordingsDir, `${lectureId}.json`));
              targets.add(path.join(recordingsDir, `${lectureId}_words.json`));
              targets.add(metaPathForId(recordingsDir, lectureId));
              targets.add(path.join(recordingsDir, `${lectureId}.mp4`));
              targets.add(path.join(recordingsDir, `${lectureId}.webm`));
              targets.add(path.join(recordingsDir, `${lectureId}_manifest.json`));
              targets.add(path.join(recordingsDir, `${lectureId}_index`));

              const idxDir = String(metadata?.embeddingIndex?.indexDir || '').trim();
              if (idxDir) {
                try {
                  const resolvedRecordings = path.resolve(recordingsDir);
                  const resolvedIdx = path.resolve(idxDir);
                  if (resolvedIdx.startsWith(resolvedRecordings)) targets.add(resolvedIdx);
                } catch {
                  // ignore
                }
              }

              // Remove overlay chunk artifacts (if any).
              try {
                const files = await fsp.readdir(recordingsDir);
                for (const name of files) {
                  if (!name) continue;
                  if (name.startsWith(`${lectureId}_chunk_`)) {
                    targets.add(path.join(recordingsDir, name));
                  } else if (name.startsWith(`${lectureId}_`) && /\.(mp4|webm)$/i.test(name)) {
                    targets.add(path.join(recordingsDir, name));
                  }
                }
              } catch {
                // ignore
              }

              let removedCount = 0;
              for (const p of targets) {
                const ok = await safeRemovePath(p);
                if (ok) removedCount += 1;
              }

              res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
              res.end(JSON.stringify({ success: true, removedCount }));
              return;
            } catch (e) {
              res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
              res.end(JSON.stringify({ success: false, error: String(e.message || e) }));
              return;
            }
          }
        }

        // Remote library (server is the source of truth): list and serve recordings from this PC.
        if (method === 'GET' && (pathname === '/library/lectures' || pathname === '/library/recordings')) {
          try {
            const files = await fsp.readdir(recordingsDir);
            const metadataFiles = files.filter((f) => {
              const name = String(f || '');
              const lower = name.toLowerCase();
              if (!lower.endsWith('.json')) return false;
              if (lower.endsWith('.meta.json')) return false;
              if (lower.endsWith('_words.json')) return false;
              if (lower.endsWith('_manifest.json')) return false;
              if (/_overlay_remote_chunk_\d{4}\.json$/i.test(name)) return false;
              return true;
            });

            const recordings = [];
            for (const filename of metadataFiles) {
              const metadataPath = path.join(recordingsDir, filename);
              try {
                const rec = await readJsonFile(metadataPath);
                const baseId = String(filename || '').replace(/\.json$/i, '');
                const userTitle = await readTitleOverride(recordingsDir, baseId);
                if (userTitle) rec.userTitle = userTitle;
                recordings.push(rec);
              } catch (e) {
                console.warn('[RemoteInbox] Failed to read metadata:', filename, e?.message || e);
              }
            }

            recordings.sort((a, b) => (Date.parse(String(b?.savedAt || '')) || 0) - (Date.parse(String(a?.savedAt || '')) || 0));
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
            res.end(JSON.stringify({ success: true, recordings }));
            return;
          } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ success: false, error: String(e.message || e) }));
            return;
          }
        }

        if (method === 'GET' && pathname.startsWith('/library/lectures/')) {
          const rest = pathname.slice('/library/lectures/'.length);
          const parts = rest.split('/').filter(Boolean);
          const lectureId = decodeURIComponent(parts[0] || '').trim().replace(/\.(json|webm|mp4)$/i, '');
          const sub = parts[1] || 'meta';
          if (!lectureId) {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ success: false, error: 'Missing lectureId' }));
            return;
          }

          if (sub === 'meta') {
            try {
              const metadataPath = path.join(recordingsDir, `${lectureId}.json`);
              const rec = await readJsonFile(metadataPath);
              const userTitle = await readTitleOverride(recordingsDir, lectureId);
              if (userTitle) rec.userTitle = userTitle;
              res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
              res.end(JSON.stringify({ success: true, metadata: rec }));
              return;
            } catch (e) {
              res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
              res.end(JSON.stringify({ success: false, error: 'Metadata not found' }));
              return;
            }
          }

          if (sub === 'words') {
            try {
              const wordsPath = path.join(recordingsDir, `${lectureId}_words.json`);
              const content = await fsp.readFile(wordsPath, 'utf8');
              res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
              res.end(content);
              return;
            } catch {
              res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
              res.end(JSON.stringify({ success: false, error: 'Words not found' }));
              return;
            }
          }

          if (sub === 'video') {
            try {
              const mp4 = path.join(recordingsDir, `${lectureId}.mp4`);
              const webm = path.join(recordingsDir, `${lectureId}.webm`);
              let videoPath = '';
              try {
                await fsp.stat(mp4);
                videoPath = mp4;
              } catch {
                await fsp.stat(webm);
                videoPath = webm;
              }
              await serveVideoWithRange(req, res, videoPath);
              return;
            } catch {
              res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
              res.end(JSON.stringify({ success: false, error: 'Video not found' }));
              return;
            }
          }
        }

        // Client polling: get status
        if (method === 'GET' && pathname.startsWith('/inbox/status/')) {
          const jobId = decodeURIComponent(pathname.slice('/inbox/status/'.length)).trim();
          const job = jobs.get(jobId);
          if (!job) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Job not found' }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, jobId, status: job }));
          return;
        }

        // Client polling: fetch final metadata JSON
        if (method === 'GET' && pathname.startsWith('/inbox/result/')) {
          const jobId = decodeURIComponent(pathname.slice('/inbox/result/'.length)).trim();
          const job = jobs.get(jobId);
          if (!job) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Job not found' }));
            return;
          }
          if (job.state !== 'complete' || !job.metadataPath) {
            res.writeHead(409, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Result not ready', state: job.state }));
            return;
          }
          try {
            const json = await fsp.readFile(String(job.metadataPath), 'utf8');
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(json);
            return;
          } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: String(e.message || e) }));
            return;
          }
        }

        // Client polling: fetch transcript JSON (available after transcription, before VLM completes)
        if (method === 'GET' && pathname.startsWith('/inbox/transcript/')) {
          const jobId = decodeURIComponent(pathname.slice('/inbox/transcript/'.length)).trim();
          const job = jobs.get(jobId);
          if (!job) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Job not found' }));
            return;
          }
          if (!job.transcriptReady || !job.transcriptPath) {
            res.writeHead(409, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Transcript not ready', state: job.state }));
            return;
          }
          try {
            const json = await fsp.readFile(String(job.transcriptPath), 'utf8');
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(json);
            return;
          } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: String(e.message || e) }));
            return;
          }
        }

        // Server-side YouTube ingestion (client sends URL; server downloads + enqueues for processing).
        // POST /inbox/youtube { url, jobId? }
        if (method === 'POST' && (pathname === '/inbox/youtube' || pathname === '/inbox/youtube_ingest')) {
          try {
            const body = await readRequestBody(req, 256 * 1024);
            let parsed = null;
            try {
              parsed = JSON.parse(String(body || ''));
            } catch {
              parsed = null;
            }
            const ytUrl = String(parsed?.url || '').trim();
            if (!ytUrl) {
              res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
              res.end(JSON.stringify({ success: false, error: 'Missing url' }));
              return;
            }

            const jobIdProvided = String(parsed?.jobId || '').trim();
            const jobId = jobIdProvided || `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            if (jobs.has(jobId)) {
              res.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8' });
              res.end(JSON.stringify({ success: false, error: 'Job already exists', jobId }));
              return;
            }

            const clientIp = parseClientIp(req);
            jobs.set(jobId, {
              state: 'processing',
              phase: 'Downloading YouTube',
              progressPercent: 0,
              clientIp,
              fileName: ytUrl,
              storedFileName: null,
              sessionId: null,
              overlayBase: null,
              chunkIndex: null,
              recordingEnabled: null,
              isManifest: false,
              receivedBytes: 0,
              totalBytes: 0,
              savedVideoPath: null,
              metadataPath: null,
              transcriptReady: false,
              transcriptPath: null,
              error: null,
              updatedAt: Date.now(),
            });

            res.writeHead(202, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ success: true, jobId }));

            // Run download in the background.
            setImmediate(async () => {
              const outputBase = `${generateFilename()}_youtube_${Math.random().toString(36).slice(2, 7)}`;
              const pythonCmd = getVenvPythonPath();
              const scriptPath = scriptPathDownloadYouTube();

              const updateJob = (partial) => {
                const current = jobs.get(jobId) || {};
                jobs.set(jobId, { ...current, ...(partial || {}), updatedAt: Date.now() });
              };

              try {
                const child = spawn(
                  pythonCmd,
                  [scriptPath, '--url', ytUrl, '--output-dir', recordingsDir, '--output-base', outputBase],
                  { windowsHide: true }
                );

                let lastError = '';
                let finalResult = null;

                const handleLine = (line) => {
                  const trimmed = String(line || '').trim();
                  if (!trimmed) return;
                  let msg = null;
                  try {
                    msg = JSON.parse(trimmed);
                  } catch {
                    return;
                  }
                  if (!msg || typeof msg !== 'object') return;

                  if (msg.type === 'progress') {
                    const pct = Number(msg.percent);
                    if (Number.isFinite(pct)) {
                      updateJob({
                        phase: String(msg.phase || 'Downloading YouTube'),
                        progressPercent: Math.max(0, Math.min(100, Math.round(pct))),
                      });
                    } else {
                      updateJob({ phase: String(msg.phase || 'Downloading YouTube') });
                    }
                  } else if (msg.type === 'error') {
                    lastError = msg.message || msg.detail || 'Download failed';
                    updateJob({ state: 'error', error: lastError, phase: 'Error' });
                  } else if (msg.type === 'done') {
                    finalResult = msg;
                  }
                };

                const pump = (buf) => {
                  const text = String(buf || '');
                  text.split(/\r?\n/).forEach(handleLine);
                };

                child.stdout?.on('data', pump);
                child.stderr?.on('data', (buf) => {
                  const t = String(buf || '').trim();
                  if (t) lastError = lastError || t;
                });

                child.on('error', (err) => {
                  lastError = `Failed to start downloader: ${err.message || String(err)}`;
                });

                child.on('close', async (code) => {
                  try {
                    if (code === 0 && finalResult?.file_path) {
                      const videoPath = String(finalResult.file_path);
                      const storedFileName = path.basename(videoPath);
                      const fileName = String(finalResult.file_name || storedFileName);
                      const size = Number(finalResult.size || 0) || 0;

                      updateJob({
                        state: 'processing',
                        phase: 'Queued for processing',
                        progressPercent: 0,
                        fileName,
                        storedFileName,
                        savedVideoPath: videoPath,
                        receivedBytes: size,
                        totalBytes: size,
                        error: null,
                      });

                      try {
                        sendToRenderer?.('inbox:file-received', {
                          jobId,
                          videoPath,
                          fileName,
                          storedFileName,
                          fileSize: size,
                          clientIp,
                          sessionId: null,
                          overlayBase: null,
                          chunkIndex: null,
                          recordingEnabled: null,
                          isManifest: false,
                        });
                      } catch {
                        // ignore
                      }
                      return;
                    }

                    const errMsg = lastError || `Downloader exited (${code})`;
                    updateJob({ state: 'error', error: errMsg, phase: 'Error' });
                  } catch (e) {
                    updateJob({ state: 'error', error: String(e.message || e), phase: 'Error' });
                  }
                });
              } catch (e) {
                updateJob({ state: 'error', error: String(e.message || e), phase: 'Error' });
              }
            });
            return;
          } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ success: false, error: String(e.message || e) }));
            return;
          }
        }

        if (!((method === 'PUT' || method === 'POST') && pathname.startsWith('/inbox/upload'))) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not found');
          return;
        }

        const clientIp = parseClientIp(req);
        const jobIdHeader = req.headers['x-job-id'];
        const jobId = String(Array.isArray(jobIdHeader) ? jobIdHeader[0] : jobIdHeader || '').trim()
          || `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

        const sessionIdHeader = req.headers['x-session-id'];
        const sessionId = String(Array.isArray(sessionIdHeader) ? sessionIdHeader[0] : sessionIdHeader || '').trim();

        const overlayBaseHeader = req.headers['x-overlay-base'];
        const overlayBase = sanitizeBaseFilename(Array.isArray(overlayBaseHeader) ? overlayBaseHeader[0] : overlayBaseHeader || '');

        const chunkIndexHeader = req.headers['x-chunk-index'];
        const chunkIndexRaw = String(Array.isArray(chunkIndexHeader) ? chunkIndexHeader[0] : chunkIndexHeader || '').trim();
        const chunkIndex = chunkIndexRaw ? Number(chunkIndexRaw) : NaN;

        const isManifestHeader = req.headers['x-is-manifest'];
        const isManifest = String(Array.isArray(isManifestHeader) ? isManifestHeader[0] : isManifestHeader || '').trim();
        const isManifestUpload = isManifest === '1' || /^true$/i.test(isManifest);

        const recEnabledHeader = req.headers['x-recording-enabled'];
        const recEnabledRaw = String(Array.isArray(recEnabledHeader) ? recEnabledHeader[0] : recEnabledHeader || '').trim();
        const recordingEnabled =
          recEnabledRaw === '1' || /^true$/i.test(recEnabledRaw) ? true :
          recEnabledRaw === '0' || /^false$/i.test(recEnabledRaw) ? false :
          null;

        const originalName = sanitizeFilename(req.headers['x-filename'] || 'remote_upload.mp4');
        const ext = safeExtFromName(originalName);

        let storedFileName = '';
        if (isManifestUpload) {
          storedFileName = `${overlayBase}_manifest.json`;
        } else if (Number.isFinite(chunkIndex) && chunkIndex > 0) {
          storedFileName = `${overlayBase}_chunk_${String(chunkIndex).padStart(4, '0')}${ext}`;
        } else {
          const rand = Math.random().toString(36).slice(2, 7);
          const baseFilename = `${generateFilename()}_remote_${rand}`;
          storedFileName = `${baseFilename}${ext}`;
        }

        const targetPath = path.join(recordingsDir, storedFileName);
        try {
          console.log('[RemoteInbox] Upload start', {
            clientIp,
            jobId,
            sessionId,
            overlayBase,
            chunkIndex: Number.isFinite(chunkIndex) ? chunkIndex : null,
            isManifest: isManifestUpload,
            recordingEnabled,
            originalName,
            storedFileName,
          });
        } catch {
          // ignore
        }

        const total = Number(req.headers['content-length'] || 0) || 0;

        reset();
        setState({
          active: true,
          clientIp,
          fileName: originalName,
          totalBytes: total,
          savedPath: targetPath,
          lastError: null,
        });

        jobs.set(jobId, {
          state: 'uploading',
          phase: 'Uploading to server',
          progressPercent: 0,
          clientIp,
          fileName: originalName,
          storedFileName,
          sessionId,
          overlayBase,
          chunkIndex: Number.isFinite(chunkIndex) ? chunkIndex : null,
          recordingEnabled,
          isManifest: isManifestUpload,
          receivedBytes: 0,
          totalBytes: total,
          savedVideoPath: targetPath,
          metadataPath: null,
          error: null,
          updatedAt: Date.now(),
        });

        const out = fs.createWriteStream(targetPath);
        let received = 0;
        let finished = false;

        const abort = async (err) => {
          if (finished) return;
          finished = true;
          try {
            out.destroy();
          } catch {
            // ignore
          }
          try {
            await fsp.unlink(targetPath);
          } catch {
            // ignore
          }
          setState({
            active: false,
            lastError: err ? String(err.message || err) : 'Upload aborted',
          });
          const job = jobs.get(jobId);
          if (job) {
            job.state = 'error';
            job.error = err ? String(err.message || err) : 'Upload aborted';
            job.updatedAt = Date.now();
            jobs.set(jobId, job);
          }
        };

        req.on('aborted', () => abort(new Error('Client aborted upload')));
        req.on('error', (e) => abort(e));
        out.on('error', (e) => abort(e));

        req.on('data', (chunk) => {
          received += chunk.length;
          const pct = total > 0 ? Math.max(0, Math.min(100, Math.round((received / total) * 100))) : 0;
          setState({
            receivedBytes: received,
            progressPercent: pct,
          });
          const job = jobs.get(jobId);
          if (job) {
            job.receivedBytes = received;
            job.progressPercent = pct;
            job.updatedAt = Date.now();
            jobs.set(jobId, job);
          }
        });

        req.pipe(out);

        out.on('finish', async () => {
          if (finished) return;
          finished = true;

          try {
            const st = await fsp.stat(targetPath);
            setState({
              active: false,
              receivedBytes: st.size,
              progressPercent: 100,
            });

            try {
              sendToRenderer?.('inbox:file-received', {
                jobId,
                videoPath: targetPath,
                fileName: originalName,
                storedFileName,
                fileSize: st.size,
                clientIp,
                sessionId,
                overlayBase,
                chunkIndex: Number.isFinite(chunkIndex) ? chunkIndex : null,
                recordingEnabled,
                isManifest: isManifestUpload,
              });
            } catch {
              // ignore
            }

            const job = jobs.get(jobId) || {};
            jobs.set(jobId, {
              ...job,
              state: isManifestUpload ? 'complete' : 'processing',
              phase: isManifestUpload ? 'Manifest received' : 'Queued for processing',
              progressPercent: Math.max(0, Math.min(100, Number(job.progressPercent || 100))),
              receivedBytes: st.size,
              totalBytes: total,
              clientIp,
              fileName: originalName,
              storedFileName,
              sessionId,
              overlayBase,
              chunkIndex: Number.isFinite(chunkIndex) ? chunkIndex : null,
              recordingEnabled,
              isManifest: isManifestUpload,
              savedVideoPath: targetPath,
              updatedAt: Date.now(),
            });

            // Manifest handling: merge chunk videos immediately after all chunks are received.
            if (isManifestUpload) {
              setImmediate(async () => {
                try {
                  const raw = await fsp.readFile(targetPath, 'utf8');
                  const manifest = JSON.parse(raw);
                  const enabled = Boolean(manifest && manifest.recordingEnabled);
                  const quality = manifest && typeof manifest.quality === 'string' ? manifest.quality : null;
                  console.log('[RemoteInbox] Manifest received', { overlayBase, enabled, quality: quality || undefined });

                  const base = sanitizeBaseFilename(manifest.baseFilename || overlayBase);
                  const chunks = Array.isArray(manifest.chunks) ? manifest.chunks : [];
                  const ordered = chunks
                    .map((c) => ({
                      idx: Number(c.chunkIndex),
                      name: String(c.storedFileName || ''),
                      durationMs: Number(c.durationMs),
                    }))
                    .filter((c) => Number.isFinite(c.idx) && c.idx > 0)
                    .sort((a, b) => a.idx - b.idx);

                  const inputPaths = ordered.map((c) => path.join(recordingsDir, c.name));
                  if (inputPaths.length === 0) throw new Error('Manifest has no chunk list');

                  let mergedVideoPath = '';
                  if (enabled) {
                    // Ensure all inputs exist (quick wait loop).
                    const deadline = Date.now() + 5000;
                    while (Date.now() < deadline) {
                      let missing = false;
                      for (const p of inputPaths) {
                        try {
                          await fsp.stat(p);
                        } catch {
                          missing = true;
                          break;
                        }
                      }
                      if (!missing) break;
                      await new Promise((r) => setTimeout(r, 200));
                    }

                    for (const p of inputPaths) {
                      await fsp.stat(p);
                    }

                    const outPath = path.join(recordingsDir, `${base}.webm`);
                    mergedVideoPath = outPath;
                    setState({ lastError: null, fileName: `${base}.webm` });
                    console.log('[RemoteInbox] Merging chunks', { base, outPath, count: inputPaths.length });
                    await concatWebmFiles(recordingsDir, inputPaths, outPath);
                    console.log('[RemoteInbox] Merge complete', { outPath });
                  }

                  // Build a single lecture metadata JSON from the processed chunk results.
                  // This makes the server the source of truth (one combined lecture entry per overlay session).
                  const formatTimestamp = (ms) => {
                    const totalSeconds = Math.floor(Math.max(0, Number(ms) || 0) / 1000);
                    const minutes = Math.floor(totalSeconds / 60);
                    const seconds = totalSeconds % 60;
                    return `[${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}]`;
                  };

                  const parseBracketTimestampMs = (s) => {
                    const m = String(s || '').match(/\[(\d+):(\d+)\]/);
                    if (!m) return null;
                    const mm = Number(m[1]);
                    const ss = Number(m[2]);
                    if (!Number.isFinite(mm) || !Number.isFinite(ss)) return null;
                    return (mm * 60 + ss) * 1000;
                  };

                  const offsetWindowLabel = (label, offsetMs) => {
                    const str = String(label || '');
                    const matches = [...str.matchAll(/\[(\d+):(\d+)\]/g)];
                    if (matches.length < 2) return str;
                    const startMs = parseBracketTimestampMs(matches[0][0]);
                    const endMs = parseBracketTimestampMs(matches[1][0]);
                    if (startMs === null || endMs === null) return str;
                    return `${formatTimestamp(startMs + offsetMs)}-${formatTimestamp(endMs + offsetMs)}`;
                  };

                  const waitForFile = async (p, timeoutMs) => {
                    const deadline = Date.now() + timeoutMs;
                    let delay = 250;
                    while (Date.now() < deadline) {
                      try {
                        await fsp.stat(p);
                        return true;
                      } catch {
                        // ignore
                      }
                      await new Promise((r) => setTimeout(r, delay));
                      delay = Math.min(5000, Math.round(delay * 1.25));
                    }
                    return false;
                  };

                  // Prefer durations from manifest (client ffprobe); fall back to 0 if missing.
                  const orderedWithDur = ordered.map((c) => ({
                    ...c,
                    durationMs: Number.isFinite(c.durationMs) && c.durationMs > 0 ? Math.round(c.durationMs) : 0,
                  }));

                  const combinedTranscripts = [];
                  const combinedSummaries = [];
                  let cumulativeMs = 0;

                  // Wait for all chunk metadata JSONs to exist, then combine.
                  // Chunk metadata filenames are derived from the stored chunk filenames.
                  const maxWaitMs = 6 * 60 * 60 * 1000; // 6 hours (long queue tolerance)

                  for (const c of orderedWithDur) {
                    const baseName = path.basename(c.name).replace(/\.(webm|mp4)$/i, '');
                    const metaPath = path.join(recordingsDir, `${baseName}.json`);
                    const ok = await waitForFile(metaPath, maxWaitMs);
                    if (!ok) {
                      throw new Error(`Timeout waiting for chunk metadata: ${metaPath}`);
                    }
                    const meta = await readJsonFile(metaPath);
                    const offsetMs = cumulativeMs;
                    cumulativeMs += Math.max(0, Number(c.durationMs) || 0);

                    const tx = Array.isArray(meta?.transcripts) ? meta.transcripts : [];
                    for (const t of tx) {
                      const relMs = Number(t?.timestampMs || 0);
                      const absMs = offsetMs + (Number.isFinite(relMs) ? relMs : 0);
                      combinedTranscripts.push({
                        text: String(t?.text || ''),
                        timestampMs: absMs,
                        timestamp: formatTimestamp(absMs),
                      });
                    }

                    const sums = Array.isArray(meta?.summaries) ? meta.summaries : [];
                    for (const s of sums) {
                      combinedSummaries.push({
                        text: String(s?.text || ''),
                        windowLabel: offsetWindowLabel(s?.windowLabel, offsetMs),
                      });
                    }
                  }

                  combinedTranscripts.sort((a, b) => Number(a.timestampMs || 0) - Number(b.timestampMs || 0));

                  const outMetaPath = path.join(recordingsDir, `${base}.json`);
                  let fileSize = 0;
                  if (enabled && mergedVideoPath) {
                    try {
                      const stOut = await fsp.stat(mergedVideoPath);
                      fileSize = Number(stOut.size || 0);
                    } catch {
                      fileSize = 0;
                    }
                  }

                  const fullMeta = {
                    quality: quality || (enabled ? 'original' : null),
                    duration: Math.max(0, cumulativeMs),
                    transcriptCount: combinedTranscripts.length,
                    summaryCount: combinedSummaries.length,
                    transcripts: combinedTranscripts,
                    summaries: combinedSummaries,
                    uploadedFileName: `${base}.webm`,
                    origin: { kind: 'remote' },
                    recordedMimeType: 'video/webm',
                    videoFilename: enabled ? `${base}.webm` : `${base}.webm`,
                    videoPath: enabled ? mergedVideoPath : '',
                    savedAt: new Date().toISOString(),
                    fileSize: enabled ? fileSize : 0,
                  };

                  await fsp.writeFile(outMetaPath, JSON.stringify(fullMeta, null, 2), 'utf8');
                  console.log('[RemoteInbox] Overlay session metadata saved', { base, outMetaPath, enabled });
                } catch (e) {
                  setState({ lastError: String(e.message || e) });
                  console.error('[RemoteInbox] Merge failed', e);
                }
              });
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, jobId, videoPath: targetPath, storedFileName, size: st.size }));
          } catch (e) {
            await abort(e);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: String(e.message || e) }));
          }
        });
      } catch (e) {
        setState({ active: false, lastError: String(e.message || e) });
        try {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: String(e.message || e) }));
        } catch {
          // ignore
        }
      }
    });

    return await new Promise((resolve) => {
      server.on('error', (err) => {
        server = null;
        setState({ running: false, lastError: err.message || String(err) });
        resolve({ success: false, error: err.message || String(err) });
      });
      server.listen(port, '0.0.0.0', () => {
        setState({ running: true, port });
        resolve({ success: true, port });
      });
    });
  };

  const stop = async () => {
    if (!server) {
      setState({ running: false });
      return { success: true };
    }
    const s = server;
    server = null;
    reset();
    return await new Promise((resolve) => {
      try {
        s.close(() => {
          setState({ running: false });
          resolve({ success: true });
        });
      } catch (e) {
        setState({ running: false, lastError: String(e.message || e) });
        resolve({ success: false, error: String(e.message || e) });
      }
    });
  };

  ipcMain.handle('inbox:start', async (_event, port) => {
    try {
      return await start(port);
    } catch (e) {
      return { success: false, error: String(e.message || e) };
    }
  });

  ipcMain.handle('inbox:stop', async () => {
    try {
      return await stop();
    } catch (e) {
      return { success: false, error: String(e.message || e) };
    }
  });

  ipcMain.handle('inbox:status', async () => {
    return { success: true, status: { ...state } };
  });

  // Renderer (server PC) updates job status while processing.
  ipcMain.handle('inbox:update-job', async (_event, jobIdRaw, partial) => {
    const jobId = String(jobIdRaw || '').trim();
    if (!jobId) return { success: false, error: 'Missing jobId' };
    const current = jobs.get(jobId) || { state: 'processing' };
    const next = { ...current, ...(partial || {}), updatedAt: Date.now() };
    jobs.set(jobId, next);
    return { success: true };
  });

  ipcMain.handle('inbox:complete-job', async (_event, jobIdRaw, metadataPathRaw) => {
    const jobId = String(jobIdRaw || '').trim();
    const metadataPath = String(metadataPathRaw || '').trim();
    if (!jobId) return { success: false, error: 'Missing jobId' };
    if (!metadataPath) return { success: false, error: 'Missing metadataPath' };
    const current = jobs.get(jobId) || {};
    jobs.set(jobId, {
      ...current,
      state: 'complete',
      phase: 'Complete',
      progressPercent: 100,
      metadataPath,
      error: null,
      updatedAt: Date.now(),
    });
    return { success: true };
  });

  ipcMain.handle('inbox:error-job', async (_event, jobIdRaw, errorRaw) => {
    const jobId = String(jobIdRaw || '').trim();
    if (!jobId) return { success: false, error: 'Missing jobId' };
    const current = jobs.get(jobId) || {};
    jobs.set(jobId, {
      ...current,
      state: 'error',
      error: String(errorRaw || 'Error'),
      updatedAt: Date.now(),
    });
    return { success: true };
  });

  return { start, stop, state };
}

module.exports = { setupRemoteInboxHandlers };
