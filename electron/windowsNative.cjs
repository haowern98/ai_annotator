/**
 * Native Windows API helper for setting extended window styles.
 * Uses koffi to call Windows User32 APIs without native compilation.
 * 
 * This module applies WS_EX_TOOLWINDOW style to hide the overlay from
 * Alt+Tab and many third-party window pickers.
 */

const os = require('os');

// Only run on Windows
const isWindows = os.platform() === 'win32';

let koffi = null;
let user32 = null;
let kernel32 = null;
let GetWindowLongPtrW = null;
let SetWindowLongPtrW = null;
let SetWindowDisplayAffinityFn = null;
let SetForegroundWindow = null;
let ShowWindow = null;
let GetForegroundWindow = null;
let AttachThreadInput = null;
let GetWindowThreadProcessId = null;
let GetCurrentThreadId = null;

// Windows constants
const GWL_EXSTYLE = -20;
const WS_EX_TOOLWINDOW = 0x00000080;
const WS_EX_APPWINDOW = 0x00040000;
const WS_EX_NOACTIVATE = 0x08000000;
const SW_RESTORE = 9;
const SW_SHOW = 5;

/**
 * Initialize the koffi library and load User32
 */
function initialize() {
  if (!isWindows) {
    console.log('[WindowsNative] Not on Windows, skipping initialization');
    return false;
  }

  if (user32) {
    return true; // Already initialized
  }

  try {
    koffi = require('koffi');
    user32 = koffi.load('user32.dll');
    
    // Use 'uint64' for HWND on 64-bit Windows, with __stdcall convention
    // GetWindowLongPtrW(HWND hWnd, int nIndex) -> LONG_PTR
    GetWindowLongPtrW = user32.func('__stdcall', 'GetWindowLongPtrW', 'int64', ['uint64', 'int']);
    
    // SetWindowLongPtrW(HWND hWnd, int nIndex, LONG_PTR dwNewLong) -> LONG_PTR
    SetWindowLongPtrW = user32.func('__stdcall', 'SetWindowLongPtrW', 'int64', ['uint64', 'int', 'int64']);
    
    // SetWindowDisplayAffinity(HWND hWnd, DWORD dwAffinity) -> BOOL
    SetWindowDisplayAffinityFn = user32.func('__stdcall', 'SetWindowDisplayAffinity', 'int', ['uint64', 'uint32']);
    
    // Window focusing APIs
    SetForegroundWindow = user32.func('__stdcall', 'SetForegroundWindow', 'int', ['uint64']);
    ShowWindow = user32.func('__stdcall', 'ShowWindow', 'int', ['uint64', 'int']);
    GetForegroundWindow = user32.func('__stdcall', 'GetForegroundWindow', 'uint64', []);
    AttachThreadInput = user32.func('__stdcall', 'AttachThreadInput', 'int', ['uint32', 'uint32', 'int']);
    GetWindowThreadProcessId = user32.func('__stdcall', 'GetWindowThreadProcessId', 'uint32', ['uint64', 'void*']);
    
    // Load kernel32 for GetCurrentThreadId
    kernel32 = koffi.load('kernel32.dll');
    GetCurrentThreadId = kernel32.func('__stdcall', 'GetCurrentThreadId', 'uint32', []);
    
    console.log('[WindowsNative] Loaded user32.dll successfully');
    return true;
  } catch (err) {
    console.error('[WindowsNative] Failed to load user32.dll:', err.message);
    return false;
  }
}

/**
 * Convert a Node Buffer containing HWND to a BigInt
 * @param {Buffer} hwndBuffer - The window handle buffer from Electron
 * @returns {BigInt} The handle as a BigInt
 */
function bufferToHwnd(hwndBuffer) {
  if (!hwndBuffer || hwndBuffer.length === 0) {
    return 0n;
  }
  // Read as 64-bit little-endian unsigned integer
  return hwndBuffer.readBigUInt64LE(0);
}

/**
 * Get the extended window style for a window handle
 * @param {BigInt} hwnd - The window handle as BigInt
 * @returns {number} The extended window style bits
 */
function getWindowExStyle(hwnd) {
  if (!initialize()) return 0;

  try {
    const result = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
    return Number(result);
  } catch (err) {
    console.error('[WindowsNative] Failed to get window ex style:', err.message);
    return 0;
  }
}

/**
 * Set the extended window style for a window handle
 * @param {BigInt} hwnd - The window handle as BigInt
 * @param {number} style - The new extended window style bits
 * @returns {boolean} Success status
 */
function setWindowExStyle(hwnd, style) {
  if (!initialize()) return false;

  try {
    const result = SetWindowLongPtrW(hwnd, GWL_EXSTYLE, BigInt(style));
    return result !== 0n;
  } catch (err) {
    console.error('[WindowsNative] Failed to set window ex style:', err.message);
    return false;
  }
}

/**
 * Apply WS_EX_TOOLWINDOW style to hide window from Alt+Tab and most pickers
 * @param {BrowserWindow} browserWindow - The Electron BrowserWindow instance
 * @returns {boolean} Success status
 */
