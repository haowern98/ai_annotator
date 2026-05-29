/**
 * Video Frame Extractor
 * Extracts frames from video files at 1fps (matching live capture rate)
 * Audio extraction now uses ffmpeg via Electron IPC (see electron/main.cjs)
 */

export interface ExtractedFrame {
  timestamp_ms: number;
  image_base64: string;
}

export interface ExtractionProgress {
  currentFrame: number;
  totalFrames: number;
  percentage: number;
}

export type VideoSource = File | { path: string; size?: number };

/**
 * Extract frames from video file at 1fps
 * Uses HTML5 video element and canvas (not WebRTC MediaStream)
 */
export async function extractFramesAt1FPS(
  videoFile: VideoSource,
  onProgress?: (progress: ExtractionProgress) => void
): Promise<ExtractedFrame[]> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');

    if (!ctx) {
      reject(new Error('Failed to get canvas context'));
      return;
    }

    const frames: ExtractedFrame[] = [];
    let videoUrl: string | null = null;

    video.preload = 'metadata';
    video.muted = true;

    video.onloadedmetadata = () => {
      const duration = video.duration;
      const totalFrames = Math.floor(duration);

      // Set canvas size (matching config.json video mode settings)
      const baseResolution = 960; // Same as live capture
      canvas.width = baseResolution;
      canvas.height = baseResolution;

      let currentFrame = 0;

      const extractNextFrame = () => {
        if (currentFrame >= totalFrames) {
          // Cleanup
          if (videoUrl) {
            URL.revokeObjectURL(videoUrl);
          }
          video.remove();
          canvas.remove();

          resolve(frames);
          return;
        }

        const targetTime = currentFrame;
        video.currentTime = targetTime;
      };

      video.onseeked = () => {
        try {
          // Draw current frame to canvas
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

          // Convert to base64 (JPEG, 0.8 quality - matching live capture)
          const base64Image = canvas.toDataURL('image/jpeg', 0.8).split(',')[1];

          frames.push({
            timestamp_ms: currentFrame * 1000,
            image_base64: base64Image,
          });

          if (onProgress) {
            onProgress({
              currentFrame: currentFrame + 1,
              totalFrames: Math.floor(duration),
              percentage: ((currentFrame + 1) / Math.floor(duration)) * 100,
            });
          }

          currentFrame++;
          extractNextFrame();
        } catch (error) {
          reject(new Error(`Frame extraction failed at ${currentFrame}s: ${error}`));
        }
      };

      video.onerror = () => {
        reject(new Error('Video playback error during frame extraction'));
      };

      // Start extraction
      extractNextFrame();
    };

    video.onerror = () => {
      reject(new Error('Failed to load video metadata'));
    };

    // Load video file
    if (videoFile instanceof File) {
      videoUrl = URL.createObjectURL(videoFile);
      video.src = videoUrl;
    } else {
      const p = String(videoFile.path || '').trim();
      if (!p) {
        reject(new Error('Missing video path'));
        return;
      }
      // Prefer Electron custom protocol (registered in electron/main.cjs) to avoid file:// restrictions.
      // Note: this is cross-origin vs http://localhost, so set CORS mode to allow canvas extraction.
      video.crossOrigin = 'anonymous';
      // Use localhost as host for proper URL format
      const normalizedPath = p.replace(/\\/g, '/');
      video.src = `video://localhost/${normalizedPath}`;
    }
  });
}

