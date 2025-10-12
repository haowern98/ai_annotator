import React from 'react';
import { AppStatus, LogEntry, LogLevel } from '../types';
import Controls from './Controls';
import LiveApiService from '../services/liveApiService';
import { ContinuousStreamingCapture } from '../utils/continuousStreaming';

// Configuration for the two sessions
const TRANSCRIPT_PROMPT = `You are transcribing audio from an interview. 
Respond ONLY in the following format:

TRANSCRIPT:[exact words spoken by interviewer]`;

const REPLY_PROMPT = `You are interviewing for a software engineer position at a software engineering company.
Respond ONLY in the following format:

REPLY:
[Your response to the interviewer's question or statement. If the question is short, reply with a single sentence. If the question is more detailed, provide a more detailed response with examples and elaboration, but still be concise]`;

const STREAMING_CONFIG = {
  videoFrameRate: 1,
  audioChunkMs: 100,
};

const InterviewMode: React.FC = () => {
  const [replies, setReplies] = React.useState<any[]>([]);
  const [currentReply, setCurrentReply] = React.useState<string>('');
  const [transcript, setTranscript] = React.useState<any[]>([]);
  const [currentTranscript, setCurrentTranscript] = React.useState<string>('');
  const [status, setStatus] = React.useState<AppStatus>(AppStatus.IDLE);
  const [selectedMode, setSelectedMode] = React.useState<string>('Interview Mode');
  const [mediaStream, setMediaStream] = React.useState<MediaStream | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  
  // State for the two service instances
  const [transcriptService, setTranscriptService] = React.useState<LiveApiService | null>(null);
  const [replyService, setReplyService] = React.useState<LiveApiService | null>(null);

  const videoRef = React.useRef<HTMLVideoElement>(null);
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const streamingCaptureRef = React.useRef<ContinuousStreamingCapture | null>(null);
  const statusRef = React.useRef(status);

  React.useEffect(() => {
    statusRef.current = status;
  }, [status]);

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

  const cleanup = React.useCallback(() => {
    if (streamingCaptureRef.current) {
      streamingCaptureRef.current.stop();
      streamingCaptureRef.current = null;
    }
    
    transcriptService?.disconnect();
    replyService?.disconnect();
    setTranscriptService(null);
    setReplyService(null);

    if (mediaStream) {
      mediaStream.getTracks().forEach((track) => track.stop());
      setMediaStream(null);
    }
  }, [mediaStream, transcriptService, replyService]);

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
    setCurrentReply('');
    setTranscript([]);
    setCurrentTranscript('');
    addLog('Initializing dual-session Live API...');
    setStatus(AppStatus.CAPTURING);

    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      setMediaStream(stream);
      setStatus(AppStatus.CONNECTING);

      // --- Create and Connect Both Services ---
      const service1 = new LiveApiService(process.env.API_KEY, addLog);
      const service2 = new LiveApiService(process.env.API_KEY, addLog);

      // Connect Transcript Service
      const connectTranscript = service1.connect({
        onTranscript: (text, isFinal) => {
          if (isFinal) {
            addLog(`Transcript (final): ${text.substring(0, 50)}...`, LogLevel.SUCCESS);
            // This service should primarily use onModelResponse due to the prompt
          } else {
            setCurrentTranscript(text);
          }
        },
        onModelResponse: (text) => {
           const match = text.match(/TRANSCRIPT:\s*(.*)/is);
           if (match && match[1]) {
             const transcriptText = match[1].trim();
             setTranscript(prev => [...prev, { timestamp: new Date().toLocaleTimeString(), text: transcriptText }]);
             addLog(`Parsed transcript: ${transcriptText.substring(0,30)}...`);
           }
           setCurrentTranscript('');
        },
        onError: (e) => { setError(`Transcript Service Error: ${e}`); setStatus(AppStatus.ERROR); cleanup(); },
        onClose: () => addLog('Transcript service closed.'),
      }, TRANSCRIPT_PROMPT);
      
      // Connect Reply Service
      const connectReply = service2.connect({
        onTranscript: () => {}, // Not used by this service
        onPartialResponse: (textChunk) => {
          setCurrentReply(prev => prev + textChunk);
        },
        onModelResponse: (text) => {
          const match = text.match(/REPLY:\s*(.*)/is);
          if (match && match[1]) {
            const replyText = match[1].trim();
            setReplies(prev => [...prev, { timestamp: new Date().toLocaleTimeString(), text: replyText }]);
            addLog(`Parsed reply: ${replyText.substring(0,30)}...`, LogLevel.SUCCESS);
          }
          setCurrentReply('');
        },
        onError: (e) => { setError(`Reply Service Error: ${e}`); setStatus(AppStatus.ERROR); cleanup(); },
        onClose: () => addLog('Reply service closed.'),
      }, REPLY_PROMPT);

      await Promise.all([connectTranscript, connectReply]);

      addLog('Both API services connected successfully.', LogLevel.SUCCESS);
      setTranscriptService(service1);
      setReplyService(service2);
      setStatus(AppStatus.ANALYZING);

    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error.";
      addLog(`Failed to start session: ${message}`, LogLevel.ERROR);
      setError(`Failed to start session: ${message}`);
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
  
  // Connect video source when mediaStream changes
  React.useEffect(() => {
    if (mediaStream && videoRef.current) {
      videoRef.current.srcObject = mediaStream;
    }
  }, [mediaStream]);

  // Initialize streaming when services and video are ready
  React.useEffect(() => {
    const video = videoRef.current;
    if (!video || !mediaStream || !transcriptService || !replyService) return;

    let hasStarted = false;
    const handleVideoReady = () => {
      if (hasStarted) return;
      hasStarted = true;

      addLog('Video ready. Initializing continuous streaming...', LogLevel.SUCCESS);
      const capture = new ContinuousStreamingCapture(
        STREAMING_CONFIG,
        {
          onError: (error) => { setError(`Streaming Error: ${error}`); setStatus(AppStatus.ERROR); },
          onStatusChange: (newStatus) => setStatus(newStatus),
        },
        addLog,
        { videoRef, canvasRef }
      );
      
      // Set both services and the media stream
      capture.setApiServices({ transcriptService, replyService });
      capture.setMediaStream(mediaStream);
      streamingCaptureRef.current = capture;

      capture.start();
      addLog('Continuous streaming started for both sessions!', LogLevel.SUCCESS);
    };

    video.addEventListener('loadedmetadata', handleVideoReady);
    if (video.readyState >= 1) handleVideoReady();

    return () => video.removeEventListener('loadedmetadata', handleVideoReady);
  }, [mediaStream, transcriptService, replyService, addLog]);

  // Main component render (no changes needed here, but included for completeness)
  return (
    <main className="flex-grow container mx-auto p-4 md:p-6 lg:p-8 flex flex-col lg:flex-row gap-8">
      {/* Left Side */}
      <div className="lg:w-1/2 flex flex-col gap-4">
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
            <video ref={videoRef} autoPlay playsInline muted className="w-full h-full object-contain bg-black" />
          ) : (
            <div className="w-full h-full flex flex-col items-center justify-center text-center p-6">
              <h3 className="text-xl font-bold text-content-100 mb-2">Screen Capture Preview</h3>
            </div>
          )}
        </div>
        <div className="bg-base-200 border border-base-300 rounded-lg shadow-md flex flex-col" style={{ height: '300px' }}>
          <div className="p-4 border-b border-base-300"><h3 className="text-lg font-bold">Interviewer Transcript</h3></div>
          <div className="flex-grow p-6 overflow-y-auto">
            <div className="space-y-4">
              {transcript.map((item, index) => (
                <div key={index} className="bg-base-300 p-4 rounded-lg">
                  <div className="text-xs text-content-200 mb-2">{item.timestamp}</div>
                  <div>{item.text}</div>
                </div>
              ))}
              {currentTranscript && (
                <div className="bg-base-300/50 p-4 rounded-lg italic text-content-200">{currentTranscript}</div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Right Side */}
      <div className="lg:w-1/2 flex flex-col gap-4">
        <div className="bg-base-200 border border-base-300 rounded-lg shadow-md flex flex-col" style={{ height: '700px' }}>
          <div className="p-4 border-b border-base-300"><h3 className="text-lg font-bold">AI-Generated Replies</h3></div>
          <div className="flex-grow p-6 overflow-y-auto">
             <div className="space-y-4">
                {replies.map((reply, index) => (
                  <div key={index} className="border-l-4 border-brand-secondary pl-4 py-2">
                    <div className="text-xs text-content-200 mb-2">{reply.timestamp}</div>
                    <div>{reply.text}</div>
                  </div>
                ))}
                {currentReply && (
                  <div className="border-l-4 border-brand-secondary/50 pl-4 py-2 italic text-content-200">{currentReply}</div>
                )}
              </div>
          </div>
        </div>
      </div>
      <canvas ref={canvasRef} className="hidden"></canvas>
    </main>
  );
};

export default InterviewMode;