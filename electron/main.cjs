const { app, BrowserWindow, ipcMain, desktopCapturer, Menu, dialog, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs');
const { setupScreenCaptureHandlers } = require('./ipc/screenCapture.cjs');
const { setupOverlayHandlers } = require('./ipc/overlay.cjs');
const { setupLectureOverlayHandlers } = require('./ipc/lectureOverlay.cjs');
const { setupWhisperHandlers } = require('./ipc/whisper.cjs');
const { setupRecordingHandlers } = require('./ipc/recording.cjs');
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
      secure: true,
      supportFetchAPI: true,
      bypassCSP: true,
      stream: true
    }
  }
]);

let mainWindow;

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

  createWindow();

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
