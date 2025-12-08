const { BrowserWindow, screen } = require('electron');
const path = require('path');
const { applyToolWindowStyle, setDisplayAffinity, isWindows } = require('./windowsNative.cjs');

let lectureOverlayWindow = null;

/**
 * Create lecture overlay window that floats on top
 * Positioned at center-top of the screen (separate from Interview overlay)
 */
function createLectureOverlayWindow() {
  if (lectureOverlayWindow) {
    lectureOverlayWindow.focus();
    return lectureOverlayWindow;
  }

  // Get primary display dimensions
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width: screenWidth } = primaryDisplay.workAreaSize;
  
  const windowWidth = 950;
  const windowHeight = 450; // Slightly taller for two sections
  const xPosition = Math.round((screenWidth - windowWidth) / 2);
  const yPosition = 10;

  lectureOverlayWindow = new BrowserWindow({
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
    skipTaskbar: true,
    hasShadow: false,
    focusable: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });

  // Use 'screen-saver' level for highest always-on-top priority
  lectureOverlayWindow.setAlwaysOnTop(true, 'screen-saver');

  // Re-assert always-on-top when window loses focus
  lectureOverlayWindow.on('blur', () => {
    if (lectureOverlayWindow && !lectureOverlayWindow.isDestroyed()) {
      setTimeout(() => {
        if (lectureOverlayWindow && !lectureOverlayWindow.isDestroyed()) {
          lectureOverlayWindow.setAlwaysOnTop(true, 'screen-saver');
        }
      }, 100);
    }
  });

  // Periodic keep-alive
  const keepAliveInterval = setInterval(() => {
    if (lectureOverlayWindow && !lectureOverlayWindow.isDestroyed()) {
      lectureOverlayWindow.setAlwaysOnTop(true, 'screen-saver');
      if (!lectureOverlayWindow.isVisible()) {
        lectureOverlayWindow.show();
        console.log('[LectureOverlay] Restored visibility via keep-alive');
      }
    } else {
      clearInterval(keepAliveInterval);
    }
  }, 3000);

  // Mark this window
  try {
    lectureOverlayWindow.setTitle('LLS Lecture Overlay');
  } catch (e) {
    console.warn('[LectureOverlay] Failed to set title marker:', e);
  }

  // Prevent screen capture from including the overlay
  try {
    lectureOverlayWindow.setContentProtection(true);
  } catch (e) {
    console.warn('[LectureOverlay] Failed to enable content protection:', e);
  }

  // Apply native Windows styles
  if (isWindows) {
    lectureOverlayWindow.once('ready-to-show', () => {
      try {
        const toolWindowSuccess = applyToolWindowStyle(lectureOverlayWindow);
        if (toolWindowSuccess) {
          console.log('[LectureOverlay] ✅ Applied WS_EX_TOOLWINDOW');
        }

        const affinitySuccess = setDisplayAffinity(lectureOverlayWindow, 0x11);
        if (affinitySuccess) {
          console.log('[LectureOverlay] ✅ Applied WDA_EXCLUDEFROMCAPTURE');
        }
      } catch (err) {
        console.warn('[LectureOverlay] Failed to apply native window styles:', err);
      }
    });
  }

  // Load the lecture overlay HTML
  const port = process.env.VITE_PORT || '5173';
  if (process.env.NODE_ENV === 'development') {
    const loadUrl = async () => {
      const ports = [port, '5173', '5174', '5175', '5176'];
      for (const p of ports) {
        try {
          await lectureOverlayWindow.loadURL(`http://localhost:${p}/lecture-overlay.html`);
          console.log(`[LectureOverlay] Loaded from port ${p}`);
          return;
        } catch (err) {
          console.log(`[LectureOverlay] Failed to load from port ${p}, trying next...`);
        }
      }
      console.error('[LectureOverlay] Failed to load from any port');
    };
    loadUrl().catch(err => console.error('[LectureOverlay] Load error:', err));
  } else {
    lectureOverlayWindow.loadFile(path.join(__dirname, '..', 'dist', 'lecture-overlay.html'));
  }

  // Handle errors
  lectureOverlayWindow.webContents.on('crashed', (event, killed) => {
    console.error('[LectureOverlay] Window crashed!', { killed });
  });

  lectureOverlayWindow.webContents.on('render-process-gone', (event, details) => {
    console.error('[LectureOverlay] Render process gone!', details);
  });

  lectureOverlayWindow.on('unresponsive', () => {
    console.error('[LectureOverlay] Window became unresponsive');
  });

  lectureOverlayWindow.on('closed', () => {
    lectureOverlayWindow = null;
  });

  return lectureOverlayWindow;
}

/**
 * Get the lecture overlay window instance
 */
function getLectureOverlayWindow() {
  return lectureOverlayWindow;
}

/**
 * Close the lecture overlay window
 */
function closeLectureOverlayWindow() {
  if (lectureOverlayWindow) {
    lectureOverlayWindow.close();
    lectureOverlayWindow = null;
  }
}

/**
 * Show the lecture overlay window
 */
function showLectureOverlayWindow() {
  if (lectureOverlayWindow) {
    lectureOverlayWindow.show();
    lectureOverlayWindow.focus();
  }
}

/**
 * Hide the lecture overlay window
 */
function hideLectureOverlayWindow() {
  if (lectureOverlayWindow) {
    lectureOverlayWindow.hide();
  }
}

/**
 * Check if lecture overlay window exists
 */
function hasLectureOverlayWindow() {
  return lectureOverlayWindow !== null && !lectureOverlayWindow.isDestroyed();
}

/**
 * Resize the lecture overlay window
 */
function resizeLectureOverlayWindow(width, height) {
  if (lectureOverlayWindow && !lectureOverlayWindow.isDestroyed()) {
    lectureOverlayWindow.setSize(width, height);
  }
}

/**
 * Send data to the lecture overlay window
 */
function sendToLectureOverlay(channel, data) {
  if (lectureOverlayWindow && !lectureOverlayWindow.isDestroyed()) {
    lectureOverlayWindow.webContents.send(channel, data);
  }
}

module.exports = {
  createLectureOverlayWindow,
  getLectureOverlayWindow,
  closeLectureOverlayWindow,
  showLectureOverlayWindow,
  hideLectureOverlayWindow,
  hasLectureOverlayWindow,
  resizeLectureOverlayWindow,
  sendToLectureOverlay,
};
