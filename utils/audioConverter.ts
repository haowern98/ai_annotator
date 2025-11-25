/**
 * Audio conversion utilities for processing audio data
 * Converts between different formats needed for Whisper transcription
 */

/**
 * Convert Float32Array PCM audio to 16-bit PCM Uint8Array
 * @param float32Array - Audio data from AudioWorklet (-1.0 to 1.0)
 * @returns Uint8Array containing 16-bit PCM audio
 */
export function float32ToPCM16(float32Array: Float32Array): Uint8Array {
  const buffer = new Uint8Array(float32Array.length * 2);
  const view = new DataView(buffer.buffer);
  
  for (let i = 0; i < float32Array.length; i++) {
    // Clamp to [-1, 1]
    const s = Math.max(-1, Math.min(1, float32Array[i]));
    // Convert to 16-bit integer
    const val = s < 0 ? s * 0x8000 : s * 0x7fff;
    view.setInt16(i * 2, Math.round(val), true); // true = little endian
  }
  
  return buffer;
}

/**
 * Resample audio from one sample rate to another
 * Simple linear interpolation resampling
 * @param audioData - Source audio data
 * @param sourceSampleRate - Source sample rate (e.g., 48000)
 * @param targetSampleRate - Target sample rate (e.g., 16000)
 * @returns Resampled audio data
 */
export function resampleAudio(
  audioData: Float32Array,
  sourceSampleRate: number,
  targetSampleRate: number
): Float32Array {
  if (sourceSampleRate === targetSampleRate) {
    return audioData;
  }

  const ratio = sourceSampleRate / targetSampleRate;
  const newLength = Math.round(audioData.length / ratio);
  const result = new Float32Array(newLength);

  for (let i = 0; i < newLength; i++) {
    const srcIndex = i * ratio;
    const srcIndexFloor = Math.floor(srcIndex);
    const srcIndexCeil = Math.min(srcIndexFloor + 1, audioData.length - 1);
    const t = srcIndex - srcIndexFloor;

    // Linear interpolation
    result[i] =
      audioData[srcIndexFloor] * (1 - t) + audioData[srcIndexCeil] * t;
  }

  return result;
}

/**
 * Merge multiple audio buffers into a single buffer
 * @param buffers - Array of audio buffers to merge
 * @returns Single merged buffer
 */
export function mergeAudioBuffers(buffers: Buffer[]): Buffer {
  const totalLength = buffers.reduce((sum, buf) => sum + buf.length, 0);
  return Buffer.concat(buffers, totalLength);
}

/**
 * Merge multiple Float32Array audio chunks into a single array
 * @param chunks - Array of Float32Array chunks
 * @returns Single merged Float32Array
 */
export function mergeFloat32Arrays(chunks: Float32Array[]): Float32Array {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Float32Array(totalLength);
  
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  
  return result;
}

/**
 * Calculate duration of audio buffer in seconds
 * @param buffer - Audio buffer (16-bit PCM)
 * @param sampleRate - Sample rate in Hz
 * @returns Duration in seconds
 */
export function getAudioDuration(buffer: Buffer, sampleRate: number): number {
  const numSamples = buffer.length / 2; // 16-bit = 2 bytes per sample
  return numSamples / sampleRate;
}

/**
 * Convert base64 audio to Buffer
 * @param base64Audio - Base64-encoded audio string
 * @returns Buffer containing audio data
 */
export function base64ToBuffer(base64Audio: string): Buffer {
  return Buffer.from(base64Audio, 'base64');
}

/**
 * Convert Buffer to base64
 * @param buffer - Audio buffer
 * @returns Base64-encoded string
 */
export function bufferToBase64(buffer: Buffer): string {
  return buffer.toString('base64');
}

/**
 * Check if audio buffer contains silence (energy-based)
 * @param float32Array - Audio data
 * @param threshold - Energy threshold (0.0-1.0), default 0.01
 * @returns true if audio is mostly silence
 */
export function isSilence(
  float32Array: Float32Array,
  threshold: number = 0.01
): boolean {
  let sumSquares = 0;
  for (let i = 0; i < float32Array.length; i++) {
    sumSquares += float32Array[i] * float32Array[i];
  }
  const rms = Math.sqrt(sumSquares / float32Array.length);
  return rms < threshold;
}

/**
 * Apply gain to audio data
 * @param float32Array - Audio data
 * @param gain - Gain multiplier (1.0 = no change, >1.0 = louder, <1.0 = quieter)
 * @returns Audio data with gain applied
 */
export function applyGain(float32Array: Float32Array, gain: number): Float32Array {
  const result = new Float32Array(float32Array.length);
  for (let i = 0; i < float32Array.length; i++) {
    result[i] = Math.max(-1, Math.min(1, float32Array[i] * gain));
  }
  return result;
}
