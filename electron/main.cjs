const { app, BrowserWindow, ipcMain, desktopCapturer, Menu, dialog, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { setupScreenCaptureHandlers } = require('./ipc/screenCapture.cjs');
const { setupOverlayHandlers } = require('./ipc/overlay.cjs');
const { setupLectureOverlayHandlers } = require('./ipc/lectureOverlay.cjs');
const { setupWhisperHandlers } = require('./ipc/whisper.cjs');
const { setupRecordingHandlers } = require('./ipc/recording.cjs');
const { focusCapturedWindow } = require('./windowsNative.cjs');

// Python server state
let pythonServer = null;
let pythonServerPort = null;
let pythonServerReady = false;

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
      secure: true,
      supportFetchAPI: true,
      bypassCSP: true,
      stream: true
    }
  }
]);

let mainWindow;

/**
 * Start Python model server
 */
function startPythonServer() {
  return new Promise((resolve, reject) => {
    try {
      console.log('[Python] Starting model server...');
      
      // Determine Python executable path (check venv first, then embedded)
      const isDev = process.env.NODE_ENV === 'development';
      
      let pythonPath;
      if (isDev) {
        // Dev: Check venv first, then embedded Python
        const venvPath = path.join(__dirname, 'python-env', 'venv', 'Scripts', 'python.exe');
        const embedPath = path.join(__dirname, 'python-env', 'python', 'python.exe');
        
        if (fs.existsSync(venvPath)) {
          pythonPath = venvPath;
          console.log('[Python] Using venv Python');
        } else if (fs.existsSync(embedPath)) {
          pythonPath = embedPath;
          console.log('[Python] Using embedded Python');
        } else {
          const error = 'Python not found. Create venv: cd electron/python-env && python -m venv venv';
          console.error('[Python]', error);
          reject(new Error(error));
          return;
        }
      } else {
        // Production: Use bundled embedded Python
        pythonPath = path.join(process.resourcesPath, 'python-env', 'python', 'python.exe');
      }
      
      const serverScript = isDev
        ? path.join(__dirname, 'python-server', 'model_server.py')
        : path.join(process.resourcesPath, 'python-server', 'model_server.py');
      
      console.log('[Python] Python path:', pythonPath);
      console.log('[Python] Server script:', serverScript);
      
      // Check if Python exists
      if (!fs.existsSync(pythonPath)) {
        const error = `Python not found at: ${pythonPath}`;
        console.error('[Python]', error);
        reject(new Error(error));
        return;
      }
      
      // Spawn Python process
      pythonServer = spawn(pythonPath, [serverScript], {
        env: {
          ...process.env,
          PYTHONUNBUFFERED: '1',  // Disable Python output buffering
        },
        windowsHide: true,  // Hide console window on Windows
      });
      
      // Handle stdout (port number, progress, logs)
      pythonServer.stdout.on('data', (data) => {
        const output = data.toString().trim();
        console.log('[Python]', output);
        
        // Parse special messages
        if (output.startsWith('SERVER_PORT:')) {
          pythonServerPort = parseInt(output.split(':')[1]);
          console.log(`[Python] ✅ Server running on port ${pythonServerPort}`);
          pythonServerReady = true;
          resolve(pythonServerPort);
        } else if (output.startsWith('DOWNLOAD_PROGRESS:')) {
          // Format: DOWNLOAD_PROGRESS:model_name:percent
          const parts = output.split(':');
          const modelName = parts[1];
          const percent = parseInt(parts[2]);
          
          // Send to renderer
          if (mainWindow) {
            mainWindow.webContents.send('python:download-progress', {
              model: modelName,
              percent: percent
            });
          }
        } else if (output.startsWith('ERROR:')) {
          const errorMsg = output.substring(6);
          console.error('[Python] ❌ Error:', errorMsg);
          if (mainWindow) {
            mainWindow.webContents.send('python:error', errorMsg);
          }
        }
      });
      
      // Handle stderr
      pythonServer.stderr.on('data', (data) => {
        console.error('[Python] stderr:', data.toString());
      });
      
      // Handle process exit
      pythonServer.on('close', (code) => {
        console.log(`[Python] Process exited with code ${code}`);
        pythonServerReady = false;
        pythonServerPort = null;
      });
      
      pythonServer.on('error', (err) => {
        console.error('[Python] Failed to start:', err);
        reject(err);
      });
      
      // Timeout if server doesn't start in 30 seconds
      setTimeout(() => {
        if (!pythonServerReady) {
          reject(new Error('Python server failed to start within 30 seconds'));
        }
      }, 30000);
      
    } catch (error) {
      console.error('[Python] Error starting server:', error);
      reject(error);
    }
  });
}

/**
 * Stop Python server
 */
function stopPythonServer() {
  if (pythonServer) {
    console.log('[Python] Stopping server...');
    pythonServer.kill();
    pythonServer = null;
    pythonServerReady = false;
    pythonServerPort = null;
  }
}

/**
 * Get Python server WebSocket URL
 */
function getPythonServerUrl() {
  if (!pythonServerReady || !pythonServerPort) {
    return null;
  }
  return `ws://127.0.0.1:${pythonServerPort}/ws`;
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

  // Setup IPC handlers
  setupScreenCaptureHandlers(ipcMain, desktopCapturer);
  setupOverlayHandlers(ipcMain, getMainWindow);
  setupLectureOverlayHandlers(ipcMain, getMainWindow);
  setupWhisperHandlers(ipcMain);
  setupRecordingHandlers(ipcMain);
  
  // Python server IPC handlers
  ipcMain.handle('python:get-server-url', () => {
    return getPythonServerUrl();
  });
  
  ipcMain.handle('python:is-ready', () => {
    return pythonServerReady;
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
app.whenReady().then(async () => {
  // Register video protocol handler for serving local video files
  protocol.registerFileProtocol('video', (request, callback) => {
    try {
      const url = request.url.substr(8); // Remove 'video://' prefix
      const filePath = decodeURIComponent(url);
      console.log('[Protocol] Video request:', request.url);
      console.log('[Protocol] Resolved path:', filePath);
      
      // Check if file exists
      const fs = require('fs');
      if (!fs.existsSync(filePath)) {
        console.error('[Protocol] File not found:', filePath);
        callback({ error: -6 }); // net::ERR_FILE_NOT_FOUND
        return;
      }
      
      callback({ path: filePath });
    } catch (err) {
      console.error('[Protocol] Error handling video request:', err);
      callback({ error: -2 }); // net::FAILED
    }
  });

  // Start Python server before creating window
  try {
    await startPythonServer();
    console.log('[Main] ✅ Python server started successfully');
  } catch (error) {
    console.error('[Main] ❌ Failed to start Python server:', error);
    // Continue anyway - app can still work in Interview mode with Gemini API
  }

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  // Stop Python server
  stopPythonServer();
  
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  // Ensure Python server is stopped
  stopPythonServer();
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
