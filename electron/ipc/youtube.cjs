const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { app } = require('electron');

function getUserDataPath() {
  return app.getPath('userData');
}

function getVenvPythonPath() {
  // Repo root is one level up from electron/
  const repoRoot = path.join(__dirname, '..', '..');
  const venvPython = path.join(repoRoot, '.venv', 'Scripts', 'python.exe');
  if (fs.existsSync(venvPython)) return venvPython;
  return 'python';
}

function setupYouTubeHandlers(ipcMain) {
  ipcMain.handle('youtube:download', async (event, payload) => {
    const url = String(payload?.url || '').trim();
    const id = String(payload?.id || '');
    if (!url) return { success: false, error: 'URL is required' };

    const outDir = path.join(getUserDataPath(), 'youtube_downloads');
    const pythonCmd = getVenvPythonPath();
    const scriptPath = path.join(__dirname, '..', '..', 'scripts', 'download_youtube.py');

    return await new Promise((resolve) => {
      let done = false;
      let lastError = '';
      let finalResult = null;

      const child = spawn(
        pythonCmd,
        [scriptPath, '--url', url, '--output-dir', outDir],
        { windowsHide: true }
      );

      const sendProgress = (data) => {
        try {
          event.sender.send('youtube:download-progress', { id, ...data });
        } catch {
          // ignore
        }
      };

      const handleLine = (line) => {
        const trimmed = String(line || '').trim();
        if (!trimmed) return;
        let msg = null;
        try {
          msg = JSON.parse(trimmed);
        } catch {
          // non-json output; forward as log
          sendProgress({ type: 'log', message: trimmed });
          return;
        }

        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'progress') {
          sendProgress(msg);
        } else if (msg.type === 'error') {
          lastError = msg.message || msg.detail || 'Download failed';
          sendProgress(msg);
        } else if (msg.type === 'done') {
          finalResult = msg;
          sendProgress(msg);
        } else {
          sendProgress(msg);
        }
      };

      const pump = (buf) => {
        const text = String(buf || '');
        text.split(/\r?\n/).forEach(handleLine);
      };

      child.stdout?.on('data', pump);
      child.stderr?.on('data', (buf) => {
        const text = String(buf || '').trim();
        if (text) sendProgress({ type: 'stderr', message: text });
        lastError = lastError || text;
      });

      child.on('error', (err) => {
        if (done) return;
        done = true;
        resolve({ success: false, error: `Failed to start downloader: ${err.message}` });
      });

      child.on('close', (code) => {
        if (done) return;
        done = true;
        if (code === 0 && finalResult?.file_path) {
          resolve({ success: true, ...finalResult });
        } else {
          resolve({ success: false, error: lastError || `Downloader exited (${code})` });
        }
      });
    });
  });
}

module.exports = { setupYouTubeHandlers };

