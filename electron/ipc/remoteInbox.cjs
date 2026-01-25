const http = require('http');
const path = require('path');
const fs = require('fs');
const fsp = require('fs').promises;

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

function setupRemoteInboxHandlers(ipcMain, options) {
  const {
    getRecordingsDir,
    sendToRenderer,
    defaultPort = 7557,
  } = options || {};

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

        if (!((method === 'PUT' || method === 'POST') && url.startsWith('/inbox/upload'))) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not found');
          return;
        }

        const clientIp = parseClientIp(req);
        const originalName = sanitizeFilename(req.headers['x-filename'] || 'remote_upload.mp4');
        const ext = safeExtFromName(originalName);
        const rand = Math.random().toString(36).slice(2, 7);

        const baseFilename = `${generateFilename()}_remote_${rand}`;
        const videoFilename = `${baseFilename}${ext}`;
        const targetPath = path.join(recordingsDir, videoFilename);

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
                videoPath: targetPath,
                fileName: originalName,
                fileSize: st.size,
                clientIp,
              });
            } catch {
              // ignore
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, videoPath: targetPath, size: st.size }));
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

  return { start, stop, state };
}

module.exports = { setupRemoteInboxHandlers };

