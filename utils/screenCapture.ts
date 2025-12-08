/**
 * Screen Capture Utility
 * Provides a unified API for screen capture that works in both browser and Electron
 */

// electronAPI types are declared in types.ts - do not redeclare here

export interface ScreenSource {
  id: string;
  name: string;
  thumbnail: string;
  appIcon?: string | null;
  display_id?: string;
}

/**
 * Check if running in Electron environment
 */
export function isElectron(): boolean {
  return typeof window !== 'undefined' && window.electronAPI?.isElectron === true;
}

/**
 * Get available screen sources (Electron only)
 * In browser mode, this returns null
 */
export async function getScreenSources(): Promise<ScreenSource[] | null> {
  if (!isElectron()) {
    return null;
  }

  try {
    // Ensure our overlay is hidden from the OS-level source list before asking for sources
    try {
      if (window.electronAPI && typeof window.electronAPI.hideOverlay === 'function') {
        // Best-effort; ignore errors
        await window.electronAPI.hideOverlay();
      }
    } catch (e) {
      console.warn('Failed to hide overlay before fetching screen sources:', e);
    }

    const sources = await window.electronAPI!.getScreenSources();

    // After fetching sources, we can re-show the overlay (it will be hidden only briefly)
    try {
      if (window.electronAPI && typeof window.electronAPI.showOverlay === 'function') {
        await window.electronAPI.showOverlay();
      }
    } catch (e) {
      console.warn('Failed to show overlay after fetching screen sources:', e);
    }
    return sources.map(source => ({
      id: source.id,
      name: source.name,
      thumbnail: source.thumbnail,
      appIcon: source.appIcon,
      display_id: source.display_id,
    }));
  } catch (error) {
    console.error('Error getting screen sources:', error);
    throw error;
  }
}

/**
 * Capture screen with unified API
 * Works in both browser and Electron environments
 */
export async function captureScreen(options?: {
  audio?: boolean;
  video?: boolean | MediaTrackConstraints;
  sourceId?: string; // For Electron: specific source ID
  onSourceRequired?: (sources: ScreenSource[]) => Promise<string>; // Callback when source selection needed
}): Promise<MediaStream> {
  const { audio = true, video = true, sourceId, onSourceRequired } = options || {};

  if (isElectron()) {
    // Electron mode: Use desktopCapturer
    try {
      let finalSourceId = sourceId;

      // If no source ID provided, let user select
      if (!finalSourceId) {
        const sources = await getScreenSources();
        if (!sources || sources.length === 0) {
          throw new Error('No screen sources available');
        }

        // If callback provided, use it to get user selection
        if (onSourceRequired) {
          finalSourceId = await onSourceRequired(sources);
          if (!finalSourceId) {
            throw new Error('Screen selection cancelled');
          }
        } else {
          // Fallback: automatically select the first screen
          finalSourceId = sources[0].id;
        }
      }

      // Validate the source
      await window.electronAPI!.getScreenStream(finalSourceId);

      // Use navigator.mediaDevices.getUserMedia with Electron constraints
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: audio ? {
          mandatory: {
            chromeMediaSource: 'desktop' as any,
            // Note: Do NOT include chromeMediaSourceId for audio
            // According to Electron docs, this breaks audio capture
          }
        } as any : false,
        video: video ? {
          mandatory: {
            chromeMediaSource: 'desktop' as any,
            chromeMediaSourceId: finalSourceId,
            // Add video dimension constraints to ensure proper stream initialization
            minWidth: 1280,
            maxWidth: 4096,
            minHeight: 720,
            maxHeight: 2160,
          }
        } as any : false,
      });

      return stream;
    } catch (error) {
      console.error('Error capturing screen in Electron:', error);
      throw error;
    }
  } else {
    // Browser mode: Use standard getDisplayMedia
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        audio,
        video,
      });

      return stream;
    } catch (error) {
      console.error('Error capturing screen in browser:', error);
      throw error;
    }
  }
}

/**
 * Get audio stream from microphone
 */
export async function captureMicrophone(constraints?: MediaTrackConstraints): Promise<MediaStream> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: constraints || true,
      video: false,
    });

    return stream;
  } catch (error) {
    console.error('Error capturing microphone:', error);
    throw error;
  }
}

/**
 * Combine screen and microphone streams
 */
export function combineStreams(screenStream: MediaStream, micStream: MediaStream): MediaStream {
  const combinedStream = new MediaStream();

  // Add video tracks from screen
  screenStream.getVideoTracks().forEach(track => {
    combinedStream.addTrack(track);
  });

  // Add audio tracks from microphone
  micStream.getAudioTracks().forEach(track => {
    combinedStream.addTrack(track);
  });

  return combinedStream;
}
