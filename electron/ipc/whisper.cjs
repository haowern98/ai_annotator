const path = require('path');
const fs = require('fs').promises;
const os = require('os');

let pipeline = null;
let isInitialized = false;

/**
 * Initialize Whisper using Transformers.js (works without compilation)
 */
async function initializeWhisper(modelName = 'tiny.en') {
  if (isInitialized) {
    console.log('[Whisper IPC] Already initialized');
    return { success: true };
  }

  try {
    console.log('[Whisper IPC] Initializing Transformers.js Whisper...');
    
    // Import transformers.js
    const { pipeline: createPipeline } = await import('@xenova/transformers');
    
    console.log('[Whisper IPC] Loading whisper model (this may take a moment on first run)...');
    
    // Initialize the automatic-speech-recognition pipeline
    // Using distil-whisper for faster performance
    pipeline = await createPipeline(
      'automatic-speech-recognition',
      'distil-whisper/distil-small.en',
      { dtype: 'fp32' }
    );
    
    isInitialized = true;
    console.log('[Whisper IPC] ✓ Transformers.js Whisper initialized successfully');
    return { success: true };
  } catch (error) {
    console.error('[Whisper IPC] ❌ Failed to initialize:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Transcribe audio buffer using Transformers.js
 */
async function transcribeAudio(audioBuffer, options = {}) {
  if (!isInitialized || !pipeline) {
    throw new Error('Whisper not initialized. Call initialize first.');
  }

  try {
    console.log('[Whisper IPC] Transcribing audio...');
    const startTime = Date.now();
    
    // Convert PCM16 buffer to Float32Array for Transformers.js
    const float32Audio = convertPCM16ToFloat32(audioBuffer);
    
    // Transcribe using Transformers.js
    const result = await pipeline(float32Audio, {
      language: 'english',
      task: 'transcribe',
      chunk_length_s: 30,
      stride_length_s: 5,
      return_timestamps: false,
    });

    const elapsed = Date.now() - startTime;
    const text = result.text || '';
    
    console.log(`[Whisper IPC] ✓ Transcription complete in ${elapsed}ms: "${text}"`);

    return { success: true, text: text.trim(), elapsed };
  } catch (error) {
    console.error('[Whisper IPC] ❌ Transcription failed:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Convert PCM16 buffer to Float32Array
 */
function convertPCM16ToFloat32(buffer) {
  const int16Array = new Int16Array(buffer.buffer, buffer.byteOffset, buffer.length / 2);
  const float32Array = new Float32Array(int16Array.length);
  
  for (let i = 0; i < int16Array.length; i++) {
    // Convert from Int16 range (-32768 to 32767) to Float32 range (-1.0 to 1.0)
    float32Array[i] = int16Array[i] / 32768.0;
  }
  
  return float32Array;
}

/**
 * Dispose Whisper instance
 */
function disposeWhisper() {
  if (pipeline) {
    console.log('[Whisper IPC] Disposing Whisper instance...');
    pipeline = null;
    isInitialized = false;
  }
}

/**
 * Setup Whisper IPC handlers
 */
function setupWhisperHandlers(ipcMain) {
  console.log('[Whisper IPC] Setting up handlers...');

  // Initialize Whisper
  ipcMain.handle('whisper:initialize', async (event, modelName) => {
    return await initializeWhisper(modelName);
  });

  // Transcribe audio
  ipcMain.handle('whisper:transcribe', async (event, audioBuffer, options) => {
    try {
      // Validate input
      if (!audioBuffer) {
        console.error('[Whisper IPC] No audio buffer provided');
        return { success: false, error: 'No audio buffer provided' };
      }

      // Convert array to Buffer if needed
      let buffer;
      try {
        buffer = Buffer.isBuffer(audioBuffer) ? audioBuffer : Buffer.from(audioBuffer);
      } catch (bufferError) {
        console.error('[Whisper IPC] Failed to convert to buffer:', bufferError);
        return { success: false, error: 'Invalid audio buffer format' };
      }

      // Check buffer size
      if (buffer.length === 0) {
        console.log('[Whisper IPC] Empty audio buffer, skipping');
        return { success: true, text: '', elapsed: 0 };
      }

      return await transcribeAudio(buffer, options);
    } catch (error) {
      console.error('[Whisper IPC] Handler error:', error);
      return { success: false, error: error.message };
    }
  });

  // Dispose Whisper
  ipcMain.handle('whisper:dispose', async () => {
    disposeWhisper();
    return { success: true };
  });

  console.log('[Whisper IPC] ✓ Handlers registered');
}

module.exports = { setupWhisperHandlers };
