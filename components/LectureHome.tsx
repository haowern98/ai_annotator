import React from 'react';
import { Monitor, Upload, RotateCw } from 'lucide-react';
import { NetworkIcon } from './icons';
import { LogLevel } from '../types';
import LectureHomeSidebar from './LectureHomeSidebar';
import LectureParakeetSessionManager, {
  TranscriptEntry,
  SummaryEntry,
} from '../services/lectureParakeetSessionManager';
import { ScreenSourcePicker } from './ScreenSourcePicker';
import { RecordingConfirmModal, RecordingQuality } from './RecordingConfirmModal';
import { UploadLectureModal } from './UploadLectureModal';
import { UploadProgressModal } from './UploadProgressModal';
import RemoteProcessingModal from './RemoteProcessingModal';
import { UploadQueueManager, QueuedVideo } from '../services/uploadQueueManager';
import ParakeetBatchTranscriber from '../services/parakeetBatchTranscriber';
import { QwenHttpClient } from '../services/qwenHttpClient';

interface LectureHomeProps {
  onSessionStart?: () => void;
  onSidebarModeChange?: (mode: 'lecture' | 'interview' | 'history') => void;
  uploadQueueRef: React.MutableRefObject<UploadQueueManager | null>;
  uploadQueue: QueuedVideo[];
  uploadParakeetRef: React.MutableRefObject<ParakeetBatchTranscriber | null>;
}

