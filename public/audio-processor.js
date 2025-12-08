// AudioWorklet processor - runs on audio rendering thread
// This runs independently from the main thread, preventing UI blocking
class AudioCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.bufferSize = 4096;
    this.buffer = new Float32Array(this.bufferSize);
    this.bufferIndex = 0;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];

    // If no input, keep processor alive
    if (!input || input.length === 0) {
      return true;
    }

    const channelData = input[0]; // First channel (mono)

    if (!channelData) {
      return true;
    }

    // Accumulate audio data until we have bufferSize samples
    for (let i = 0; i < channelData.length; i++) {
      this.buffer[this.bufferIndex++] = channelData[i];

      // When buffer is full, send to main thread
      if (this.bufferIndex >= this.bufferSize) {
        // Convert Float32Array to Int16Array (PCM)
        const pcmData = new Int16Array(this.bufferSize);
        for (let j = 0; j < this.bufferSize; j++) {
          const s = Math.max(-1, Math.min(1, this.buffer[j]));
          pcmData[j] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }

        // Send PCM data to main thread
        this.port.postMessage({ pcmData: pcmData });

        // Reset buffer
        this.bufferIndex = 0;
      }
    }

    return true; // Keep processor alive
  }
}

registerProcessor('audio-capture-processor', AudioCaptureProcessor);
