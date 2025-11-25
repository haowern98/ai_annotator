const { app, BrowserWindow, ipcMain, desktopCapturer, Menu } = require('electron');
const path = require('path');
const { setupScreenCaptureHandlers } = require('./ipc/screenCapture.cjs');
const { setupOverlayHandlers } = require('./ipc/overlay.cjs');
const { setupWhisperHandlers } = require('./ipc/whisper.cjs');

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

let mainWindow;

function createWindow() {
  // Remove the default menu
  Menu.setApplicationMenu(null);

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
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
    backgroundColor: '#0f172a', // Match the app's dark background
    autoHideMenuBar: true,
    frame: true,
    titleBarStyle: 'default',
  });

  // Setup IPC handlers
  setupScreenCaptureHandlers(ipcMain, desktopCapturer);
  setupOverlayHandlers(ipcMain);
  setupWhisperHandlers(ipcMain);

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

app.whenReady().then(() => {
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