function applyToolWindowStyle(browserWindow) {
  if (!isWindows) {
    console.log('[WindowsNative] Not on Windows, skipping tool window style');
    return false;
  }

  if (!browserWindow || browserWindow.isDestroyed()) {
    console.error('[WindowsNative] Invalid or destroyed browser window');
    return false;
  }

  if (!initialize()) {
    return false;
  }

  try {
    // Get the native window handle from Electron
    const hwndBuffer = browserWindow.getNativeWindowHandle();
    
    if (!hwndBuffer || hwndBuffer.length === 0) {
      console.error('[WindowsNative] Failed to get native window handle');
      return false;
    }

    // Convert buffer to BigInt for koffi
    const hwnd = bufferToHwnd(hwndBuffer);
    console.log('[WindowsNative] Window handle:', '0x' + hwnd.toString(16));

    // Get current extended style
    const currentStyle = getWindowExStyle(hwnd);
    console.log('[WindowsNative] Current extended style:', '0x' + currentStyle.toString(16));

    // Add WS_EX_TOOLWINDOW, remove WS_EX_APPWINDOW (which forces it into taskbar/alt+tab)
    // Note: We do NOT add WS_EX_NOACTIVATE so the overlay can receive keyboard input
    const newStyle = (currentStyle | WS_EX_TOOLWINDOW) & ~WS_EX_APPWINDOW;
    console.log('[WindowsNative] New extended style:', '0x' + newStyle.toString(16));

    const success = setWindowExStyle(hwnd, newStyle);
    
    if (success) {
      console.log('[WindowsNative] ✅ Successfully applied WS_EX_TOOLWINDOW style');
    } else {
      console.error('[WindowsNative] ❌ Failed to apply WS_EX_TOOLWINDOW style');
    }

    return success;
  } catch (err) {
    console.error('[WindowsNative] Error applying tool window style:', err.message);
    return false;
  }
}

/**
 * Apply additional display affinity settings to exclude from capture
 * Uses SetWindowDisplayAffinity API (Windows 7+)
 * @param {BrowserWindow} browserWindow - The Electron BrowserWindow instance
 * @param {number} affinity - The display affinity value (0 = none, 0x11 = exclude from capture)
 * @returns {boolean} Success status
 */
function setDisplayAffinity(browserWindow, affinity = 0x11) {
  if (!isWindows) {
    return false;
  }

  if (!browserWindow || browserWindow.isDestroyed()) {
    return false;
  }

  if (!initialize()) {
    return false;
  }

  try {
    const hwndBuffer = browserWindow.getNativeWindowHandle();
    
    if (!hwndBuffer || hwndBuffer.length === 0) {
      return false;
    }

    // Convert buffer to BigInt for koffi
    const hwnd = bufferToHwnd(hwndBuffer);

    const success = SetWindowDisplayAffinityFn(hwnd, affinity);
    
    if (success) {
      console.log('[WindowsNative] ✅ Applied display affinity:', '0x' + affinity.toString(16));
    } else {
      console.error('[WindowsNative] ❌ Failed to apply display affinity');
    }

    return success !== 0;
  } catch (err) {
    console.error('[WindowsNative] Error setting display affinity:', err.message);
    return false;
  }
}

/**
 * Parse HWND from desktopCapturer source ID
 * @param {string} sourceId - The source ID (e.g., 'window:12345678:0')
 * @returns {BigInt|null} The window handle or null if it's a screen
 */
function parseHwndFromSourceId(sourceId) {
  if (!sourceId) return null;
  const match = sourceId.match(/^window:(\d+):/);
  if (match) {
    return BigInt(match[1]);
  }
  return null; // It's a screen, not a window
}

/**
 * Focus an external window by HWND (Zoom-like behavior)
 * @param {BigInt|number} hwnd - The window handle
 * @returns {boolean} Success status
 */
function focusWindow(hwnd) {
  if (!isWindows || !initialize()) return false;

  const hwndBigInt = typeof hwnd === 'bigint' ? hwnd : BigInt(hwnd);

  try {
    // First, restore if minimized
    ShowWindow(hwndBigInt, SW_RESTORE);

    // Get foreground window's thread to attach to
    const foregroundHwnd = GetForegroundWindow();
    const foregroundThread = GetWindowThreadProcessId(foregroundHwnd, null);
    const currentThread = GetCurrentThreadId();

    // Attach input to foreground thread (allows SetForegroundWindow)
    AttachThreadInput(currentThread, foregroundThread, 1);

    // Now bring window to foreground
    const result = SetForegroundWindow(hwndBigInt);

    // Detach threads
    AttachThreadInput(currentThread, foregroundThread, 0);

    if (result) {
      console.log('[WindowsNative] ✅ Successfully focused window:', '0x' + hwndBigInt.toString(16));
    } else {
      console.log('[WindowsNative] ⚠️ SetForegroundWindow returned false');
    }

    return result !== 0;
  } catch (err) {
    console.error('[WindowsNative] Failed to focus window:', err.message);
    return false;
  }
}

/**
 * Focus a captured window by its source ID
 * @param {string} sourceId - The desktopCapturer source ID
 * @returns {{success: boolean, isScreen?: boolean, error?: string}} Result
 */
function focusCapturedWindow(sourceId) {
  if (!isWindows) {
    return { success: false, error: 'Only supported on Windows' };
  }

  const hwnd = parseHwndFromSourceId(sourceId);
  if (!hwnd) {
    // It's a screen capture - nothing to focus, but that's OK
    return { success: true, isScreen: true };
  }

  const success = focusWindow(hwnd);
  return { success, hwnd: hwnd.toString() };
}

module.exports = {
  isWindows,
  applyToolWindowStyle,
  setDisplayAffinity,
  focusWindow,
  focusCapturedWindow,
  parseHwndFromSourceId,
  WS_EX_TOOLWINDOW,
  WS_EX_APPWINDOW,
  WS_EX_NOACTIVATE,
};
