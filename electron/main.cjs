const { app, BrowserWindow, ipcMain, desktopCapturer, Menu, dialog, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const nodeNet = require('net');
const { setupScreenCaptureHandlers } = require('./ipc/screenCapture.cjs');
const { setupOverlayHandlers } = require('./ipc/overlay.cjs');
const { setupLectureOverlayHandlers } = require('./ipc/lectureOverlay.cjs');
const { setupWhisperHandlers } = require('./ipc/whisper.cjs');
const { setupRecordingHandlers } = require('./ipc/recording.cjs');
const { setupFileUtilsHandlers } = require('./ipc/fileUtils.cjs');
const { setupYouTubeHandlers } = require('./ipc/youtube.cjs');
const { setupNetworkHandlers } = require('./ipc/network.cjs');
const { setupQwenControlHandlers } = require('./ipc/qwenControl.cjs');
const { setupRemoteInboxHandlers } = require('./ipc/remoteInbox.cjs');
const { setupRemoteUploadHandlers } = require('./ipc/remoteUpload.cjs');
const { focusCapturedWindow } = require('./windowsNative.cjs');

// Only set command-line switches if app is properly loaded
if (app && app.commandLine) {
  // CRITICAL FIX: Enable Windows Graphics Capture (WGC) for OS-level capture
  // WGC CAN capture hardware-accelerated windows (same API as OBS Studio)
  // Only available on Windows 10 1903+ (May 2019 Update)
  app.commandLine.appendSwitch('enable-features', 'WebRtcUseWgcCapturer');

  // Configure Electron for better screen/video capture
  app.commandLine.appendSwitch('disable-features', 'HardwareMediaKeyHandling');
  app.commandLine.appendSwitch('enable-usermedia-screen-capturing');
} else {
  console.error('[ERROR] app or app.commandLine is undefined!');
}

// Register custom protocol schemes
if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient('video', process.execPath, [path.resolve(process.argv[1])]);
  }
} else {
  app.setAsDefaultProtocolClient('video');
}

// Register protocol privileges before app is ready
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'video',
    privileges: {
      standard: true,
      secure: true,
      corsEnabled: true,
      supportFetchAPI: true,
      bypassCSP: true,
      allowServiceWorkers: true,
      stream: true
    }
  }
]);

let mainWindow;
let splashWindow;

let parakeetProcess = null;
let qwenProcess = null;

function getRecordingsDirFallback() {
  // In dev, keep recordings in the repo root under `.recordings`.
  // `__dirname` here is `<repo>/electron`, so go up one level.
  return path.join(__dirname, '..', '.recordings');
}

// Track Qwen server activity (remote "server mode" UX).
// Driven by qwen_worker stdout/stderr logs (uvicorn access logs + batch logs),
// without requiring any changes to qwen_worker/server.py.
const qwenActivityState = {
  active: false,
  clientIp: null,
  phase: null,
  progressPercent: 0,
  updatedAt: 0,
  lastError: null,
};

function broadcastQwenActivity() {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('qwen:activity', qwenActivityState);
    }
  } catch {
    // ignore
  }
}

function setQwenActivity(partial) {
  Object.assign(qwenActivityState, partial);
  qwenActivityState.updatedAt = Date.now();
  broadcastQwenActivity();
}

function resetQwenActivity() {
  setQwenActivity({
    active: false,
    clientIp: null,
    phase: null,
    progressPercent: 0,
    lastError: null,
  });
}

function parseQwenLogLine(line) {
  const text = String(line || '').trim();
  if (!text) return;

  // Batch logs emitted by qwen_worker (sequential VLM batching)
  // Example: [BATCH 3/19] Time: 10.0s - 14.0s
  const batchMatch = text.match(/^\[BATCH\s+(\d+)\s*\/\s*(\d+)\]/i);
  if (batchMatch) {
    const current = Number(batchMatch[1]);
    const total = Number(batchMatch[2]);
    if (Number.isFinite(current) && Number.isFinite(total) && total > 0) {
      const pct = Math.max(0, Math.min(100, Math.round((current / total) * 100)));
      setQwenActivity({
        active: true,
        phase: `Analyzing with VLM (${current}/${total})`,
        progressPercent: pct,
      });
    }
    return;
  }

  // Uvicorn access logs include the client IP + path.
  // Example: INFO:     192.168.1.10:53421 - "POST /api/v1/analyze_sequential HTTP/1.1" 200 OK
  const accessMatch = text.match(
    /\b(\d{1,3}(?:\.\d{1,3}){3}):\d+\s*-\s*\"[A-Z]+\s+([^ ]+)\s+HTTP\/[0-9.]+\"\s+(\d{3})\b/
  );
  if (accessMatch) {
    const ip = accessMatch[1];
    const path = accessMatch[2];
    const statusCode = Number(accessMatch[3]);

    if (path.includes('/api/v1/analyze_sequential') || path.includes('/api/v1/analyze')) {
      setQwenActivity({ clientIp: ip });
    }

    if (Number.isFinite(statusCode) && statusCode >= 400) {
      setQwenActivity({
        active: false,
        lastError: `${ip} ${path} failed (${statusCode})`,
      });
    }
    return;
  }

  if (/traceback/i.test(text) || /\b(error|exception)\b/i.test(text)) {
    setQwenActivity({ lastError: text });
  }
}

