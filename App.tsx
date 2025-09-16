
import React, { useState, useRef, useCallback, useEffect } from 'react';
import { AppStatus, Summary, LogEntry, LogLevel } from './types';
import GeminiService from './services/geminiService';
import Header from './components/Header';
import Controls from './components/Controls';
import VideoDisplay from './components/VideoDisplay';
import SummaryDisplay from './components/SummaryDisplay';
import config from './config.json';

const SUMMARY_INTERVAL_MS = config.SUMMARY_INTERVAL_MS;
const INITIAL_PROMPT = config.INITIAL_PROMPT;

export default function App() {
  const [status, setStatus] = useState<AppStatus>(AppStatus.IDLE);
  const [summaries, setSummaries] = useState<Summary[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [mediaStream, setMediaStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [geminiService, setGeminiService] = useState<GeminiService | null>(null);

  const [isVideoReady, setIsVideoReady] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const intervalRef = useRef<number | null>(null);
  const statusRef = useRef(status);
  const isFirstFrameRef = useRef(true);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioMimeTypeRef = useRef<string>('audio/webm');
  const captureAndSendFrameRef = useRef<() => void>(() => {});

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
  
  const cleanup = useCallback(() => {
    if (intervalRef.current) {
      window.clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
      mediaRecorderRef.current.stop();
      mediaRecorderRef.current = null;
    }
    if (geminiService) {
      geminiService.disconnect();
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
    cleanup();
    setStatus(AppStatus.IDLE);
    addLog("Analysis stopped and resources cleaned up.", LogLevel.SUCCESS);
  }, [addLog, cleanup]);

  const captureAndSendFrame = useCallback(async () => {
    if (!videoRef.current || !canvasRef.current || !geminiService?.isConnected()) {
      addLog("Skipping frame capture: core dependencies not ready.", LogLevel.WARN);
      return;
    }

    const currentStream = videoRef.current.srcObject as MediaStream | null;
    if (!currentStream || !currentStream.active) {
      addLog(`Media stream is not active. Stopping analysis.`, LogLevel.WARN);
      handleStop();
      return;
    }

    const video = videoRef.current;
    if (video.videoWidth === 0 || video.videoHeight === 0) {
      addLog("Video has no dimensions yet, skipping frame capture.", LogLevel.WARN);
      return;
    }
    
    addLog("Capturing frame and audio snippet...");
    
    // 1. Capture Video Frame
    const canvas = canvasRef.current;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
       addLog("Failed to get 2D context from canvas.", LogLevel.ERROR);
       return;
    }
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
    const videoBase64Data = dataUrl.split(',')[1];
    
    // 2. Capture Audio Snippet
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state !== 'recording') {
        addLog("Audio recorder not ready. Sending frame without audio.", LogLevel.WARN);
        const prompt = isFirstFrameRef.current ? INITIAL_PROMPT : undefined;
        geminiService.sendFrame(videoBase64Data, undefined, undefined, prompt);
        if (isFirstFrameRef.current) isFirstFrameRef.current = false;
        return;
    }

    const audioPromise = new Promise<{ audioData: string; mimeType: string }>((resolve, reject) => {
        let audioChunks: Blob[] = [];
        recorder.ondataavailable = (e) => {
             if (e.data.size > 0) audioChunks.push(e.data);
        };
        recorder.onstop = () => {
            if (audioChunks.length === 0) {
                return reject(new Error("No audio data was captured in the interval."));
            }

            const detectedMimeType = audioChunks[0].type || audioMimeTypeRef.current;
            if (!detectedMimeType) {
                return reject(new Error("Could not determine audio MIME type from data blobs."));
            }

            const audioBlob = new Blob(audioChunks, { type: detectedMimeType });
            const reader = new FileReader();
            reader.onloadend = () => {
                const dataUrl = reader.result as string;
                if (!dataUrl || !dataUrl.startsWith('data:')) {
                    return reject(new Error("Invalid data URL from FileReader."));
                }
                
                // Robustly find the Base64 data, ignoring commas in the MIME type.
                const separator = ';base64,';
                const separatorIndex = dataUrl.indexOf(separator);
                if (separatorIndex === -1) {
                    return reject(new Error("Malformed base64 data URL: ';base64,' separator not found."));
                }
                const base64Audio = dataUrl.substring(separatorIndex + separator.length);

                resolve({ audioData: base64Audio, mimeType: detectedMimeType });
                
                if (statusRef.current === AppStatus.ANALYZING) {
                    recorder.start();
                }
            };
            reader.onerror = reject;
            reader.readAsDataURL(audioBlob);
            
            recorder.ondataavailable = null;
            recorder.onstop = null;
        };
        recorder.stop();
    });

    try {
        const { audioData, mimeType } = await audioPromise;
        const prompt = isFirstFrameRef.current ? INITIAL_PROMPT : undefined;
        geminiService.sendFrame(videoBase64Data, audioData, mimeType, prompt);
        if (isFirstFrameRef.current) {
            isFirstFrameRef.current = false;
        }
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        addLog(`Error capturing audio: ${message}. Sending video only.`, LogLevel.WARN);
        const prompt = isFirstFrameRef.current ? INITIAL_PROMPT : undefined;
        geminiService.sendFrame(videoBase64Data, undefined, undefined, prompt);
        if (isFirstFrameRef.current) {
            isFirstFrameRef.current = false;
        }
        // Restart recording even on failure to not halt the process
        // FIX: The original check `recorder.state === 'inactive'` caused a TypeScript error
        // because the type of `recorder.state` was narrowed to 'recording' earlier in the
        // function, and TypeScript's control flow analysis didn't detect that
        // `recorder.stop()` changes the state. Reading from the ref `mediaRecorderRef.current`
        // bypasses this incorrect narrowing.
        if (mediaRecorderRef.current?.state === 'inactive' && statusRef.current === AppStatus.ANALYZING) {
            mediaRecorderRef.current.start();
        }
    }

  }, [addLog, handleStop, geminiService]);
  
  useEffect(() => {
    captureAndSendFrameRef.current = captureAndSendFrame;
  }, [captureAndSendFrame]);

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
    if (isVideoReady && geminiService && isFirstFrameRef.current) {
      addLog("Dependencies met (video + connection). Triggering initial frame capture.", LogLevel.SUCCESS);
      captureAndSendFrame();
    }
  }, [isVideoReady, geminiService, captureAndSendFrame, addLog]);
  
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
    isFirstFrameRef.current = true;
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
          cleanup();
        },
        onClose: (reason) => {
          if (statusRef.current !== AppStatus.STOPPING && statusRef.current !== AppStatus.IDLE) {
             const msg = `Session closed unexpectedly: ${reason || 'Unknown reason'}`;
             addLog(msg, LogLevel.ERROR);
             setError(msg);
             setStatus(AppStatus.IDLE);
             cleanup();
          }
        },
      });

      addLog("Connection established. Setting service in state.", LogLevel.SUCCESS);
      setGeminiService(service);
      setStatus(AppStatus.ANALYZING);
      
      addLog("Starting periodic capture interval for subsequent frames.");
      intervalRef.current = window.setInterval(() => {
        captureAndSendFrameRef.current();
      }, SUMMARY_INTERVAL_MS);
      addLog(`Subsequent frames will be captured every ${SUMMARY_INTERVAL_MS / 1000} seconds.`);

    } catch (err) {
      const message = err instanceof Error ? err.message : "An unknown error occurred.";
      addLog(`Failed to start session: ${message}`, LogLevel.ERROR);
      if (message.includes('Permission denied')) {
        setError('Screen share permission was denied. Please allow screen sharing to start the analysis.');
      } else {
        setError(`Failed to start session: ${message}`);
      }
      setStatus(AppStatus.ERROR);
      cleanup();
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
          <Controls status={status} onStart={handleStart} onStop={handleStop} />
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