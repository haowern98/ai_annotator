const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
let electronSession = null;

function normalizeServerUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return s;
  return `http://${s}`;
}

function deriveInboxUrl(serverUrl, inboxPort) {
  const u = new URL(serverUrl);
  const port = inboxPort != null ? String(inboxPort) : (u.port ? String(Number(u.port) + 1) : '7557');
  u.port = port;
  u.pathname = '/inbox/upload';
  u.search = '';
  return u;
}

function deriveInboxBase(serverUrl, inboxPort) {
  const u = new URL(serverUrl);
  const port = inboxPort != null ? String(inboxPort) : (u.port ? String(Number(u.port) + 1) : '7557');
  u.port = port;
  u.pathname = '';
  u.search = '';
  return u;
}

function httpGetJson(urlObj, headers = null) {
  const client = urlObj.protocol === 'https:' ? https : http;
  return new Promise((resolve) => {
    const req = client.request(
      urlObj,
      { method: 'GET', headers: headers || undefined },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += String(chunk || '');
        });
        res.on('end', () => {
          let parsed = null;
          try {
            parsed = JSON.parse(body);
          } catch {
            // ignore
          }
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, statusCode: res.statusCode, body, json: parsed });
        });
      }
    );
    req.on('error', (err) => resolve({ ok: false, statusCode: 0, body: err.message || String(err), json: null }));
    req.end();
  });
}

function httpPostJson(urlObj, payload, headers = null) {
  const client = urlObj.protocol === 'https:' ? https : http;
  const body = Buffer.from(JSON.stringify(payload || {}), 'utf8');
  const mergedHeaders = {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(body.length),
    ...(headers || {}),
  };

  return new Promise((resolve) => {
    const req = client.request(
      urlObj,
      { method: 'POST', headers: mergedHeaders },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { text += String(chunk || ''); });
        res.on('end', () => {
          let parsed = null;
          try {
            parsed = JSON.parse(text);
          } catch {
            // ignore
          }
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, statusCode: res.statusCode, body: text, json: parsed });
        });
      }
    );
    req.on('error', (err) => resolve({ ok: false, statusCode: 0, body: err.message || String(err), json: null }));
    req.write(body);
    req.end();
  });
}

