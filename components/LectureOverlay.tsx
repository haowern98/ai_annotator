import React, { useEffect, useState, useRef, useMemo } from 'react';

interface TranscriptEntry {
  id: string;
  text: string;
  timestampMs: number;
  isFinal: boolean;
  formattedTime?: string;
}

interface SummaryEntry {
  id: string;
  text: string;
  timestampMs: number;
  windowStart: number;
  windowEnd: number;
  windowLabel: string;
}

// Markdown renderer for summaries (simplified from InterviewOverlay)
const MarkdownRenderer: React.FC<{ content: string }> = ({ content }) => {
  const rendered = useMemo(() => {
    if (!content) return null;

    const elements: React.ReactNode[] = [];
    const lines = content.split('\n');
    let keyIndex = 0;

    lines.forEach((line, lineIndex) => {
      if (lineIndex > 0) {
        elements.push(<br key={`br-${keyIndex++}`} />);
      }

      // Check for bullet points
      const bulletMatch = line.match(/^(\s*)[-*]\s+(.*)$/);
      if (bulletMatch) {
        const indent = bulletMatch[1].length;
        const bulletContent = bulletMatch[2];
        elements.push(
          <span key={`bullet-${keyIndex++}`} style={{ marginLeft: `${indent * 8 + 8}px`, display: 'inline-block' }}>
            • {processInline(bulletContent, keyIndex)}
          </span>
        );
        keyIndex++;
      } else {
        elements.push(...processInline(line, keyIndex));
        keyIndex++;
      }
    });

    return elements;
  }, [content]);

  return <div className="markdown-content">{rendered}</div>;
};

