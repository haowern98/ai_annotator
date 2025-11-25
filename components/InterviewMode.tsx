import React from 'react';
import { AppStatus, LogLevel } from '../types';
import Controls from './Controls';
import { DualGeminiSessionManager } from '../services/dualGeminiSessionManager';
import { ScreenSourcePicker } from './ScreenSourcePicker';

const InterviewMode: React.FC = () => {
  const [replies, setReplies] = React.useState<any[]>([]);
  const [currentReply, setCurrentReply] = React.useState<string>('');
  const [transcript, setTranscript] = React.useState<any[]>([]);
  const [currentTranscript, setCurrentTranscript] = React.useState<string>('');
  const [status, setStatus] = React.useState<AppStatus>(AppStatus.IDLE);
  const [selectedMode, setSelectedMode] = React.useState<string>('Interview Mode');
  const [mediaStream, setMediaStream] = React.useState<MediaStream | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  // Screen source picker state (for Electron)
  const [isPickerOpen, setIsPickerOpen] = React.useState(false);
  const [pickerSources, setPickerSources] = React.useState<Array<{id: string; name: string; thumbnail: string; appIcon?: string | null}> | null>(null);
  const pickerResolveRef = React.useRef<((sourceId: string) => void) | null>(null);

  const videoRef = React.useRef<HTMLVideoElement>(null);
  const sessionManagerRef = React.useRef<DualGeminiSessionManager | null>(null);
  const overlayCreatedRef = React.useRef<boolean>(false);

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

  // Handle stop from overlay
  const handleStopFromOverlay = React.useCallback(async () => {
    addLog('Stop requested from overlay');
    sessionManagerRef.current?.stop();

    // Close overlay window
    if (window.electronAPI?.closeOverlay && overlayCreatedRef.current) {
      try {
        await window.electronAPI.closeOverlay();
        overlayCreatedRef.current = false;
        addLog('Overlay window closed', LogLevel.INFO);
      } catch (err) {
        addLog(`Error closing overlay: ${err}`, LogLevel.ERROR);
      }
    }
  }, [addLog]);

  // Initialize session manager - FIXED: removed refs parameter
  React.useEffect(() => {
    sessionManagerRef.current = new DualGeminiSessionManager(
      {
        onStatusChange: (newStatus) => setStatus(newStatus),
        onError: (errorMsg) => setError(errorMsg),
        onTranscriptUpdate: (transcripts, current) => {
          const timestamp = new Date().toISOString();
          console.log(`[${timestamp}] 🎨 REACT STATE UPDATE: currentTranscript.length=${current.length}`);
          console.log(`[${timestamp}] 🎨 Preview text: "${current.substring(0, 100)}${current.length > 100 ? '...' : ''}"`);

          setTranscript(transcripts);
          setCurrentTranscript(current);

          console.log(`[${timestamp}] ✅ React setState called`);

          // Send completed transcripts AND current to overlay if it exists
          if (window.electronAPI?.updateOverlayTranscript) {
            // Send both completed transcripts and current incomplete text
            window.electronAPI.updateOverlayTranscript(JSON.stringify({
              completed: transcripts,
              current: current
            }));
          }
        },
        onReplyUpdate: (replyList, current) => {
          setReplies(replyList);
          setCurrentReply(current);

          // Send completed replies AND current to overlay if it exists
          if (window.electronAPI?.updateOverlayReply) {
            // Send both completed replies and current incomplete text
            window.electronAPI.updateOverlayReply(JSON.stringify({
              completed: replyList,
              current: current
            }));
          }
        },
      },
      addLog
    );

    // Listen for control commands from overlay
    const handleOverlayControl = (_event: any, command: string) => {
      if (command === 'stop') {
        handleStopFromOverlay();
      } else if (command === 'pause') {
        // TODO: Implement pause functionality
        addLog('Pause requested from overlay (not yet implemented)', LogLevel.WARN);
      }
    };

    if (window.electronAPI?.onOverlayControl) {
      window.electronAPI.onOverlayControl(handleOverlayControl);
    }

    return () => {
      sessionManagerRef.current?.stop();

      // Remove overlay control listener
      if (window.electronAPI?.removeOverlayControlListener) {
        window.electronAPI.removeOverlayControlListener(handleOverlayControl);
      }
    };
  }, [addLog, handleStopFromOverlay]);

  // Update media stream from session manager
  React.useEffect(() => {
    const interval = setInterval(() => {
      if (sessionManagerRef.current) {
        const stream = sessionManagerRef.current.getMediaStream();
        if (stream !== mediaStream) {
          setMediaStream(stream);
        }
      }
    }, 100);

    return () => clearInterval(interval);
  }, [mediaStream]);

  // Simple video element stream assignment
  React.useEffect(() => {
    if (!mediaStream || !videoRef.current) return;

    const video = videoRef.current;

    // Log stream track information
    const videoTracks = mediaStream.getVideoTracks();
    const audioTracks = mediaStream.getAudioTracks();
    addLog(`Stream assigned - Video: ${videoTracks.length} tracks, Audio: ${audioTracks.length} tracks`, LogLevel.INFO);

    // Assign stream to video element
    video.srcObject = mediaStream;

    // Attempt to play
    video.play().catch(err => {
      addLog(`Video autoplay blocked: ${err.message}`, LogLevel.WARN);
    });

    return () => {
      video.srcObject = null;
    };
  }, [mediaStream, addLog]);

  // Picker handlers
  const handlePickerSelect = React.useCallback(async (sourceId: string) => {
    setIsPickerOpen(false);
    if (pickerResolveRef.current) {
      pickerResolveRef.current(sourceId);
      pickerResolveRef.current = null;
    }
    setPickerSources(null);

    // Create overlay window after source selection
    if (window.electronAPI?.createOverlay && !overlayCreatedRef.current) {
      try {
        const result = await window.electronAPI.createOverlay();
        if (result.success) {
          overlayCreatedRef.current = true;
          addLog('Overlay window created', LogLevel.SUCCESS);
        } else {
          addLog(`Failed to create overlay: ${result.error}`, LogLevel.ERROR);
        }
      } catch (err) {
        addLog(`Error creating overlay: ${err}`, LogLevel.ERROR);
      }
    }
  }, [addLog]);

  const handlePickerCancel = React.useCallback(() => {
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
    addLog('Interview Mode: Start Analysis clicked');
    if (!process.env.API_KEY) {
      const msg = "API_KEY environment variable not set.";
      addLog(msg, LogLevel.ERROR);
      setError(msg);
      setStatus(AppStatus.ERROR);
      return;
    }

    setError(null);
    setReplies([]);
    setCurrentReply('');
    setTranscript([]);
    setCurrentTranscript('');

    // Pass the picker callback to the session manager
    const onSourceRequired = async (sources: any[]) => {
      return new Promise<string>((resolve) => {
        setPickerSources(sources);
        setIsPickerOpen(true);
        pickerResolveRef.current = resolve;
      });
    };

    await sessionManagerRef.current?.start(process.env.API_KEY, onSourceRequired);
  };

  const handleStop = async () => {
    addLog('Interview Mode: Stop Analysis clicked');
    sessionManagerRef.current?.stop();

    // Close overlay window
    if (window.electronAPI?.closeOverlay && overlayCreatedRef.current) {
      try {
        await window.electronAPI.closeOverlay();
        overlayCreatedRef.current = false;
        addLog('Overlay window closed', LogLevel.INFO);
      } catch (err) {
        addLog(`Error closing overlay: ${err}`, LogLevel.ERROR);
      }
    }
  };

  return (
    <main className="flex-grow container mx-auto p-4 md:p-6 lg:p-8 flex flex-col lg:flex-row gap-8">
      {/* Left Side */}
      <div className="lg:w-1/3 flex flex-col gap-4">
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
        <div className="bg-base-200 border border-base-300 rounded-lg shadow-md overflow-hidden" style={{ height: '250px' }}>
          {mediaStream ? (
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              style={{
                width: '100%',
                height: '100%',
                objectFit: 'contain',
                backgroundColor: 'black'
              }}
            />
          ) : (
            <div className="w-full h-full flex flex-col items-center justify-center text-center p-6">
              <h3 className="text-xl font-bold text-content-100 mb-2">Screen Capture Preview</h3>
            </div>
          )}
        </div>
      </div>

      {/* Middle - AI Replies */}
      <div className="lg:w-1/3 flex flex-col gap-4">
        <div className="bg-base-200 border border-base-300 rounded-lg shadow-md flex flex-col" style={{ height: '700px' }}>
          <div className="p-4 border-b border-base-300"><h3 className="text-lg font-bold">AI-Generated Replies</h3></div>
          <div className="flex-grow p-6 overflow-y-auto">
             <div className="space-y-4">
                {currentReply && (
                  <div className="border-l-4 border-brand-secondary/50 pl-4 py-2 italic text-content-200">{currentReply}</div>
                )}
                {[...replies].reverse().map((reply, index) => (
                  <div key={index} className="border-l-4 border-brand-secondary pl-4 py-2">
                    <div className="text-xs text-content-200 mb-2">{reply.timestamp}</div>
                    <div>{reply.text}</div>
                  </div>
                ))}
              </div>
          </div>
        </div>
      </div>

      {/* Right Side - Interview Transcript */}
      <div className="lg:w-1/3 flex flex-col gap-4">
        <div className="bg-base-200 border border-base-300 rounded-lg shadow-md flex flex-col" style={{ height: '700px' }}>
          <div className="p-4 border-b border-base-300"><h3 className="text-lg font-bold">Interviewer Transcript</h3></div>
          <div className="flex-grow p-6 overflow-y-auto">
            <div className="space-y-4">
              {currentTranscript && (
                <div className="bg-base-300/50 p-4 rounded-lg italic text-content-200">{currentTranscript}</div>
              )}
              {transcript.map((item, index) => (
                <div key={index} className="bg-base-300 p-4 rounded-lg">
                  <div className="text-xs text-content-200 mb-2">{item.timestamp}</div>
                  <div>{item.text}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Screen Source Picker Modal (Electron only) */}
      {isPickerOpen && pickerSources && (
        <ScreenSourcePicker
          isOpen={isPickerOpen}
          sources={pickerSources}
          onSelect={handlePickerSelect}
          onCancel={handlePickerCancel}
        />
      )}
    </main>
  );
};

export default InterviewMode;
