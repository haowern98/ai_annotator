
import React, { useState, useRef, useCallback, useEffect } from 'react';
import { AppStatus, Summary, LogEntry, LogLevel, NavigationView, NavigationState } from './types';
import GeminiService from './services/geminiService';
import { VideoModeCapture } from './utils/videoMode';
import { captureScreen, isElectron, ScreenSource } from './utils/screenCapture';
import TitleBar from './components/TitleBar';
import { Sidebar } from './components/Sidebar';
import InterviewHome from './components/InterviewHome';
import LectureHome from './components/LectureHome';
import HistoryHome from './components/HistoryHome';
import { ScreenSourcePicker } from './components/ScreenSourcePicker';
import { UploadQueueManager, QueuedVideo } from './services/uploadQueueManager';
import ParakeetBatchTranscriber from './services/parakeetBatchTranscriber';
import { QwenHttpClient } from './services/qwenHttpClient';
import config from './config.json';

const VIDEO_MODE_CONFIG = {
  dataCollectionIntervalMs: config.VIDEO_MODE_DATA_COLLECTION_INTERVAL_MS,
  setsPerMinute: config.VIDEO_MODE_SETS_PER_MINUTE,
  videoModePrompt: config.VIDEO_MODE_PROMPT,
};

export default function App() {
  const [status, setStatus] = useState<AppStatus>(AppStatus.IDLE);
  const [summaries, setSummaries] = useState<Summary[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [mediaStream, setMediaStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [geminiService, setGeminiService] = useState<GeminiService | null>(null);
  const [selectedMode, setSelectedMode] = useState<string>('Lecture Mode');
  const [sidebarMode, setSidebarMode] = useState<'lecture' | 'interview' | 'history'>('lecture');

  // Upload queue state (app-level to persist across navigation)
  const uploadQueueRef = useRef<UploadQueueManager | null>(null);
  const [uploadQueue, setUploadQueue] = useState<QueuedVideo[]>([]);
  const uploadParakeetRef = useRef<ParakeetBatchTranscriber | null>(null);

  // Navigation state for browser-like back/forward
  const [navigation, setNavigation] = useState<NavigationState>({
    history: ['home'],
    currentIndex: 0
  });

  const canGoBack = navigation.currentIndex > 0;
  const canGoForward = navigation.currentIndex < navigation.history.length - 1;
  const currentView = navigation.history[navigation.currentIndex];

  const navigateTo = useCallback((view: NavigationView) => {
    setNavigation(prev => {
      // Remove any forward history when navigating to a new page
      const newHistory = prev.history.slice(0, prev.currentIndex + 1);
      newHistory.push(view);
      return {
        history: newHistory,
        currentIndex: newHistory.length - 1
      };
    });
  }, []);

  const goBack = useCallback(() => {
    setNavigation(prev => ({
      ...prev,
      currentIndex: Math.max(0, prev.currentIndex - 1)
    }));
  }, []);

  const goForward = useCallback(() => {
    setNavigation(prev => ({
      ...prev,
      currentIndex: Math.min(prev.history.length - 1, prev.currentIndex + 1)
    }));
  }, []);

  const handleSidebarModeChange = (mode: 'lecture' | 'interview' | 'history') => {
    setSidebarMode(mode);
    // Reset navigation to home when switching modes
    setNavigation({ history: ['home'], currentIndex: 0 });
  };

  const [isVideoReady, setIsVideoReady] = useState(false);

  // Screen source picker state (for Electron)
  const [isPickerOpen, setIsPickerOpen] = useState(false);
  const [pickerSources, setPickerSources] = useState<ScreenSource[] | null>(null);
  const pickerResolveRef = useRef<((sourceId: string) => void) | null>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const statusRef = useRef(status);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioMimeTypeRef = useRef<string>('audio/webm');
  const videoModeRef = useRef<VideoModeCapture | null>(null);

  const addLog = useCallback((message: string, level: LogLevel = LogLevel.INFO) => {
    setLogs(prev => [...prev, {
      id: Date.now() + Math.random(),
      timestamp: new Date().toLocaleTimeString(),
      level,
      message,
    }]);
  }, []);

  // Initialize upload queue on mount
  useEffect(() => {
    // Clear server mode on app startup (doesn't persist across restarts)
    try {
      const remoteConfig = localStorage.getItem('qwen_remote_config');
      if (remoteConfig) {
        const config = JSON.parse(remoteConfig);
        if (config.mode === 'server') {
          console.log('[App] Clearing server mode from previous session');
          localStorage.setItem('qwen_remote_config', JSON.stringify({ mode: 'local' }));
        }
      }
    } catch (e) {
      console.error('[App] Failed to clear server mode:', e);
    }

    const uploadParakeet = new ParakeetBatchTranscriber(addLog);
    
    // Load remote processing config
    let qwenUrl = 'http://127.0.0.1:7556';
    try {
      const remoteConfig = localStorage.getItem('qwen_remote_config');
      if (remoteConfig) {
        const config = JSON.parse(remoteConfig);
        if (config.mode === 'client' && config.remoteUrl) {
          qwenUrl = config.remoteUrl;
          console.log(`[Upload Queue] Using remote Qwen server: ${qwenUrl}`);
        }
      }
    } catch (e) {
      console.warn('[Upload Queue] Failed to load remote config, using local server');
    }
    
    const uploadQwen = new QwenHttpClient(qwenUrl);
    uploadParakeetRef.current = uploadParakeet;

    const initUploadClients = async () => {
      try {
        await uploadParakeet.connect({
          onReady: () => console.log('[Upload Queue] Parakeet worker ready'),
          onError: (err) => console.error(`[Upload Queue] Parakeet error: ${err}`),
        });

        await uploadQwen.connect({
          onReady: () => console.log('[Upload Queue] Qwen worker ready'),
          onError: (err) => console.error(`[Upload Queue] Qwen error: ${err}`),
          onProgress: (msg) => console.log(`[Upload Queue] ${msg}`),
        });

        uploadQueueRef.current = new UploadQueueManager(uploadParakeet, uploadQwen, () => false, {
          onQueueUpdate: (queue) => setUploadQueue(queue),
          onVideoComplete: (video) => console.log(`Upload complete: ${video.fileName}`),
          onVideoError: (video, err) => console.error(`Upload failed: ${video.fileName} - ${err}`),
        });

        console.log('[Upload Queue] Upload queue manager initialized');
      } catch (error) {
        console.error('[Upload Queue] Failed to initialize:', error);
      }
    };

    initUploadClients();

    // In server mode, accept full-video uploads via the Electron main-process inbox.
    // When a file arrives, enqueue it for local processing (same pipeline as local path/YouTube uploads).
    const api = window.electronAPI as any;
    const handleInboxFile = (payload: any) => {
      try {
        const videoPath = String(payload?.videoPath || '').trim();
        if (!videoPath) return;
        const fileName = String(payload?.fileName || 'remote_upload');
        const fileSize = Number(payload?.fileSize || 0);
        const jobId = String(payload?.jobId || '').trim();
        if (jobId && (window.electronAPI as any)?.updateInboxJob) {
          (window.electronAPI as any).updateInboxJob(jobId, {
            state: 'processing',
            phase: 'Queued for processing',
            progressPercent: 0,
          });
        }
        if (jobId && uploadQueueRef.current?.addVideoPathRemoteJob) {
          uploadQueueRef.current.addVideoPathRemoteJob(videoPath, fileName, fileSize, jobId);
        } else {
          uploadQueueRef.current?.addVideoPath(videoPath, fileName, fileSize);
        }
      } catch (e) {
        console.warn('[Upload Queue] Failed to enqueue inbox file:', e);
      }
    };

    if (api?.onInboxFileReceived) {
      api.onInboxFileReceived(handleInboxFile);
    }

    return () => {
      try {
        (window.electronAPI as any)?.removeInboxListeners?.();
      } catch {
        // ignore
      }
      if (uploadQueueRef.current) {
        uploadQueueRef.current = null;
      }
    };
  }, [addLog]);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);
  
  const cleanup = useCallback((clearSession: boolean = false) => {
    if (videoModeRef.current) {
      videoModeRef.current.stop();
      videoModeRef.current = null;
    }
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
      mediaRecorderRef.current.stop();
      mediaRecorderRef.current = null;
    }
    if (geminiService) {
      if (clearSession) {
        // Completely clear session - next connection will be fresh
        geminiService.clearSession();
      } else {
        // Just disconnect - can resume later
        geminiService.disconnect();
      }
      setGeminiService(null);
    }
    if (mediaStream) {
      mediaStream.getTracks().forEach((track) => track.stop());
      setMediaStream(null);
    }
    setIsVideoReady(false);
  }, [mediaStream, geminiService]);

  const handleStop = useCallback(() => {
    addLog("Stop Analysis triggered.");
    setStatus(AppStatus.STOPPING);
    // Don't clear session - allow resuming later if user restarts
    cleanup(false);
    setStatus(AppStatus.IDLE);
    addLog("Analysis stopped. Session preserved for potential resume.", LogLevel.SUCCESS);
  }, [addLog, cleanup]);


  


  useEffect(() => {
    if (!mediaStream || !videoRef.current) return;

    const video = videoRef.current;
    const handleVideoReady = () => {
        addLog("Video metadata loaded. Setting video ready flag.", LogLevel.SUCCESS);

        // Explicitly start video playback
        video.play().catch(err => {
          addLog(`Video autoplay blocked: ${err.message}. Attempting muted playback...`, LogLevel.WARN);
        });

        setIsVideoReady(true);
    };

    video.addEventListener('loadedmetadata', handleVideoReady);
    return () => video.removeEventListener('loadedmetadata', handleVideoReady);
  }, [mediaStream, addLog]);

  useEffect(() => {
    if (isVideoReady && geminiService && selectedMode === 'Video Mode') {
      addLog("Dependencies met (video + connection). Initializing video mode.", LogLevel.SUCCESS);
      
      // Initialize video mode capture
      const videoMode = new VideoModeCapture(
        VIDEO_MODE_CONFIG,
        {
          onSummary: (summary) => {
            setSummaries((prev) => [
              ...prev,
              {
                id: `sum_${Date.now()}`,
                text: summary,
                timestamp: new Date().toLocaleTimeString(),
              },
            ]);
          },
          onError: (error) => {
            setError(`Video Mode Error: ${error}`);
            setStatus(AppStatus.ERROR);
            cleanup(true); // Clear session on video mode error
          },
          onStatusChange: (newStatus) => {
            setStatus(newStatus);
          },
        },
        addLog,
        {
          videoRef,
          canvasRef,
          mediaRecorderRef,
          audioMimeTypeRef,
          statusRef,
        }
      );
      
      videoMode.setGeminiService(geminiService);
      videoModeRef.current = videoMode;
      
      // Start video mode capture
      videoMode.start();
    } else if (isVideoReady && geminiService && selectedMode === 'Lecture Mode') {
      addLog("Lecture Mode selected but not yet implemented.", LogLevel.INFO);
    }
  }, [isVideoReady, geminiService, selectedMode, addLog, cleanup]);

  // Picker handlers
  const handlePickerSelect = useCallback((sourceId: string) => {
    setIsPickerOpen(false);
    if (pickerResolveRef.current) {
      pickerResolveRef.current(sourceId);
      pickerResolveRef.current = null;
    }
    setPickerSources(null);
  }, []);

  const handlePickerCancel = useCallback(() => {
    setIsPickerOpen(false);
    if (pickerResolveRef.current) {
      // Resolve with empty string to signal cancellation
      pickerResolveRef.current('');
      pickerResolveRef.current = null;
    }
    setPickerSources(null);
    setStatus(AppStatus.IDLE);
    addLog('Screen selection cancelled', LogLevel.INFO);
  }, [addLog]);

  const handleStart = async () => {
    addLog("Start Analysis clicked.");
    if (!process.env.API_KEY) {
      const msg = "API_KEY environment variable not set.";
      addLog(msg, LogLevel.ERROR);
      setError(msg);
      setStatus(AppStatus.ERROR);
      return;
    }
    
    cleanup();
    setError(null);
    setSummaries([]);
    setLogs([]);
    addLog("Initializing analysis session...");
    setStatus(AppStatus.CAPTURING);

    try {
      addLog(`Requesting screen capture permission... ${isElectron() ? '(Electron mode)' : '(Browser mode)'}`);
      const stream = await captureScreen({
        video: true,
        audio: true,
        onSourceRequired: async (sources) => {
          // Show picker modal and wait for user selection
          return new Promise<string>((resolve) => {
            setPickerSources(sources);
            setIsPickerOpen(true);
            pickerResolveRef.current = resolve;
          });
        },
      });
      addLog("Screen capture permission granted.", LogLevel.SUCCESS);
      
      if (stream.getAudioTracks().length > 0) {
        addLog("Audio track found in stream. Initializing MediaRecorder.", LogLevel.SUCCESS);
        
        // Create a new stream with only the audio tracks.
        // This ensures the recorder produces an `audio/*` MIME type, not `video/*`.
        const audioStream = new MediaStream(stream.getAudioTracks());
        
        let recorder: MediaRecorder | null = null;
        const preferredMimeType = 'audio/webm';

        if (MediaRecorder.isTypeSupported(preferredMimeType)) {
          try {
            addLog(`Attempting to start recorder with preferred mimeType: ${preferredMimeType}`);
            recorder = new MediaRecorder(audioStream, { mimeType: preferredMimeType });
            recorder.start();
            addLog("Recorder started successfully with preferred type.", LogLevel.SUCCESS);
          } catch (e) {
            addLog(`Failed to start recorder with ${preferredMimeType}: ${(e as Error).message}`, LogLevel.WARN);
            recorder = null; 
          }
        }

        if (!recorder) {
          try {
            addLog("Attempting to start recorder with browser default mimeType.");
            recorder = new MediaRecorder(audioStream);
            recorder.start();
            addLog("Recorder started successfully with browser default.", LogLevel.SUCCESS);
          } catch (e) {
            addLog(`Failed to start recorder with browser default: ${(e as Error).message}`, LogLevel.ERROR);
            recorder = null; 
          }
        }

        if (recorder) {
          mediaRecorderRef.current = recorder;
          audioMimeTypeRef.current = recorder.mimeType;
          if (recorder.mimeType) {
            addLog(`MediaRecorder initialized with specified mimeType: ${recorder.mimeType}`, LogLevel.SUCCESS);
          } else {
            addLog(`MediaRecorder initialized with browser default. Actual mimeType will be detected from data.`, LogLevel.INFO);
          }
        } else {
          addLog("All attempts to start MediaRecorder failed. Proceeding without audio.", LogLevel.WARN);
          mediaRecorderRef.current = null;
        }
      } else {
        addLog("No audio track found in the selected stream. Proceeding without audio.", LogLevel.WARN);
      }

      setMediaStream(stream);
      setStatus(AppStatus.CONNECTING);

      const service = new GeminiService(process.env.API_KEY, addLog);
      await service.connect({
        onMessage: (text) => {
          setSummaries((prev) => [
            ...prev,
            {
              id: `sum_${Date.now()}`,
              text,
              timestamp: new Date().toLocaleTimeString(),
            },
          ]);
        },
        onError: (e) => {
          setError(`Session Error: ${e}`);
          setStatus(AppStatus.ERROR);
          cleanup(true); // Clear session on error
        },
        onClose: (reason) => {
          if (statusRef.current !== AppStatus.STOPPING && statusRef.current !== AppStatus.IDLE) {
             const msg = `Session closed unexpectedly: ${reason || 'Unknown reason'}`;
             addLog(msg, LogLevel.ERROR);
             setError(msg);
             setStatus(AppStatus.IDLE);
             cleanup(true); // Clear session on unexpected close
          }
        },
        onReconnecting: () => {
          addLog('Connection lost. Attempting to reconnect with session context...', LogLevel.WARN);
          setStatus(AppStatus.CONNECTING);
        },
      });

      addLog("Connection established. Setting service in state.", LogLevel.SUCCESS);
      setGeminiService(service);
      setStatus(AppStatus.ANALYZING);
      
      addLog("Video mode will start automatically once video is ready.");

    } catch (err) {
      const message = err instanceof Error ? err.message : "An unknown error occurred.";
      addLog(`Failed to start session: ${message}`, LogLevel.ERROR);
      if (message.includes('Permission denied')) {
        setError('Screen share permission was denied. Please allow screen sharing to start the analysis.');
      } else {
        setError(`Failed to start session: ${message}`);
      }
      setStatus(AppStatus.ERROR);
      cleanup(true); // Clear session on startup error
    }
  };
  
  const cleanupRef = useRef(cleanup);
  useEffect(() => {
    cleanupRef.current = cleanup;
  }, [cleanup]);

  useEffect(() => {
    return () => {
      cleanupRef.current();
    };
  }, []);

  return (
    <div style={{
      height: '100vh',
      backgroundColor: '#1a1a1a',
      display: 'flex',
      flexDirection: 'column',
      fontFamily: 'system-ui, -apple-system, sans-serif',
      overflow: 'hidden',
      borderRadius: '10px',
      border: '1px solid #3a3a3a'
    }}>
      {/* Custom Title Bar */}
      <TitleBar 
        canGoBack={canGoBack}
        canGoForward={canGoForward}
        onBack={goBack}
        onForward={goForward}
      />
      
      {/* Main Content Area */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {/* Sidebar */}
        <Sidebar 
          onModeChange={handleSidebarModeChange}
          currentMode={sidebarMode}
        />
        
        {/* Content */}
        {sidebarMode === 'lecture' ? (
          <LectureHome 
            onSidebarModeChange={handleSidebarModeChange}
            uploadQueueRef={uploadQueueRef}
            uploadQueue={uploadQueue}
            uploadParakeetRef={uploadParakeetRef}
          />
        ) : sidebarMode === 'history' ? (
          <HistoryHome 
            currentView={currentView}
            onNavigate={navigateTo}
          />
        ) : (
          <InterviewHome 
            currentView={currentView}
            onNavigate={navigateTo}
          />
        )}
      </div>

      <canvas ref={canvasRef} className="hidden"></canvas>

      {/* Screen Source Picker Modal (Electron only) */}
      {isPickerOpen && pickerSources && (
        <ScreenSourcePicker
          isOpen={isPickerOpen}
          sources={pickerSources}
          onSelect={handlePickerSelect}
          onCancel={handlePickerCancel}
        />
      )}
    </div>
  );
}
