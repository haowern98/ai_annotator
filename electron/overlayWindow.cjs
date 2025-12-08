const { BrowserWindow, screen } = require('electron');
const path = require('path');
const { applyToolWindowStyle, setDisplayAffinity, isWindows } = require('./windowsNative.cjs');

let overlayWindow = null;

/**
 * Create overlay window that floats on top of the selected browser
 * Positioned at center-top of the screen
 */
function createOverlayWindow() {
  if (overlayWindow) {
    overlayWindow.focus();
    return overlayWindow;
  }

  // Get primary display dimensions to center the window
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width: screenWidth } = primaryDisplay.workAreaSize;
  
  const windowWidth = 950;
  const windowHeight = 380;
  const xPosition = Math.round((screenWidth - windowWidth) / 2); // Center horizontally
  const yPosition = 10; // Small offset from top

  overlayWindow = new BrowserWindow({
    width: windowWidth,
    height: windowHeight,
    x: xPosition,
    y: yPosition,
    alwaysOnTop: true,
    frame: false,
    transparent: true,
    resizable: true,
    movable: true,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true, // Don't show in taskbar
    hasShadow: false, // Disable shadow for cleaner transparent look
    focusable: true, // Allow focus but we'll manage it
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.cjs'), // Use electron/preload.cjs
    },
  });

  // Use 'screen-saver' level for highest always-on-top priority
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');

  // Re-assert always-on-top when window loses focus to prevent disappearing
  overlayWindow.on('blur', () => {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      // Small delay to let other windows settle, then re-assert position
      setTimeout(() => {
        if (overlayWindow && !overlayWindow.isDestroyed()) {
          overlayWindow.setAlwaysOnTop(true, 'screen-saver');
        }
      }, 100);
    }
  });

  // Periodic keep-alive to ensure overlay stays visible
  const keepAliveInterval = setInterval(() => {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      // Re-assert always-on-top periodically in case it got lost
      overlayWindow.setAlwaysOnTop(true, 'screen-saver');
      // If somehow hidden, show it again
      if (!overlayWindow.isVisible()) {
        overlayWindow.show();
        console.log('[Overlay] Restored visibility via keep-alive');
      }
    } else {
      clearInterval(keepAliveInterval);
    }
  }, 3000);

  // Mark this window so it can be identified and filtered out from screen capture lists
  try {
    overlayWindow.setTitle('LLS Overlay');
  } catch (e) {
    console.warn('[Overlay] Failed to set title marker:', e);
  }

  // Prevent most OS-level screen capture from including the overlay's pixels
  try {
    // setContentProtection is supported on macOS and Windows (Electron)
    overlayWindow.setContentProtection(true);
  } catch (e) {
    console.warn('[Overlay] Failed to enable content protection:', e);
  }

  // Apply native Windows styles to hide from Alt+Tab and window pickers
  if (isWindows) {
    // Wait for window to be ready before applying native styles
    overlayWindow.once('ready-to-show', () => {
      try {
        // Apply WS_EX_TOOLWINDOW to hide from Alt+Tab and many window pickers
        const toolWindowSuccess = applyToolWindowStyle(overlayWindow);
        if (toolWindowSuccess) {
          console.log('[Overlay] ✅ Applied WS_EX_TOOLWINDOW - hidden from Alt+Tab');
        }

        // Also apply display affinity for additional capture protection
        // 0x11 = WDA_EXCLUDEFROMCAPTURE (Windows 10 2004+)
        const affinitySuccess = setDisplayAffinity(overlayWindow, 0x11);
        if (affinitySuccess) {
          console.log('[Overlay] ✅ Applied WDA_EXCLUDEFROMCAPTURE display affinity');
        }
      } catch (err) {
        console.warn('[Overlay] Failed to apply native window styles:', err);
      }
    });
  }

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
