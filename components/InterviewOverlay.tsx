import React, { useEffect, useState, useRef, useMemo, useCallback } from 'react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';

interface TranscriptEntry {
  text: string;
  timestamp: number;
}

interface ReplyEntry {
  text: string;
  timestamp: number;
}

// Code block component with copy button
interface CodeBlockProps {
  code: string;
  language: string;
}

const CodeBlock: React.FC<CodeBlockProps> = ({ code, language }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  return (
    <div className="code-block-wrapper">
      <div className="code-block-header">
        <span className="code-language">{language || 'code'}</span>
        <button className="copy-btn" onClick={handleCopy}>
          {copied ? '✓ Copied!' : '📋 Copy'}
        </button>
      </div>
      <SyntaxHighlighter
        language={language || 'text'}
        style={oneDark}
        customStyle={{
          margin: 0,
          borderRadius: '0 0 6px 6px',
          fontSize: '11px',
          padding: '10px',
        }}
        wrapLongLines={true}
      >
        {code}
      </SyntaxHighlighter>
    </div>
  );
};

// Markdown renderer component
interface MarkdownRendererProps {
  content: string;
}

const MarkdownRenderer: React.FC<MarkdownRendererProps> = ({ content }) => {
  const renderMarkdown = useMemo(() => {
    if (!content) return null;

    // Split content by code blocks first
    const codeBlockRegex = /```(\w*)\n?([\s\S]*?)```/g;
    const parts: React.ReactNode[] = [];
    let lastIndex = 0;
    let match;
    let keyIndex = 0;

    while ((match = codeBlockRegex.exec(content)) !== null) {
      // Add text before code block
      if (match.index > lastIndex) {
        const textBefore = content.slice(lastIndex, match.index);
        parts.push(
          <span key={`text-${keyIndex++}`}>
            {renderInlineMarkdown(textBefore)}
          </span>
        );
      }

      // Add code block
      const language = match[1] || 'text';
      const code = match[2].trim();
      parts.push(
        <CodeBlock key={`code-${keyIndex++}`} language={language} code={code} />
      );

      lastIndex = match.index + match[0].length;
    }

    // Add remaining text after last code block
    if (lastIndex < content.length) {
      const remainingText = content.slice(lastIndex);
      parts.push(
        <span key={`text-${keyIndex++}`}>
          {renderInlineMarkdown(remainingText)}
        </span>
      );
    }

    return parts.length > 0 ? parts : renderInlineMarkdown(content);
  }, [content]);

  return <div className="markdown-content">{renderMarkdown}</div>;
};

// Helper function to render inline markdown (bold, italic, inline code)
function renderInlineMarkdown(text: string): React.ReactNode[] {
  const elements: React.ReactNode[] = [];
  let remaining = text;
  let keyIndex = 0;

  // Process line by line to handle bullet points
  const lines = remaining.split('\n');
  
  lines.forEach((line, lineIndex) => {
    if (lineIndex > 0) {
      elements.push(<br key={`br-${keyIndex++}`} />);
    }

    // Check for bullet points
    const bulletMatch = line.match(/^(\s*)[-*]\s+(.*)$/);
    if (bulletMatch) {
      const indent = bulletMatch[1].length;
      const content = bulletMatch[2];
      elements.push(
        <span key={`bullet-${keyIndex++}`} style={{ marginLeft: `${indent * 8 + 8}px`, display: 'inline-block' }}>
          • {processInlineFormatting(content, keyIndex)}
        </span>
      );
      keyIndex++;
    } else {
      // Process inline formatting
      elements.push(...processInlineFormatting(line, keyIndex));
      keyIndex++;
    }
  });

  return elements;
}

