const http = require('http');
const path = require('path');
const fs = require('fs');
const fsp = require('fs').promises;
const { spawn } = require('child_process');

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

        if (method === 'GET' && (url === '/inbox/health' || url === '/health')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok', service: 'remote_inbox', port }));
          return;
        }

        // Client polling: get status
        if (method === 'GET' && url.startsWith('/inbox/status/')) {
          const jobId = decodeURIComponent(url.slice('/inbox/status/'.length)).trim();
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
        if (method === 'GET' && url.startsWith('/inbox/result/')) {
          const jobId = decodeURIComponent(url.slice('/inbox/result/'.length)).trim();
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

        if (!((method === 'PUT' || method === 'POST') && url.startsWith('/inbox/upload'))) {
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
                  console.log('[RemoteInbox] Manifest received', { overlayBase, enabled });
                  if (!enabled) return;

                  const base = sanitizeBaseFilename(manifest.baseFilename || overlayBase);
                  const chunks = Array.isArray(manifest.chunks) ? manifest.chunks : [];
                  const ordered = chunks
                    .map((c) => ({ idx: Number(c.chunkIndex), name: String(c.storedFileName || '') }))
                    .filter((c) => Number.isFinite(c.idx) && c.idx > 0)
                    .sort((a, b) => a.idx - b.idx);

                  const inputPaths = ordered.map((c) => path.join(recordingsDir, c.name));
                  if (inputPaths.length === 0) throw new Error('Manifest has no chunk list');

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
                  setState({ lastError: null, fileName: `${base}.webm` });
                  console.log('[RemoteInbox] Merging chunks', { base, outPath, count: inputPaths.length });
                  await concatWebmFiles(recordingsDir, inputPaths, outPath);
                  console.log('[RemoteInbox] Merge complete', { outPath });
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