function attachQwenActivityListeners(proc) {
  if (!proc || proc.killed) return;
  if (proc.__qwenActivityAttached) return;
  proc.__qwenActivityAttached = true;

  proc.stdout?.on('data', (buf) => {
    String(buf)
      .split(/\r?\n/)
      .filter(Boolean)
      .forEach((l) => parseQwenLogLine(l));
  });

  proc.stderr?.on('data', (buf) => {
    String(buf)
      .split(/\r?\n/)
      .filter(Boolean)
      .forEach((l) => parseQwenLogLine(l));
  });
}

// Expose Qwen activity snapshot to renderer (optional initial fetch).
// Register once at module load (not per-window) to avoid duplicate handler errors.
ipcMain.handle('qwen:get-activity', async () => {
  return { success: true, activity: qwenActivityState };
});

const splashState = {
  parakeet: { progress: 0, status: 'Waiting…', isError: false },
  qwen: { progress: 0, status: 'Waiting…', isError: false },
};

function sendSplashUpdate(partial) {
  Object.assign(splashState, partial);
  try {
    if (splashWindow && !splashWindow.isDestroyed()) {
      splashWindow.webContents.send('splash:update', splashState);
    }
  } catch {
    // ignore
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function findParakeetModelPath() {
  const fromEnv = process.env.PARAKEET_MODEL_PATH;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;

  const homeDir = process.env.USERPROFILE || os.homedir();
  const snapshotsDir = path.join(
    homeDir,
    '.cache',
    'huggingface',
    'hub',
    'models--nvidia--parakeet-tdt-0.6b-v3',
    'snapshots'
  );

  if (!fs.existsSync(snapshotsDir)) return null;

  try {
    const candidates = [];
    const entries = fs.readdirSync(snapshotsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const modelFile = path.join(snapshotsDir, entry.name, 'parakeet-tdt-0.6b-v3.nemo');
      if (!fs.existsSync(modelFile)) continue;
      const st = fs.statSync(modelFile);
      candidates.push({ file: modelFile, mtimeMs: st.mtimeMs });
    }

    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return candidates[0]?.file || null;
  } catch {
    return null;
  }
}

function getVenvPythonPath() {
  const repoRoot = path.join(__dirname, '..');
  const candidate = path.join(repoRoot, '.venv', 'Scripts', 'python.exe');
  if (fs.existsSync(candidate)) return candidate;
  return process.env.QWEN_PYTHON || process.env.PARAKEET_PYTHON || 'python';
}

async function fetchJsonWithTimeout(url, timeoutMs = 1500) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timeoutId);
  }
}

function isPortOpen(host, port, timeoutMs = 400) {
  return new Promise((resolve) => {
    const socket = new nodeNet.Socket();
    let done = false;

    const finish = (ok) => {
      if (done) return;
      done = true;
      try {
        socket.destroy();
      } catch {
        // ignore
      }
      resolve(ok);
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, host);
  });
}

