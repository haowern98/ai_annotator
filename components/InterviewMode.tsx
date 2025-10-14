import React from 'react';
import { AppStatus, LogLevel } from '../types';
import Controls from './Controls';
import { DualGeminiSessionManager } from '../services/dualGeminiSessionManager';

const InterviewMode: React.FC = () => {
  const [replies, setReplies] = React.useState<any[]>([]);
  const [currentReply, setCurrentReply] = React.useState<string>('');
  const [transcript, setTranscript] = React.useState<any[]>([]);
  const [currentTranscript, setCurrentTranscript] = React.useState<string>('');
  const [status, setStatus] = React.useState<AppStatus>(AppStatus.IDLE);
  const [selectedMode, setSelectedMode] = React.useState<string>('Interview Mode');
  const [mediaStream, setMediaStream] = React.useState<MediaStream | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const videoRef = React.useRef<HTMLVideoElement>(null);
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const sessionManagerRef = React.useRef<DualGeminiSessionManager | null>(null);

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

  // Initialize session manager
  React.useEffect(() => {
    sessionManagerRef.current = new DualGeminiSessionManager(
      {
        onStatusChange: (newStatus) => setStatus(newStatus),
        onError: (errorMsg) => setError(errorMsg),
        onTranscriptUpdate: (transcripts, current) => {
          setTranscript(transcripts);
          setCurrentTranscript(current);
        },
        onReplyUpdate: (replyList, current) => {
          setReplies(replyList);
          setCurrentReply(current);
        },
      },
      addLog,
      { videoRef, canvasRef }
    );

    return () => {
      sessionManagerRef.current?.stop();
    };
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

  // Connect video source when mediaStream changes
  React.useEffect(() => {
    if (mediaStream && videoRef.current) {
      videoRef.current.srcObject = mediaStream;
    }
  }, [mediaStream]);

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

    await sessionManagerRef.current?.start(process.env.API_KEY);
  };

  const handleStop = () => {
    addLog('Interview Mode: Stop Analysis clicked');
    sessionManagerRef.current?.stop();
  };

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
