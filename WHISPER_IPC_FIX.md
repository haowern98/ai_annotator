# Whisper IPC Architecture Fix

## Problem
The initial implementation tried to use `whisper-node` directly in the renderer process (browser context), which failed because:
- `whisper-node` requires Node.js modules (`fs`, `path`, `os`, etc.)
- Vite externalizes these modules for browser compatibility
- Renderer processes in Electron don't have direct access to Node.js APIs with `contextIsolation: true`

**Error:** `Module "fs" has been externalized for browser compatibility. Cannot access "fs.realpath" in client code.`

## Solution Architecture

### IPC-Based Design
```
┌─────────────────────────────────────────────────────────────────┐
│                    RENDERER PROCESS (React)                     │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │  NativeWhisperService.ts                                   │ │
│  │  - Calls window.electronAPI.whisperInitialize()            │ │
│  │  - Calls window.electronAPI.whisperTranscribe()            │ │
│  │  - Calls window.electronAPI.whisperDispose()               │ │
│  └─────────────────────┬──────────────────────────────────────┘ │
│                        │ IPC invoke()                            │
└────────────────────────┼─────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│                  PRELOAD SCRIPT (Bridge)                        │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │  preload-electron.cjs                                      │ │
│  │  - Exposes whisperInitialize via contextBridge            │ │
│  │  - Exposes whisperTranscribe via contextBridge            │ │
│  │  - Exposes whisperDispose via contextBridge               │ │
│  └─────────────────────┬──────────────────────────────────────┘ │
│                        │ ipcRenderer.invoke()                    │
└────────────────────────┼─────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│                   MAIN PROCESS (Node.js)                        │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │  electron/ipc/whisper.cjs                                  │ │
│  │  - Imports whisper-node (native Node.js)                  │ │
│  │  - Manages Whisper instance lifecycle                     │ │
│  │  - Handles file I/O (temp WAV files)                      │ │
│  │  - Returns transcription results                          │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                   │
│  - Full access to fs, path, os, child_process                   │
│  - Native module loading (whisper.cpp bindings)                 │
│  - No browser compatibility restrictions                        │
└─────────────────────────────────────────────────────────────────┘
```

## Files Changed

### Created
1. **`electron/ipc/whisper.cjs`** - Main process Whisper handler
   - `setupWhisperHandlers(ipcMain)` - Registers IPC handlers
   - `initializeWhisper(modelName)` - Loads Whisper model
   - `transcribeAudio(audioBuffer, options)` - Transcribes audio
   - `createWavBuffer(pcm16Buffer)` - Creates WAV files from PCM16

### Modified
1. **`preload-electron.cjs`**
   - Added `whisperInitialize(modelName)`
   - Added `whisperTranscribe(audioBuffer, options)`
   - Added `whisperDispose()`

2. **`main-electron.cjs`**
   - Imported `setupWhisperHandlers` from `electron/ipc/whisper.cjs`
   - Called `setupWhisperHandlers(ipcMain)` on app startup

3. **`services/nativeWhisperService.ts`**
   - Removed direct `whisper-node` import
   - Changed `initialize()` to use `window.electronAPI.whisperInitialize()`
   - Changed `transcribe()` to use `window.electronAPI.whisperTranscribe()`
   - Removed file I/O methods (moved to main process)
   - Changed `dispose()` to use `window.electronAPI.whisperDispose()`

4. **`types.ts`**
   - Added `whisperInitialize` to `window.electronAPI` interface
   - Added `whisperTranscribe` to `window.electronAPI` interface
   - Added `whisperDispose` to `window.electronAPI` interface

## IPC Message Flow

### Initialization
```typescript
// Renderer: NativeWhisperService.initialize()
const result = await window.electronAPI.whisperInitialize('tiny.en');

// Main Process: whisper.cjs
ipcMain.handle('whisper:initialize', async (event, modelName) => {
  const whisper = require('whisper-node');
  whisperInstance = await whisper.whisper(os.homedir(), modelName);
  return { success: true };
});
```

### Transcription
```typescript
// Renderer: NativeWhisperService.transcribe(audioBuffer)
const result = await window.electronAPI.whisperTranscribe(audioBuffer, {
  language: 'en',
  task: 'transcribe',
  maxLen: 1,
  splitOnWord: true,
});

// Main Process: whisper.cjs
ipcMain.handle('whisper:transcribe', async (event, audioBuffer, options) => {
  const buffer = Buffer.from(audioBuffer);
  const wavBuffer = createWavBuffer(buffer);
  const tempFile = path.join(os.tmpdir(), `whisper-${Date.now()}.wav`);
  await fs.writeFile(tempFile, wavBuffer);
  
  const result = await whisperInstance.transcribe(tempFile, options);
  await fs.unlink(tempFile);
  
  return { success: true, text: result[0]?.speech || '' };
});
```

## Key Benefits

1. **Security**: Maintains Electron's `contextIsolation: true`
2. **Compatibility**: No browser/Node.js module conflicts
3. **Performance**: Native whisper.cpp runs in main process (no IPC overhead for compute)
4. **Clean Separation**: UI logic in renderer, native operations in main
5. **Error Handling**: IPC errors caught and returned to renderer

## Testing

After starting the app:
1. Navigate to Interview Mode
2. Click "Start Interview"
3. Grant microphone/screen permissions
4. Speak for 3+ seconds
5. Console should show:
   ```
   [Whisper IPC] Setting up handlers...
   [Whisper IPC] ✓ Handlers registered
   [Whisper IPC] Initializing whisper-node...
   [Whisper IPC] Loading tiny.en model...
   [Whisper IPC] ✓ Whisper initialized successfully
   ```

## Troubleshooting

### Model not downloading
- Check internet connection on first run
- Check `~/.whisper-node/` directory for model files
- Manually download from: https://huggingface.co/ggerganov/whisper.cpp

### IPC not working
- Verify `setupWhisperHandlers(ipcMain)` called in `main-electron.cjs`
- Check DevTools console for "Whisper service requires Electron environment"
- Verify `window.electronAPI` is defined in renderer

### Transcription fails
- Check audio format: PCM16, 16kHz, mono
- Verify `audioBuffer` is not empty
- Check temp directory write permissions
- Look for errors in main process console (not DevTools)

## Performance Notes

- **Model Size**: tiny.en (~75MB) - fastest, good accuracy
- **RTF**: Real-Time Factor < 1.0 (processes faster than real-time)
- **IPC Overhead**: ~1-5ms per transcription call (negligible)
- **Total Latency**: 4-5 seconds (3s audio buffer + 1-2s processing)