function createSplashWindow() {
  const win = new BrowserWindow({
    width: 560,
    height: 300,
    resizable: false,
    maximizable: false,
    minimizable: false,
    show: true,
    frame: false,
    backgroundColor: '#242424',
    webPreferences: {
      preload: path.join(__dirname, 'splashPreload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
    },
  });

  win.webContents.once('did-finish-load', () => {
    try {
      win.webContents.send('splash:update', splashState);
    } catch {
      // ignore
    }
  });

  win.loadFile(path.join(__dirname, 'splash.html'));
  return win;
}

async function ensureParakeetReady() {
  const host = '127.0.0.1';
  const port = Number(process.env.PARAKEET_WS_PORT || 8765);

  sendSplashUpdate({ parakeet: { progress: 5, status: 'Starting…', isError: false } });

  if (await isPortOpen(host, port)) {
    sendSplashUpdate({ parakeet: { progress: 100, status: 'Ready', isError: false } });
    return;
  }

  const modelPath = findParakeetModelPath();
  if (!modelPath) {
    const err = new Error('Parakeet model not found (set PARAKEET_MODEL_PATH)');
    sendSplashUpdate({ parakeet: { progress: 100, status: err.message, isError: true } });
    throw err;
  }
  process.env.PARAKEET_MODEL_PATH = modelPath;

  const pythonCmd = process.env.PARAKEET_PYTHON || getVenvPythonPath();
  const scriptPath = path.join(__dirname, '..', 'parakeet_worker', 'server.py');
  sendSplashUpdate({ parakeet: { progress: 10, status: 'Launching…', isError: false } });

  let exited = false;
  let exitInfo = '';
  let lastStderr = '';

  try {
    parakeetProcess = spawn(pythonCmd, [scriptPath], {
      cwd: path.join(__dirname, '..'),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PARAKEET_WS_PORT: String(port), PARAKEET_MODEL_PATH: modelPath },
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Failed to spawn';
    sendSplashUpdate({ parakeet: { progress: 100, status: msg, isError: true } });
    throw error;
  }

  parakeetProcess.stdout?.on('data', (buf) => {
    const chunk = String(buf);
    chunk.split(/\r?\n/).filter(Boolean).forEach((l) => console.log(`[ParakeetWorker] ${l}`));
    if (/ready/i.test(chunk)) {
      sendSplashUpdate({ parakeet: { progress: 95, status: 'Almost ready…', isError: false } });
    }
  });

  parakeetProcess.stderr?.on('data', (buf) => {
    const chunk = String(buf);
    chunk.split(/\r?\n/).filter(Boolean).forEach((l) => console.warn(`[ParakeetWorker] ${l}`));
    lastStderr = chunk.trim().slice(-400);
  });

  parakeetProcess.on('exit', (code, signal) => {
    exited = true;
    exitInfo = `Parakeet exited (${code ?? 'null'}${signal ? `, ${signal}` : ''})`;
  });

  parakeetProcess.on('error', (err) => {
    exited = true;
    exitInfo = `Parakeet failed to start: ${err.message}`;
  });

  // Soft progress while we wait
  let progress = 12;
  const progressTimer = setInterval(() => {
    progress = Math.min(90, progress + 2);
    sendSplashUpdate({ parakeet: { progress, status: 'Loading…', isError: false } });
  }, 350);

  const timeoutMs = Number(process.env.PARAKEET_START_TIMEOUT_MS || 180000);
  const startedAt = Date.now();
  try {
    while (Date.now() - startedAt < timeoutMs) {
      if (exited) {
        const msg = lastStderr ? `${exitInfo}: ${lastStderr}` : exitInfo;
        const err = new Error(msg || 'Parakeet exited');
        sendSplashUpdate({ parakeet: { progress: 100, status: err.message, isError: true } });
        throw err;
      }
      if (await isPortOpen(host, port, 500)) {
        clearInterval(progressTimer);
        sendSplashUpdate({ parakeet: { progress: 100, status: 'Ready', isError: false } });
        return;
      }
      await sleep(500);
    }
  } finally {
    clearInterval(progressTimer);
  }

  const err = new Error('Timed out waiting for Parakeet');
  sendSplashUpdate({ parakeet: { progress: 100, status: err.message, isError: true } });
  throw err;
}

async function ensureQwenReady() {
  const baseUrl = process.env.QWEN_BASE_URL || 'http://127.0.0.1:7556';
  const healthUrl = `${baseUrl.replace(/\/+$/, '')}/health`;

  sendSplashUpdate({ qwen: { progress: 5, status: 'Starting…', isError: false } });

  try {
    const json = await fetchJsonWithTimeout(healthUrl, 1200);
    if (json?.status === 'healthy') {
      sendSplashUpdate({ qwen: { progress: 100, status: 'Ready', isError: false } });
      return;
    }
  } catch {
    // not up yet
  }

  const qwenHost = process.env.QWEN_HOST || '127.0.0.1';
  const qwenPort = String(process.env.QWEN_PORT || '7556');
  const pythonCmd = getVenvPythonPath();

  sendSplashUpdate({ qwen: { progress: 10, status: 'Launching…', isError: false } });

  let exited = false;
  let exitInfo = '';
  let lastStderr = '';

  try {
    qwenProcess = spawn(
      pythonCmd,
      ['-m', 'uvicorn', 'server:app', '--host', qwenHost, '--port', qwenPort, '--log-level', 'info'],
      {
        cwd: path.join(__dirname, '..', 'qwen_worker'),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, QWEN_HOST: qwenHost, QWEN_PORT: qwenPort },
      }
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Failed to spawn';
    sendSplashUpdate({ qwen: { progress: 100, status: msg, isError: true } });
    throw error;
  }

  qwenProcess.stdout?.on('data', (buf) => {
    const chunk = String(buf);
    // Forward worker logs to the parent process so dev terminal shows stage-by-stage progress.
    chunk.split(/\r?\n/).filter(Boolean).forEach((l) => console.log(`[QwenWorker] ${l}`));
    chunk.split(/\r?\n/).filter(Boolean).forEach((l) => parseQwenLogLine(l));

    if (/\[QwenWorker\]\s*Model ready/i.test(chunk) || /Uvicorn running on/i.test(chunk)) {
      sendSplashUpdate({ qwen: { progress: 95, status: 'Almost ready…', isError: false } });
    }
  });

  qwenProcess.stderr?.on('data', (buf) => {
    const chunk = String(buf);
    chunk.split(/\r?\n/).filter(Boolean).forEach((l) => console.warn(`[QwenWorker] ${l}`));
    chunk.split(/\r?\n/).filter(Boolean).forEach((l) => parseQwenLogLine(l));
    lastStderr = chunk.trim().slice(-400);
  });

  qwenProcess.on('exit', (code, signal) => {
    exited = true;
    exitInfo = `Qwen exited (${code ?? 'null'}${signal ? `, ${signal}` : ''})`;
  });

  qwenProcess.on('error', (err) => {
    exited = true;
    exitInfo = `Qwen failed to start: ${err.message}`;
  });

  // Soft progress while we wait
  let progress = 12;
  const progressTimer = setInterval(() => {
    progress = Math.min(92, progress + 1.5);
    sendSplashUpdate({ qwen: { progress, status: 'Loading…', isError: false } });
  }, 450);

  const timeoutMs = Number(process.env.QWEN_START_TIMEOUT_MS || 300000);
  const startedAt = Date.now();
  try {
    while (Date.now() - startedAt < timeoutMs) {
      if (exited) {
        const msg = lastStderr ? `${exitInfo}: ${lastStderr}` : exitInfo;
        const err = new Error(msg || 'Qwen exited');
        sendSplashUpdate({ qwen: { progress: 100, status: err.message, isError: true } });
        throw err;
      }
      try {
        const json = await fetchJsonWithTimeout(healthUrl, 1500);
        if (json?.status === 'healthy') {
          clearInterval(progressTimer);
          sendSplashUpdate({ qwen: { progress: 100, status: 'Ready', isError: false } });
          return;
        }
      } catch {
        // keep waiting
      }
      await sleep(1000);
    }
  } finally {
    clearInterval(progressTimer);
  }

  const err = new Error('Timed out waiting for Qwen');
  sendSplashUpdate({ qwen: { progress: 100, status: err.message, isError: true } });
  throw err;
}

function createWindow() {
  // Remove the default menu
  Menu.setApplicationMenu(null);

  mainWindow = new BrowserWindow({
    width: 900,
    height: 600,
    minWidth: 700,
    minHeight: 500,
    title: 'Live Lecture Summarizer',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
      // Enable necessary features for media capture
      enableBlinkFeatures: 'WebAudioWorklet',
      backgroundThrottling: false, // Prevent throttling of media capture
    },
    icon: path.join(__dirname, '../public/icon.png'),
    backgroundColor: '#00000000', // Transparent for rounded corners
    transparent: true, // Enable transparency for rounded corners
    autoHideMenuBar: true,
    frame: false, // Frameless window for custom title bar
    titleBarStyle: 'hidden',
    show: false, // show after splash + worker readiness
  });

  // Window control IPC handlers
  ipcMain.on('window:minimize', () => {
    mainWindow?.minimize();
  });

  ipcMain.on('window:maximize', () => {
    if (mainWindow?.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow?.maximize();
    }
  });

  ipcMain.on('window:close', () => {
    mainWindow?.close();
  });

  ipcMain.handle('window:isMaximized', () => {
    return mainWindow?.isMaximized() ?? false;
  });

  // Send maximize state changes to renderer
  mainWindow.on('maximize', () => {
    mainWindow?.webContents.send('window:maximize-change', true);
  });

  mainWindow.on('unmaximize', () => {
    mainWindow?.webContents.send('window:maximize-change', false);
  });

  // Show native message box dialog
  ipcMain.handle('dialog:showMessageBox', async (event, options) => {
    if (!mainWindow) {
      return { response: -1 };
    }
    return await dialog.showMessageBox(mainWindow, options);
  });

  // Focus captured window (Zoom-like behavior)
  ipcMain.handle('focus-captured-window', async (event, sourceId) => {
    return focusCapturedWindow(sourceId);
  });

  // Get primary screen source ID for screen analysis
  ipcMain.handle('get-primary-screen-source', async () => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'] });
      if (sources.length === 0) {
        return { success: false, error: 'No screens found' };
      }
      // Return the first screen (primary display)
      const primaryScreen = sources[0];
      console.log('[Main] Primary screen source:', primaryScreen.name, primaryScreen.id);
      return { success: true, sourceId: primaryScreen.id, name: primaryScreen.name };
    } catch (err) {
      console.error('[Main] Failed to get primary screen source:', err);
      return { success: false, error: err.message };
    }
  });

  // Track server mode state
  let isServerMode = false;
  const getServerMode = () => isServerMode;
  const setServerMode = (mode) => { isServerMode = mode; };

  // Remote inbox for full-video uploads (server mode).
  const remoteInbox = setupRemoteInboxHandlers(ipcMain, {
    getRecordingsDir: getRecordingsDirFallback,
    sendToRenderer: (channel, payload) => {
      try {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(channel, payload);
        }
      } catch {
        // ignore
      }
    },
    defaultPort: 7557,
  });

  const startInbox = async () => {
    try {
      await remoteInbox.start(7557);
    } catch {
      // ignore
    }
  };

  const stopInbox = async () => {
    try {
      await remoteInbox.stop();
    } catch {
      // ignore
    }
  };

  // Network and Qwen control handlers
  setupNetworkHandlers(ipcMain);
  setupQwenControlHandlers(
    ipcMain, 
    getVenvPythonPath, 
    fetchJsonWithTimeout,
    () => qwenProcess,
    (proc) => {
      qwenProcess = proc;
      resetQwenActivity();
      attachQwenActivityListeners(proc);
    },
    getServerMode,
    (mode) => {
      setServerMode(mode);
      if (mode) startInbox();
      else stopInbox();
    },
    startInbox,
    stopInbox
  );

  // Setup IPC handlers
  setupScreenCaptureHandlers(ipcMain, desktopCapturer);
  setupOverlayHandlers(ipcMain, getMainWindow);
  setupLectureOverlayHandlers(ipcMain, getMainWindow);
  setupWhisperHandlers(ipcMain);
  setupRecordingHandlers(ipcMain);
  setupFileUtilsHandlers(ipcMain);
  setupYouTubeHandlers(ipcMain);
  setupRemoteUploadHandlers(ipcMain, {
    inboxPort: 7557,
    sendToRenderer: (channel, payload) => {
      try {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(channel, payload);
        }
      } catch {
        // ignore
      }
    },
  });

  // Load the app
  if (process.env.NODE_ENV === 'development') {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/**
 * Get the main window instance
 */
function getMainWindow() {
  return mainWindow;
}

// Register custom protocol for local file access
app.whenReady().then(() => {
  splashWindow = createSplashWindow();
  sendSplashUpdate({
    parakeet: { progress: 0, status: 'Waiting…', isError: false },
    qwen: { progress: 0, status: 'Waiting…', isError: false },
  });

  // Register video protocol handler for serving local video files.
  // IMPORTANT: frame extraction seeks many times (video.currentTime), which requires Range support.
  protocol.registerStreamProtocol('video', (request, callback) => {
    const { Readable } = require('stream');

    const fail = (statusCode, message) => {
      console.warn('[Protocol] video:// fail', { statusCode, message, url: request?.url });
      callback({
        statusCode,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        data: Readable.from([Buffer.from(String(message || 'Error'))]),
      });
    };

    try {
      // Helps debug renderer playback failures (media pipeline gives opaque errors).
      // Keep log minimal to avoid spamming during seek.
      // Note: request.headers may contain Range during playback.
      // Handle video://localhost/C:/Users/... format
      const url = request.url.replace(/^video:\/\/localhost\//i, '');
      let decodedPath = decodeURIComponent(url);
      const filePath = path.resolve(decodedPath);
      const rangeHeader = request.headers?.Range || request.headers?.range;
      if (rangeHeader) {
        console.log('[Protocol] video://', { filePath, range: String(rangeHeader) });
      }

      const repoRoot = path.resolve(__dirname, '..');
      const allowedRoots = [
        path.resolve(app.getPath('userData')),
        path.resolve(path.join(repoRoot, '.recordings')),
      ];

      // DEBUG: Log all paths for troubleshooting
      console.log('[Protocol] Security check:', {
        __dirname,
        repoRoot,
        requestedFile: filePath,
        allowedRoots,
        normalized: filePath.toLowerCase(),
        allowedRootsNormalized: allowedRoots.map(r => r.toLowerCase()),
      });

      const normalized = filePath.toLowerCase();
      const isAllowed = allowedRoots.some((root) => {
        const rootNorm = root.toLowerCase();
        const matches = normalized === rootNorm || normalized.startsWith(rootNorm + path.sep);
        console.log('[Protocol] Checking root:', { root: rootNorm, matches });
        return matches;
      });

      if (!isAllowed) {
        console.error('[Protocol] 403 FORBIDDEN - File not in allowed roots');
        return fail(403, 'Forbidden');
      }

      const stat = fs.statSync(filePath);
      if (!stat.isFile()) {
        return fail(404, 'Not found');
      }

      const ext = path.extname(filePath).toLowerCase();
      const contentType =
        ext === '.mp4'
          ? 'video/mp4'
          : ext === '.webm'
            ? 'video/webm'
            : ext === '.mov'
              ? 'video/quicktime'
              : 'application/octet-stream';

      const size = stat.size;
      if (rangeHeader) {
        const m = /^bytes=(\d*)-(\d*)$/i.exec(String(rangeHeader).trim());
        if (!m) return fail(416, 'Invalid Range');

        let start = m[1] ? parseInt(m[1], 10) : 0;
        let end = m[2] ? parseInt(m[2], 10) : size - 1;

        if (Number.isNaN(start) || Number.isNaN(end) || start < 0 || end < 0) {
          return fail(416, 'Invalid Range');
        }

        if (start >= size) {
          return callback({
            statusCode: 416,
            headers: { 'Content-Range': `bytes */${size}` },
            data: Readable.from([]),
          });
        }

        if (end >= size) end = size - 1;
        if (end < start) end = start;

        const chunkSize = end - start + 1;
        const stream = fs.createReadStream(filePath, { start, end });
        return callback({
          statusCode: 206,
          headers: {
            'Content-Type': contentType,
            'Accept-Ranges': 'bytes',
            'Access-Control-Allow-Origin': '*',
            'Content-Range': `bytes ${start}-${end}/${size}`,
            'Content-Length': String(chunkSize),
          },
          data: stream,
        });
      }

      const stream = fs.createReadStream(filePath);
      return callback({
        statusCode: 200,
        headers: {
          'Content-Type': contentType,
          'Accept-Ranges': 'bytes',
          'Access-Control-Allow-Origin': '*',
          'Content-Length': String(size),
        },
        data: stream,
      });
    } catch (err) {
      console.error('[Protocol] Error handling video request:', err);
      return fail(500, 'Internal error');
    }
  });

  createWindow();

  const mainReady = new Promise((resolve) => {
    if (!mainWindow) return resolve();
    mainWindow.webContents.once('did-finish-load', resolve);
  });

  Promise.allSettled([ensureParakeetReady(), ensureQwenReady()])
    .then(async (results) => {
      const allOk = results.every((r) => r.status === 'fulfilled');
      if (!allOk) {
        await sleep(1500);
      }

      await mainReady;

      if (splashWindow && !splashWindow.isDestroyed()) {
        splashWindow.close();
        splashWindow = null;
      }

      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show();
      }
    })
    .catch(async () => {
      await mainReady;
      if (splashWindow && !splashWindow.isDestroyed()) {
        splashWindow.close();
        splashWindow = null;
      }
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show();
      }
    });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  try {
    if (parakeetProcess && !parakeetProcess.killed) parakeetProcess.kill();
  } catch {
    // ignore
  }
  try {
    if (qwenProcess && !qwenProcess.killed) qwenProcess.kill();
  } catch {
    // ignore
  }
});

// Handle any unhandled errors
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  // Don't exit on uncaught exceptions in development
  if (process.env.NODE_ENV !== 'development') {
    app.quit();
  }
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});