// Process bold, italic, inline code
function processInline(text: string, baseKey: number): React.ReactNode[] {
  const elements: React.ReactNode[] = [];
  const regex = /(\*\*(.+?)\*\*)|(\*(.+?)\*)|(`([^`]+)`)/g;
  let lastIndex = 0;
  let match;
  let keyIndex = 0;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      elements.push(
        <span key={`plain-${baseKey}-${keyIndex++}`}>
          {text.slice(lastIndex, match.index)}
        </span>
      );
    }

    if (match[1]) {
      // Bold
      elements.push(
        <strong key={`bold-${baseKey}-${keyIndex++}`} className="md-bold">{match[2]}</strong>
      );
    } else if (match[3]) {
      // Italic
      elements.push(
        <em key={`italic-${baseKey}-${keyIndex++}`} className="md-italic">{match[4]}</em>
      );
    } else if (match[5]) {
      // Inline code
      elements.push(
        <code key={`code-${baseKey}-${keyIndex++}`} className="md-inline-code">{match[6]}</code>
      );
    }

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    elements.push(
      <span key={`plain-${baseKey}-${keyIndex++}`}>{text.slice(lastIndex)}</span>
    );
  }

  return elements.length > 0 ? elements : [<span key={`empty-${baseKey}`}>{text}</span>];
}

const LectureOverlay: React.FC = () => {
  // Transcript state
  const [transcripts, setTranscripts] = useState<TranscriptEntry[]>([]);
  const [currentTranscript, setCurrentTranscript] = useState<string | null>(null);
  
  // Summary state
  const [summaries, setSummaries] = useState<SummaryEntry[]>([]);
  const [isSummaryGenerating, setIsSummaryGenerating] = useState(false);
  
  // Connection state
  const [isConnected, setIsConnected] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [elapsedTime, setElapsedTime] = useState('[00:00]');
  const [remotePhase, setRemotePhase] = useState<string | null>(null);
  
  // Recording state
  const [isRecording, setIsRecording] = useState(false);
  const [recordingQuality, setRecordingQuality] = useState<string | null>(null);
  
  // Section heights (resizable)
  const [transcriptHeight, setTranscriptHeight] = useState<number>(180);
  const [summaryHeight, setSummaryHeight] = useState<number>(220);
  
  // Overlay width (resizable)
  const [overlayWidth, setOverlayWidth] = useState<number>(934);
  const MIN_WIDTH = 520;
  
  // Resize state
  const [resizingSection, setResizingSection] = useState<'transcript' | 'summary' | null>(null);
  const [resizingWidth, setResizingWidth] = useState(false);
  const resizeStartY = useRef(0);
  const resizeStartHeight = useRef(0);
  const resizeStartX = useRef(0);
  const resizeStartWidth = useRef(0);
  
  // Refs for auto-scroll
  const transcriptRef = useRef<HTMLDivElement>(null);
  const summaryRef = useRef<HTMLDivElement>(null);

  // Listen for updates from main process
  useEffect(() => {
    const electronAPI = window.electronAPI as any;
    
    // Transcript updates
    const handleTranscriptUpdate = (_event: any, data: string) => {
      try {
        const parsed = JSON.parse(data);
        setTranscripts(parsed.transcripts || []);
        setCurrentTranscript(parsed.current || null);
      } catch (err) {
        console.error('Failed to parse transcript data:', err);
      }
    };
    
    // Summary updates
    const handleSummaryUpdate = (_event: any, data: string) => {
      try {
        const parsed = JSON.parse(data);
        setSummaries(parsed.summaries || []);
        setIsSummaryGenerating(parsed.isGenerating ?? false);
      } catch (err) {
        console.error('Failed to parse summary data:', err);
      }
    };
    
    // Status updates
    const handleStatusUpdate = (_event: any, data: string) => {
      try {
        const parsed = JSON.parse(data);
        console.log('[LectureOverlay] Status update received:', parsed);
        if (parsed.isConnected !== undefined) setIsConnected(parsed.isConnected);
        if (parsed.isRunning !== undefined) setIsRunning(parsed.isRunning);
        if (parsed.isPaused !== undefined) setIsPaused(parsed.isPaused);
        if (parsed.elapsedTime !== undefined) setElapsedTime(parsed.elapsedTime);
        if (parsed.remotePhase !== undefined) setRemotePhase(parsed.remotePhase ? String(parsed.remotePhase) : null);
        if (parsed.isRecording !== undefined) {
          console.log('[LectureOverlay] Setting isRecording to:', parsed.isRecording);
          setIsRecording(parsed.isRecording);
        }
        if (parsed.recordingQuality !== undefined) {
          console.log('[LectureOverlay] Setting recordingQuality to:', parsed.recordingQuality);
          setRecordingQuality(parsed.recordingQuality);
        }
      } catch (err) {
        console.error('Failed to parse status data:', err);
      }
    };
    
    // Register listeners
    if (electronAPI?.onLectureTranscriptUpdate) {
      electronAPI.onLectureTranscriptUpdate(handleTranscriptUpdate);
    }
    if (electronAPI?.onLectureSummaryUpdate) {
      electronAPI.onLectureSummaryUpdate(handleSummaryUpdate);
    }
    if (electronAPI?.onLectureStatusUpdate) {
      electronAPI.onLectureStatusUpdate(handleStatusUpdate);
    }
    
    return () => {
      if (electronAPI?.removeLectureTranscriptListener) {
        electronAPI.removeLectureTranscriptListener(handleTranscriptUpdate);
      }
      if (electronAPI?.removeLectureSummaryListener) {
        electronAPI.removeLectureSummaryListener(handleSummaryUpdate);
      }
      if (electronAPI?.removeLectureStatusListener) {
        electronAPI.removeLectureStatusListener(handleStatusUpdate);
      }
    };
  }, []);

  // Auto-scroll transcript
  useEffect(() => {
    if (transcriptRef.current) {
      transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
    }
  }, [transcripts, currentTranscript]);

  // Auto-scroll summary
  useEffect(() => {
    if (summaryRef.current) {
      summaryRef.current.scrollTop = summaryRef.current.scrollHeight;
    }
  }, [summaries]);

  // Calculate window height
  const calculateWindowHeight = () => {
    let height = 16; // Padding
    height += transcriptHeight;
    height += 14; // Resize handle
    height += summaryHeight;
    height += 14; // Resize handle
    return height;
  };

  // Update window size
  const updateWindowSize = async (width?: number, height?: number) => {
    const finalHeight = height ?? calculateWindowHeight();
    const finalWidth = width ?? overlayWidth + 16;
    const electronAPI = window.electronAPI as any;
    if (electronAPI?.resizeLectureOverlay) {
      await electronAPI.resizeLectureOverlay({ width: finalWidth, height: finalHeight });
    }
  };

  // Auto-resize on section changes
  useEffect(() => {
    updateWindowSize();
  }, [transcriptHeight, summaryHeight, overlayWidth]);

  // Height resize handlers
  const handleResizeMouseDown = (section: 'transcript' | 'summary') => (e: React.MouseEvent) => {
    e.preventDefault();
    setResizingSection(section);
    resizeStartY.current = e.clientY;
    resizeStartHeight.current = section === 'transcript' ? transcriptHeight : summaryHeight;
  };

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!resizingSection) return;
      
      const delta = e.clientY - resizeStartY.current;
      const newHeight = Math.max(80, resizeStartHeight.current + delta);
      
      if (resizingSection === 'transcript') {
        setTranscriptHeight(newHeight);
      } else {
        setSummaryHeight(newHeight);
      }
    };

    const handleMouseUp = () => {
      setResizingSection(null);
    };

    if (resizingSection) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    }

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [resizingSection]);

  // Width resize handlers
  const handleWidthResizeMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    setResizingWidth(true);
    resizeStartX.current = e.clientX;
    resizeStartWidth.current = overlayWidth;
  };

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!resizingWidth) return;
      
      const delta = e.clientX - resizeStartX.current;
      const newWidth = Math.max(MIN_WIDTH, resizeStartWidth.current + delta);
      setOverlayWidth(newWidth);
    };

    const handleMouseUp = () => {
      setResizingWidth(false);
    };

    if (resizingWidth) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    }

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [resizingWidth]);

  // Control handlers
  const handleTogglePause = async () => {
    const electronAPI = window.electronAPI as any;
    if (electronAPI?.lectureControl) {
      await electronAPI.lectureControl(isPaused ? 'resume' : 'pause');
    }
  };

  const handleGenerateSummary = async () => {
    const electronAPI = window.electronAPI as any;
    if (electronAPI?.lectureControl && !isSummaryGenerating) {
      await electronAPI.lectureControl('generate-summary');
    }
  };

  const handleExit = async () => {
    const electronAPI = window.electronAPI as any;
    if (electronAPI) {
      await electronAPI.lectureControl?.('stop');
      await electronAPI.closeLectureOverlay?.();
    }
  };

  return (
    <div className="overlay-wrapper" style={{ width: `${overlayWidth}px` }}>
      {/* Transcript Section */}
      <div className="section transcript-section" style={{ height: `${transcriptHeight}px` }}>
        {/* Header */}
        <div className="section-header">
          <div className="header-left">
            <div className="logo-area">
              <div className="logo-icon">A</div>
              <span className="logo-text">ALEA</span>
              <span className="mode-badge">Lecture</span>
              {isRecording && (
                <span className="recording-badge recording" title={`Recording: ${recordingQuality || 'unknown'} quality`}>
                  <span className="rec-dot"></span>
                  REC
                </span>
              )}
              {!isRecording && (
                <span className="recording-badge no-recording" title="Not recording">
                  No Recording
                </span>
              )}
            </div>
            <span className="elapsed-time">{elapsedTime}</span>
          </div>
          <div className="header-controls">
            <button
              onClick={handleTogglePause}
              className={`control-btn toggle-btn ${isRunning && !isPaused ? 'listening' : 'paused'}`}
              disabled={!isConnected}
            >
              {isRunning && !isPaused ? (
                <><span className="pulse-dot"></span>Recording</>
              ) : isPaused ? (
                'Resume'
              ) : (
                'Waiting...'
              )}
            </button>
            <button onClick={handleExit} className="control-btn exit-btn">
              Exit
            </button>
          </div>
        </div>
        
        {/* Transcript Content */}
        <div className="section-content" ref={transcriptRef}>
          {transcripts.length === 0 && !currentTranscript ? (
            <p className="empty-message">
              {isConnected ? 'Listening for lecture...' : 'Connecting...'}
            </p>
          ) : (
            <>
              {transcripts.map((entry) => (
                <p key={entry.id} className="transcript-entry">
                  <span className="timestamp">{entry.formattedTime}</span>
                  <span className="text">{entry.text}</span>
                </p>
              ))}
              {currentTranscript && (
                <p className="transcript-entry current">
                  <span className="text">{currentTranscript}</span>
                </p>
              )}
            </>
          )}
        </div>
      </div>

      {/* Resize Handle */}
      <div
        className={`resize-handle ${resizingSection === 'transcript' ? 'active' : ''}`}
        onMouseDown={handleResizeMouseDown('transcript')}
      />

      {/* Summary Section */}
      <div className="section summary-section" style={{ height: `${summaryHeight}px` }}>
        {/* Header */}
        <div className="section-header summary-header">
          <span className="section-title">📝 Summary</span>
          <button
            className="generate-btn"
            onClick={handleGenerateSummary}
            disabled={true}
          >
            {isSummaryGenerating ? '⏳ Generating...' : '✨ Generate Now'}
          </button>
        </div>
        
        {/* Summary Content */}
        <div className="section-content summary-content" ref={summaryRef}>
          {summaries.length === 0 && !isSummaryGenerating ? (
            <p className="empty-message">
              {remotePhase ? remotePhase : 'Waiting for first chunk…'}
            </p>
          ) : (
            <>
              {isSummaryGenerating && summaries.length === 0 && (
                <div className="thinking-indicator">
                  <span className="thinking-dot"></span>
                  <span className="thinking-dot"></span>
                  <span className="thinking-dot"></span>
                  <span className="thinking-text">Generating summary</span>
                </div>
              )}
              {summaries.map((entry) => (
                <div key={entry.id} className="summary-entry">
                  <div className="summary-timestamp">[{entry.windowLabel}]</div>
                  <div className="summary-text">
                    <MarkdownRenderer content={entry.text} />
                  </div>
                </div>
              ))}
            </>
          )}
        </div>
      </div>

      {/* Bottom Resize Handle */}
      <div
        className={`resize-handle ${resizingSection === 'summary' ? 'active' : ''}`}
        onMouseDown={handleResizeMouseDown('summary')}
      />

      {/* Width Resize Handle */}
      <div
        className={`width-resize-handle ${resizingWidth ? 'active' : ''}`}
        onMouseDown={handleWidthResizeMouseDown}
      />

      <style>{`
        * {
          box-sizing: border-box;
          margin: 0;
          padding: 0;
        }

        .overlay-wrapper {
          width: 100%;
          height: 100vh;
          display: flex;
          flex-direction: column;
          gap: 0;
          padding: 8px;
          padding-right: 14px;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
          position: relative;
        }

        /* Width Resize Handle */
        .width-resize-handle {
          position: absolute;
          right: 0;
          top: 0;
          width: 6px;
          height: 100%;
          cursor: col-resize;
          background: transparent;
          z-index: 100;
        }

        .width-resize-handle::before {
          content: '';
          position: absolute;
          right: 2px;
          top: 50%;
          transform: translateY(-50%);
          width: 3px;
          height: 40px;
          background: rgba(100, 116, 139, 0.5);
          border-radius: 2px;
          transition: background 0.15s ease, height 0.15s ease;
        }

        .width-resize-handle:hover::before,
        .width-resize-handle.active::before {
          background: rgba(59, 130, 246, 0.8);
          height: 60px;
        }

        /* Resize Handle */
        .resize-handle {
          width: 100%;
          height: 6px;
          cursor: row-resize;
          background: transparent;
          position: relative;
          flex-shrink: 0;
          margin: 4px 0;
        }

        .resize-handle::before {
          content: '';
          position: absolute;
          left: 50%;
          top: 50%;
          transform: translate(-50%, -50%);
          width: 40px;
          height: 3px;
          background: rgba(100, 116, 139, 0.5);
          border-radius: 2px;
          transition: background 0.15s ease, width 0.15s ease;
        }

        .resize-handle:hover::before,
        .resize-handle.active::before {
          background: rgba(59, 130, 246, 0.8);
          width: 60px;
        }

        /* Section Styling */
        .section {
          flex-shrink: 0;
          background: rgba(30, 41, 59, 0.72);
          border-radius: 8px;
          border: 1px solid rgba(51, 65, 85, 0.9);
          display: flex;
          flex-direction: column;
          overflow: hidden;
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
        }

        /* Section Header */
        .section-header {
          -webkit-app-region: drag;
          padding: 10px 14px;
          background: rgba(15, 23, 42, 0.9);
          border-bottom: 1px solid rgba(51, 65, 85, 0.9);
          display: flex;
          justify-content: space-between;
          align-items: center;
          min-height: 44px;
        }

        .header-left {
          display: flex;
          align-items: center;
          gap: 12px;
        }

        .logo-area {
          display: flex;
          align-items: center;
          gap: 8px;
        }

        .logo-icon {
          width: 28px;
          height: 28px;
          background: linear-gradient(135deg, #1e40af, #3b82f6);
          border-radius: 8px;
          display: flex;
          align-items: center;
          justify-content: center;
          font-weight: 700;
          font-size: 14px;
          color: #f8fafc;
        }

        .logo-text {
          font-weight: 700;
          font-size: 15px;
          color: #f8fafc;
          letter-spacing: 0.5px;
        }

        .mode-badge {
          background: linear-gradient(135deg, #7c3aed, #8b5cf6);
          color: #fff;
          padding: 3px 8px;
          border-radius: 4px;
          font-size: 10px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }

        .elapsed-time {
          font-family: 'Monaco', 'Consolas', monospace;
          font-size: 12px;
          color: #94a3b8;
          background: rgba(15, 23, 42, 0.6);
          padding: 4px 8px;
          border-radius: 4px;
          border: 1px solid rgba(51, 65, 85, 0.5);
        }

        .header-controls {
          -webkit-app-region: no-drag;
          display: flex;
          gap: 8px;
        }

        .control-btn {
          background: #334155;
          border: 1px solid #475569;
          color: #f8fafc;
          padding: 6px 14px;
          border-radius: 6px;
          cursor: pointer;
          font-size: 12px;
          font-weight: 500;
          transition: all 0.15s ease;
        }

        .control-btn:hover:not(:disabled) {
          background: #475569;
          transform: translateY(-1px);
        }

        .control-btn:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }

        .toggle-btn.listening {
          background: rgba(239, 68, 68, 0.2);
          border-color: #ef4444;
          color: #fca5a5;
          display: flex;
          align-items: center;
          gap: 6px;
        }

        .toggle-btn.listening:hover {
          background: rgba(239, 68, 68, 0.3);
        }

        .pulse-dot {
          width: 8px;
          height: 8px;
          background: #ef4444;
          border-radius: 50%;
          animation: pulse-glow 1.5s ease-in-out infinite;
          box-shadow: 0 0 6px rgba(239, 68, 68, 0.6);
        }

        @keyframes pulse-glow {
          0%, 100% {
            opacity: 1;
            transform: scale(1);
            box-shadow: 0 0 6px rgba(239, 68, 68, 0.6);
          }
          50% {
            opacity: 0.6;
            transform: scale(0.85);
            box-shadow: 0 0 12px rgba(239, 68, 68, 0.9);
          }
        }

        .toggle-btn.paused {
          background: rgba(34, 197, 94, 0.2);
          border-color: rgba(34, 197, 94, 0.5);
          color: #86efac;
        }

        .exit-btn:hover {
          background: rgba(239, 68, 68, 0.25);
          border-color: rgba(239, 68, 68, 0.5);
        }

        /* Summary Header */
        .summary-header {
          -webkit-app-region: no-drag;
          padding: 8px 12px;
          min-height: 40px;
        }

        .section-title {
          font-weight: 600;
          font-size: 13px;
          color: #f8fafc;
        }

        .generate-btn {
          background: linear-gradient(135deg, #14b8a6, #0d9488);
          border: none;
          color: #fff;
          padding: 6px 12px;
          border-radius: 6px;
          cursor: pointer;
          font-size: 11px;
          font-weight: 600;
          transition: all 0.15s ease;
        }

        .generate-btn:hover:not(:disabled) {
          background: linear-gradient(135deg, #0d9488, #0f766e);
          transform: translateY(-1px);
          box-shadow: 0 2px 8px rgba(20, 184, 166, 0.4);
        }

        .generate-btn:disabled {
          background: #475569;
          cursor: not-allowed;
          opacity: 0.7;
        }

        /* Section Content */
        .section-content {
          flex: 1;
          padding: 12px;
          margin: 10px;
          background: rgba(15, 23, 42, 0.75);
          border-radius: 6px;
          border: 1px solid rgba(51, 65, 85, 0.9);
          overflow-y: auto;
          min-height: 60px;
        }

        .section-content::-webkit-scrollbar {
          width: 5px;
        }

        .section-content::-webkit-scrollbar-track {
          background: #1e293b;
          border-radius: 3px;
        }

        .section-content::-webkit-scrollbar-thumb {
          background: #475569;
          border-radius: 3px;
        }

        /* Transcript Entries */
        .transcript-entry {
          color: #f8fafc;
          font-size: 13px;
          line-height: 1.5;
          margin-bottom: 8px;
          display: flex;
          gap: 8px;
        }

        .transcript-entry .timestamp {
          color: #7c3aed;
          font-family: 'Monaco', 'Consolas', monospace;
          font-size: 11px;
          flex-shrink: 0;
        }

        .transcript-entry .text {
          flex: 1;
        }

        .transcript-entry.current .text {
          color: #3b82f6;
          font-style: italic;
        }

        /* Summary Entries */
        .summary-entry {
          margin-bottom: 16px;
          padding-bottom: 12px;
          border-bottom: 1px solid rgba(51, 65, 85, 0.5);
        }

        .summary-entry:last-child {
          margin-bottom: 0;
          padding-bottom: 0;
          border-bottom: none;
        }

        .summary-timestamp {
          color: #7c3aed;
          font-family: 'Monaco', 'Consolas', monospace;
          font-size: 11px;
          margin-bottom: 6px;
        }

        .summary-text {
          color: #f8fafc;
          font-size: 13px;
          line-height: 1.6;
        }

        /* Thinking Indicator */
        .thinking-indicator {
          display: flex;
          align-items: center;
          gap: 4px;
          padding: 8px 0;
        }

        .thinking-dot {
          width: 6px;
          height: 6px;
          background: #7c3aed;
          border-radius: 50%;
          animation: pulse 1.4s ease-in-out infinite;
        }

        .thinking-dot:nth-child(2) {
          animation-delay: 0.2s;
        }

        .thinking-dot:nth-child(3) {
          animation-delay: 0.4s;
        }

        .thinking-text {
          color: #7c3aed;
          font-size: 13px;
          font-weight: 500;
          margin-left: 6px;
        }

        @keyframes pulse {
          0%, 100% {
            opacity: 0.4;
            transform: scale(0.8);
          }
          50% {
            opacity: 1;
            transform: scale(1);
          }
        }

        /* Empty Message */
        .empty-message {
          color: #cbd5e1;
          font-style: italic;
          font-size: 13px;
        }

        /* Markdown Styles */
        .markdown-content {
          color: #f8fafc;
          font-size: 13px;
          line-height: 1.6;
        }

        .md-bold {
          font-weight: 700;
          color: #f8fafc;
        }

        .md-italic {
          font-style: italic;
          color: #cbd5e1;
        }

        .md-inline-code {
          background: rgba(124, 58, 237, 0.2);
          color: #c4b5fd;
          padding: 1px 5px;
          border-radius: 3px;
          font-family: 'Fira Code', 'Consolas', 'Monaco', monospace;
          font-size: 11px;
        }

        /* Recording Badge */
        .recording-badge {
          padding: 3px 8px;
          border-radius: 4px;
          font-size: 11px;
          font-weight: 600;
          display: inline-flex;
          align-items: center;
          gap: 4px;
          margin-left: 8px;
        }

        .recording-badge.recording {
          background: rgba(239, 68, 68, 0.2);
          border: 1px solid #ef4444;
          color: #fca5a5;
        }

        .recording-badge.no-recording {
          background: rgba(100, 116, 139, 0.2);
          border: 1px solid #64748b;
          color: #94a3b8;
        }

        .rec-dot {
          width: 6px;
          height: 6px;
          background: #ef4444;
          border-radius: 50%;
          animation: pulse-rec 1.5s ease-in-out infinite;
        }

        @keyframes pulse-rec {
          0%, 100% {
            opacity: 1;
          }
          50% {
            opacity: 0.4;
          }
        }
      `}</style>
    </div>
  );
};

export default LectureOverlay;