function setupRemoteUploadHandlers(ipcMain, options) {
  const { sendToRenderer, inboxPort = 7557 } = options || {};

  ipcMain.handle('remoteUpload:sendFile', async (_event, serverUrlRaw, filePathRaw, displayNameRaw, authTokenRaw) => {
    const serverUrl = normalizeServerUrl(serverUrlRaw);
    const filePath = String(filePathRaw || '').trim();
    const authToken = String(authTokenRaw || '').trim();

    let displayName = '';
    let jobId = '';
    let sessionId = '';
    let overlayBase = '';
    let chunkIndex = '';
    let isManifest = false;
    let recordingEnabled = '';
    if (displayNameRaw && typeof displayNameRaw === 'object') {
      displayName = String(displayNameRaw.displayName || '').trim();
      jobId = String(displayNameRaw.jobId || '').trim();
      sessionId = String(displayNameRaw.sessionId || '').trim();
      overlayBase = String(displayNameRaw.overlayBase || '').trim();
      chunkIndex = String(displayNameRaw.chunkIndex ?? '').trim();
      isManifest = Boolean(displayNameRaw.isManifest);
      recordingEnabled = String(displayNameRaw.recordingEnabled ?? '').trim();
    } else {
      displayName = String(displayNameRaw || '').trim();
    }

    if (!serverUrl) return { success: false, error: 'Missing serverUrl' };
    if (!filePath) return { success: false, error: 'Missing filePath' };

    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch (e) {
      return { success: false, error: `File not found: ${e.message || e}` };
    }

    const total = stat.size || 0;
    const uploadUrl = deriveInboxUrl(serverUrl, inboxPort);
    const client = uploadUrl.protocol === 'https:' ? https : http;

    const fileName = displayName || path.basename(filePath);

    return await new Promise((resolve) => {
      let sent = 0;
    const req = client.request(
      uploadUrl,
      {
        method: 'PUT',
        headers: {
          'Content-Length': String(total),
          'Content-Type': 'application/octet-stream',
          'X-Filename': fileName,
          ...(authToken ? { 'X-AI-ANNOTATOR-TOKEN': authToken } : {}),
          ...(jobId ? { 'X-Job-Id': jobId } : {}),
          ...(sessionId ? { 'X-Session-Id': sessionId } : {}),
          ...(overlayBase ? { 'X-Overlay-Base': overlayBase } : {}),
          ...(chunkIndex ? { 'X-Chunk-Index': chunkIndex } : {}),
            ...(isManifest ? { 'X-Is-Manifest': '1' } : {}),
            ...(recordingEnabled ? { 'X-Recording-Enabled': recordingEnabled } : {}),
          },
        },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            body += String(chunk || '');
          });
          res.on('end', () => {
            const ok = res.statusCode && res.statusCode >= 200 && res.statusCode < 300;
            if (!ok) {
              sendToRenderer?.('remoteUpload:error', {
                error: `Upload failed (${res.statusCode}): ${body.slice(0, 400)}`,
              });
              return resolve({ success: false, error: `Upload failed (${res.statusCode})` });
            }

            let serverJobId = jobId;
            try {
              const parsed = JSON.parse(body);
              if (parsed && typeof parsed === 'object' && parsed.jobId) {
                serverJobId = String(parsed.jobId);
              }
            } catch {
              // ignore
            }

            sendToRenderer?.('remoteUpload:complete', { ok: true, jobId: serverJobId });
            resolve({ success: true, jobId: serverJobId });
          });
        }
      );

      req.on('error', (err) => {
        sendToRenderer?.('remoteUpload:error', { error: err.message || String(err) });
        resolve({ success: false, error: err.message || String(err) });
      });

      const stream = fs.createReadStream(filePath);
      stream.on('data', (chunk) => {
        sent += chunk.length;
        const pct = total > 0 ? Math.max(0, Math.min(100, Math.round((sent / total) * 100))) : 0;
        sendToRenderer?.('remoteUpload:progress', {
          fileName,
          sentBytes: sent,
          totalBytes: total,
          progressPercent: pct,
          inboxUrl: uploadUrl.toString(),
        });
      });
      stream.on('error', (err) => {
        try {
          req.destroy(err);
        } catch {
          // ignore
        }
      });
      req.on('close', () => {
        try {
          stream.destroy();
        } catch {
          // ignore
        }
      });

      stream.pipe(req);
    });
  });

  // Set cookie-based auth for the inbox origin (needed for <video> playback on remote library later).
  ipcMain.handle('remoteUpload:setAuth', async (_event, serverUrlRaw, authTokenRaw) => {
    const serverUrl = normalizeServerUrl(serverUrlRaw);
    const authToken = String(authTokenRaw || '').trim();
    if (!serverUrl) return { success: false, error: 'Missing serverUrl' };

    try {
      if (!electronSession) {
        try {
          // Lazy require to avoid issues in non-Electron contexts.
          // eslint-disable-next-line global-require
          electronSession = require('electron').session;
        } catch {
          electronSession = null;
        }
      }
      if (!electronSession?.defaultSession?.cookies) {
        return { success: false, error: 'Electron session cookies API not available' };
      }

      const base = deriveInboxBase(serverUrl, inboxPort);
      const cookieUrl = `${base.protocol}//${base.hostname}:${base.port}/`;

      if (!authToken) {
        try {
          await electronSession.defaultSession.cookies.remove(cookieUrl, 'ai_annotator_token');
        } catch {
          // ignore
        }
        return { success: true };
      }

      await electronSession.defaultSession.cookies.set({
        url: cookieUrl,
        name: 'ai_annotator_token',
        value: authToken,
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        secure: false,
      });
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message || String(e) };
    }
  });

  // Client polling helpers (avoid CORS by doing HTTP in main process).
  ipcMain.handle('remoteUpload:getStatus', async (_event, serverUrlRaw, jobIdRaw, authTokenRaw) => {
    const serverUrl = normalizeServerUrl(serverUrlRaw);
    const jobId = String(jobIdRaw || '').trim();
    const authToken = String(authTokenRaw || '').trim();
    if (!serverUrl) return { success: false, error: 'Missing serverUrl' };
    if (!jobId) return { success: false, error: 'Missing jobId' };

    const base = deriveInboxBase(serverUrl, inboxPort);
    const url = new URL(`/inbox/status/${encodeURIComponent(jobId)}`, base);
    const headers = authToken ? { 'X-AI-ANNOTATOR-TOKEN': authToken } : null;
    const res = await httpGetJson(url, headers);
    if (!res.ok) return { success: false, error: `Status failed (${res.statusCode})`, detail: res.body };
    return { success: true, data: res.json };
  });

  ipcMain.handle('remoteUpload:getResult', async (_event, serverUrlRaw, jobIdRaw, authTokenRaw) => {
    const serverUrl = normalizeServerUrl(serverUrlRaw);
    const jobId = String(jobIdRaw || '').trim();
    const authToken = String(authTokenRaw || '').trim();
    if (!serverUrl) return { success: false, error: 'Missing serverUrl' };
    if (!jobId) return { success: false, error: 'Missing jobId' };

    const base = deriveInboxBase(serverUrl, inboxPort);
    const url = new URL(`/inbox/result/${encodeURIComponent(jobId)}`, base);
    const headers = authToken ? { 'X-AI-ANNOTATOR-TOKEN': authToken } : null;
    const res = await httpGetJson(url, headers);
    if (!res.ok) return { success: false, error: `Result failed (${res.statusCode})`, detail: res.body };
    return { success: true, data: res.json };
  });

  ipcMain.handle('remoteUpload:getTranscript', async (_event, serverUrlRaw, jobIdRaw, authTokenRaw) => {
    const serverUrl = normalizeServerUrl(serverUrlRaw);
    const jobId = String(jobIdRaw || '').trim();
    const authToken = String(authTokenRaw || '').trim();
    if (!serverUrl) return { success: false, error: 'Missing serverUrl' };
    if (!jobId) return { success: false, error: 'Missing jobId' };

    const base = deriveInboxBase(serverUrl, inboxPort);
    const url = new URL(`/inbox/transcript/${encodeURIComponent(jobId)}`, base);
    const headers = authToken ? { 'X-AI-ANNOTATOR-TOKEN': authToken } : null;
    const res = await httpGetJson(url, headers);
    if (!res.ok) return { success: false, error: `Transcript failed (${res.statusCode})`, detail: res.body };
    return { success: true, data: res.json };
  });

  // Remote library APIs (server is the source of truth).
  ipcMain.handle('remoteUpload:libraryList', async (_event, serverUrlRaw, authTokenRaw) => {
    const serverUrl = normalizeServerUrl(serverUrlRaw);
    const authToken = String(authTokenRaw || '').trim();
    if (!serverUrl) return { success: false, error: 'Missing serverUrl' };

    const base = deriveInboxBase(serverUrl, inboxPort);
    const url = new URL('/library/lectures', base);
    const headers = authToken ? { 'X-AI-ANNOTATOR-TOKEN': authToken } : null;
    const res = await httpGetJson(url, headers);
    if (!res.ok) return { success: false, error: `Library list failed (${res.statusCode})`, detail: res.body };
    return { success: true, data: res.json };
  });

  ipcMain.handle('remoteUpload:libraryMeta', async (_event, serverUrlRaw, lectureIdRaw, authTokenRaw) => {
    const serverUrl = normalizeServerUrl(serverUrlRaw);
    const lectureId = String(lectureIdRaw || '').trim();
    const authToken = String(authTokenRaw || '').trim();
    if (!serverUrl) return { success: false, error: 'Missing serverUrl' };
    if (!lectureId) return { success: false, error: 'Missing lectureId' };

    const base = deriveInboxBase(serverUrl, inboxPort);
    const url = new URL(`/library/lectures/${encodeURIComponent(lectureId)}/meta`, base);
    const headers = authToken ? { 'X-AI-ANNOTATOR-TOKEN': authToken } : null;
    const res = await httpGetJson(url, headers);
    if (!res.ok) return { success: false, error: `Library meta failed (${res.statusCode})`, detail: res.body };
    return { success: true, data: res.json };
  });

  ipcMain.handle('remoteUpload:libraryWords', async (_event, serverUrlRaw, lectureIdRaw, authTokenRaw) => {
    const serverUrl = normalizeServerUrl(serverUrlRaw);
    const lectureId = String(lectureIdRaw || '').trim();
    const authToken = String(authTokenRaw || '').trim();
    if (!serverUrl) return { success: false, error: 'Missing serverUrl' };
    if (!lectureId) return { success: false, error: 'Missing lectureId' };

    const base = deriveInboxBase(serverUrl, inboxPort);
    const url = new URL(`/library/lectures/${encodeURIComponent(lectureId)}/words`, base);
    const headers = authToken ? { 'X-AI-ANNOTATOR-TOKEN': authToken } : null;
    const res = await httpGetJson(url, headers);
    if (!res.ok) return { success: false, error: `Library words failed (${res.statusCode})`, detail: res.body };
    return { success: true, data: res.json };
  });

  // Server-side YouTube ingest (client sends URL; server downloads + enqueues).
  ipcMain.handle('remoteUpload:youtubeIngest', async (_event, serverUrlRaw, urlRaw, jobIdRaw, authTokenRaw) => {
    const serverUrl = normalizeServerUrl(serverUrlRaw);
    const ytUrl = String(urlRaw || '').trim();
    const jobId = String(jobIdRaw || '').trim();
    const authToken = String(authTokenRaw || '').trim();
    if (!serverUrl) return { success: false, error: 'Missing serverUrl' };
    if (!ytUrl) return { success: false, error: 'Missing url' };

    const base = deriveInboxBase(serverUrl, inboxPort);
    const url = new URL('/inbox/youtube', base);
    const headers = authToken ? { 'X-AI-ANNOTATOR-TOKEN': authToken } : null;
    const res = await httpPostJson(url, { url: ytUrl, ...(jobId ? { jobId } : {}) }, headers);
    if (!res.ok) return { success: false, error: `YouTube ingest failed (${res.statusCode})`, detail: res.body };
    return { success: true, data: res.json };
  });
}

module.exports = { setupRemoteUploadHandlers };
