import React from 'react';
import { AppStatus, LogLevel } from '../types';
import Controls from './Controls';
import { DualGeminiSessionManager } from '../services/dualGeminiSessionManager';
import { ScreenSourcePicker } from './ScreenSourcePicker';
import { screenAnalysisService } from '../services/screenAnalysisService';
import { captureScreen } from '../utils/screenCapture';

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
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const sessionManagerRef = React.useRef<DualGeminiSessionManager | null>(null);
  const overlayCreatedRef = React.useRef<boolean>(false);
  const analysisFrameIntervalRef = React.useRef<NodeJS.Timeout | null>(null);
  const analysisActiveRef = React.useRef<boolean>(false);
  
  // Independent screen capture for Screen Analysis (auto-captures primary display)
  const analysisVideoRef = React.useRef<HTMLVideoElement | null>(null);
  const analysisCanvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const analysisStreamRef = React.useRef<MediaStream | null>(null);

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
        sessionManagerRef.current?.pause();
        addLog('Audio streaming paused from overlay', LogLevel.INFO);
      } else if (command === 'resume') {
        sessionManagerRef.current?.resume();
        addLog('Audio streaming resumed from overlay', LogLevel.INFO);
      }
    };

    if (window.electronAPI?.onOverlayControl) {
      window.electronAPI.onOverlayControl(handleOverlayControl);
    }

    // Listen for screen analysis control commands
    const handleAnalysisControl = async (_event: any, command: string | { command: string; text: string }) => {
      if (command === 'start') {
        addLog('Starting Screen Analysis service...', LogLevel.INFO);
        
        try {
          // Get primary screen source directly (without hide/show overlay)
          addLog('Capturing primary display...', LogLevel.INFO);
          
          let primarySourceId: string | undefined;
          
          // Get sources directly without hiding overlay
          if (window.electronAPI?.getScreenSources) {
            const sources = await window.electronAPI.getScreenSources();
            if (sources && sources.length > 0) {
              // Find first "screen" source (not a window)
              const screenSource = sources.find(s => s.id.startsWith('screen:')) || sources[0];
              primarySourceId = screenSource.id;
              addLog(`Using source: ${screenSource.name}`, LogLevel.INFO);
            }
          }
          
          // Capture with the specific sourceId to skip getScreenSources call
          const stream = await captureScreen({
            video: true,
            audio: false,
            sourceId: primarySourceId  // Pass sourceId to skip internal source fetching
          });
          
          analysisStreamRef.current = stream;
          
          // Create hidden video element for frame capture
          if (!analysisVideoRef.current) {
            analysisVideoRef.current = document.createElement('video');
            analysisVideoRef.current.autoplay = true;
            analysisVideoRef.current.playsInline = true;
            analysisVideoRef.current.muted = true;
          }
          
          analysisVideoRef.current.srcObject = stream;
          await analysisVideoRef.current.play();
          
          addLog('Screen capture started', LogLevel.SUCCESS);
          
          // Wait for video dimensions to be available
          await new Promise(resolve => setTimeout(resolve, 300));
          
          analysisActiveRef.current = true;
          
          const connected = await screenAnalysisService.connect({
            onAnalysisReady: (analysis: string) => {
              addLog('Analysis received, sending to overlay', LogLevel.SUCCESS);
              if ((window.electronAPI as any)?.updateOverlayAnalysis) {
                (window.electronAPI as any).updateOverlayAnalysis(JSON.stringify({
                  text: analysis,
                  isGenerating: false
                }));
              }
            },
            onError: (error: Error) => {
              addLog(`Screen Analysis error: ${error.message}`, LogLevel.ERROR);
            },
            onConnectionChange: (isConnected: boolean) => {
              addLog(`Screen Analysis ${isConnected ? 'connected' : 'disconnected'}`, isConnected ? LogLevel.SUCCESS : LogLevel.WARN);
              if ((window.electronAPI as any)?.updateOverlayAnalysis) {
                (window.electronAPI as any).updateOverlayAnalysis(JSON.stringify({
                  isConnected: isConnected
                }));
              }
            }
          });
          
          if (connected) {
            addLog('Screen Analysis service connected, starting frame capture', LogLevel.SUCCESS);
            startAnalysisFrameCapture();
          }
        } catch (err: any) {
          addLog(`Failed to start screen capture: ${err.message}`, LogLevel.ERROR);
          analysisActiveRef.current = false;
        }
      } else if (command === 'stop') {
        addLog('Stopping Screen Analysis service...', LogLevel.INFO);
        analysisActiveRef.current = false;
        stopAnalysisFrameCapture();
        
        // Clean up analysis stream
        if (analysisStreamRef.current) {
          analysisStreamRef.current.getTracks().forEach(track => track.stop());
          analysisStreamRef.current = null;
        }
        if (analysisVideoRef.current) {
          analysisVideoRef.current.srcObject = null;
        }
        
        await screenAnalysisService.disconnect();
      } else if (command === 'generate') {
        addLog('Generating analysis reply...', LogLevel.INFO);
        await screenAnalysisService.generateReply();
      } else if (typeof command === 'object' && command.command === 'question') {
        addLog(`Sending user question: ${command.text.substring(0, 50)}...`, LogLevel.INFO);
        await screenAnalysisService.sendUserQuestion(command.text);
      }
    };

    if ((window.electronAPI as any)?.onAnalysisControl) {
      (window.electronAPI as any).onAnalysisControl(handleAnalysisControl);
    }

    return () => {
      sessionManagerRef.current?.stop();
      
      // Stop analysis frame capture and disconnect
      stopAnalysisFrameCapture();
      screenAnalysisService.disconnect();
      
      // Clean up analysis stream
      if (analysisStreamRef.current) {
        analysisStreamRef.current.getTracks().forEach(track => track.stop());
        analysisStreamRef.current = null;
      }

      // Remove overlay control listener
      if (window.electronAPI?.removeOverlayControlListener) {
        window.electronAPI.removeOverlayControlListener(handleOverlayControl);
      }
      
      // Remove analysis control listener
      if ((window.electronAPI as any)?.removeAnalysisControlListener) {
        (window.electronAPI as any).removeAnalysisControlListener();
      }
    };
  }, [addLog, handleStopFromOverlay]);

  // Frame capture for screen analysis (uses independent analysis stream)
  const captureAnalysisFrame = React.useCallback((): string | null => {
    const video = analysisVideoRef.current;
    if (!video || video.videoWidth === 0 || video.videoHeight === 0) {
      return null;
    }

    // Create canvas if not exists
    if (!analysisCanvasRef.current) {
      analysisCanvasRef.current = document.createElement('canvas');
    }
    const canvas = analysisCanvasRef.current;
    
    // Scale down for efficiency (max 1280px width)
    const scale = Math.min(1, 1280 / video.videoWidth);
    canvas.width = video.videoWidth * scale;
    canvas.height = video.videoHeight * scale;
    
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    
    // Convert to base64 JPEG (quality 0.7 for balance)
    const dataUrl = canvas.toDataURL('image/jpeg', 0.7);
    // Remove the data:image/jpeg;base64, prefix
    return dataUrl.split(',')[1];
  }, []);

  const startAnalysisFrameCapture = React.useCallback(() => {
    if (analysisFrameIntervalRef.current) {
      clearInterval(analysisFrameIntervalRef.current);
    }
    
    addLog('Starting analysis frame capture (1 frame/sec)', LogLevel.INFO);
    
    analysisFrameIntervalRef.current = setInterval(async () => {
      if (!analysisActiveRef.current) return;
      
      const frame = captureAnalysisFrame();
      if (frame) {
        try {
          await screenAnalysisService.sendVideoFrame(frame);
        } catch (err) {
          // Silent fail for frame send errors
        }
      }
    }, 1000); // 1 frame per second
  }, [addLog, captureAnalysisFrame]);

  const stopAnalysisFrameCapture = React.useCallback(() => {
    if (analysisFrameIntervalRef.current) {
      clearInterval(analysisFrameIntervalRef.current);
      analysisFrameIntervalRef.current = null;
      addLog('Stopped analysis frame capture', LogLevel.INFO);
    }
  }, [addLog]);

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