// Process bold, italic, inline code
function processInlineFormatting(text: string, baseKey: number): React.ReactNode[] {
  const elements: React.ReactNode[] = [];
  
  // Regex to match: **bold**, *italic*, `code`
  const inlineRegex = /(\*\*(.+?)\*\*)|(\*(.+?)\*)|(`([^`]+)`)/g;
  let lastIndex = 0;
  let match;
  let keyIndex = 0;

  while ((match = inlineRegex.exec(text)) !== null) {
    // Add text before match
    if (match.index > lastIndex) {
      elements.push(
        <span key={`plain-${baseKey}-${keyIndex++}`}>
          {text.slice(lastIndex, match.index)}
        </span>
      );
    }

    if (match[1]) {
      // Bold: **text**
      elements.push(
        <strong key={`bold-${baseKey}-${keyIndex++}`} className="md-bold">
          {match[2]}
        </strong>
      );
    } else if (match[3]) {
      // Italic: *text*
      elements.push(
        <em key={`italic-${baseKey}-${keyIndex++}`} className="md-italic">
          {match[4]}
        </em>
      );
    } else if (match[5]) {
      // Inline code: `code`
      elements.push(
        <code key={`code-${baseKey}-${keyIndex++}`} className="md-inline-code">
          {match[6]}
        </code>
      );
    }

    lastIndex = match.index + match[0].length;
  }

  // Add remaining text
  if (lastIndex < text.length) {
    elements.push(
      <span key={`plain-${baseKey}-${keyIndex++}`}>
        {text.slice(lastIndex)}
      </span>
    );
  }

  return elements.length > 0 ? elements : [<span key={`empty-${baseKey}`}>{text}</span>];
}

const InterviewOverlay: React.FC = () => {
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [currentTranscript, setCurrentTranscript] = useState<string>('');
  const [replies, setReplies] = useState<ReplyEntry[]>([]);
  const [currentReply, setCurrentReply] = useState<string>('');
  const [isListening, setIsListening] = useState<boolean>(true);
  const [isThinking, setIsThinking] = useState<boolean>(false);
  const [showReply, setShowReply] = useState<boolean>(true);
  
  // Screen Analysis state
  const [showAnalysis, setShowAnalysis] = useState<boolean>(false);
  const [analysisResult, setAnalysisResult] = useState<string>('');
  const [isAnalysisConnected, setIsAnalysisConnected] = useState<boolean>(false);
  const [isAnalysisGenerating, setIsAnalysisGenerating] = useState<boolean>(false);
  const [isAnalysisRunning, setIsAnalysisRunning] = useState<boolean>(false);
  const [userQuestion, setUserQuestion] = useState<string>('');

  // Section heights (resizable)
  const [transcriptHeight, setTranscriptHeight] = useState<number>(150);
  const [replyHeight, setReplyHeight] = useState<number>(110);
  const [analysisHeight, setAnalysisHeight] = useState<number>(300);
  
  // Overlay width (resizable)
  const [overlayWidth, setOverlayWidth] = useState<number>(934); // 950 - 16px padding
  const MIN_WIDTH = 520; // Minimum width to prevent button wrap
  
  // Height resize drag state
  const [resizingSection, setResizingSection] = useState<'transcript' | 'reply' | 'analysis' | null>(null);
  const resizeStartY = useRef<number>(0);
  const resizeStartHeight = useRef<number>(0);
  
  // Width resize drag state
  const [resizingWidth, setResizingWidth] = useState<boolean>(false);
  const resizeStartX = useRef<number>(0);
  const resizeStartWidth = useRef<number>(0);

  const transcriptRef = useRef<HTMLDivElement>(null);
  const replyRef = useRef<HTMLDivElement>(null);
  const analysisRef = useRef<HTMLDivElement>(null);

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
        // Set the current (incomplete) text and thinking state
        const current = parsed.current || '';
        setCurrentReply(current);
        setIsThinking(current === '...' || (current.length > 0 && entries.length === 0));
      } catch (err) {
        console.error('Failed to parse reply data:', err);
      }
    };

    // Register listeners if electron API is available
    if (window.electronAPI) {
      window.electronAPI.onTranscriptUpdate(handleTranscriptUpdate);
      window.electronAPI.onReplyUpdate(handleReplyUpdate);
      
      // Listen for analysis updates
      if ((window.electronAPI as any).onAnalysisUpdate) {
        (window.electronAPI as any).onAnalysisUpdate((_event: any, data: string) => {
          try {
            const parsed = JSON.parse(data);
            // Only update fields that are explicitly present in the message
            if (parsed.text !== undefined) {
              setAnalysisResult(parsed.text);
            }
            if (parsed.isGenerating !== undefined) {
              setIsAnalysisGenerating(parsed.isGenerating);
            }
            if (parsed.isConnected !== undefined) {
              setIsAnalysisConnected(parsed.isConnected);
            }
          } catch (err) {
            // If not JSON, treat as plain text
            setAnalysisResult(data);
            setIsAnalysisGenerating(false);
          }
        });
      }
    }

    return () => {
      // Cleanup listeners
      if (window.electronAPI?.removeTranscriptListener) {
        window.electronAPI.removeTranscriptListener(handleTranscriptUpdate);
      }
      if (window.electronAPI?.removeReplyListener) {
        window.electronAPI.removeReplyListener(handleReplyUpdate);
      }
      if ((window.electronAPI as any)?.removeAnalysisListener) {
        (window.electronAPI as any).removeAnalysisListener();
      }
    };
  }, []);

  // Auto-scroll transcript to bottom (latest content)
  useEffect(() => {
    if (transcriptRef.current) {
      transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
    }
  }, [transcript, currentTranscript]);

  // Auto-scroll replies to bottom (latest content)
  useEffect(() => {
    if (replyRef.current) {
      replyRef.current.scrollTop = replyRef.current.scrollHeight;
    }
  }, [replies, currentReply]);

  // Auto-scroll analysis to bottom
  useEffect(() => {
    if (analysisRef.current) {
      analysisRef.current.scrollTop = analysisRef.current.scrollHeight;
    }
  }, [analysisResult]);

  // Calculate total window height from section heights
  const calculateWindowHeight = () => {
    // Padding (8px top + 8px bottom)
    let height = 16;
    
    // Always include transcript section
    height += transcriptHeight;
    
    // Transcript resize handle (always visible if any other section is visible)
    if (showReply || showAnalysis) {
      height += 14; // resize handle (6px) + margins (4px * 2)
    }
    
    if (showReply) {
      height += replyHeight;
      height += 14; // reply resize handle
    }
    
    if (showAnalysis) {
      height += analysisHeight;
      height += 14; // analysis resize handle
    }
    
    return height;
  };

  // Update window size (both width and height)
  const updateWindowSize = async (width?: number, height?: number) => {
    const finalHeight = height ?? calculateWindowHeight();
    const finalWidth = width ?? overlayWidth + 16; // Add padding
    if ((window.electronAPI as any)?.resizeOverlay) {
      await (window.electronAPI as any).resizeOverlay({ width: finalWidth, height: finalHeight });
    }
  };

  // Auto-resize window when sections toggle or heights change
  useEffect(() => {
    updateWindowSize();
  }, [showReply, showAnalysis, transcriptHeight, replyHeight, analysisHeight, overlayWidth]);

  // Resize handle mouse handlers
  const handleResizeMouseDown = (section: 'transcript' | 'reply' | 'analysis') => (e: React.MouseEvent) => {
    e.preventDefault();
    setResizingSection(section);
    resizeStartY.current = e.clientY;
    
    // Store starting height based on which section
    if (section === 'transcript') {
      resizeStartHeight.current = transcriptHeight;
    } else if (section === 'reply') {
      resizeStartHeight.current = replyHeight;
    } else {
      resizeStartHeight.current = analysisHeight;
    }
  };

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!resizingSection) return;
      
      const delta = e.clientY - resizeStartY.current;
      const newHeight = Math.max(60, resizeStartHeight.current + delta); // Min 60px
      
      if (resizingSection === 'transcript') {
        setTranscriptHeight(newHeight);
      } else if (resizingSection === 'reply') {
        setReplyHeight(newHeight);
      } else if (resizingSection === 'analysis') {
        setAnalysisHeight(newHeight);
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

  // Width resize handle mouse handlers
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

  // Handle analysis toggle (just show/hide section)
  const handleToggleAnalysis = async () => {
    setShowAnalysis(!showAnalysis);
  };

  // Handle start/stop analysis service
  const handleToggleAnalysisService = async () => {
    if (window.electronAPI) {
      if (!isAnalysisRunning) {
        // Start analysis service
        await (window.electronAPI as any).startScreenAnalysis?.();
        setIsAnalysisRunning(true);
        setIsAnalysisConnected(false); // Will be updated when service connects
      } else {
        // Stop analysis service
        await (window.electronAPI as any).stopScreenAnalysis?.();
        setIsAnalysisRunning(false);
        setAnalysisResult('');
        setIsAnalysisGenerating(false);
        setIsAnalysisConnected(false);
      }
    }
  };

  // Handle generate analysis reply button
  const handleGenerateAnalysisReply = async () => {
    if ((window.electronAPI as any)?.generateAnalysisReply && !isAnalysisGenerating) {
      setIsAnalysisGenerating(true);
      await (window.electronAPI as any).generateAnalysisReply();
    }
  };

  // Handle sending user question to analysis service
  const handleSendQuestion = async () => {
    const trimmedQuestion = userQuestion.trim();
    if (!trimmedQuestion || !isAnalysisConnected || isAnalysisGenerating) {
      return;
    }
    
    setIsAnalysisGenerating(true);
    setUserQuestion(''); // Clear input
    
    if ((window.electronAPI as any)?.sendAnalysisQuestion) {
      await (window.electronAPI as any).sendAnalysisQuestion(trimmedQuestion);
    }
  };

  // Handle Enter key in question input
  const handleQuestionKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendQuestion();
    }
  };

  const handleToggleListening = async () => {
    if (window.electronAPI) {
      // Send stop command to stop the session entirely when toggling off
      // Since pause is not implemented, we'll just log for now
      // The main app needs to implement pause/resume in DualGeminiSessionManager
      await window.electronAPI.overlayControl(isListening ? 'pause' : 'resume');
      setIsListening(!isListening);
    }
  };

  const handleExit = async () => {
    if (window.electronAPI) {
      // First stop the session
      await window.electronAPI.overlayControl('stop');
      // Then close the overlay window
      await window.electronAPI.closeOverlay();
    }
  };

  return (
    <div className="overlay-wrapper" style={{ width: `${overlayWidth}px` }}>
      {/* Top Section: Header + Transcript */}
      <div className="top-section" style={{ height: `${transcriptHeight}px`, minHeight: '60px' }}>
        {/* Header Bar */}
        <div className="overlay-header">
          <div className="logo-area">
            <div className="logo-icon">A</div>
            <span className="logo-text">ALEA</span>
          </div>
          <div className="header-controls">
            <button
              onClick={() => setShowReply(prev => !prev)}
              className={`control-btn reply-toggle-btn ${showReply ? 'on' : 'off'}`}
              aria-pressed={showReply}
              aria-label={showReply ? 'Hide replies' : 'Unhide replies'}
            >
              <span className="toggle-text">{showReply ? 'Hide Replies' : 'Unhide Replies'}</span>
              <span className="switch-track" aria-hidden="true">
                <span className="switch-thumb" />
              </span>
            </button>

            <button
              onClick={handleToggleAnalysis}
              className={`control-btn reply-toggle-btn ${showAnalysis ? 'on' : 'off'}`}
              aria-pressed={showAnalysis}
              aria-label={showAnalysis ? 'Hide analysis' : 'Show analysis'}
            >
              <span className="toggle-text analysis-toggle-text">{showAnalysis ? 'Hide Analysis' : 'Show Analysis'}</span>
              <span className="switch-track" aria-hidden="true">
                <span className="switch-thumb" />
              </span>
            </button>

            <button 
              onClick={handleToggleListening} 
              className={`control-btn toggle-btn ${isListening ? 'listening' : 'paused'}`}
            >
              {isListening ? (
                <><span className="pulse-dot"></span>Listening</>
              ) : (
                'Start Listening'
              )}
            </button>
            <button onClick={handleExit} className="control-btn exit-btn">
              Exit
            </button>
          </div>
        </div>

        {/* Transcript Area */}
        <div className="transcript-area" ref={transcriptRef}>
          {transcript.length === 0 && !currentTranscript ? (
            <p className="empty-message">Listening for speech...</p>
          ) : (
            <>
              {transcript.map((entry, index) => (
                <p key={`${entry.timestamp}-${index}`} className="transcript-text">
                  {entry.text}
                </p>
              ))}
              {currentTranscript && (
                <p className="transcript-text current">
                  {currentTranscript}
                </p>
              )}
            </>
          )}
        </div>
      </div>

      {/* Resize Handle for Transcript (show if Reply or Analysis is visible) */}
      {(showReply || showAnalysis) && (
        <div 
          className={`resize-handle ${resizingSection === 'transcript' ? 'active' : ''}`}
          onMouseDown={handleResizeMouseDown('transcript')}
        />
      )}

      {/* Bottom Section: Reply */}
      {showReply && (
        <div className="reply-section" style={{ height: `${replyHeight}px`, minHeight: '60px' }}>
          <div className="reply-content" ref={replyRef}>
          {replies.length === 0 && !currentReply && !isThinking ? (
            <p className="empty-message">AI responses will appear here...</p>
          ) : (
            <>
              {replies.map((reply, index) => (
                <p key={`${reply.timestamp}-${index}`} className="reply-text">
                  {reply.text}
                </p>
              ))}
              {isThinking && (
                <div className="thinking-indicator">
                  <span className="thinking-dot"></span>
                  <span className="thinking-dot"></span>
                  <span className="thinking-dot"></span>
                  <span className="thinking-text">Thinking</span>
                </div>
              )}
              {currentReply && currentReply !== '...' && (
                <p className="reply-text current">
                  {currentReply}
                </p>
              )}
            </>
          )}
          </div>
        </div>
      )}

      {/* Resize Handle for Reply (show when Reply visible) */}
      {showReply && (
        <div 
          className={`resize-handle ${resizingSection === 'reply' ? 'active' : ''}`}
          onMouseDown={handleResizeMouseDown('reply')}
        />
      )}

      {/* Screen Analysis Section - Fixed below Reply */}
      {showAnalysis && (
        <div className="analysis-section" style={{ height: `${analysisHeight}px`, minHeight: '60px' }}>
          <div className="analysis-header">
            <span className="analysis-title">🖥️ Screen Analysis</span>
            <div className="analysis-buttons">
              <button 
                className={`analysis-btn ${isAnalysisRunning ? 'stop' : 'start'}`}
                onClick={handleToggleAnalysisService}
              >
                {isAnalysisRunning ? '⏹ Stop' : '▶ Start'}
              </button>
              <button 
                className="analysis-btn generate"
                onClick={handleGenerateAnalysisReply}
                disabled={!isAnalysisConnected || isAnalysisGenerating}
              >
                {isAnalysisGenerating ? '⏳ Generating...' : '✨ Generate'}
              </button>
            </div>
          </div>
          <div className="analysis-content" ref={analysisRef}>
            {!isAnalysisRunning ? (
              <p className="empty-message">Click "Start" to begin screen analysis...</p>
            ) : !analysisResult && !isAnalysisGenerating ? (
              <p className="empty-message">
                {isAnalysisConnected 
                  ? 'Connected! Click "Generate" to analyze the screen...' 
                  : 'Connecting to analysis service...'}
              </p>
            ) : (
              <>
                {isAnalysisGenerating && !analysisResult && (
                  <div className="thinking-indicator">
                    <span className="thinking-dot"></span>
                    <span className="thinking-dot"></span>
                    <span className="thinking-dot"></span>
                    <span className="thinking-text">Analyzing screen</span>
                  </div>
                )}
                {analysisResult && (
                  <MarkdownRenderer content={analysisResult} />
                )}
              </>
            )}
          </div>
          {/* Chat input for asking questions */}
          <div className="analysis-chat-input">
            <input
              type="text"
              className="question-input"
              placeholder="Ask a question..."
              value={userQuestion}
              onChange={(e) => setUserQuestion(e.target.value)}
              onKeyDown={handleQuestionKeyDown}
              disabled={!isAnalysisConnected || isAnalysisGenerating}
            />
            <button
              className="send-btn"
              onClick={handleSendQuestion}
              disabled={!isAnalysisConnected || isAnalysisGenerating || !userQuestion.trim()}
            >
              {isAnalysisGenerating ? '⏳' : '📤'}
            </button>
          </div>
        </div>
      )}

      {/* Resize Handle at bottom of Analysis (always show when Analysis is visible) */}
      {showAnalysis && (
        <div 
          className={`resize-handle ${resizingSection === 'analysis' ? 'active' : ''}`}
          onMouseDown={handleResizeMouseDown('analysis')}
        />
      )}

      {/* Right Edge Resize Handle for Width */}
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
          padding-right: 14px; /* Extra padding for width resize handle */
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
          position: relative;
        }

        /* Width Resize Handle on right edge */
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

        /* Resize Handle between sections */
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

        /* Top Section: Header + Transcript - using app colors (slightly transparent)
           Transparency uses RGBA so background passes through the desktop beneath. */
        .top-section {
          flex-shrink: 0;
          background: rgba(30, 41, 59, 0.72); /* was #1e293b */
          border-radius: 8px;
          border: 1px solid rgba(51, 65, 85, 0.9); /* was #334155 */
          display: flex;
          flex-direction: column;
          overflow: hidden;
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
        }

        /* Header Bar */
        .overlay-header {
          -webkit-app-region: drag;
          padding: 10px 14px;
          background: rgba(15, 23, 42, 0.9); /* was #0f172a */
          border-bottom: 1px solid rgba(51, 65, 85, 0.9);
          display: flex;
          justify-content: space-between;
          align-items: center;
          min-height: 44px;
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

        .control-btn:hover {
          background: #475569;
          transform: translateY(-1px);
        }

        /* Reply toggle switch - teal design */
        .reply-toggle-btn {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 6px;
          padding: 6px 10px;
          background: transparent;
          border: none;
          height: 30px;
          outline: none;
          box-shadow: none;
          cursor: pointer;
          -webkit-appearance: none;
          -moz-appearance: none;
          appearance: none;
        }

        .reply-toggle-btn:hover {
          background: transparent;
          transform: none;
        }

        .reply-toggle-btn:focus,
        .reply-toggle-btn:focus-visible,
        .reply-toggle-btn:active {
          outline: none;
          box-shadow: none;
          border: none;
          background: transparent;
        }

        .reply-toggle-btn .toggle-text {
          font-size: 12px;
          font-weight: 500;
          color: #f8fafc;
        }

        .reply-toggle-btn .toggle-text.analysis-toggle-text {
          width: 85px;
          text-align: right;
        }

        .reply-toggle-btn .switch-track {
          width: 36px;
          height: 20px;
          background: #cbd5e1;
          border-radius: 999px;
          display: inline-block;
          position: relative;
          transition: background 200ms ease;
        }

        .reply-toggle-btn.on .switch-track {
          background: #14b8a6; /* Teal color */
        }

        .reply-toggle-btn.off .switch-track {
          background: #cbd5e1; /* Gray color */
        }

        .reply-toggle-btn .switch-thumb {
          width: 16px;
          height: 16px;
          background: #fff;
          border-radius: 50%;
          position: absolute;
          top: 50%;
          left: 2px;
          transform: translateY(-50%);
          box-shadow: 0 1px 3px rgba(0,0,0,0.2);
          transition: transform 200ms cubic-bezier(.4,.0,.2,1);
        }

        .reply-toggle-btn.on .switch-thumb {
          transform: translateY(-50%) translateX(16px);
        }

        .reply-toggle-btn .sr-only {
          display: none;
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

        .toggle-btn.paused:hover {
          background: rgba(34, 197, 94, 0.3);
        }

        .exit-btn:hover {
          background: rgba(239, 68, 68, 0.25);
          border-color: rgba(239, 68, 68, 0.5);
        }

        /* Transcript Area */
        .transcript-area {
          flex: 1;
          padding: 12px;
          margin: 10px;
          background: rgba(15, 23, 42, 0.75); /* was #0f172a */
          border-radius: 6px;
          border: 1px solid rgba(51, 65, 85, 0.9);
          overflow-y: auto;
          min-height: 60px;
        }

        .transcript-area::-webkit-scrollbar {
          width: 5px;
        }

        .transcript-area::-webkit-scrollbar-track {
          background: #1e293b;
          border-radius: 3px;
        }

        .transcript-area::-webkit-scrollbar-thumb {
          background: #475569;
          border-radius: 3px;
        }

        .transcript-text {
          color: #f8fafc;
          font-size: 13px;
          line-height: 1.5;
          margin-bottom: 6px;
        }

        .transcript-text.current {
          color: #3b82f6;
          font-style: italic;
        }

        /* Reply Section - Resizable */
        .reply-section {
          flex-shrink: 0;
          background: rgba(30, 41, 59, 0.72); /* was #1e293b */
          border-radius: 8px;
          border: 1px solid rgba(51, 65, 85, 0.9);
          overflow: hidden;
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
          padding: 10px;
        }

        .reply-content {
          padding: 12px;
          background: rgba(15, 23, 42, 0.75); /* was #0f172a */
          border-radius: 6px;
          border: 1px solid rgba(51, 65, 85, 0.9);
          overflow-y: auto;
          height: 100%;
        }

        .reply-content::-webkit-scrollbar {
          width: 5px;
        }

        .reply-content::-webkit-scrollbar-track {
          background: #1e293b;
          border-radius: 3px;
        }

        .reply-content::-webkit-scrollbar-thumb {
          background: #475569;
          border-radius: 3px;
        }

        .reply-text {
          color: #f8fafc;
          font-size: 14px;
          line-height: 1.6;
          margin-bottom: 10px;
        }

        .reply-text.current {
          color: #3b82f6;
          font-style: italic;
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
          background: #3b82f6;
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
          color: #3b82f6;
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

        /* Screen Analysis Section - Resizable */
        .analysis-section {
          flex-shrink: 0;
          background: rgba(30, 41, 59, 0.72);
          border-radius: 8px;
          border: 1px solid rgba(51, 65, 85, 0.9);
          overflow: hidden;
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
          display: flex;
          flex-direction: column;
        }

        .analysis-header {
          padding: 8px 12px;
          background: rgba(15, 23, 42, 0.9);
          border-bottom: 1px solid rgba(51, 65, 85, 0.9);
          display: flex;
          justify-content: space-between;
          align-items: center;
          flex-shrink: 0;
        }

        .analysis-title {
          font-weight: 600;
          font-size: 12px;
          color: #f8fafc;
        }

        .analysis-buttons {
          display: flex;
          gap: 6px;
        }

        .analysis-btn {
          border: none;
          color: #fff;
          padding: 5px 10px;
          border-radius: 5px;
          cursor: pointer;
          font-size: 11px;
          font-weight: 600;
          transition: all 0.15s ease;
        }

        .analysis-btn.start {
          background: linear-gradient(135deg, #22c55e, #16a34a);
        }

        .analysis-btn.start:hover {
          background: linear-gradient(135deg, #16a34a, #15803d);
          transform: translateY(-1px);
          box-shadow: 0 2px 8px rgba(34, 197, 94, 0.4);
        }

        .analysis-btn.stop {
          background: linear-gradient(135deg, #ef4444, #dc2626);
        }

        .analysis-btn.stop:hover {
          background: linear-gradient(135deg, #dc2626, #b91c1c);
          transform: translateY(-1px);
          box-shadow: 0 2px 8px rgba(239, 68, 68, 0.4);
        }

        .analysis-btn.generate {
          background: linear-gradient(135deg, #14b8a6, #0d9488);
        }

        .analysis-btn.generate:hover:not(:disabled) {
          background: linear-gradient(135deg, #0d9488, #0f766e);
          transform: translateY(-1px);
          box-shadow: 0 2px 8px rgba(20, 184, 166, 0.4);
        }

        .analysis-btn:disabled {
          background: #475569;
          cursor: not-allowed;
          opacity: 0.7;
        }

        .generate-btn {
          background: linear-gradient(135deg, #14b8a6, #0d9488);
          border: none;
          color: #fff;
          padding: 5px 12px;
          border-radius: 5px;
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

        .analysis-content {
          flex: 1;
          min-height: 0;
          padding: 10px;
          margin: 8px;
          background: rgba(15, 23, 42, 0.75);
          border-radius: 6px;
          border: 1px solid rgba(51, 65, 85, 0.9);
          overflow-y: auto;
        }

        .analysis-content::-webkit-scrollbar {
          width: 5px;
        }

        .analysis-content::-webkit-scrollbar-track {
          background: #1e293b;
          border-radius: 3px;
        }

        .analysis-content::-webkit-scrollbar-thumb {
          background: #475569;
          border-radius: 3px;
        }

        /* Chat Input for Analysis */
        .analysis-chat-input {
          display: flex;
          gap: 6px;
          padding: 8px;
          background: rgba(15, 23, 42, 0.9);
          border-top: 1px solid rgba(51, 65, 85, 0.9);
          flex-shrink: 0;
          -webkit-app-region: no-drag;
        }

        .question-input {
          flex: 1;
          background: rgba(30, 41, 59, 0.9);
          border: 1px solid rgba(51, 65, 85, 0.9);
          border-radius: 6px;
          padding: 8px 12px;
          color: #f8fafc;
          font-size: 12px;
          outline: none;
          transition: border-color 0.15s ease;
          -webkit-app-region: no-drag;
          -webkit-user-select: text;
          user-select: text;
        }

        .question-input:focus {
          border-color: rgba(59, 130, 246, 0.6);
        }

        .question-input::placeholder {
          color: #64748b;
        }

        .question-input:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }

        .send-btn {
          background: linear-gradient(135deg, #3b82f6, #2563eb);
          border: none;
          color: #fff;
          padding: 8px 12px;
          border-radius: 6px;
          cursor: pointer;
          font-size: 14px;
          transition: all 0.15s ease;
          min-width: 40px;
        }

        .send-btn:hover:not(:disabled) {
          background: linear-gradient(135deg, #2563eb, #1d4ed8);
          transform: translateY(-1px);
          box-shadow: 0 2px 8px rgba(59, 130, 246, 0.4);
        }

        .send-btn:disabled {
          background: #475569;
          cursor: not-allowed;
          opacity: 0.7;
        }

        .analysis-text {
          color: #f8fafc;
          font-size: 12px;
          line-height: 1.5;
          white-space: pre-wrap;
        }

        /* Markdown Styles */
        .markdown-content {
          color: #f8fafc;
          font-size: 12px;
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
          background: rgba(59, 130, 246, 0.2);
          color: #93c5fd;
          padding: 1px 5px;
          border-radius: 3px;
          font-family: 'Fira Code', 'Consolas', 'Monaco', monospace;
          font-size: 11px;
        }

        /* Code Block Wrapper */
        .code-block-wrapper {
          margin: 10px 0;
          border-radius: 6px;
          overflow: hidden;
          border: 1px solid rgba(51, 65, 85, 0.9);
        }

        .code-block-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          background: rgba(30, 41, 59, 0.95);
          padding: 6px 10px;
          border-bottom: 1px solid rgba(51, 65, 85, 0.7);
        }

        .code-language {
          font-size: 10px;
          font-weight: 600;
          color: #94a3b8;
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }

        .copy-btn {
          background: rgba(59, 130, 246, 0.2);
          border: 1px solid rgba(59, 130, 246, 0.4);
          color: #93c5fd;
          padding: 3px 8px;
          border-radius: 4px;
          font-size: 10px;
          font-weight: 500;
          cursor: pointer;
          transition: all 0.15s ease;
        }

        .copy-btn:hover {
          background: rgba(59, 130, 246, 0.35);
          border-color: rgba(59, 130, 246, 0.6);
          transform: translateY(-1px);
        }

        .copy-btn:active {
          transform: translateY(0);
        }
      `}</style>
    </div>
  );
};

export default InterviewOverlay;
