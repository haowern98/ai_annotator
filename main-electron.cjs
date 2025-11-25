// Now that we're in root, require('electron') should work properly
console.log('[DEBUG] About to require electron...');
console.log('[DEBUG] __dirname:', __dirname);
console.log('[DEBUG] process.versions.electron:', process.versions.electron);

const electronModule = require('electron');
console.log('[DEBUG] electron type:', typeof electronModule);
console.log('[DEBUG] electron value:', electronModule);

const { app, BrowserWindow, ipcMain, desktopCapturer, Menu } = electronModule;
console.log('[DEBUG] app type:', typeof app);

const path = require('path');
const { setupScreenCaptureHandlers } = require('./electron/ipc/screenCapture.cjs');
const { setupOverlayHandlers } = require('./electron/ipc/overlay.cjs');
const { setupWhisperHandlers } = require('./electron/ipc/whisper.cjs');

// DO NOT disable hardware acceleration - it prevents video frame delivery
// app.disableHardwareAcceleration();

// CRITICAL FIX: Configure Electron command-line switches BEFORE app.whenReady()
// These switches must be set synchronously at startup, before any app lifecycle events

// Only set command-line switches if app is properly loaded
if (app && app.commandLine) {
  // Configure Electron for better screen/video capture
  app.commandLine.appendSwitch('disable-features', 'HardwareMediaKeyHandling');

  // CRITICAL: Disable Windows Graphics Capture (WGC) and use legacy GDI capture
  // WGC cannot capture hardware-accelerated windows (Chrome tabs with video, games, etc.)
  app.commandLine.appendSwitch('disable-features', 'WebRtcUseWgcCapturer');

  // Try enabling these for better video capture
  app.commandLine.appendSwitch('enable-usermedia-screen-capturing');
} else {
  console.error('[ERROR] app or app.commandLine is undefined!');
}

// Alternative GPU flags (uncomment if video still shows black after disabling hardware acceleration):
// app.commandLine.appendSwitch('use-angle', 'gl'); // Force OpenGL backend
// app.commandLine.appendSwitch('enable-features', 'VaapiVideoDecoder'); // Enable hardware video decoding
// app.commandLine.appendSwitch('disable-gpu'); // Completely disable GPU (last resort)

let mainWindow;

function createWindow() {
  // Remove the default menu
  Menu.setApplicationMenu(null);

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      preload: path.join(__dirname, 'preload-electron.cjs'),
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
});
