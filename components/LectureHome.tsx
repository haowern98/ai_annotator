import React from 'react';
import { Monitor, Upload, RotateCw } from 'lucide-react';
import { NetworkIcon } from './icons';
import { LogLevel } from '../types';
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
}

const LectureHome: React.FC<LectureHomeProps> = ({ onSessionStart, onSidebarModeChange }) => {
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

  // Upload queue manager state
  const uploadQueueRef = React.useRef<UploadQueueManager | null>(null);
  const [uploadQueue, setUploadQueue] = React.useState<QueuedVideo[]>([]);
  const [isUploadProgressOpen, setIsUploadProgressOpen] = React.useState(false);
  const uploadParakeetRef = React.useRef<ParakeetBatchTranscriber | null>(null);

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

  // Initialize session manager + upload queue (batch-only)
  React.useEffect(() => {
    sessionManagerRef.current = new LectureParakeetSessionManager(addLog);

    // Batch clients: keep these independent from live capture/session manager
    const uploadParakeet = new ParakeetBatchTranscriber(addLog);
    
    // Load remote processing config to determine Qwen URL
    let qwenUrl = 'http://127.0.0.1:7556'; // default local
    try {
      const remoteConfig = localStorage.getItem('qwen_remote_config');
      if (remoteConfig) {
        const config = JSON.parse(remoteConfig);
        if (config.mode === 'client' && config.remoteUrl) {
          qwenUrl = config.remoteUrl;
          addLog(`[Upload Queue] Using remote Qwen server: ${qwenUrl}`, LogLevel.INFO);
        }
      }
    } catch (e) {
      addLog('[Upload Queue] Failed to load remote config, using local server', LogLevel.WARN);
    }
    
    const uploadQwen = new QwenHttpClient(qwenUrl);
    uploadParakeetRef.current = uploadParakeet;

    const initUploadClients = async () => {
      try {
        await uploadParakeet.connect({
          onReady: () => addLog('[Upload Queue] Parakeet worker ready', LogLevel.SUCCESS),
          onError: (err) => addLog(`[Upload Queue] Parakeet error: ${err}`, LogLevel.ERROR),
        });

        await uploadQwen.connect({
          onReady: () => addLog('[Upload Queue] Qwen worker ready', LogLevel.SUCCESS),
          onError: (err) => addLog(`[Upload Queue] Qwen error: ${err}`, LogLevel.ERROR),
          onProgress: (msg) => addLog(`[Upload Queue] ${msg}`, LogLevel.INFO),
        });

        uploadQueueRef.current = new UploadQueueManager(uploadParakeet, uploadQwen, () => isRunning, {
          onQueueUpdate: (queue) => setUploadQueue(queue),
          onVideoComplete: (video) => addLog(`Upload complete: ${video.fileName}`, LogLevel.SUCCESS),
          onVideoError: (video, err) => addLog(`Upload failed: ${video.fileName} - ${err}`, LogLevel.ERROR),
          onLog: addLog,
        });

        addLog('[Upload Queue] Queue manager initialized', LogLevel.SUCCESS);
      } catch (e) {
        addLog(`[Upload Queue] Initialization failed: ${e}`, LogLevel.ERROR);
      }
    };

    initUploadClients();

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
        handleStopFromOverlay();
      } else if (command === 'pause') {
        sessionManagerRef.current?.pause();
      } else if (command === 'resume') {
        sessionManagerRef.current?.resume();
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
      const recordingQuality = quality; // Local variable to use throughout this function
      setSelectedQuality(quality);
      if (quality === null) {
        addLog('Proceeding without recording', LogLevel.INFO);
      } else {
        addLog(`Selected recording quality: ${quality}`, LogLevel.SUCCESS);
      }

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

      mediaStreamRef.current = stream;

      // Setup video element
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }

      // Setup recording if quality was selected (but don't start yet)
      if (recordingQuality !== null && videoRef.current) {
        await setupRecording(videoRef.current, recordingQuality);
      }

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
      recordingQualityRef.current = recordingQuality;
      
      if (recordingQuality !== null && electronAPI?.updateLectureStatus) {
        addLog(`Sending recording status to overlay: quality=${recordingQuality}`, LogLevel.INFO);
        const statusResult = await electronAPI.updateLectureStatus(JSON.stringify({
          isConnected: false,
          isRunning: false,
          isPaused: false,
          isRecording: true,
          recordingQuality: recordingQuality,
          elapsedTime: '[00:00]'
        }));
        addLog(`Recording status sent to overlay: ${JSON.stringify(statusResult)}`, LogLevel.INFO);
      } else {
        addLog(`NOT sending recording status: recordingQuality=${recordingQuality}, hasUpdateAPI=${!!electronAPI?.updateLectureStatus}`, LogLevel.WARN);
      }

      // Set session start time (for both recording and non-recording sessions)
      sessionStartTimeRef.current = Date.now();
      stopProcessedRef.current = false;  // Reset stop flag for new session

      // Start the session
      await sessionManagerRef.current?.start(
        {
          onTranscriptUpdate: (transcripts: TranscriptEntry[], current: string | null) => {
            // Format transcripts with timestamps
            const formatted = transcripts.map(t => ({
              ...t,
              formattedTime: sessionManagerRef.current?.formatTimestamp(t.timestampMs) ?? '[00:00]'
            }));

            // Send to overlay
            if (electronAPI?.updateLectureTranscript) {
              electronAPI.updateLectureTranscript(JSON.stringify({
                transcripts: formatted,
                current
              }));
            }
          },
          onSummaryUpdate: (summaries: SummaryEntry[], isGenerating: boolean) => {
            // Summaries already have windowLabel from dual-session manager
            // Send to overlay
            if (electronAPI?.updateLectureSummary) {
              electronAPI.updateLectureSummary(JSON.stringify({
                summaries,
                isGenerating
              }));
            }
          },
          onError: (errorMsg: string) => {
            addLog(`Session error: ${errorMsg}`, LogLevel.ERROR);
            setError(errorMsg);
          },
          onConnectionChange: async (transcriptConnected: boolean, summaryConnected: boolean) => {
            const connected = transcriptConnected || summaryConnected;
            addLog(`Connection: Transcript=${transcriptConnected}, Summary=${summaryConnected}`, connected ? LogLevel.SUCCESS : LogLevel.WARN);
            setIsRunning(connected);

            // Send status to overlay
            if (electronAPI?.updateLectureStatus) {
              const statusResult = await electronAPI.updateLectureStatus(JSON.stringify({
                isConnected: connected,
                isRunning: connected,
                isPaused: false,
                isRecording: recordingQuality !== null,
                recordingQuality: recordingQuality,
                elapsedTime: sessionManagerRef.current?.formatTimestamp(
                  sessionManagerRef.current?.getElapsedTime() ?? 0
                ) ?? '[00:00]'
              }));
              addLog(`Status update result: ${JSON.stringify(statusResult)}`, LogLevel.INFO);
            }
          },
        },
        stream,
        videoRef.current!,
        canvasRef.current!
      );

      setIsRunning(true);
      onSessionStart?.();
      addLog('Lecture session started', LogLevel.SUCCESS);

    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      addLog(`Failed to start lecture session: ${message}`, LogLevel.ERROR);
      setError(message);
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

  const handleUploadModalUpload = (source: { type: 'youtube' | 'file'; value: string | File }) => {
    if (source.type === 'youtube') {
      if (!uploadQueueRef.current) {
        addLog('Upload queue not ready', LogLevel.ERROR);
        setError('Upload queue not ready yet. Try again in a moment.');
        return;
      }

      const url = String(source.value || '').trim();
      if (!url) {
        setError('Please enter a YouTube URL');
        return;
      }

      uploadQueueRef.current.addYouTubeUrl(url);
      setIsUploadModalOpen(false);
      setIsUploadProgressOpen(true);
      return;
    }

    const file = source.value as File;
    if (!uploadQueueRef.current) {
      addLog('Upload queue not ready', LogLevel.ERROR);
      setError('Upload queue not ready yet. Try again in a moment.');
      return;
    }

    uploadQueueRef.current.addVideo(file);
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
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '32px',
      backgroundColor: '#1a1a1a'
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
  );
};

export default LectureHome;
