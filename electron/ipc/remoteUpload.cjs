const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

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

function httpGetJson(urlObj) {
  const client = urlObj.protocol === 'https:' ? https : http;
  return new Promise((resolve) => {
    const req = client.request(
      urlObj,
      { method: 'GET' },
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

function setupRemoteUploadHandlers(ipcMain, options) {
  const { sendToRenderer, inboxPort = 7557 } = options || {};

  ipcMain.handle('remoteUpload:sendFile', async (_event, serverUrlRaw, filePathRaw, displayNameRaw) => {
    const serverUrl = normalizeServerUrl(serverUrlRaw);
    const filePath = String(filePathRaw || '').trim();

    let displayName = '';
    let jobId = '';
    if (displayNameRaw && typeof displayNameRaw === 'object') {
      displayName = String(displayNameRaw.displayName || '').trim();
      jobId = String(displayNameRaw.jobId || '').trim();
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
            ...(jobId ? { 'X-Job-Id': jobId } : {}),
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

  // Client polling helpers (avoid CORS by doing HTTP in main process).
  ipcMain.handle('remoteUpload:getStatus', async (_event, serverUrlRaw, jobIdRaw) => {
    const serverUrl = normalizeServerUrl(serverUrlRaw);
    const jobId = String(jobIdRaw || '').trim();
    if (!serverUrl) return { success: false, error: 'Missing serverUrl' };
    if (!jobId) return { success: false, error: 'Missing jobId' };

    const base = deriveInboxBase(serverUrl, inboxPort);
    const url = new URL(`/inbox/status/${encodeURIComponent(jobId)}`, base);
    const res = await httpGetJson(url);
    if (!res.ok) return { success: false, error: `Status failed (${res.statusCode})`, detail: res.body };
    return { success: true, data: res.json };
  });

  ipcMain.handle('remoteUpload:getResult', async (_event, serverUrlRaw, jobIdRaw) => {
    const serverUrl = normalizeServerUrl(serverUrlRaw);
    const jobId = String(jobIdRaw || '').trim();
    if (!serverUrl) return { success: false, error: 'Missing serverUrl' };
    if (!jobId) return { success: false, error: 'Missing jobId' };

    const base = deriveInboxBase(serverUrl, inboxPort);
    const url = new URL(`/inbox/result/${encodeURIComponent(jobId)}`, base);
    const res = await httpGetJson(url);
    if (!res.ok) return { success: false, error: `Result failed (${res.statusCode})`, detail: res.body };
    return { success: true, data: res.json };
  });
}

module.exports = { setupRemoteUploadHandlers };
