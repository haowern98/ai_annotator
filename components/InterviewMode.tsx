import React from 'react';
import { AppStatus, LogEntry, LogLevel } from '../types';
import Controls from './Controls';
import LiveApiService from '../services/liveApiService';
import { ContinuousStreamingCapture } from '../utils/continuousStreaming';

interface InterviewModeProps {
  // Props will be added later when wiring to Gemini
}

const STREAMING_CONFIG = {
  videoFrameRate: 1, // 1 FPS for video
  audioChunkMs: 100,
  systemInstruction: `You are a interviewing for a software engineer position at a company.

IMPORTANT INSTRUCTIONS:
1. Always transcribe what you heard first, then provide your copilot assistance.
2. When you detect the interviewer has finished speaking (turn complete), respond ONLY IN THE FOLLOWING FORMAT:

TRANSCRIPT: 
(newline)[exact words spoken by interviewer]

(newline)REPLY: 
(newline)[Your reponse to the interviewer's question or statement. If the question is short, reply with a single sentence. If the question is more detailed, provide a more detailed response with examples and elaboration, but still be concise]
`,
};

const InterviewMode: React.FC<InterviewModeProps> = () => {
  const [replies, setReplies] = React.useState<any[]>([]);
  const [currentReply, setCurrentReply] = React.useState<string>(''); // Accumulates streaming response
  const [transcript, setTranscript] = React.useState<any[]>([]);
  const [currentTranscript, setCurrentTranscript] = React.useState<string>(''); // Accumulates partial transcript
  const [status, setStatus] = React.useState<AppStatus>(AppStatus.IDLE);
  const [selectedMode, setSelectedMode] = React.useState<string>('Interview Mode');
  const [mediaStream, setMediaStream] = React.useState<MediaStream | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [liveApiService, setLiveApiService] = React.useState<LiveApiService | null>(null);

  const videoRef = React.useRef<HTMLVideoElement>(null);
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const mediaRecorderRef = React.useRef<MediaRecorder | null>(null);
  const streamingCaptureRef = React.useRef<ContinuousStreamingCapture | null>(null);
  const statusRef = React.useRef(status);

  // Keep status ref updated
  React.useEffect(() => {
    statusRef.current = status;
  }, [status]);

  // Add log helper - now logs to console instead of UI
  const addLog = React.useCallback((message: string, level: LogLevel = LogLevel.INFO) => {
    const timestamp = new Date().toLocaleTimeString();
    const prefix = `[${timestamp}]`;
    
    switch (level) {
      case LogLevel.ERROR:
        console.error(`${prefix} ❌ ${message}`);
        break;
      case LogLevel.WARN:
        console.warn(`${prefix} ⚠️  ${message}`);
        break;
      case LogLevel.SUCCESS:
        console.log(`%c${prefix} ✓ ${message}`, 'color: #4ade80');
        break;
      default:
        console.log(`${prefix} ${message}`);
    }
  }, []);



  const cleanup = React.useCallback(() => {
    // Stop streaming capture
    if (streamingCaptureRef.current) {
      streamingCaptureRef.current.stop();
      streamingCaptureRef.current = null;
    }

    // Stop media recorder
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
      mediaRecorderRef.current.stop();
      mediaRecorderRef.current = null;
    }

    // Disconnect Live API
    if (liveApiService) {
      liveApiService.disconnect();
      setLiveApiService(null);
    }

    // Stop media stream
    if (mediaStream) {
      mediaStream.getTracks().forEach((track) => track.stop());
      setMediaStream(null);
    }
  }, [mediaStream, liveApiService]);

  const handleStart = async () => {
    addLog('Interview Mode: Start Analysis clicked');
    
    if (!process.env.API_KEY) {
      const msg = "API_KEY environment variable not set.";
      addLog(msg, LogLevel.ERROR);
      setError(msg);
      setStatus(AppStatus.ERROR);
      return;
    }

    cleanup();
    setError(null);
    setReplies([]);
    setTranscript([]);
    addLog('Initializing Live API session...');
    setStatus(AppStatus.CAPTURING);

    try {
      addLog('Requesting screen capture permission...');
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
      });

      addLog('Screen capture permission granted.', LogLevel.SUCCESS);

      // Check for audio
      if (stream.getAudioTracks().length > 0) {
        addLog('Audio track found in stream.', LogLevel.SUCCESS);
      } else {
        addLog('No audio track found in stream', LogLevel.WARN);
      }

      setMediaStream(stream);
      setStatus(AppStatus.CONNECTING);

      // Create Live API service
      addLog('Creating Live API service...');
      const service = new LiveApiService(process.env.API_KEY, addLog);

      // Connect to Live API
      await service.connect({
        onTranscript: (text, isFinal) => {
          if (isFinal) {
            addLog(`Transcript (final): ${text.substring(0, 50)}...`);
            setTranscript(prev => [...prev, {
              timestamp: new Date().toLocaleTimeString(),
              text,
            }]);
            setCurrentTranscript(''); // Clear partial transcript
          } else {
            // Accumulate partial transcript
            setCurrentTranscript(text);
          }
        },
        onPartialResponse: (textChunk) => {
          // Accumulate streaming AI response
          setCurrentReply(prev => prev + textChunk);
        },
        onModelResponse: (text) => {
          addLog(`Complete model response: ${text.substring(0, 50)}...`, LogLevel.SUCCESS);
          
          // Parse response to extract transcript and reply
          const transcriptMatch = text.match(/TRANSCRIPT:\s*(.+?)(?=\n\s*REPLY:)/is);
          const replyMatch = text.match(/REPLY:\s*(.+)/is);
          
          if (transcriptMatch && transcriptMatch[1]) {
            const transcriptText = transcriptMatch[1].trim();
            // Add transcript to interviewer transcript section
            setTranscript(prev => [...prev, {
              timestamp: new Date().toLocaleTimeString(),
              text: transcriptText,
            }]);
            addLog(`Extracted transcript: ${transcriptText.substring(0, 30)}...`);
          }
          
          if (replyMatch && replyMatch[1]) {
            const aiReply = replyMatch[1].trim();
            // Filter out responses with leaked labels
            const hasLeakedLabels = /^(TRANSCRIPT|REPLY):/im.test(aiReply);
            if (!hasLeakedLabels) {
              // Add AI reply to replies section
              setReplies(prev => [...prev, {
                timestamp: new Date().toLocaleTimeString(),
                text: aiReply,
              }]);
            }
          } else if (!transcriptMatch) {
            // No proper format found
            setReplies(prev => [...prev, {
              timestamp: new Date().toLocaleTimeString(),
              text: "No reply found - model did not follow format",
            }]);
          }
          
          setCurrentReply(''); // Clear for next response
        },
        onError: (e) => {
          setError(`Live API Error: ${e}`);
          addLog(`Live API Error: ${e}`, LogLevel.ERROR);
          setStatus(AppStatus.ERROR);
          cleanup();
        },
        onClose: (reason) => {
          if (statusRef.current !== AppStatus.STOPPING && statusRef.current !== AppStatus.IDLE) {
            const msg = `Live API closed unexpectedly: ${reason || 'Unknown reason'}`;
            addLog(msg, LogLevel.ERROR);
            setError(msg);
            setStatus(AppStatus.IDLE);
            cleanup();
          }
        },
        onReconnecting: () => {
          addLog('Connection lost. Attempting to reconnect...', LogLevel.WARN);
          setStatus(AppStatus.CONNECTING);
        },
      }, STREAMING_CONFIG.systemInstruction);

      addLog('Live API connection established.', LogLevel.SUCCESS);
      setLiveApiService(service);
      setStatus(AppStatus.ANALYZING);

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

  const handleStop = () => {
    addLog('Interview Mode: Stop Analysis clicked');
    setStatus(AppStatus.STOPPING);
    cleanup();
    setStatus(AppStatus.IDLE);
    addLog('Analysis stopped', LogLevel.SUCCESS);
  };

  // Set video source when mediaStream changes
  React.useEffect(() => {
    if (mediaStream && videoRef.current) {
      videoRef.current.srcObject = mediaStream;
      addLog('Video stream connected to preview', LogLevel.SUCCESS);
    }
  }, [mediaStream, addLog]);

  // Initialize streaming capture when video is ready and Live API is connected
  React.useEffect(() => {
    const video = videoRef.current;
    if (!video || !mediaStream || !liveApiService) return;

    let hasStarted = false;

    const handleVideoReady = () => {
      if (hasStarted) return;
      hasStarted = true;

      addLog('Video metadata loaded. Initializing continuous streaming...', LogLevel.SUCCESS);

      // Create streaming capture instance
      const streamingCapture = new ContinuousStreamingCapture(
        STREAMING_CONFIG,
        {
          onTranscript: (text, isFinal) => {
            if (isFinal) {
              setTranscript(prev => [...prev, {
                timestamp: new Date().toLocaleTimeString(),
                text,
              }]);
            }
          },
          onModelResponse: (text) => {
            setReplies(prev => [...prev, {
              timestamp: new Date().toLocaleTimeString(),
              text,
            }]);
          },
          onError: (error) => {
            setError(`Streaming Error: ${error}`);
            setStatus(AppStatus.ERROR);
          },
          onStatusChange: (newStatus) => {
            setStatus(newStatus);
          },
        },
        addLog,
        {
          videoRef,
          canvasRef,
        }
      );

      streamingCapture.setLiveApiService(liveApiService);
      streamingCapture.setMediaStream(mediaStream);
      streamingCaptureRef.current = streamingCapture;

      // Start streaming
      streamingCapture.start();
      addLog('Continuous audio/video streaming started!', LogLevel.SUCCESS);
    };

    video.addEventListener('loadedmetadata', handleVideoReady);
    
    // If metadata already loaded, trigger immediately
    if (video.readyState >= 1) {
      handleVideoReady();
    }

    return () => {
      video.removeEventListener('loadedmetadata', handleVideoReady);
    };
  }, [mediaStream, liveApiService, addLog]);

  // Cleanup on unmount ONLY
  React.useEffect(() => {
    return () => {
      if (streamingCaptureRef.current) {
        streamingCaptureRef.current.stop();
      }
      if (liveApiService) {
        liveApiService.disconnect();
      }
      if (mediaStream) {
        mediaStream.getTracks().forEach((track) => track.stop());
      }
    };
  }, []); // Empty deps - only on unmount



  return (
    <main className="flex-grow container mx-auto p-4 md:p-6 lg:p-8 flex flex-col lg:flex-row gap-8">
      {/* Left Side - Control Panel and Screen Preview */}
      <div className="lg:w-1/2 flex flex-col gap-4">
        {/* Control Panel */}
        <Controls 
          status={status} 
          onStart={handleStart} 
          onStop={handleStop}
          selectedMode={selectedMode}
          onModeChange={setSelectedMode}
        />

        {/* Error Display */}
        {error && (
          <div className="bg-red-900/50 border border-red-700 text-red-200 p-4 rounded-lg">
            <p className="font-bold">An Error Occurred</p>
            <p className="text-sm">{error}</p>
          </div>
        )}

        {/* Screen Capture Preview - Smaller */}
        <div className="bg-base-200 border border-base-300 rounded-lg shadow-md overflow-hidden" style={{ height: '250px' }}>
          {mediaStream ? (
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              className="w-full h-full object-contain bg-black"
            />
          ) : (
            <div className="w-full h-full flex flex-col items-center justify-center text-center p-6">
              <div className="text-base-300 mb-4">
                <svg className="w-16 h-16 mx-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                </svg>
              </div>
              <h3 className="text-xl font-bold text-content-100 mb-2">Screen Capture Preview</h3>
              <p className="text-sm text-content-200">Your selected screen will appear here once you start the analysis.</p>
            </div>
          )}
        </div>

        {/* Transcript Section */}
        <div className="bg-base-200 border border-base-300 rounded-lg shadow-md flex flex-col" style={{ height: '300px' }}>
          <div className="p-4 border-b border-base-300">
            <h3 className="text-lg font-bold text-content-100">Interviewer Transcript</h3>
          </div>
          <div className="flex-grow p-6 overflow-y-auto">
            {transcript.length === 0 && !currentTranscript ? (
              <div className="h-full flex flex-col items-center justify-center text-center">
                <div className="text-base-300 mb-4">
                  <svg className="w-12 h-12 mx-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                  </svg>
                </div>
                <p className="text-content-200">Transcript will appear here</p>
                <p className="text-sm text-content-200 mt-1">Start the analysis to see the conversation transcript.</p>
              </div>
            ) : (
              <div className="space-y-4">
                {transcript.map((item: any, index: number) => (
                  <div key={index} className="bg-base-300 p-4 rounded-lg">
                    <div className="text-xs text-content-200 mb-2">{item.timestamp}</div>
                    <div className="text-content-100">{item.text}</div>
                  </div>
                ))}
                {/* Show current streaming transcript */}
                {currentTranscript && (
                  <div className="bg-base-300/50 p-4 rounded-lg border-l-4 border-blue-500">
                    <div className="text-xs text-content-200 mb-2">Live...</div>
                    <div className="text-content-100 italic">{currentTranscript}</div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Right Side - AI Reply */}
      <div className="lg:w-1/2 flex flex-col gap-4">
        {/* AI Replies Section - Full height */}
        <div className="bg-base-200 border border-base-300 rounded-lg shadow-md flex flex-col flex-grow">
          <div className="p-4 border-b border-base-300">
            <h3 className="text-lg font-bold text-content-100">AI-Generated Replies</h3>
          </div>
          <div className="flex-grow p-6 overflow-y-auto">
            {replies.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-center">
                <div className="text-base-300 mb-4">
                  <svg className="w-16 h-16 mx-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                  </svg>
                </div>
                <h4 className="text-xl font-bold text-content-100 mb-2">Replies will appear here</h4>
                <p className="text-sm text-content-200">AI responses will be displayed as the conversation progresses.</p>
              </div>
            ) : (
              <div className="space-y-4">
                {replies.map((reply: any, index: number) => (
                  <div key={index} className="border-l-4 border-brand-secondary pl-4 py-2">
                    <div className="text-xs text-content-200 mb-2">{reply.timestamp}</div>
                    <div className="text-content-100">{reply.text}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Hidden canvas for video frame capture */}
      <canvas ref={canvasRef} className="hidden"></canvas>
    </main>
  );
};

export default InterviewMode;