const LectureHome: React.FC<LectureHomeProps> = ({ 
  onSessionStart, 
  onSidebarModeChange,
  uploadQueueRef,
  uploadQueue,
  uploadParakeetRef
}) => {
  const [hoveredButton, setHoveredButton] = React.useState<string | null>(null);
  const [isRunning, setIsRunning] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Recording confirmation modal state
  const [isConfirmModalOpen, setIsConfirmModalOpen] = React.useState(false);
  const [selectedQuality, setSelectedQuality] = React.useState<RecordingQuality | null>(null);
  const confirmResolveRef = React.useRef<((quality: RecordingQuality | null) => void) | null>(null);

  // Screen source picker state
  const [isPickerOpen, setIsPickerOpen] = React.useState(false);
  const [pickerSources, setPickerSources] = React.useState<Array<{id: string; name: string; thumbnail: string; appIcon?: string | null}> | null>(null);
  const pickerResolveRef = React.useRef<((sourceId: string) => void) | null>(null);

  // Upload lecture modal state
  const [isUploadModalOpen, setIsUploadModalOpen] = React.useState(false);

  // Remote processing modal state
  const [isRemoteModalOpen, setIsRemoteModalOpen] = React.useState(false);
  const [isUploadProgressOpen, setIsUploadProgressOpen] = React.useState(false);
  const remoteUploadIdRef = React.useRef<string | null>(null);
  const remoteJobIdRef = React.useRef<string | null>(null);
  const remoteClientVideoPathRef = React.useRef<string | null>(null);

  // Session manager and media refs
  const sessionManagerRef = React.useRef<LectureParakeetSessionManager | null>(null);
  const overlayCreatedRef = React.useRef<boolean>(false);
  const videoRef = React.useRef<HTMLVideoElement | null>(null);
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const mediaStreamRef = React.useRef<MediaStream | null>(null);

  // Recording refs
  const recordingCanvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const mediaRecorderRef = React.useRef<MediaRecorder | null>(null);
  const recordingChunksRef = React.useRef<Blob[]>([]);
  const animationFrameRef = React.useRef<number | null>(null);
  const sessionStartTimeRef = React.useRef<number>(0);
  const recordingQualityRef = React.useRef<RecordingQuality | null>(null);
  const stopProcessedRef = React.useRef<boolean>(false);

  // Remote overlay chunk session (client remote mode only)
  const remoteOverlayActiveRef = React.useRef<boolean>(false);
  const remoteOverlayConfigRef = React.useRef<{ remoteUrl: string; sessionId: string; baseFilename: string; recordingEnabled: boolean } | null>(null);
  const remoteOverlayChunkIndexRef = React.useRef<number>(1);
  const remoteOverlayChunkStartMsRef = React.useRef<number>(0);
  const remoteOverlayCanvasStreamRef = React.useRef<MediaStream | null>(null);
  const remoteOverlayMimeTypeRef = React.useRef<string>('video/webm');
  const remoteOverlayActiveChunkRecorderRef = React.useRef<{
    recorder: MediaRecorder;
    blobs: Blob[];
    mimeType: string;
  } | null>(null);
  const remoteOverlayRotateInProgressRef = React.useRef<boolean>(false);
  const remoteOverlayPendingUploadsRef = React.useRef<
    Array<{
      chunkIndex: number;
      chunkStartMs: number;
      chunkEndMs: number;
      localPath: string;
      storedFileName: string;
      jobId: string;
      deleteLocalAfterUpload: boolean;
      isManifest?: boolean;
    }>
  >([]);
  const remoteOverlayUploadInFlightRef = React.useRef<boolean>(false);
  const remoteOverlayCurrentUploadFileNameRef = React.useRef<string>('');
  const remoteOverlayTimersRef = React.useRef<{ rotate?: number; elapsed?: number } | null>(null);
  const remoteOverlayChunkMetaRef = React.useRef<Map<string, { chunkStartMs: number; chunkEndMs: number }>>(new Map());
  const remoteOverlayTranscriptsRef = React.useRef<Array<TranscriptEntry & { formattedTime?: string }>>([]);
  const remoteOverlaySummariesRef = React.useRef<Array<any>>([]);
  const remoteOverlayStopFnRef = React.useRef<(() => void) | null>(null);

  const formatTimestamp = React.useCallback((ms: number): string => {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  }, []);

  const stopRemoteOverlaySession = React.useCallback(() => {
    try {
      remoteOverlayStopFnRef.current?.();
    } catch {
      // ignore
    }
  }, []);

  const addLog = React.useCallback((message: string, level: LogLevel = LogLevel.INFO) => {
    const timestamp = new Date().toLocaleTimeString();
    const prefix = `[${timestamp}]`;
    switch (level) {
      case LogLevel.ERROR: console.error(`${prefix} ❌ ${message}`); break;
      case LogLevel.WARN: console.warn(`${prefix} ⚠️  ${message}`); break;
      case LogLevel.SUCCESS: console.log(`%c${prefix} ✓ ${message}`, 'color: #4ade80'); break;
      default: console.log(`${prefix} ${message}`);
    }
  }, []);

  // Initialize session manager only
  React.useEffect(() => {
    sessionManagerRef.current = new LectureParakeetSessionManager(addLog);

    // Create hidden video and canvas elements
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    videoRef.current = video;

    const canvas = document.createElement('canvas');
    canvasRef.current = canvas;

    // Listen for control commands from overlay
    const handleLectureControl = (_event: any, command: string) => {
      addLog(`[LectureHome] Received control command: ${command}`, LogLevel.INFO);
      
      if (command === 'stop') {
        if (remoteOverlayActiveRef.current) {
          stopRemoteOverlaySession();
        } else {
          handleStopFromOverlay();
        }
      } else if (command === 'pause') {
        if (remoteOverlayActiveRef.current) {
          try {
            mediaRecorderRef.current?.pause();
          } catch {
            // ignore
          }
        } else {
          sessionManagerRef.current?.pause();
        }
      } else if (command === 'resume') {
        if (remoteOverlayActiveRef.current) {
          try {
            mediaRecorderRef.current?.resume();
          } catch {
            // ignore
          }
        } else {
          sessionManagerRef.current?.resume();
        }
      } else if (command === 'generate-summary') {
        sessionManagerRef.current?.generateSummary();
      }
    };

    const electronAPI = window.electronAPI as any;
    if (electronAPI?.onLectureControl) {
      electronAPI.onLectureControl(handleLectureControl);
    }

    return () => {
      sessionManagerRef.current?.stop();
      if (mediaStreamRef.current) {
        mediaStreamRef.current.getTracks().forEach(track => track.stop());
      }
      uploadParakeetRef.current?.disconnect();
      if (electronAPI?.removeLectureControlListener) {
        electronAPI.removeLectureControlListener(handleLectureControl);
      }
    };
  }, [addLog]);

  // Track remote full-video upload progress (client mode).
  React.useEffect(() => {
    const api = window.electronAPI as any;
    if (!api?.onRemoteUploadProgress) return;

    const handleProgress = (payload: any) => {
      // Remote overlay chunk uploader (one-at-a-time).
      if (remoteOverlayActiveRef.current) {
        const expected = remoteOverlayCurrentUploadFileNameRef.current;
        const fileName = String(payload?.fileName || '');
        if (expected && fileName === expected) {
          const pct = Math.max(0, Math.min(100, Number(payload?.progressPercent || 0)));
          const electronAPI = window.electronAPI as any;
          if (electronAPI?.updateLectureStatus) {
            electronAPI.updateLectureStatus(
              JSON.stringify({
                remotePhase: `Uploading ${expected} (${pct}%)`,
              })
            );
          }
        }
      }

      const id = remoteUploadIdRef.current;
      if (!id) return;
      const rawPct = Number(payload?.progressPercent || 0);
      // Scale upload into the first ~33% of the overall progress bar.
      const scaledPct = Math.max(0, Math.min(33, (rawPct / 100) * 33));
      uploadQueueRef.current?.updateRemoteUpload(
        id,
        scaledPct,
        Number(payload?.sentBytes || 0),
        Number(payload?.totalBytes || 0)
      );
    };

    api.onRemoteUploadProgress(handleProgress);

    return () => {
      try {
        api.removeRemoteUploadListeners?.();
      } catch {
        // ignore
      }
    };
  }, [uploadQueueRef]);

  // Save session metadata without recording
  const saveSessionMetadata = React.useCallback(async (collectedTranscripts?: any[], collectedSummaries?: any[]) => {
    try {
      if (!sessionStartTimeRef.current) {
        addLog('No session start time - skipping metadata save', LogLevel.WARN);
        return;
      }

      // Use collected data if provided, otherwise try to get from session manager
      const transcripts = collectedTranscripts || sessionManagerRef.current?.getTranscripts() || [];
      const summaries = collectedSummaries || sessionManagerRef.current?.getSummaries() || [];
      const duration = Date.now() - sessionStartTimeRef.current;

      // Prepare metadata
      const metadata = {
        quality: null, // Recording was disabled
        duration,
        transcriptCount: transcripts.length,
        summaryCount: summaries.length,
        transcripts: transcripts.map(t => ({
          text: t.text,
          timestamp: sessionManagerRef.current?.formatTimestamp(t.timestampMs) || '[00:00]'
        })),
        summaries: summaries.map(s => ({
          text: s.text,
          windowLabel: s.windowLabel
        }))
      };

      // Save via IPC (pass null for videoData)
      const electronAPI = window.electronAPI as any;
      if (electronAPI?.saveRecording) {
        addLog('Saving session metadata...', LogLevel.INFO);
        const result = await electronAPI.saveRecording(null, metadata);
        
        if (result.success) {
          addLog(`Session saved: ${result.filename}`, LogLevel.SUCCESS);
        } else {
          addLog(`Failed to save session: ${result.error}`, LogLevel.ERROR);
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      addLog(`Error saving session metadata: ${message}`, LogLevel.ERROR);
    }
  }, [addLog]);

  // Stop recording and save to disk
  const stopRecordingAndSave = React.useCallback(async (collectedTranscripts?: any[], collectedSummaries?: any[]) => {
    if (!mediaRecorderRef.current || mediaRecorderRef.current.state === 'inactive') {
      return;
    }

    return new Promise<void>((resolve) => {
      const recorder = mediaRecorderRef.current!;

      recorder.onstop = async () => {
        try {
          // Stop animation frame
          if (animationFrameRef.current) {
            cancelAnimationFrame(animationFrameRef.current);
            animationFrameRef.current = null;
          }

          // Create video blob with dynamic MIME type based on recorded format
          const videoBlob = new Blob(recordingChunksRef.current, { type: mediaRecorderRef.current?.mimeType || 'video/webm' });
          const fileSizeMB = (videoBlob.size / 1024 / 1024).toFixed(2);
          addLog(`Recording complete: ${fileSizeMB}MB`, LogLevel.SUCCESS);

          // Convert blob to ArrayBuffer for IPC
          const arrayBuffer = await videoBlob.arrayBuffer();

          // Use collected data if provided, otherwise try to get from session manager
          const transcripts = collectedTranscripts || sessionManagerRef.current?.getTranscripts() || [];
          const summaries = collectedSummaries || sessionManagerRef.current?.getSummaries() || [];
          const duration = Date.now() - sessionStartTimeRef.current;

          addLog(`Collected metadata: ${transcripts.length} transcripts, ${summaries.length} summaries`, LogLevel.INFO);

          // Prepare metadata with complete transcript/summary data
          const metadata = {
            quality: recordingQualityRef.current,
            duration,
            transcriptCount: transcripts.length,
            summaryCount: summaries.length,
            transcripts: transcripts.map(t => ({
              text: t.text,
              timestamp: sessionManagerRef.current?.formatTimestamp(t.timestampMs) || '[00:00]',
              timestampMs: t.timestampMs
            })),
            summaries: summaries.map(s => ({
              text: s.text,
              windowLabel: s.windowLabel
            })),
            recordedMimeType: mediaRecorderRef.current?.mimeType || 'video/webm'
          };

          // Save via IPC with metadata containing transcripts and summaries
          const electronAPI = window.electronAPI as any;
          if (electronAPI?.saveRecording) {
            addLog(`Saving recording to disk with metadata...`, LogLevel.INFO);
            addLog(`Metadata recordedMimeType: ${metadata.recordedMimeType}`, LogLevel.INFO);
            addLog(`Metadata: ${JSON.stringify({ transcriptCount: metadata.transcriptCount, summaryCount: metadata.summaryCount, recordedMimeType: metadata.recordedMimeType })}`, LogLevel.INFO);
            const result = await electronAPI.saveRecording(arrayBuffer, metadata);
            
            if (result.success) {
              addLog(`Recording saved: ${result.filename}`, LogLevel.SUCCESS);
            } else {
              addLog(`Failed to save recording: ${result.error}`, LogLevel.ERROR);
            }
          }

          // Cleanup
          recordingChunksRef.current = [];
          mediaRecorderRef.current = null;
          recordingCanvasRef.current = null;

          resolve();
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Unknown error';
          addLog(`Error saving recording: ${message}`, LogLevel.ERROR);
          resolve();
        }
      };

      recorder.stop();
    });
  }, [addLog]);

  const handleStopFromOverlay = React.useCallback(async () => {
    addLog('Stop requested from overlay');
    
    // Prevent duplicate stop calls - but use a ref to track if we've already processed
    if (stopProcessedRef.current) {
      addLog('Already processing stop, ignoring duplicate request', LogLevel.WARN);
      return;
    }
    
    stopProcessedRef.current = true;
    setIsRunning(false);

    // Stop the session first (this may generate a final summary)
    await sessionManagerRef.current?.stop();

    // CRITICAL: Collect transcript/summary data AFTER stopping (to include final summary)
    const transcriptsAfterStop = sessionManagerRef.current?.getTranscripts() || [];
    const summariesAfterStop = sessionManagerRef.current?.getSummaries() || [];
    addLog(`Post-stop collection: ${transcriptsAfterStop.length} transcripts, ${summariesAfterStop.length} summaries`, LogLevel.INFO);

    // Save recording if active, otherwise save metadata only
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      addLog('Saving recording with video...', LogLevel.INFO);
      await stopRecordingAndSave(transcriptsAfterStop, summariesAfterStop);
    } else if (recordingQualityRef.current === null && sessionStartTimeRef.current > 0) {
      // Recording was disabled, but session occurred - save metadata
      addLog(`Saving metadata only (no recording). Quality=${recordingQualityRef.current}, SessionStart=${sessionStartTimeRef.current}`, LogLevel.INFO);
      await saveSessionMetadata(transcriptsAfterStop, summariesAfterStop);
    } else {
      addLog(`Skipping save. MediaRecorder=${!!mediaRecorderRef.current}, RecordingQuality=${recordingQualityRef.current}, SessionStart=${sessionStartTimeRef.current}`, LogLevel.WARN);
    }

    // Stop media stream
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach(track => track.stop());
      mediaStreamRef.current = null;
    }

    const electronAPI = window.electronAPI as any;
    if (electronAPI?.closeLectureOverlay && overlayCreatedRef.current) {
      try {
        await electronAPI.closeLectureOverlay();
        overlayCreatedRef.current = false;
        addLog('Lecture overlay window closed', LogLevel.INFO);
      } catch (err) {
        addLog(`Error closing overlay: ${err}`, LogLevel.ERROR);
      }
    }
  }, [addLog, stopRecordingAndSave, saveSessionMetadata]);

  // Confirmation modal handlers
  const handleConfirmModalConfirm = React.useCallback((quality: RecordingQuality) => {
    setIsConfirmModalOpen(false);
    if (confirmResolveRef.current) {
      confirmResolveRef.current(quality);
      confirmResolveRef.current = null;
    }
    addLog(`Recording quality selected: ${quality}`, LogLevel.INFO);
  }, [addLog]);

  const handleConfirmModalStartWithoutRecording = React.useCallback(() => {
    setIsConfirmModalOpen(false);
    if (confirmResolveRef.current) {
      confirmResolveRef.current(null); // null indicates no recording
      confirmResolveRef.current = null;
    }
    addLog('Starting without recording', LogLevel.INFO);
  }, [addLog]);

  const handleConfirmModalCancel = React.useCallback(() => {
    setIsConfirmModalOpen(false);
    if (confirmResolveRef.current) {
      confirmResolveRef.current('cancelled' as any); // Special flag for cancel
      confirmResolveRef.current = null;
    }
    setSelectedQuality(null);
    addLog('Recording confirmation cancelled', LogLevel.INFO);
  }, [addLog]);

  // Picker handlers
  const handlePickerSelect = React.useCallback(async (sourceId: string) => {
    setIsPickerOpen(false);
    if (pickerResolveRef.current) {
      pickerResolveRef.current(sourceId);
      pickerResolveRef.current = null;
    }
    setPickerSources(null);
  }, []);

  const handlePickerCancel = React.useCallback(() => {
    setIsPickerOpen(false);
    if (pickerResolveRef.current) {
      pickerResolveRef.current('');
      pickerResolveRef.current = null;
    }
    setPickerSources(null);
    addLog('Screen selection cancelled', LogLevel.INFO);
  }, [addLog]);

  // Recording setup function
  const setupRecording = React.useCallback(async (videoElement: HTMLVideoElement, quality: RecordingQuality) => {
    try {
      addLog(`Setting up recording with ${quality} quality`, LogLevel.INFO);

      // Get video dimensions
      const originalWidth = videoElement.videoWidth;
      const originalHeight = videoElement.videoHeight;

      // Calculate downscaled dimensions based on quality
      let targetWidth = originalWidth;
      let targetHeight = originalHeight;

      if (quality === 'medium') {
        const maxWidth = 1280;
        if (originalWidth > maxWidth) {
          const scale = maxWidth / originalWidth;
          targetWidth = maxWidth;
          targetHeight = Math.round(originalHeight * scale);
        }
      } else if (quality === 'low') {
        const maxWidth = 480;
        if (originalWidth > maxWidth) {
          const scale = maxWidth / originalWidth;
          targetWidth = maxWidth;
          targetHeight = Math.round(originalHeight * scale);
        }
      }

      addLog(`Recording dimensions: ${targetWidth}x${targetHeight} (original: ${originalWidth}x${originalHeight})`, LogLevel.INFO);

      // Create hidden recording canvas
      const recordingCanvas = document.createElement('canvas');
      recordingCanvas.width = targetWidth;
      recordingCanvas.height = targetHeight;
      recordingCanvas.style.display = 'none';
      recordingCanvasRef.current = recordingCanvas;

      const ctx = recordingCanvas.getContext('2d');
      if (!ctx) {
        throw new Error('Failed to get canvas 2D context');
      }

      // Start continuous canvas drawing at 30fps
      const drawFrame = () => {
        if (recordingCanvasRef.current && videoRef.current && videoRef.current.readyState >= 2) {
          ctx.drawImage(videoRef.current, 0, 0, targetWidth, targetHeight);
        }
        animationFrameRef.current = requestAnimationFrame(drawFrame);
      };
      drawFrame();

      // Get stream from canvas
      const canvasStream = recordingCanvas.captureStream(30);

      // Add audio tracks from original stream to canvas stream
      if (mediaStreamRef.current) {
        const audioTracks = mediaStreamRef.current.getAudioTracks();
        audioTracks.forEach(track => canvasStream.addTrack(track));
        addLog(`Added ${audioTracks.length} audio track(s) to recording`, LogLevel.INFO);
      }

      // Detect supported MIME types and fallback gracefully
      // Prioritize WebM when audio is present (better compatibility)
      const supportedMimeTypes = [
        'video/webm;codecs="vp8,opus"',               // WebM VP8 + Opus (best for canvas+audio)
        'video/webm',                                   // Generic WebM
        'video/mp4;codecs="avc1.4d401e,mp4a.40.2"',  // H.264 + AAC
        'video/mp4'                                     // Generic MP4
      ];

      let mimeType = '';
      for (const type of supportedMimeTypes) {
        if (MediaRecorder.isTypeSupported(type)) {
          mimeType = type;
          break;
        }
      }

      if (!mimeType) {
        throw new Error('No supported video codec found');
      }

      addLog(`Using video codec: ${mimeType}`, LogLevel.INFO);

      const recorder = new MediaRecorder(canvasStream, {
        mimeType,
        videoBitsPerSecond: quality === 'high' ? 8000000 : quality === 'medium' ? 2500000 : 1000000
      });

      recordingChunksRef.current = [];

      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          recordingChunksRef.current.push(event.data);
        }
      };

      recorder.onstop = async () => {
        addLog('Recording stopped, processing...', LogLevel.INFO);
      };

      recorder.onerror = (event: any) => {
        addLog(`Recording error: ${event.error?.message || 'Unknown error'}`, LogLevel.ERROR);
      };

      recorder.start(1000); // Collect data every second
      mediaRecorderRef.current = recorder;

      addLog('Recording started successfully', LogLevel.SUCCESS);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      addLog(`Failed to setup recording: ${message}`, LogLevel.ERROR);
      setError(message);
    }
  }, [addLog]);

  const handleOpenOverlay = async () => {
    addLog('Lecture Mode: Open Overlay clicked');

    setError(null);
    const electronAPI = window.electronAPI as any;

    try {
      // Remote overlay session only (requires remote client mode).
      let remoteCfg: any = null;
      try {
        const saved = localStorage.getItem('qwen_remote_config');
        remoteCfg = saved ? JSON.parse(saved) : null;
      } catch {
        remoteCfg = null;
      }

      if (!(remoteCfg?.mode === 'client' && remoteCfg?.remoteUrl)) {
        const msg = 'Remote Overlay is only available in Remote Processing Client Mode (connected).';
        addLog(msg, LogLevel.WARN);
        setError(msg);
        return;
      }

      const remoteUrl = String(remoteCfg.remoteUrl || '').trim();
      if (!remoteUrl) {
        const msg = 'Missing remote server URL.';
        addLog(msg, LogLevel.ERROR);
        setError(msg);
        return;
      }

      // Step 1: Show recording confirmation modal
      const quality = await new Promise<RecordingQuality | null | 'cancelled'>((resolve) => {
        setIsConfirmModalOpen(true);
        confirmResolveRef.current = resolve as any;
      });

      // Check if user cancelled
      if (quality === 'cancelled') {
        addLog('User cancelled recording setup', LogLevel.INFO);
        setSelectedQuality(null);
        return;
      }

      // Store quality in both state AND local variable
      const recordingEnabled = quality !== null;
      const captureQuality: RecordingQuality = (quality || 'medium') as RecordingQuality;
      setSelectedQuality(quality);
      if (quality === null) {
        addLog('Proceeding without recording', LogLevel.INFO);
      } else {
        addLog(`Selected recording quality: ${quality}`, LogLevel.SUCCESS);
      }

      const initRes = await electronAPI?.initRecording?.();
      if (!initRes?.success || !initRes?.path) {
        throw new Error(initRes?.error || 'Failed to initialize recordings directory');
      }
      const recordingsDir = String(initRes.path);

      const now = new Date();
      const y = now.getFullYear();
      const m = String(now.getMonth() + 1).padStart(2, '0');
      const d = String(now.getDate()).padStart(2, '0');
      const hh = String(now.getHours()).padStart(2, '0');
      const mm = String(now.getMinutes()).padStart(2, '0');
      const ss = String(now.getSeconds()).padStart(2, '0');
      const baseFilename = `lecture_${y}${m}${d}_${hh}${mm}${ss}_overlay_remote`;
      const sessionId = `overlay_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

      remoteOverlayActiveRef.current = true;
      remoteOverlayConfigRef.current = { remoteUrl, sessionId, baseFilename, recordingEnabled };
      remoteOverlayChunkIndexRef.current = 1;
      remoteOverlayChunkStartMsRef.current = 0;
      remoteOverlayPendingUploadsRef.current = [];
      remoteOverlayUploadInFlightRef.current = false;
      remoteOverlayCurrentUploadFileNameRef.current = '';
      remoteOverlayChunkMetaRef.current = new Map();
      remoteOverlayTranscriptsRef.current = [];
      remoteOverlaySummariesRef.current = [];

      const localChunkPaths: string[] = [];
      let stopping = false;

      // Step 2: Get screen sources
      let sources: any[] = [];
      if (electronAPI?.getScreenSources) {
        sources = await electronAPI.getScreenSources();
      } else {
        addLog('Screen source picker not available', LogLevel.WARN);
      }

      // Step 3: Show picker if we have sources
      let selectedSourceId: string = '';
      if (sources && sources.length > 0) {
        selectedSourceId = await new Promise<string>((resolve) => {
          setPickerSources(sources);
          setIsPickerOpen(true);
          pickerResolveRef.current = resolve;
        });

        if (!selectedSourceId) {
          addLog('No source selected', LogLevel.INFO);
          setSelectedQuality(null);
          return;
        }
      }

      // Create media stream from selected source
      addLog('Creating media stream...', LogLevel.INFO);
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          // @ts-ignore - Electron-specific
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: selectedSourceId,
          },
        },
        video: {
          // @ts-ignore - Electron-specific
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: selectedSourceId,
          },
        },
      });

      // System audio required for remote overlay mode.
      if (!stream.getAudioTracks || stream.getAudioTracks().length === 0) {
        try {
          stream.getTracks().forEach((t) => t.stop());
        } catch {
          // ignore
        }
        throw new Error('System audio capture not available for this source. Select a different window/screen.');
      }

      mediaStreamRef.current = stream;

      // Setup video element
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }

      // Setup a rolling chunk recorder (always records for upload; "recordingEnabled" only controls final merge + retention).
      const startChunkRecorder = () => {
        const s = remoteOverlayCanvasStreamRef.current;
        if (!s) throw new Error('Missing canvas stream');
        const mimeType = String(remoteOverlayMimeTypeRef.current || 'video/webm');

        const blobs: Blob[] = [];
        const recorder = new MediaRecorder(s, {
          mimeType,
          videoBitsPerSecond: captureQuality === 'high' ? 8000000 : captureQuality === 'medium' ? 2500000 : 1000000,
        });

        remoteOverlayActiveChunkRecorderRef.current = { recorder, blobs, mimeType };
        mediaRecorderRef.current = recorder;

        recorder.ondataavailable = (event) => {
          if (!remoteOverlayActiveRef.current) return;
          const active = remoteOverlayActiveChunkRecorderRef.current;
          if (!active || active.recorder !== recorder) return; // prevent late events from bleeding into the next chunk
          if (event.data && event.data.size > 0) blobs.push(event.data);
        };

        recorder.onerror = (event: any) => {
          addLog(`Recording error: ${event.error?.message || 'Unknown error'}`, LogLevel.ERROR);
        };

        // Use timeslice so we don't buffer a single 3-minute blob in memory.
        recorder.start(1000);
      };

      const stopChunkRecorderAndCollect = async (): Promise<{ blobs: Blob[]; mimeType: string } | null> => {
        const active = remoteOverlayActiveChunkRecorderRef.current;
        if (!active) return null;
        const { recorder, blobs, mimeType } = active;

        const collected = await new Promise<Blob[]>((resolve) => {
          let resolved = false;
          const finalize = () => {
            if (resolved) return;
            resolved = true;
            // Detach and mark inactive so late events from this recorder can't bleed into the next chunk.
            remoteOverlayActiveChunkRecorderRef.current = null;
            mediaRecorderRef.current = null;
            try {
              recorder.ondataavailable = null as any;
              recorder.onerror = null as any;
            } catch {
              // ignore
            }
            resolve(blobs.slice());
          };

          const onStop = () => finalize();
          try {
            recorder.addEventListener('stop', onStop, { once: true });
          } catch {
            // ignore
          }

          try {
            recorder.requestData?.();
          } catch {
            // ignore
          }

          try {
            if (recorder.state !== 'inactive') recorder.stop();
            else finalize();
          } catch {
            finalize();
          }
        });

        return collected && collected.length ? { blobs: collected, mimeType } : null;
      };

      const setupChunkRecorder = async () => {
        if (!videoRef.current) throw new Error('Video element not ready');

        const originalWidth = videoRef.current.videoWidth || 1920;
        const originalHeight = videoRef.current.videoHeight || 1080;
        let targetWidth = originalWidth;
        let targetHeight = originalHeight;

        if (captureQuality === 'medium') {
          const maxWidth = 1280;
          if (originalWidth > maxWidth) {
            const scale = maxWidth / originalWidth;
            targetWidth = maxWidth;
            targetHeight = Math.round(originalHeight * scale);
          }
        } else if (captureQuality === 'low') {
          const maxWidth = 480;
          if (originalWidth > maxWidth) {
            const scale = maxWidth / originalWidth;
            targetWidth = maxWidth;
            targetHeight = Math.round(originalHeight * scale);
          }
        }

        const recordingCanvas = document.createElement('canvas');
        recordingCanvas.width = targetWidth;
        recordingCanvas.height = targetHeight;
        recordingCanvas.style.display = 'none';
        recordingCanvasRef.current = recordingCanvas;

        const ctx = recordingCanvas.getContext('2d');
        if (!ctx) throw new Error('Failed to get canvas 2D context');

        const drawFrame = () => {
          if (recordingCanvasRef.current && videoRef.current && videoRef.current.readyState >= 2) {
            ctx.drawImage(videoRef.current, 0, 0, targetWidth, targetHeight);
          }
          animationFrameRef.current = requestAnimationFrame(drawFrame);
        };
        drawFrame();

        const canvasStream = recordingCanvas.captureStream(30);
        const audioTracks = stream.getAudioTracks();
        audioTracks.forEach((track) => canvasStream.addTrack(track));

        const supportedMimeTypes = [
          'video/webm;codecs="vp8,opus"',
          'video/webm',
        ];
        let mimeType = '';
        for (const type of supportedMimeTypes) {
          if (MediaRecorder.isTypeSupported(type)) {
            mimeType = type;
            break;
          }
        }
        if (!mimeType) throw new Error('No supported video codec found');

        remoteOverlayCanvasStreamRef.current = canvasStream;
        remoteOverlayMimeTypeRef.current = mimeType;

        startChunkRecorder();
      };

      // Create overlay window FIRST
      if (electronAPI?.createLectureOverlay && !overlayCreatedRef.current) {
        const result = await electronAPI.createLectureOverlay();
        if (result.success) {
          overlayCreatedRef.current = true;
          addLog('Lecture overlay window created', LogLevel.SUCCESS);
        } else {
          addLog(`Failed to create overlay: ${result.error}`, LogLevel.ERROR);
          return;
        }
      }

      // Send initial recording status to overlay (AFTER overlay is created)
      // Wait a bit for overlay to be fully ready
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // Store quality in ref for later use when saving
      recordingQualityRef.current = quality;
      
      if (electronAPI?.updateLectureStatus) {
        await electronAPI.updateLectureStatus(
          JSON.stringify({
            isConnected: true,
            isRunning: true,
            isPaused: false,
            isRecording: recordingEnabled,
            recordingQuality: captureQuality,
            elapsedTime: '[00:00]',
            remotePhase: 'Recording (chunked)',
          })
        );
      }

      // Set session start time (for both recording and non-recording sessions)
      sessionStartTimeRef.current = Date.now();
      stopProcessedRef.current = false;  // Reset stop flag for new session

      const parseTimeToSeconds = (s: string): number | null => {
        const m = String(s || '').trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
        if (!m) return null;
        const a = Number(m[1]);
        const b = Number(m[2]);
        const c = m[3] ? Number(m[3]) : null;
        if (!Number.isFinite(a) || !Number.isFinite(b) || (c !== null && !Number.isFinite(c))) return null;
        if (c === null) return a * 60 + b;
        return a * 3600 + b * 60 + c;
      };

      const extractRangeFromLabel = (label: string): { startSec: number; endSec: number } | null => {
        const matches = String(label || '').match(/(\d{1,2}:\d{2}(?::\d{2})?)/g);
        if (!matches || matches.length < 2) return null;
        const a = parseTimeToSeconds(matches[0]);
        const b = parseTimeToSeconds(matches[1]);
        if (a === null || b === null) return null;
        return { startSec: a, endSec: b };
      };

      const formatRangeLabel = (orig: string, startMs: number, endMs: number): string => {
        const start = formatTimestamp(startMs);
        const end = formatTimestamp(endMs);
        if (String(orig || '').startsWith('Topics:')) return `Topics: ${start}-${end}`;
        if (/\[.*\]/.test(String(orig || ''))) return `[${start}]-[${end}]`;
        return `${start}-${end}`;
      };

      const pushOverlayUpdates = () => {
        if (electronAPI?.updateLectureTranscript) {
          electronAPI.updateLectureTranscript(
            JSON.stringify({
              transcripts: remoteOverlayTranscriptsRef.current,
              current: null,
            })
          );
        }
        if (electronAPI?.updateLectureSummary) {
          electronAPI.updateLectureSummary(
            JSON.stringify({
              summaries: remoteOverlaySummariesRef.current,
              isGenerating: false,
            })
          );
        }
      };

      const pollAndApplyResult = async (jobId: string) => {
        const cfg = remoteOverlayConfigRef.current;
        if (!cfg) return;
        const api = window.electronAPI as any;
        const meta = remoteOverlayChunkMetaRef.current.get(jobId);
        if (!meta) return;

        addLog(`[RemoteOverlay] Poll start: jobId=${jobId}`, LogLevel.INFO);
        while (remoteOverlayActiveRef.current) {
          const st = await api.getRemoteJobStatus(cfg.remoteUrl, jobId);
          if (!st?.success) {
            addLog(`[RemoteOverlay] Poll status failed: jobId=${jobId}`, LogLevel.WARN);
            await new Promise((r) => setTimeout(r, 1000));
            continue;
          }
          const state = st?.data?.status?.state;
          const phase = st?.data?.status?.phase;
          const pct = st?.data?.status?.progressPercent;
          addLog(`[RemoteOverlay] Poll: jobId=${jobId} state=${state} phase=${phase} pct=${pct}`, LogLevel.INFO);
          if (state === 'error') {
            const err = st?.data?.status?.error || 'Remote processing failed';
            addLog(`Remote chunk error: ${err}`, LogLevel.ERROR);
            return;
          }
          if (state === 'complete') break;
          await new Promise((r) => setTimeout(r, 1500));
        }

        const res = await api.getRemoteJobResult(cfg.remoteUrl, jobId);
        if (!res?.success || !res?.data) return;
        addLog(`[RemoteOverlay] Result received: jobId=${jobId}`, LogLevel.SUCCESS);
        const serverMeta = res.data;

        const offsetMs = meta.chunkStartMs;
        const transcripts = Array.isArray(serverMeta.transcripts) ? serverMeta.transcripts : [];
        const summaries = Array.isArray(serverMeta.summaries) ? serverMeta.summaries : [];

        for (let i = 0; i < transcripts.length; i++) {
          const t = transcripts[i] || {};
          const ts = Number(t.timestampMs ?? 0);
          const text = String(t.text || '').trim();
          if (!text) continue;
          const timestampMs = offsetMs + Math.max(0, ts);
          remoteOverlayTranscriptsRef.current.push({
            id: `t_${jobId}_${i}`,
            text,
            timestampMs,
            isFinal: true,
            formattedTime: `[${formatTimestamp(timestampMs)}]`,
          });
        }

        for (let i = 0; i < summaries.length; i++) {
          const s = summaries[i] || {};
          const text = String(s.text || '').trim();
          if (!text) continue;
          const label = String(s.windowLabel || '');
          const range = extractRangeFromLabel(label);
          const startMs = offsetMs + (range ? range.startSec * 1000 : meta.chunkStartMs);
          const endMs = offsetMs + (range ? range.endSec * 1000 : meta.chunkEndMs);
          remoteOverlaySummariesRef.current.push({
            id: `s_${jobId}_${i}`,
            text,
            timestampMs: startMs,
            windowStart: startMs / 1000,
            windowEnd: endMs / 1000,
            windowLabel: formatRangeLabel(label, startMs, endMs),
          });
        }

        // Sort for stable display
        remoteOverlayTranscriptsRef.current.sort((a, b) => a.timestampMs - b.timestampMs);
        remoteOverlaySummariesRef.current.sort((a, b) => Number(a.timestampMs || 0) - Number(b.timestampMs || 0));
        pushOverlayUpdates();
        addLog(
          `[RemoteOverlay] Overlay updated: transcripts=${remoteOverlayTranscriptsRef.current.length} summaries=${remoteOverlaySummariesRef.current.length}`,
          LogLevel.INFO
        );
      };

      const processNextUpload = async (): Promise<void> => {
        if (remoteOverlayUploadInFlightRef.current) return;
        const cfg = remoteOverlayConfigRef.current;
        if (!cfg) return;

        const next = remoteOverlayPendingUploadsRef.current.shift();
        if (!next) return;

        remoteOverlayUploadInFlightRef.current = true;
        remoteOverlayCurrentUploadFileNameRef.current = next.storedFileName;

        try {
          const api = window.electronAPI as any;
          try {
            const chunkLabel = next.isManifest ? 'manifest' : `chunk ${String(next.chunkIndex).padStart(4, '0')}`;
            api?.updateLectureStatus?.(JSON.stringify({ remotePhase: `Sending ${chunkLabel}…` }));
          } catch {
            // ignore
          }
          addLog(
            `[RemoteOverlay] Upload start: ${next.storedFileName} (jobId=${next.jobId})`,
            LogLevel.INFO
          );
          const res = await api.sendVideoToRemoteServer(cfg.remoteUrl, next.localPath, {
            displayName: next.storedFileName,
            jobId: next.jobId,
            sessionId: cfg.sessionId,
            overlayBase: cfg.baseFilename,
            chunkIndex: next.isManifest ? '' : String(next.chunkIndex),
            isManifest: Boolean(next.isManifest),
            recordingEnabled: String(cfg.recordingEnabled),
          });
          if (!res?.success) {
            throw new Error(res?.error || 'Remote upload failed');
          }
          addLog(
            `[RemoteOverlay] Upload complete: ${next.storedFileName} (jobId=${res?.jobId || next.jobId})`,
            LogLevel.SUCCESS
          );
          try {
            const chunkLabel = next.isManifest ? 'manifest' : `chunk ${String(next.chunkIndex).padStart(4, '0')}`;
            api?.updateLectureStatus?.(JSON.stringify({ remotePhase: `Finished sending ${chunkLabel}.` }));
          } catch {
            // ignore
          }

          if (next.deleteLocalAfterUpload) {
            try {
              await api.deleteFile(next.localPath);
              addLog(`[RemoteOverlay] Deleted local chunk: ${next.storedFileName}`, LogLevel.INFO);
            } catch {
              // ignore
            }
          }

          if (!next.isManifest) {
            void pollAndApplyResult(next.jobId);
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          addLog(`Remote overlay upload error: ${msg}`, LogLevel.ERROR);
          setError(msg);
        } finally {
          remoteOverlayUploadInFlightRef.current = false;
          remoteOverlayCurrentUploadFileNameRef.current = '';
          void processNextUpload();
        }
      };

      const finalizeChunk = async (isFinal: boolean) => {
        const cfg = remoteOverlayConfigRef.current;
        if (!cfg) return;

        if (remoteOverlayRotateInProgressRef.current) return;
        remoteOverlayRotateInProgressRef.current = true;
        try {
          const collected = await stopChunkRecorderAndCollect();
          if (!collected || collected.blobs.length === 0) {
            return;
          }

          const chunkIndex = remoteOverlayChunkIndexRef.current;
          const chunkStartMs = remoteOverlayChunkStartMsRef.current;
          const chunkEndMs = Date.now() - sessionStartTimeRef.current;
          addLog(
            `[RemoteOverlay] Finalize chunk ${chunkIndex} (${formatTimestamp(chunkStartMs)}-${formatTimestamp(chunkEndMs)}) blobs=${collected.blobs.length}`,
            LogLevel.INFO
          );

          remoteOverlayChunkMetaRef.current.set(`${cfg.sessionId}_chunk_${String(chunkIndex).padStart(4, '0')}`, {
            chunkStartMs,
            chunkEndMs,
          });

          const blob = new Blob(collected.blobs, { type: collected.mimeType || 'video/webm' });
          const buf = await blob.arrayBuffer();

          const writeRes = await electronAPI.writeRecordingChunk(buf, cfg.baseFilename, chunkIndex, '.webm');
          if (!writeRes?.success || !writeRes?.videoPath) {
            throw new Error(writeRes?.error || 'Failed to write chunk');
          }
          addLog(
            `[RemoteOverlay] Wrote chunk file: ${writeRes.videoFilename} (${Math.round(Number(writeRes.fileSize || 0) / 1024 / 1024)}MB)`,
            LogLevel.SUCCESS
          );

          const storedFileName = `${cfg.baseFilename}_chunk_${String(chunkIndex).padStart(4, '0')}.webm`;
          localChunkPaths.push(String(writeRes.videoPath));

          const jobId = `${cfg.sessionId}_chunk_${String(chunkIndex).padStart(4, '0')}`;
          remoteOverlayChunkMetaRef.current.set(jobId, { chunkStartMs, chunkEndMs });

          remoteOverlayPendingUploadsRef.current.push({
            chunkIndex,
            chunkStartMs,
            chunkEndMs,
            localPath: String(writeRes.videoPath),
            storedFileName,
            jobId,
            deleteLocalAfterUpload: !cfg.recordingEnabled,
          });

          remoteOverlayChunkIndexRef.current += 1;
          remoteOverlayChunkStartMsRef.current = chunkEndMs;

          void processNextUpload();

          // Start the next chunk recorder immediately unless we're stopping.
          if (!isFinal) {
            try {
              startChunkRecorder();
            } catch (e) {
              addLog(`[RemoteOverlay] Failed to start next chunk recorder: ${e}`, LogLevel.ERROR);
            }
          }

          if (isFinal) {
            // enqueue manifest as last upload
            const chunks = localChunkPaths.map((p, idx) => ({
              chunkIndex: idx + 1,
              storedFileName: `${cfg.baseFilename}_chunk_${String(idx + 1).padStart(4, '0')}.webm`,
            }));
            const manifestObj = {
              sessionId: cfg.sessionId,
              baseFilename: cfg.baseFilename,
              recordingEnabled: cfg.recordingEnabled,
              chunks,
            };
            const manifestRes = await electronAPI.writeRecordingManifest(cfg.baseFilename, manifestObj);
            if (manifestRes?.success && manifestRes?.manifestPath) {
              const manifestJobId = `${cfg.sessionId}_manifest`;
              addLog(`[RemoteOverlay] Manifest written: ${manifestRes.manifestFilename}`, LogLevel.INFO);
              remoteOverlayPendingUploadsRef.current.push({
                chunkIndex: 0,
                chunkStartMs: 0,
                chunkEndMs: 0,
                localPath: String(manifestRes.manifestPath),
                storedFileName: `${cfg.baseFilename}_manifest.json`,
                jobId: manifestJobId,
                deleteLocalAfterUpload: true,
                isManifest: true,
              });
              void processNextUpload();
            }
          }
        } finally {
          remoteOverlayRotateInProgressRef.current = false;
        }
      };

      const stopSession = async () => {
        if (stopping) return;
        stopping = true;

        // Stop timers
        const timers = remoteOverlayTimersRef.current;
        if (timers?.rotate) window.clearInterval(timers.rotate);
        if (timers?.elapsed) window.clearInterval(timers.elapsed);
        remoteOverlayTimersRef.current = null;

        // Flush + finalize last chunk
        try {
          await finalizeChunk(true);
        } catch (e) {
          addLog(`Finalize chunk error: ${e}`, LogLevel.ERROR);
        }

        // Stop recorder + stream
        try {
          mediaRecorderRef.current?.stop();
        } catch {
          // ignore
        }

        if (mediaStreamRef.current) {
          try {
            mediaStreamRef.current.getTracks().forEach((t) => t.stop());
          } catch {
            // ignore
          }
          mediaStreamRef.current = null;
        }

        remoteOverlayActiveRef.current = false;

        // If recording is enabled, merge local chunks into a final webm.
        if (recordingEnabled) {
          try {
            const outPath = `${recordingsDir}\\${baseFilename}.webm`;
            await electronAPI.concatWebm(localChunkPaths, outPath);
            try {
              const transcripts = remoteOverlayTranscriptsRef.current.map((t) => ({
                text: t.text || '',
                timestamp: t.formattedTime || `[${formatTimestamp(Number(t.timestampMs || 0))}]`,
                timestampMs: Number(t.timestampMs || 0),
              }));
              const summaries = remoteOverlaySummariesRef.current.map((s: any) => ({
                text: String(s?.text || ''),
                windowLabel: String(s?.windowLabel || ''),
              }));
              const meta = {
                quality: captureQuality,
                duration: Math.max(0, Date.now() - sessionStartTimeRef.current),
                transcriptCount: transcripts.length,
                summaryCount: summaries.length,
                transcripts,
                summaries,
                recordedMimeType: 'video/webm',
                uploadedFileName: `${baseFilename}.webm`,
              };
              const saveRes = await electronAPI.saveRecordingExisting(outPath, meta);
              if (!saveRes?.success) {
                addLog(`Client metadata save warning: ${saveRes?.error || 'saveRecordingExisting failed'}`, LogLevel.WARN);
              }
            } catch (e) {
              addLog(`Client metadata save warning: ${e}`, LogLevel.WARN);
            }
          } catch (e) {
            addLog(`Client merge warning: ${e}`, LogLevel.WARN);
          }
        }

        // Close overlay window
        if (electronAPI?.closeLectureOverlay && overlayCreatedRef.current) {
          try {
            await electronAPI.closeLectureOverlay();
            overlayCreatedRef.current = false;
          } catch {
            // ignore
          }
        }

        setIsRunning(false);
      };

      // Install stop handler for overlay control events
      remoteOverlayStopFnRef.current = () => {
        void stopSession();
      };

      // Start chunk recorder + timers
      await setupChunkRecorder();
      remoteOverlayTimersRef.current = remoteOverlayTimersRef.current || {};
      remoteOverlayTimersRef.current.rotate = window.setInterval(() => {
        void finalizeChunk(false);
      }, 180000);
      remoteOverlayTimersRef.current.elapsed = window.setInterval(() => {
        if (!electronAPI?.updateLectureStatus) return;
        const elapsed = Date.now() - sessionStartTimeRef.current;
        electronAPI.updateLectureStatus(
          JSON.stringify({
            elapsedTime: `[${formatTimestamp(elapsed)}]`,
          })
        );
      }, 1000);

      setIsRunning(true);
      onSessionStart?.();
      addLog('Lecture session started', LogLevel.SUCCESS);

    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      addLog(`Failed to start lecture session: ${message}`, LogLevel.ERROR);
      setError(message);
      remoteOverlayActiveRef.current = false;
      remoteOverlayConfigRef.current = null;
    }
  };

  const handleUploadDetails = () => {
    if (isRunning) {
      addLog('Cannot upload during active live session', LogLevel.WARN);
      setError('Please stop the live session before uploading videos');
      return;
    }
    setIsUploadModalOpen(true);
  };

  const handleUploadModalCancel = () => {
    setIsUploadModalOpen(false);
  };

  const handleUploadModalUpload = async (
    source:
      | { type: 'youtube'; value: string }
      | { type: 'file'; value: { path: string; name: string; size: number } }
  ) => {
    if (source.type === 'youtube') {
      const url = String(source.value || '').trim();
      if (!url) {
        setError('Please enter a YouTube URL');
        return;
      }

      // If we're in client remote mode, download locally (into recordings) then upload to the remote server.
      try {
        const saved = localStorage.getItem('qwen_remote_config');
        const cfg = saved ? JSON.parse(saved) : null;
        if (cfg?.mode === 'client' && cfg.remoteUrl) {
          if (!uploadQueueRef.current) {
            addLog('Upload queue not ready', LogLevel.ERROR);
            setError('Upload queue not ready yet. Try again in a moment.');
            return;
          }

          const api = window.electronAPI as any;
          if (!api?.downloadYouTube || !api?.sendVideoToRemoteServer || !api?.initRecording) {
            throw new Error('Electron API remote upload not available');
          }

          const now = new Date();
          const y = now.getFullYear();
          const m = String(now.getMonth() + 1).padStart(2, '0');
          const d = String(now.getDate()).padStart(2, '0');
          const hh = String(now.getHours()).padStart(2, '0');
          const mm = String(now.getMinutes()).padStart(2, '0');
          const ss = String(now.getSeconds()).padStart(2, '0');
          const rand = Math.random().toString(36).slice(2, 7);

          const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
          const baseFilename = `lecture_${y}${m}${d}_${hh}${mm}${ss}_remote_${rand}`;

          const remoteQueueId = uploadQueueRef.current.addRemoteUpload(jobId, 0);
          remoteUploadIdRef.current = remoteQueueId;
          remoteJobIdRef.current = jobId;
          setIsUploadModalOpen(false);
          setIsUploadProgressOpen(true);

          uploadQueueRef.current.setRemoteProgress(remoteQueueId, 'Downloading YouTube', 0);
          addLog('Downloading YouTube into recordings...', LogLevel.INFO);

          const ytRes = await api.downloadYouTube(url, (p: any) => {
            if (p?.type === 'progress' && p.phase === 'downloading' && typeof p.percent === 'number') {
              // Map YouTube download into 0-15%
              const pct = Math.max(0, Math.min(15, (p.percent / 100) * 15));
              uploadQueueRef.current?.setRemoteProgress(remoteQueueId, 'Downloading YouTube', pct);
            }
          }, { outputBase: baseFilename });

          if (!ytRes?.success || !ytRes.file_path) {
            throw new Error(ytRes?.error || 'YouTube download failed');
          }

          const clientVideoPath = String(ytRes.file_path);
          remoteClientVideoPathRef.current = clientVideoPath;
          uploadQueueRef.current.setRemoteProgress(remoteQueueId, 'Downloading YouTube', 15, Number(ytRes.size || 0));

          addLog('Uploading full video to remote server...', LogLevel.INFO);
          uploadQueueRef.current.setRemoteProgress(remoteQueueId, 'Uploading to remote server', 15);

          const res = await api.sendVideoToRemoteServer(
            String(cfg.remoteUrl),
            clientVideoPath,
            { displayName: String(ytRes.file_name || `${baseFilename}.mp4`), jobId }
          );
          if (!res?.success) {
            uploadQueueRef.current.failRemoteUpload(remoteQueueId, res?.error || 'Remote upload failed');
            remoteUploadIdRef.current = null;
            remoteJobIdRef.current = null;
            throw new Error(res?.error || 'Remote upload failed');
          }

          const effectiveJobId = String(res?.jobId || jobId);
          remoteJobIdRef.current = effectiveJobId;

          // Poll server status and fetch final metadata JSON when ready.
          const poll = async () => {
            while (true) {
              await new Promise((r) => setTimeout(r, 2500));
              const statusRes = await api.getRemoteJobStatus(String(cfg.remoteUrl), effectiveJobId);
              if (!statusRes?.success) {
                throw new Error(statusRes?.error || 'Failed to fetch remote status');
              }
              const st = statusRes?.data?.status;
              if (st?.state === 'error') {
                throw new Error(st?.error || 'Remote processing failed');
              }
              if (st?.state === 'complete') {
                uploadQueueRef.current?.setRemoteProgress(remoteQueueId, 'Downloading results', 95);
                const metaRes = await api.getRemoteJobResult(String(cfg.remoteUrl), effectiveJobId);
                if (!metaRes?.success || !metaRes.data) {
                  throw new Error(metaRes?.error || 'Failed to download results');
                }
                const meta = metaRes.data;

                // Save metadata locally and rewrite videoPath/videoFilename via saveRecordingExisting.
                delete (meta as any).wordTimestampsFile;
                const saveRes = await api.saveRecordingExisting(clientVideoPath, meta);
                if (!saveRes?.success) {
                  throw new Error(saveRes?.error || 'Failed to save results to recordings');
                }

                uploadQueueRef.current?.completeRemoteUpload(remoteQueueId, 'Complete');
                remoteUploadIdRef.current = null;
                remoteJobIdRef.current = null;
                addLog('Remote processing complete. Results saved to your recordings.', LogLevel.SUCCESS);
                return;
              }

              // Map server processing into ~33-95%.
              const serverPct = Number(st?.progressPercent || 0);
              const mappedPct = Math.max(33, Math.min(95, 33 + (serverPct / 100) * 62));
              const phase = String(st?.phase || 'Processing on remote server');
              uploadQueueRef.current?.setRemoteProgress(remoteQueueId, phase, mappedPct);
            }
          };

          poll().catch((err: any) => {
            const message = err instanceof Error ? err.message : String(err);
            uploadQueueRef.current?.failRemoteUpload(remoteQueueId, message);
            remoteUploadIdRef.current = null;
            remoteJobIdRef.current = null;
            addLog(`Remote job error: ${message}`, LogLevel.ERROR);
          });

          return;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        addLog(`Remote YouTube upload error: ${message}`, LogLevel.ERROR);
        setError(message);
        return;
      }

      // Local mode: keep existing behavior (download then process locally).
      if (!uploadQueueRef.current) {
        addLog('Upload queue not ready', LogLevel.ERROR);
        setError('Upload queue not ready yet. Try again in a moment.');
        return;
      }

      uploadQueueRef.current.addYouTubeUrl(url);
      setIsUploadModalOpen(false);
      setIsUploadProgressOpen(true);
      return;
    }

    if (!uploadQueueRef.current) {
      addLog('Upload queue not ready', LogLevel.ERROR);
      setError('Upload queue not ready yet. Try again in a moment.');
      return;
    }

    // If we're in client remote mode, send the full video to the remote server for processing.
    try {
      const saved = localStorage.getItem('qwen_remote_config');
      const cfg = saved ? JSON.parse(saved) : null;
      if (cfg?.mode === 'client' && cfg.remoteUrl) {
        const api = window.electronAPI as any;
        if (!api?.sendVideoToRemoteServer) {
          throw new Error('Electron API sendVideoToRemoteServer not available');
        }

        if (!api?.ingestVideoToRecordingsAs) {
          throw new Error('Electron API ingestVideoToRecordingsAs not available');
        }

        const now = new Date();
        const y = now.getFullYear();
        const m = String(now.getMonth() + 1).padStart(2, '0');
        const d = String(now.getDate()).padStart(2, '0');
        const hh = String(now.getHours()).padStart(2, '0');
        const mm = String(now.getMinutes()).padStart(2, '0');
        const ss = String(now.getSeconds()).padStart(2, '0');
        const rand = Math.random().toString(36).slice(2, 7);
        const baseFilename = `lecture_${y}${m}${d}_${hh}${mm}${ss}_remote_${rand}`;

        const ingest = await api.ingestVideoToRecordingsAs(source.value.path, baseFilename);
        if (!ingest?.success || !ingest.videoPath || !ingest.videoFilename) {
          throw new Error(ingest?.error || 'Failed to copy into recordings');
        }
        const clientVideoPath = String(ingest.videoPath);
        const clientFileName = String(ingest.videoFilename);
        remoteClientVideoPathRef.current = clientVideoPath;

        const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const remoteQueueId = uploadQueueRef.current.addRemoteUpload(jobId, source.value.size);
        remoteUploadIdRef.current = remoteQueueId;
        remoteJobIdRef.current = jobId;
        setIsUploadModalOpen(false);
        setIsUploadProgressOpen(true);

        uploadQueueRef.current.setRemoteProgress(remoteQueueId, 'Uploading to remote server', 0);
        addLog('Uploading full video to remote server...', LogLevel.INFO);
        const res = await api.sendVideoToRemoteServer(
          String(cfg.remoteUrl),
          clientVideoPath,
          { displayName: clientFileName, jobId }
        );
        if (!res?.success) {
          uploadQueueRef.current.failRemoteUpload(remoteQueueId, res?.error || 'Remote upload failed');
          remoteUploadIdRef.current = null;
          remoteJobIdRef.current = null;
          throw new Error(res?.error || 'Remote upload failed');
        }

        const effectiveJobId = String(res?.jobId || jobId);
        remoteJobIdRef.current = effectiveJobId;
        uploadQueueRef.current.setRemoteProgress(remoteQueueId, 'Processing on remote server', 33);
        addLog('Upload complete. Waiting for remote processing...', LogLevel.SUCCESS);

        const poll = async () => {
          while (true) {
            await new Promise((r) => setTimeout(r, 2500));
            const statusRes = await api.getRemoteJobStatus(String(cfg.remoteUrl), effectiveJobId);
            if (!statusRes?.success) {
              throw new Error(statusRes?.error || 'Failed to fetch remote status');
            }
            const st = statusRes?.data?.status;
            if (st?.state === 'error') {
              throw new Error(st?.error || 'Remote processing failed');
            }
            if (st?.state === 'complete') {
              uploadQueueRef.current?.setRemoteProgress(remoteQueueId, 'Downloading results', 95);
              const metaRes = await api.getRemoteJobResult(String(cfg.remoteUrl), effectiveJobId);
              if (!metaRes?.success || !metaRes.data) {
                throw new Error(metaRes?.error || 'Failed to download results');
              }
              const meta = metaRes.data;

              delete (meta as any).wordTimestampsFile;
              const saveRes = await api.saveRecordingExisting(clientVideoPath, meta);
              if (!saveRes?.success) {
                throw new Error(saveRes?.error || 'Failed to save results to recordings');
              }

              uploadQueueRef.current?.completeRemoteUpload(remoteQueueId, 'Complete');
              remoteUploadIdRef.current = null;
              remoteJobIdRef.current = null;
              addLog('Remote processing complete. Results saved to your recordings.', LogLevel.SUCCESS);
              return;
            }

            const serverPct = Number(st?.progressPercent || 0);
            const mappedPct = Math.max(33, Math.min(95, 33 + (serverPct / 100) * 62));
            const phase = String(st?.phase || 'Processing on remote server');
            uploadQueueRef.current?.setRemoteProgress(remoteQueueId, phase, mappedPct);
          }
        };

        poll().catch((err: any) => {
          const message = err instanceof Error ? err.message : String(err);
          uploadQueueRef.current?.failRemoteUpload(remoteQueueId, message);
          remoteUploadIdRef.current = null;
          remoteJobIdRef.current = null;
          addLog(`Remote job error: ${message}`, LogLevel.ERROR);
        });
        return;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (remoteUploadIdRef.current && uploadQueueRef.current) {
        try {
          uploadQueueRef.current.failRemoteUpload(remoteUploadIdRef.current, message);
        } catch {
          // ignore
        }
        remoteUploadIdRef.current = null;
        remoteJobIdRef.current = null;
      }
      addLog(`Remote upload error: ${message}`, LogLevel.ERROR);
      setError(message);
      return;
    }

    try {
      const api = window.electronAPI as any;
      if (!api?.ingestVideoToRecordings) {
        throw new Error('Electron API ingestVideoToRecordings not available');
      }

      addLog('Copying video into recordings...', LogLevel.INFO);
      const ingest = await api.ingestVideoToRecordings(source.value.path);
      if (!ingest?.success || !ingest.videoPath) {
        throw new Error(ingest?.error || 'Failed to copy video into recordings');
      }

      uploadQueueRef.current.addVideoPath(
        ingest.videoPath,
        source.value.name || 'video',
        Number(ingest.fileSize || source.value.size || 0)
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      addLog(`Failed to ingest local video: ${message}`, LogLevel.ERROR);
      setError(message);
      return;
    }

    setIsUploadModalOpen(false);
    setIsUploadProgressOpen(true);
  };

  const handleReviewLectures = () => {
    addLog('Switching to History view', LogLevel.INFO);
    onSidebarModeChange?.('history');
  };

  return (
    <div style={{
      flex: 1,
      display: 'flex',
      backgroundColor: '#1a1a1a'
    }}>
      {/* Main content area */}
      <div style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '32px'
      }}>
      {/* Error Display */}
      {error && (
        <div style={{
          marginBottom: '32px',
          backgroundColor: 'rgba(127, 29, 29, 0.5)',
          border: '1px solid #b91c1c',
          color: '#fca5a5',
          padding: '16px',
          borderRadius: '8px',
          maxWidth: '400px'
        }}>
          <p style={{ fontWeight: 'bold', marginBottom: '4px' }}>An Error Occurred</p>
          <p style={{ fontSize: '14px' }}>{error}</p>
        </div>
      )}

      {/* Action Buttons Grid */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '24px' }}>
        {/* Row 1: Open Overlay and Upload Details */}
        <div style={{ display: 'flex', gap: '16px' }}>
          {/* Open Overlay Button */}
          <button
            onClick={handleOpenOverlay}
            disabled={isRunning}
            onMouseEnter={() => setHoveredButton('overlay')}
            onMouseLeave={() => setHoveredButton(null)}
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: '16px',
              padding: '24px',
              borderRadius: '16px',
              border: 'none',
              backgroundColor: hoveredButton === 'overlay' && !isRunning ? '#3a3a3a' : 'transparent',
              cursor: isRunning ? 'not-allowed' : 'pointer',
              opacity: isRunning ? 0.5 : 1,
              transition: 'all 0.2s',
              width: '160px'
            }}
          >
            <div style={{
              width: '80px',
              height: '80px',
              borderRadius: '16px',
              backgroundColor: '#F26D21',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              transform: hoveredButton === 'overlay' && !isRunning ? 'scale(1.05)' : 'scale(1)',
              transition: 'transform 0.2s'
            }}>
              <Monitor style={{ width: '40px', height: '40px', color: '#ffffff' }} />
            </div>
            <span style={{ color: '#ffffff', fontWeight: 500, textAlign: 'center' }}>
              {isRunning ? 'Session Active' : 'Open Overlay'}
            </span>
          </button>

          {/* Upload Lecture Details Button */}
          <button
            onClick={handleUploadDetails}
            onMouseEnter={() => setHoveredButton('upload')}
            onMouseLeave={() => setHoveredButton(null)}
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: '16px',
              padding: '24px',
              borderRadius: '16px',
              border: 'none',
              backgroundColor: hoveredButton === 'upload' ? '#3a3a3a' : 'transparent',
              cursor: 'pointer',
              transition: 'all 0.2s',
              width: '160px'
            }}
          >
            <div style={{
              width: '80px',
              height: '80px',
              borderRadius: '16px',
              backgroundColor: '#0E72ED',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              transform: hoveredButton === 'upload' ? 'scale(1.05)' : 'scale(1)',
              transition: 'transform 0.2s'
            }}>
              <Upload style={{ width: '40px', height: '40px', color: '#ffffff' }} />
            </div>
            <span style={{ color: '#ffffff', fontWeight: 500, textAlign: 'center' }}>Upload Lecture</span>
          </button>
        </div>

        {/* Row 2: Review Lectures, Process on Another Device */}
        <div style={{ display: 'flex', gap: '16px' }}>
          <button
            onClick={handleReviewLectures}
            onMouseEnter={() => setHoveredButton('review')}
            onMouseLeave={() => setHoveredButton(null)}
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: '16px',
              padding: '24px',
              borderRadius: '16px',
              border: 'none',
              backgroundColor: hoveredButton === 'review' ? '#3a3a3a' : 'transparent',
              cursor: 'pointer',
              transition: 'all 0.2s',
              width: '160px'
            }}
          >
            <div style={{
              width: '80px',
              height: '80px',
              borderRadius: '16px',
              backgroundColor: '#7c3aed',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              transform: hoveredButton === 'review' ? 'scale(1.05)' : 'scale(1)',
              transition: 'transform 0.2s'
            }}>
              <RotateCw style={{ width: '40px', height: '40px', color: '#ffffff' }} />
            </div>
            <span style={{ color: '#ffffff', fontWeight: 500, textAlign: 'center' }}>Review Lectures</span>
          </button>

          <button
            onClick={() => {
              addLog('Opening remote processing modal', LogLevel.INFO);
              setIsRemoteModalOpen(true);
            }}
            onMouseEnter={() => setHoveredButton('remote')}
            onMouseLeave={() => setHoveredButton(null)}
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: '16px',
              padding: '24px',
              borderRadius: '16px',
              border: 'none',
              backgroundColor: hoveredButton === 'remote' ? '#3a3a3a' : 'transparent',
              cursor: 'pointer',
              transition: 'all 0.2s',
              width: '160px'
            }}
          >
            <div style={{
              width: '80px',
              height: '80px',
              borderRadius: '16px',
              backgroundColor: '#10b981',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              transform: hoveredButton === 'remote' ? 'scale(1.05)' : 'scale(1)',
              transition: 'transform 0.2s'
            }}>
              <NetworkIcon style={{ width: '40px', height: '40px', color: '#ffffff' }} />
            </div>
            <span style={{ color: '#ffffff', fontWeight: 500, textAlign: 'center', wordWrap: 'break-word' }}>
              Other Devices
            </span>
          </button>
        </div>
      </div>

      {/* Status indicator */}
      {isRunning && (
        <div style={{ marginTop: '24px', color: '#4ade80', fontSize: '14px', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ 
            width: '8px', 
            height: '8px', 
            backgroundColor: '#4ade80', 
            borderRadius: '50%',
            animation: 'pulse 1.5s ease-in-out infinite'
          }}></span>
          Lecture session active
        </div>
      )}

      {/* Upload Modals */}
      <UploadLectureModal
        isOpen={isUploadModalOpen}
        onUpload={handleUploadModalUpload}
        onCancel={handleUploadModalCancel}
      />
      <UploadProgressModal
        isOpen={isUploadProgressOpen}
        queue={uploadQueue}
        onClose={() => setIsUploadProgressOpen(false)}
        onCancel={(videoId) => uploadQueueRef.current?.cancelVideo(videoId)}
        onClearCompleted={() => uploadQueueRef.current?.clearCompleted()}
      />

      {/* Recording Confirmation Modal */}
      <RecordingConfirmModal
        isOpen={isConfirmModalOpen}
        onConfirm={handleConfirmModalConfirm}
        onStartWithoutRecording={handleConfirmModalStartWithoutRecording}
        onCancel={handleConfirmModalCancel}
      />

      {/* Screen Source Picker Modal */}
      {isPickerOpen && pickerSources && (
        <ScreenSourcePicker
          isOpen={isPickerOpen}
          sources={pickerSources}
          onSelect={handlePickerSelect}
          onCancel={handlePickerCancel}
        />
      )}

      {/* Remote Processing Modal */}
      <RemoteProcessingModal
        isOpen={isRemoteModalOpen}
        onClose={() => setIsRemoteModalOpen(false)}
        onSuccess={() => {
          // Client mode successful connection - open upload modal
          setIsUploadModalOpen(true);
        }}
      />

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }
      `}</style>
      </div>

      {/* Right Sidebar */}
      <LectureHomeSidebar 
        uploadQueue={uploadQueue}
        onCancelVideo={(videoId) => uploadQueueRef.current?.cancelVideo(videoId)}
        onClearCompleted={() => uploadQueueRef.current?.clearCompleted()}
      />
    </div>
  );
};

export default LectureHome;
