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

function setupRemoteUploadHandlers(ipcMain, options) {
  const { sendToRenderer, inboxPort = 7557 } = options || {};

  ipcMain.handle('remoteUpload:sendFile', async (_event, serverUrlRaw, filePathRaw, displayNameRaw) => {
    const serverUrl = normalizeServerUrl(serverUrlRaw);
    const filePath = String(filePathRaw || '').trim();
    const displayName = String(displayNameRaw || '').trim();

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
            sendToRenderer?.('remoteUpload:complete', { ok: true });
            resolve({ success: true });
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
}

module.exports = { setupRemoteUploadHandlers };

