const { BrowserWindow } = require('electron');
const path = require('path');

let overlayWindow = null;

/**
 * Create overlay window that floats on top of the selected browser
 */
function createOverlayWindow() {
  if (overlayWindow) {
    overlayWindow.focus();
    return overlayWindow;
  }

  overlayWindow = new BrowserWindow({
    width: 600,
    height: 400,
    x: 100, // Position from left edge
    y: 100, // Position from top edge
    alwaysOnTop: true,
    frame: false,
    transparent: true,
    resizable: true,
    movable: true,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true, // Don't show in taskbar
    hasShadow: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.cjs'), // Use electron/preload.cjs
    },
  });

  // Load the overlay HTML
  const port = process.env.VITE_PORT || '5173';
  if (process.env.NODE_ENV === 'development') {
    // Try multiple ports in case Vite is on a different port
    const loadUrl = async () => {
      const ports = [port, '5173', '5174', '5175', '5176'];
      for (const p of ports) {
        try {
          await overlayWindow.loadURL(`http://localhost:${p}/overlay.html`);
          console.log(`[Overlay] Loaded from port ${p}`);
          return;
        } catch (err) {
          console.log(`[Overlay] Failed to load from port ${p}, trying next...`);
        }
      }
      console.error('[Overlay] Failed to load from any port');
    };
    loadUrl().catch(err => console.error('[Overlay] Load error:', err));
  } else {
    overlayWindow.loadFile(path.join(__dirname, '..', 'dist', 'overlay.html'));
  }

  // Handle errors
  overlayWindow.webContents.on('crashed', (event, killed) => {
    console.error('[Overlay] Window crashed!', { killed });
  });

  overlayWindow.webContents.on('render-process-gone', (event, details) => {
    console.error('[Overlay] Render process gone!', details);
  });

  overlayWindow.on('unresponsive', () => {
    console.error('[Overlay] Window became unresponsive');
  });

  // Handle window closed
  overlayWindow.on('closed', () => {
    overlayWindow = null;
  });

  return overlayWindow;
}

/**
 * Get the overlay window instance
 */
function getOverlayWindow() {
  return overlayWindow;
}

/**
 * Close the overlay window
 */
function closeOverlayWindow() {
  if (overlayWindow) {
    overlayWindow.close();
    overlayWindow = null;
  }
}

/**
 * Show the overlay window
 */
function showOverlayWindow() {
  if (overlayWindow) {
    overlayWindow.show();
    overlayWindow.focus();
  }
}

/**
 * Hide the overlay window
 */
function hideOverlayWindow() {
  if (overlayWindow) {
    overlayWindow.hide();
  }
}

/**
 * Check if overlay window exists
 */
function hasOverlayWindow() {
  return overlayWindow !== null && !overlayWindow.isDestroyed();
}

module.exports = {
  createOverlayWindow,
  getOverlayWindow,
  closeOverlayWindow,
  showOverlayWindow,
  hideOverlayWindow,
  hasOverlayWindow,
};
