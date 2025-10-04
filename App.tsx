
import React, { useState, useRef, useCallback, useEffect } from 'react';
import { AppStatus, Summary, LogEntry, LogLevel } from './types';
import GeminiService from './services/geminiService';
import { VideoModeCapture } from './utils/videoMode';
import Header from './components/Header';
import Controls from './components/Controls';
import VideoDisplay from './components/VideoDisplay';
import SummaryDisplay from './components/SummaryDisplay';
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

  const [isVideoReady, setIsVideoReady] = useState(false);

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
      addLog("Requesting screen capture permission...");
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
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
    <div className="min-h-screen bg-base-100 flex flex-col font-sans">
      <Header />
      <main className="flex-grow container mx-auto p-4 md:p-6 lg:p-8 flex flex-col lg:flex-row gap-8">
        <div className="lg:w-3/5 flex flex-col gap-4">
          <Controls 
            status={status} 
            onStart={handleStart} 
            onStop={handleStop}
            selectedMode={selectedMode}
            onModeChange={setSelectedMode}
          />
           {error && (
            <div className="bg-red-900/50 border border-red-700 text-red-200 p-4 rounded-lg">
              <p className="font-bold">An Error Occurred</p>
              <p className="text-sm">{error}</p>
            </div>
          )}
          <VideoDisplay stream={mediaStream} videoRef={videoRef} status={status} />
        </div>
        <div className="lg:w-2/5">
          <SummaryDisplay summaries={summaries} status={status} logs={logs} />
        </div>
      </main>
      <canvas ref={canvasRef} className="hidden"></canvas>
    </div>
  );
}