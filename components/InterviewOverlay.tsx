import React, { useEffect, useState, useRef } from 'react';

interface TranscriptEntry {
  text: string;
  timestamp: number;
}

interface ReplyEntry {
  text: string;
  timestamp: number;
}

const InterviewOverlay: React.FC = () => {
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [currentTranscript, setCurrentTranscript] = useState<string>('');
  const [replies, setReplies] = useState<ReplyEntry[]>([]);
  const [currentReply, setCurrentReply] = useState<string>('');

  useEffect(() => {
    // Listen for transcript updates from main process
    const handleTranscriptUpdate = (_event: any, data: string) => {
      try {
        const parsed = JSON.parse(data);
        // Convert completed entries to our format
        const entries = parsed.completed.map((t: any) => ({
          text: t.text,
          timestamp: t.timestamp || Date.now()
        }));
        setTranscript(entries);
        // Set the current (incomplete) text
        setCurrentTranscript(parsed.current || '');
      } catch (err) {
        console.error('Failed to parse transcript data:', err);
      }
    };

    // Listen for reply updates from main process
    const handleReplyUpdate = (_event: any, data: string) => {
      try {
        const parsed = JSON.parse(data);
        // Convert completed entries to our format
        const entries = parsed.completed.map((r: any) => ({
          text: r.text,
          timestamp: r.timestamp || Date.now()
        }));
        setReplies(entries);
        // Set the current (incomplete) text
        setCurrentReply(parsed.current || '');
      } catch (err) {
        console.error('Failed to parse reply data:', err);
      }
    };

    // Register listeners if electron API is available
    if (window.electronAPI) {
      window.electronAPI.onTranscriptUpdate(handleTranscriptUpdate);
      window.electronAPI.onReplyUpdate(handleReplyUpdate);
    }

    return () => {
      // Cleanup listeners
      if (window.electronAPI?.removeTranscriptListener) {
        window.electronAPI.removeTranscriptListener(handleTranscriptUpdate);
      }
      if (window.electronAPI?.removeReplyListener) {
        window.electronAPI.removeReplyListener(handleReplyUpdate);
      }
    };
  }, []);

  // Keep scroll at top when new content arrives (since we show latest first)
  useEffect(() => {
    // Scroll to top to show latest entries
    const transcriptSection = document.querySelector('.transcript-section .section-content');
    if (transcriptSection) {
      transcriptSection.scrollTop = 0;
    }
  }, [transcript]);

  useEffect(() => {
    // Scroll to top to show latest entries
    const replySection = document.querySelector('.replies-section .section-content');
    if (replySection) {
      replySection.scrollTop = 0;
    }
  }, [replies]);

  const handleStop = async () => {
    if (window.electronAPI) {
      await window.electronAPI.overlayControl('stop');
    }
  };

  const handlePause = async () => {
    if (window.electronAPI) {
      await window.electronAPI.overlayControl('pause');
    }
  };

  return (
    <div className="overlay-container">
      {/* Draggable header with controls */}
      <div className="overlay-header">
        <div className="drag-handle">
          <span>Interview Assistant</span>
        </div>
        <div className="overlay-controls">
          <button onClick={handlePause} className="control-btn pause-btn">
            ⏸
          </button>
          <button onClick={handleStop} className="control-btn stop-btn">
            ⏹
          </button>
        </div>
      </div>

      {/* Content area */}
      <div className="overlay-content">
        {/* AI Replies Section */}
        <div className="overlay-section replies-section">
          <h3 className="section-title">AI-Generated Replies</h3>
          <div className="section-content">
            {replies.length === 0 && !currentReply ? (
              <p className="empty-message">AI replies will appear here...</p>
            ) : (
              <>
                {currentReply && (
                  <div className="reply-item current-item">
                    <p><em>{currentReply}</em></p>
                  </div>
                )}
                {[...replies].reverse().map((reply, index) => (
                  <div key={`${reply.timestamp}-${index}`} className="reply-item">
                    <p>{reply.text}</p>
                  </div>
                ))}
              </>
            )}
          </div>
        </div>

        {/* Transcript Section */}
        <div className="overlay-section transcript-section">
          <h3 className="section-title">Interviewer Transcript</h3>
          <div className="section-content">
            {transcript.length === 0 && !currentTranscript ? (
              <p className="empty-message">Transcript will appear here...</p>
            ) : (
              <>
                {currentTranscript && (
                  <div className="transcript-item current-item">
                    <p><em>{currentTranscript}</em></p>
                  </div>
                )}
                {transcript.map((entry, index) => (
                  <div key={`${entry.timestamp}-${index}`} className="transcript-item">
                    <p>{entry.text}</p>
                  </div>
                ))}
              </>
            )}
          </div>
        </div>
      </div>

      <style>{`
        * {
          box-sizing: border-box;
        }

        .overlay-container {
          width: 100%;
          height: 100vh;
          background: rgba(15, 23, 42, 0.96);
          backdrop-filter: blur(12px);
          color: white;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
          display: flex;
          flex-direction: column;
          border-radius: 16px;
          overflow: hidden;
          border: 1px solid rgba(255, 255, 255, 0.15);
          box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
        }

        .overlay-header {
          -webkit-app-region: drag;
          padding: 8px 12px;
          background: rgba(30, 41, 59, 0.9);
          border-bottom: 1px solid rgba(255, 255, 255, 0.1);
          display: flex;
          justify-content: space-between;
          align-items: center;
          min-height: 40px;
        }

        .drag-handle {
          flex: 1;
          font-weight: 600;
          font-size: 13px;
          opacity: 0.9;
        }

        .overlay-controls {
          -webkit-app-region: no-drag;
          display: flex;
          gap: 8px;
        }

        .control-btn {
          background: rgba(255, 255, 255, 0.08);
          border: 1px solid rgba(255, 255, 255, 0.15);
          color: white;
          padding: 4px 10px;
          border-radius: 6px;
          cursor: pointer;
          font-size: 14px;
          transition: all 0.15s;
          display: flex;
          align-items: center;
          justify-content: center;
          min-width: 32px;
          height: 28px;
        }

        .control-btn:hover {
          background: rgba(255, 255, 255, 0.15);
          transform: translateY(-1px);
        }

        .control-btn:active {
          transform: translateY(0);
        }

        .stop-btn:hover {
          background: rgba(239, 68, 68, 0.25);
          border-color: rgba(239, 68, 68, 0.4);
        }

        .overlay-content {
          flex: 1;
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 12px;
          padding: 12px;
          overflow: hidden;
        }

        .overlay-section {
          display: flex;
          flex-direction: column;
          background: rgba(30, 41, 59, 0.6);
          border-radius: 10px;
          padding: 14px;
          overflow: hidden;
          border: 1px solid rgba(255, 255, 255, 0.08);
        }

        .section-title {
          font-size: 14px;
          font-weight: 600;
          margin: 0 0 10px 0;
          color: rgba(255, 255, 255, 0.95);
          letter-spacing: 0.3px;
        }

        .section-content {
          flex: 1;
          overflow-y: auto;
          overflow-x: visible;
        }

        .section-content::-webkit-scrollbar {
          width: 6px;
        }

        .section-content::-webkit-scrollbar-track {
          background: rgba(0, 0, 0, 0.2);
          border-radius: 3px;
        }

        .section-content::-webkit-scrollbar-thumb {
          background: rgba(255, 255, 255, 0.2);
          border-radius: 3px;
        }

        .section-content::-webkit-scrollbar-thumb:hover {
          background: rgba(255, 255, 255, 0.3);
        }

        .empty-message {
          color: rgba(255, 255, 255, 0.4);
          font-style: italic;
          font-size: 14px;
        }

        .reply-item,
        .transcript-item {
          margin-bottom: 10px;
          padding: 10px 12px;
          background: rgba(255, 255, 255, 0.06);
          border-radius: 8px;
          font-size: 13px;
          line-height: 1.6;
          position: relative;
          display: block;
        }

        .reply-item p,
        .transcript-item p {
          margin: 0;
          color: rgba(255, 255, 255, 0.95);
          word-wrap: break-word;
          overflow-wrap: break-word;
        }

        .replies-section .reply-item {
          border-left: 3px solid rgba(59, 130, 246, 0.6);
        }

        .transcript-section .transcript-item {
          border-left: 3px solid rgba(34, 197, 94, 0.6);
        }

        .current-item {
          background: rgba(255, 255, 255, 0.08) !important;
          border-left-style: dashed !important;
        }

        .current-item em {
          font-style: italic;
          opacity: 0.9;
          word-wrap: break-word;
          overflow-wrap: break-word;
        }

        .current-item p {
          word-wrap: break-word;
          overflow-wrap: break-word;
        }
      `}</style>
    </div>
  );
};

export default InterviewOverlay;
