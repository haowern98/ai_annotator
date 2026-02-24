import React, { useState, useRef, useEffect, useMemo } from 'react';
import { Play, Pause, Download, BookOpen, Calendar, Clock, FileText, BarChart3, Film, MessageSquare, Pencil, Check, X } from 'lucide-react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { answerLectureQuestion } from '../services/lectureRagChat';
import type { RagEvidence } from '../services/lectureRagRetriever';

interface TranscriptEntry {
  text: string;
  timestamp: string;
  timestampMs?: number;
}

interface SummaryEntry {
  text: string;
  windowLabel: string;
}

type EmbeddingIndexInfo = {
  status: 'indexing' | 'ready' | 'error';
  indexDir?: string;
  error?: string;
};

interface LectureData {
  id: string;
  title: string;
  date: string;
  time: string;
  duration: string;
  transcripts: TranscriptEntry[];
  summaries: SummaryEntry[];
  videoPath: string;
  recordingEnabled: boolean;
  quality: string | null;
  fileSize: string;
  embeddingIndex?: EmbeddingIndexInfo;
}

// Helper to parse timestamp to milliseconds
const parseTimestamp = (timestamp: string): number => {
  // Try [HH:MM:SS] format first
  let match = timestamp.match(/\[?(\d+):(\d+):(\d+)\]?/);
  if (match) {
    const [, hours, minutes, seconds] = match;
    return (parseInt(hours) * 3600 + parseInt(minutes) * 60 + parseInt(seconds)) * 1000;
  }
  
  // Try [MM:SS] format
  match = timestamp.match(/\[?(\d+):(\d+)\]?/);
  if (match) {
    const [, minutes, seconds] = match;
    return (parseInt(minutes) * 60 + parseInt(seconds)) * 1000;
  }
  
  return 0;
};

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
    <div style={{
      marginTop: '8px',
      marginBottom: '8px',
      borderRadius: '6px',
      overflow: 'hidden',
      border: '1px solid #333333'
    }}>
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '8px 12px',
        backgroundColor: '#1a1a1a',
        borderBottom: '1px solid #333333'
      }}>
        <span style={{ fontSize: '11px', color: '#8a8a8a', textTransform: 'uppercase' }}>
          {language || 'code'}
        </span>
        <button
          onClick={handleCopy}
          style={{
            padding: '4px 8px',
            fontSize: '10px',
            backgroundColor: 'transparent',
            border: '1px solid #333333',
            borderRadius: '4px',
            color: copied ? '#0E72ED' : '#8a8a8a',
            cursor: 'pointer',
            transition: 'all 0.15s'
          }}
        >
          {copied ? '✓ Copied!' : '📋 Copy'}
        </button>
      </div>
      <SyntaxHighlighter
        language={language || 'text'}
        style={oneDark}
        customStyle={{
          margin: 0,
          borderRadius: '0',
          fontSize: '11px',
          padding: '10px',
          backgroundColor: '#0d1117'
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

  return <div style={{ fontSize: '12px', color: '#cccccc', lineHeight: '1.6' }}>{renderMarkdown}</div>;
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
      // Check for headers (###)
      const headerMatch = line.match(/^(#{1,3})\s+(.*)$/);
      if (headerMatch) {
        const level = headerMatch[1].length;
        const headerText = headerMatch[2];
        const fontSize = level === 1 ? '15px' : level === 2 ? '14px' : '13px';
        const marginTop = level === 1 ? '12px' : '10px';
        elements.push(
          <div key={`header-${keyIndex++}`} style={{ 
            fontSize, 
            fontWeight: 600, 
            color: '#ffffff',
            marginTop,
            marginBottom: '6px'
          }}>
            {processInlineFormatting(headerText, keyIndex)}
          </div>
        );
      } else {
        // Process inline formatting
        elements.push(...processInlineFormatting(line, keyIndex));
      }
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
        <strong key={`bold-${baseKey}-${keyIndex++}`} style={{ color: '#ffffff', fontWeight: 600 }}>
          {match[2]}
        </strong>
      );
    } else if (match[3]) {
      // Italic: *text*
      elements.push(
        <em key={`italic-${baseKey}-${keyIndex++}`} style={{ fontStyle: 'italic' }}>
          {match[4]}
        </em>
      );
    } else if (match[5]) {
      // Inline code: `code`
      elements.push(
        <code key={`code-${baseKey}-${keyIndex++}`} style={{
          backgroundColor: 'rgba(14, 114, 237, 0.1)',
          color: '#0E72ED',
          padding: '2px 6px',
          borderRadius: '3px',
          fontSize: '11px',
          fontFamily: 'monospace'
        }}>
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

interface LectureDetailsProps {
  lectureId?: string;
  lectureOrigin?: 'local' | 'remote';
  remoteServerUrl?: string;
  onTitleUpdated?: (lectureId: string, title: string) => void;
}

const LectureDetails: React.FC<LectureDetailsProps> = ({ lectureId, lectureOrigin = 'local', remoteServerUrl, onTitleUpdated }) => {
  const [lectureData, setLectureData] = useState<LectureData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [activeTranscriptIndex, setActiveTranscriptIndex] = useState<number>(-1);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [videoDurationMs, setVideoDurationMs] = useState(0);
  const [summaryTab, setSummaryTab] = useState<'topics' | 'short' | 'chat'>('topics');
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [draftTitle, setDraftTitle] = useState('');
  const [titleError, setTitleError] = useState<string | null>(null);
  const [isSavingTitle, setIsSavingTitle] = useState(false);
  const [recordingsDir, setRecordingsDir] = useState<string | null>(null);

  const [chatInput, setChatInput] = useState('');
  const [chatError, setChatError] = useState<string | null>(null);
  const [isChatBusy, setIsChatBusy] = useState(false);
  const [indexingProgress, setIndexingProgress] = useState<{
    lectureId: string;
    status: 'indexing' | 'ready' | 'error';
    phase: string;
    percentage: number | null;
    counts: null | {
      transcriptsDone: number;
      transcriptsTotal: number;
      summariesDone: number;
      summariesTotal: number;
      framesDone: number;
      framesTotal: number | null;
    };
  } | null>(null);
  const [chatMessages, setChatMessages] = useState<
    Array<{
      id: string;
      role: 'user' | 'assistant';
      content: string;
      evidence?: { transcripts: RagEvidence[]; summaries: RagEvidence[]; frames: RagEvidence[] };
    }>
  >([]);

  const videoRef = useRef<HTMLVideoElement>(null);
  const playbackIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const isSeekingRef = useRef<boolean>(false);
  const chatBottomRef = useRef<HTMLDivElement>(null);

  const { topicSummaries, shortSummaries } = useMemo(() => {
    const summaries = lectureData?.summaries || [];
    const isTopic = (s: SummaryEntry) => String(s?.windowLabel || '').trim().toLowerCase().startsWith('topics:');
    return {
      topicSummaries: summaries.filter(isTopic),
      shortSummaries: summaries.filter((s) => !isTopic(s)),
    };
  }, [lectureData?.summaries]);

  // Cache recordings directory path (used for resolving embedding index paths).
  useEffect(() => {
    const electronAPI = (window as any).electronAPI;
    if (!electronAPI?.initRecording) return;
    electronAPI
      .initRecording()
      .then((res: any) => {
        if (res?.success && res?.path) setRecordingsDir(String(res.path));
      })
      .catch(() => undefined);
  }, []);

  // Listen for main-process embedding index progress events (chat tab only).
  useEffect(() => {
    const electronAPI = (window as any).electronAPI;
    if (!electronAPI?.onEmbeddingIndexProgress) return;

    const handler = (payload: any) => {
      try {
        const id = String(payload?.lectureId || '').trim();
        if (!id || !lectureId || id !== lectureId) return;
        const status = String(payload?.status || 'indexing') as 'indexing' | 'ready' | 'error';
        const phase = String(payload?.phase || '').trim() || 'Indexing';
        const pct = payload?.percentage;
        const percentage = Number.isFinite(pct) ? Number(pct) : null;
        const counts = payload?.counts ?? null;
        setIndexingProgress({ lectureId: id, status, phase, percentage, counts });
      } catch {
        // ignore
      }
    };

    electronAPI.onEmbeddingIndexProgress(handler);
    return () => {
      electronAPI.removeEmbeddingIndexProgressListeners?.();
    };
  }, [lectureId]);

  // Load lecture data from IPC
  useEffect(() => {
    const loadLectureData = async () => {
      if (!lectureId) {
        setIsLoading(false);
        return;
      }

      try {
        const electronAPI = (window as any).electronAPI;

        console.log('[LectureDetails] Loading metadata for:', lectureId, 'origin=', lectureOrigin);

        let meta: any = null;

        if (lectureOrigin === 'remote') {
          if (!electronAPI?.remoteLibraryMeta) {
            console.error('electronAPI.remoteLibraryMeta not available');
            setIsLoading(false);
            return;
          }

          const raw = localStorage.getItem('qwen_remote_config');
          const cfg = raw ? JSON.parse(raw) : null;
          const serverUrl = String(remoteServerUrl || cfg?.remoteUrl || '').trim();
          if (!serverUrl) {
            throw new Error('Remote library not configured (missing server URL)');
          }

          const res = await electronAPI.remoteLibraryMeta(serverUrl, lectureId);
          if (!res?.success || !res?.data?.metadata) {
            throw new Error(res?.error || 'Failed to load remote lecture metadata');
          }
          meta = res.data.metadata;
        } else {
          if (!electronAPI?.getRecordingMetadata) {
            console.error('electronAPI.getRecordingMetadata not available');
            setIsLoading(false);
            return;
          }

          // Try MP4 first, then fallback to WebM for older recordings
          let result = await electronAPI.getRecordingMetadata(lectureId + '.mp4');
          if (!result.success) {
            console.log('[LectureDetails] MP4 metadata not found, trying WebM');
            result = await electronAPI.getRecordingMetadata(lectureId + '.webm');
          }

          if (result.success && result.metadata) {
            meta = result.metadata;
          }
        }

        if (meta) {
          
          // Extract filename without extension - support both .mp4 and .webm
          const videoExtension = meta.videoFilename?.match(/\.(webm|mp4)$/)?.[0] || '.webm';
          const filename = meta.videoFilename.replace(/\.(webm|mp4)$/, '');
          const titleParts = filename.split('_');
          const dateStr = titleParts[1] || '';
          const timeStr = titleParts[2] || '';

          // Format date
          let formattedDate = 'Unknown Date';
          let formattedTime = 'Unknown Time';
          if (dateStr.length === 8) {
            const year = dateStr.substring(0, 4);
            const month = dateStr.substring(4, 6);
            const day = dateStr.substring(6, 8);
            const date = new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
            formattedDate = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
          }

          // Format time
          if (timeStr.length === 6) {
            const hours = parseInt(timeStr.substring(0, 2));
            const minutes = timeStr.substring(2, 4);
            const ampm = hours >= 12 ? 'PM' : 'AM';
            const displayHours = hours % 12 || 12;
            formattedTime = `${displayHours}:${minutes} ${ampm}`;
          }

          // Format duration
          let formattedDuration = '0s';
          if (meta.duration) {
            const totalSeconds = Math.floor(meta.duration / 1000);
            const hours = Math.floor(totalSeconds / 3600);
            const minutes = Math.floor((totalSeconds % 3600) / 60);
            const seconds = totalSeconds % 60;
            if (hours > 0) {
              formattedDuration = `${hours}h ${minutes}m`;
            } else if (minutes > 0) {
              formattedDuration = `${minutes}m ${seconds}s`;
            } else {
              formattedDuration = `${seconds}s`;
            }
          }

          // Format quality
          let qualityDisplay = 'N/A';
          if (meta.quality) {
            if (meta.quality === 'low') qualityDisplay = '480p';
            else if (meta.quality === 'medium') qualityDisplay = '1280p';
            else if (meta.quality === 'high') qualityDisplay = 'Original';
            else qualityDisplay = meta.quality;
          }

          // Format file size
          const fileSizeMB = meta.fileSize ? (meta.fileSize / 1024 / 1024).toFixed(2) : '0';

          const userTitle = typeof meta.userTitle === 'string' ? meta.userTitle.trim() : '';
          setLectureData({
            id: filename,
            title: userTitle ? userTitle : `Lecture ${formattedDate}`,
            date: formattedDate,
            time: formattedTime,
            duration: formattedDuration,
            transcripts: meta.transcripts || [],
            summaries: meta.summaries || [],
            videoPath: meta.videoPath || '',
            recordingEnabled: !!meta.videoPath,
            quality: qualityDisplay,
            fileSize: `${fileSizeMB} MB`,
            embeddingIndex: meta.embeddingIndex || undefined,
          });
          
          // Set video duration from metadata
          if (meta.duration) {
            setVideoDurationMs(meta.duration);
          }

          // Load video if available
          if (meta.videoPath && meta.fileSize > 0) {
            if (lectureOrigin === 'remote') {
              const raw = localStorage.getItem('qwen_remote_config');
              const cfg = raw ? JSON.parse(raw) : null;
              const serverUrl = String(remoteServerUrl || cfg?.remoteUrl || '').trim();
              const u = new URL(/^https?:\/\//i.test(serverUrl) ? serverUrl : `http://${serverUrl}`);
              const port = u.port ? String(Number(u.port) + 1) : '7557';
              u.port = port;
              u.pathname = `/library/lectures/${encodeURIComponent(lectureId)}/video`;
              u.search = '';
              setVideoUrl(u.toString());
              console.log('[LectureDetails] Video loaded via remote library URL');
            } else {
              // Prefer streaming playback via custom protocol to avoid loading large files into renderer memory.
              if (electronAPI?.getRecordingVideoPath) {
                console.log('[LectureDetails] Loading video path...');
                const videoPathResult = await electronAPI.getRecordingVideoPath(meta.videoFilename);
                if (videoPathResult?.success && videoPathResult.path) {
                  // Use localhost as host for proper URL format
                  const normalizedPath = videoPathResult.path.replace(/\\/g, '/');
                  const url = `video://localhost/${normalizedPath}`;
                  setVideoUrl(url);
                  console.log('[LectureDetails] Video loaded via video:// protocol');
                }
              } else if (electronAPI?.getRecordingVideo) {
                console.log('[LectureDetails] Loading video data...');
                const videoResult = await electronAPI.getRecordingVideo(meta.videoFilename);
                if (videoResult?.success && videoResult.data) {
                  // Convert base64 to blob URL (small recordings only).
                  const byteCharacters = atob(videoResult.data);
                  const byteNumbers = new Array(byteCharacters.length);
                  for (let i = 0; i < byteCharacters.length; i++) {
                    byteNumbers[i] = byteCharacters.charCodeAt(i);
                  }
                  const byteArray = new Uint8Array(byteNumbers);
                  const blob = new Blob([byteArray], { type: videoResult.mimeType || 'video/webm' });
                  const url = URL.createObjectURL(blob);
                  setVideoUrl(url);
                  console.log('[LectureDetails] Video loaded as blob URL');
                } else if (videoResult?.error) {
                  console.warn('[LectureDetails] Failed to load video data:', videoResult.error);
                }
              }
            }
          }
        }
      } catch (err) {
        console.error('Failed to load lecture data:', err);
      } finally {
        setIsLoading(false);
      }
    };

    loadLectureData();

    // Cleanup blob URL on unmount
    return () => {
      if (videoUrl && videoUrl.startsWith('blob:')) {
        URL.revokeObjectURL(videoUrl);
      }
    };
  }, [lectureId]);

  // Reset chat when switching lectures.
  useEffect(() => {
    setChatMessages([]);
    setChatInput('');
    setChatError(null);
    setIsChatBusy(false);
  }, [lectureId]);

  useEffect(() => {
    if (!chatBottomRef.current) return;
    chatBottomRef.current.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }, [chatMessages.length, isChatBusy]);

  const seekToMs = (ms: number) => {
    const v = videoRef.current;
    if (!v) return;
    const t = Math.max(0, ms / 1000);
    v.currentTime = t;
    setCurrentTime(t);
  };

  const formatEvidenceTimestamp = (t0_ms: number, t1_ms: number) => {
    const fmt = (m: number) => {
      const totalSec = Math.max(0, Math.floor(m / 1000));
      const h = Math.floor(totalSec / 3600);
      const mm = Math.floor((totalSec % 3600) / 60);
      const ss = totalSec % 60;
      if (h > 0) return `[${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}]`;
      return `[${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}]`;
    };
    if (t1_ms <= t0_ms) return fmt(t0_ms);
    return `${fmt(t0_ms)}-${fmt(t1_ms)}`;
  };

  const getQwenMode = (): 'local' | 'client' => {
    try {
      const raw = localStorage.getItem('qwen_remote_config');
      if (!raw) return 'local';
      const cfg = JSON.parse(raw);
      return cfg?.mode === 'client' ? 'client' : 'local';
    } catch {
      return 'local';
    }
  };

  const getLlamaBaseUrl = (): string => {
    // v1: local only, so default to local llama-server port.
    // If the user is in remote client mode, we intentionally do not enable chat.
    const fallback = 'http://127.0.0.1:8080';
    try {
      const raw = localStorage.getItem('qwen_remote_config');
      if (!raw) return fallback;
      const cfg = JSON.parse(raw);
      const remoteUrl = String(cfg?.remoteUrl || '').trim();
      if (!remoteUrl) return fallback;
      const u = new URL(remoteUrl);
      return `${u.protocol}//${u.hostname}:8080`;
    } catch {
      return fallback;
    }
  };

  const resolveIndexDir = (): string | null => {
    const idx = lectureData?.embeddingIndex;
    const fromMeta = typeof idx?.indexDir === 'string' ? idx.indexDir.trim() : '';
    if (fromMeta) return fromMeta;
    if (!recordingsDir || !lectureId) return null;
    const normalizedDir = String(recordingsDir).replace(/\\/g, '/').replace(/\/+$/, '');
    return `${normalizedDir}/${lectureId}_index`;
  };

  const canUseChat = (): boolean => {
    if (!lectureData?.recordingEnabled) return false;
    if (getQwenMode() !== 'local') return false;
    const idx = lectureData?.embeddingIndex;
    return idx?.status === 'ready' && !!resolveIndexDir();
  };

  const handleSendChat = async () => {
    const q = chatInput.trim();
    if (!q || isChatBusy) return;

    setChatError(null);
    setChatInput('');

    const userMsg = { id: `u_${Date.now()}_${Math.random().toString(16).slice(2)}`, role: 'user' as const, content: q };
    setChatMessages((prev) => [...prev, userMsg]);

    if (!canUseChat()) {
      setChatMessages((prev) => [
        ...prev,
        {
          id: `a_${Date.now()}_${Math.random().toString(16).slice(2)}`,
          role: 'assistant' as const,
          content:
            lectureData?.embeddingIndex?.status === 'indexing'
              ? 'Indexing is still running for this lecture. Please wait until it finishes.'
              : getQwenMode() !== 'local'
                ? 'Chat is available only in local mode for v1.'
                : 'Chat is not ready for this lecture yet. (No embeddings index found.)',
        },
      ]);
      return;
    }

    const indexDir = resolveIndexDir();
    if (!indexDir) {
      setChatError('Missing index directory');
      return;
    }

    setIsChatBusy(true);
    try {
      const history = chatMessages.map((m) => ({ role: m.role, content: m.content }));
      const res = await answerLectureQuestion({
        indexDir,
        query: q,
        llamaBaseUrl: getLlamaBaseUrl(),
        history,
      });

      setChatMessages((prev) => [
        ...prev,
        {
          id: `a_${Date.now()}_${Math.random().toString(16).slice(2)}`,
          role: 'assistant',
          content: res.answer,
          evidence: res.evidence,
        },
      ]);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setChatError(msg);
      setChatMessages((prev) => [
        ...prev,
        {
          id: `a_${Date.now()}_${Math.random().toString(16).slice(2)}`,
          role: 'assistant' as const,
          content: `Error: ${msg}`,
        },
      ]);
    } finally {
      setIsChatBusy(false);
    }
  };

  // Use actual video duration instead of last transcript timestamp
  const totalDurationMs = videoDurationMs > 0 
    ? videoDurationMs 
    : (lectureData?.transcripts.length > 0
      ? parseTimestamp(lectureData.transcripts[lectureData.transcripts.length - 1].timestamp)
      : 0);

  // Playback control - use native HTML5 video playback instead of manual interval
  useEffect(() => {
    if (!videoRef.current) return;

    // Sync video element playback state with UI state
    if (isPlaying) {
      videoRef.current.play().catch((err) => {
        console.warn('Play request was prevented:', err);
        setIsPlaying(false);
      });
    } else {
      videoRef.current.pause();
    }

    return () => {
      if (videoRef.current) {
        videoRef.current.pause();
      }
    };
  }, [isPlaying, videoRef]);

  // Update active transcript based on current time
  useEffect(() => {
    if (!lectureData) return;
    
    const activeIdx = lectureData.transcripts.findIndex((t, idx) => {
      const tMs = parseTimestamp(t.timestamp);
      const nextTranscript = lectureData.transcripts[idx + 1];
      const nextMs = nextTranscript ? parseTimestamp(nextTranscript.timestamp) : Infinity;
      return currentTime >= tMs && currentTime < nextMs;
    });
    setActiveTranscriptIndex(activeIdx);
  }, [currentTime, lectureData]);

  const handlePlayPause = async () => {
    if (!videoRef.current) return;
    
    try {
      if (isPlaying) {
        videoRef.current.pause();
        setIsPlaying(false);
      } else {
        // For WebM videos, duration may report Infinity - use stored metadata duration instead
        if (videoDurationMs === 0) {
          console.warn('Video duration not available - cannot play');
          return;
        }
        
        await videoRef.current.play();
        setIsPlaying(true);
      }
    } catch (err) {
      console.error('Playback error:', err);
      if ((err as any).name === 'NotAllowedError') {
        console.warn('Playback not allowed - autoplay may be restricted');
      }
    }
  };

  const handleStartEditTitle = () => {
    if (!lectureData || !lectureId) return;
    setTitleError(null);
    setDraftTitle(lectureData.title || '');
    setIsEditingTitle(true);
  };

  const handleCancelEditTitle = () => {
    setTitleError(null);
    setIsEditingTitle(false);
  };

  const handleSaveTitle = async () => {
    if (!lectureId) return;
    const next = String(draftTitle || '').trim().replace(/\s+/g, ' ');
    if (!next) {
      setTitleError('Title cannot be empty');
      return;
    }
    setIsSavingTitle(true);
    setTitleError(null);
    try {
      const electronAPI = (window as any).electronAPI;
      let res: any = null;
      if (lectureOrigin === 'remote') {
        if (!electronAPI?.remoteLibrarySetTitle) {
          setTitleError('remoteLibrarySetTitle not available');
          return;
        }
        const raw = localStorage.getItem('qwen_remote_config');
        const cfg = raw ? JSON.parse(raw) : null;
        const serverUrl = String(remoteServerUrl || cfg?.remoteUrl || '').trim();
        if (!serverUrl) {
          setTitleError('Remote library not configured (missing server URL)');
          return;
        }
        res = await electronAPI.remoteLibrarySetTitle(serverUrl, lectureId, next);
      } else {
        if (!electronAPI?.setRecordingTitle) {
          setTitleError('setRecordingTitle not available');
          return;
        }
        res = await electronAPI.setRecordingTitle(lectureId, next);
      }

      if (!res?.success) {
        const detailErr =
          typeof res?.detail === 'string'
            ? res.detail
            : (res?.detail?.error || res?.detail?.message || null);
        setTitleError(String(detailErr || res?.error || 'Failed to save title'));
        return;
      }
      setLectureData((prev) => (prev ? { ...prev, title: next } : prev));
      onTitleUpdated?.(lectureId, next);
      setIsEditingTitle(false);
    } catch (err: any) {
      setTitleError(String(err?.message || err));
    } finally {
      setIsSavingTitle(false);
    }
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = parseInt(e.target.value);
    isSeekingRef.current = true;
    setCurrentTime(value);
    // Sync video element's currentTime property
    if (videoRef.current) {
      videoRef.current.currentTime = value / 1000; // Convert from ms to seconds
    }
    // Allow onTimeUpdate to resume after brief delay
    setTimeout(() => {
      isSeekingRef.current = false;
    }, 100);
  };

  const handleTranscriptClick = (entry: TranscriptEntry) => {
    // Use timestampMs if available, otherwise parse timestamp string
    const ms = entry.timestampMs !== undefined ? entry.timestampMs : parseTimestamp(entry.timestamp);
    setCurrentTime(ms);
    if (videoRef.current) {
      videoRef.current.currentTime = ms / 1000; // Convert to seconds
      // Pause after clicking transcript
      videoRef.current.pause();
      setIsPlaying(false);
    }
  };

  const formatTime = (ms: number) => {
    const hours = Math.floor(ms / 3600000);
    const minutes = Math.floor((ms % 3600000) / 60000);
    const seconds = Math.floor((ms % 60000) / 1000);
    return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  };

  if (isLoading) {
    return (
      <div style={{
        flex: 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: '#1a1a1a',
        color: '#8a8a8a'
      }}>
        Loading lecture data...
      </div>
    );
  }

  if (!lectureData) {
    return (
      <div style={{
        flex: 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: '#1a1a1a',
        color: '#8a8a8a'
      }}>
        Lecture not found
      </div>
    );
  }

  return (
    <div style={{
      flex: 1,
      display: 'flex',
      flexDirection: 'column',
      padding: '24px',
      backgroundColor: '#1a1a1a',
      overflow: 'hidden',
      gap: '16px'
    }}>
      {/* Two Column Layout */}
      <div style={{ display: 'flex', gap: '16px', flex: 1, minHeight: 0 }}>
        {/* Left Column - Video Player + Transcript */}
        <div style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          gap: '16px',
          overflow: 'hidden',
          minHeight: 0
        }}>
          {/* Recording Preview */}
          <div style={{
            backgroundColor: '#242424',
            border: '1px solid #333333',
            borderRadius: '12px',
            padding: '12px',
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
            flex: 1,
            minHeight: 0,
            overflow: 'hidden'
          }}>
            {/* Title and Metadata */}
            <div style={{ flexShrink: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                <BookOpen size={18} color="#8a8a8a" />
                {!isEditingTitle ? (
                  <>
                    <span style={{ fontSize: '16px', fontWeight: 600, color: '#ffffff' }}>
                      {lectureData.title}
                    </span>
                    <button
                      onClick={handleStartEditTitle}
                      title="Rename lecture"
                      style={{
                        marginLeft: '6px',
                        background: 'transparent',
                        border: '1px solid #333333',
                        borderRadius: '8px',
                        padding: '6px',
                        cursor: 'pointer',
                        color: '#8a8a8a',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        transition: 'all 0.15s',
                      }}
                      onMouseEnter={(e) => {
                        (e.currentTarget as HTMLButtonElement).style.backgroundColor = '#2a2a2a';
                        (e.currentTarget as HTMLButtonElement).style.color = '#ffffff';
                        (e.currentTarget as HTMLButtonElement).style.borderColor = '#444444';
                      }}
                      onMouseLeave={(e) => {
                        (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'transparent';
                        (e.currentTarget as HTMLButtonElement).style.color = '#8a8a8a';
                        (e.currentTarget as HTMLButtonElement).style.borderColor = '#333333';
                      }}
                    >
                      <Pencil size={14} />
                    </button>
                  </>
                ) : (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flex: 1 }}>
                    <input
                      value={draftTitle}
                      onChange={(e) => setDraftTitle(e.target.value)}
                      placeholder="Lecture title"
                      style={{
                        flex: 1,
                        minWidth: 0,
                        padding: '8px 10px',
                        borderRadius: '8px',
                        border: '1px solid #333333',
                        backgroundColor: '#1a1a1a',
                        color: '#ffffff',
                        outline: 'none',
                        fontSize: '14px',
                      }}
                    />
                    <button
                      onClick={handleSaveTitle}
                      disabled={isSavingTitle}
                      title="Save"
                      style={{
                        backgroundColor: '#0e72ed',
                        border: '1px solid #0e72ed',
                        borderRadius: '8px',
                        padding: '8px',
                        cursor: isSavingTitle ? 'not-allowed' : 'pointer',
                        opacity: isSavingTitle ? 0.6 : 1,
                        color: '#ffffff',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      <Check size={14} />
                    </button>
                    <button
                      onClick={handleCancelEditTitle}
                      disabled={isSavingTitle}
                      title="Cancel"
                      style={{
                        backgroundColor: 'transparent',
                        border: '1px solid #333333',
                        borderRadius: '8px',
                        padding: '8px',
                        cursor: isSavingTitle ? 'not-allowed' : 'pointer',
                        opacity: isSavingTitle ? 0.6 : 1,
                        color: '#8a8a8a',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      <X size={14} />
                    </button>
                  </div>
                )}
              </div>
              {titleError && (
                <div style={{ color: '#ef4444', fontSize: '12px', marginTop: '-4px', marginBottom: '6px' }}>
                  {titleError}
                </div>
              )}
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px', fontSize: '13px', color: '#8a8a8a' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <Calendar size={18} color="#8a8a8a" />
                  {lectureData.date} | {lectureData.time}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <Clock size={18} color="#8a8a8a" />
                  {lectureData.duration}
                </div>
                <button
                  onClick={() => setPlaybackSpeed(prev => prev === 1 ? 1.5 : prev === 1.5 ? 2 : 1)}
                  style={{
                    padding: '4px 8px',
                    backgroundColor: '#242424',
                    border: '1px solid #333333',
                    borderRadius: '6px',
                    color: '#8a8a8a',
                    fontSize: '11px',
                    cursor: 'pointer',
                    transition: 'all 0.15s'
                  }}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLButtonElement).style.backgroundColor = '#2a2a2a';
                    (e.currentTarget as HTMLButtonElement).style.color = '#ffffff';
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLButtonElement).style.backgroundColor = '#242424';
                    (e.currentTarget as HTMLButtonElement).style.color = '#8a8a8a';
                  }}
                >
                  Speed: {playbackSpeed}x
                </button>
              </div>
            </div>

            {/* Video Frame Display */}
            <div style={{
              flex: 1,
              backgroundColor: '#1a1a1a',
              borderRadius: '8px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              minHeight: '80px',
              position: 'relative',
              border: '1px solid #333333',
              overflow: 'hidden'
            }}>
              {lectureData.recordingEnabled && videoUrl ? (
                <video
                  ref={videoRef}
                  src={videoUrl}
                  style={{
                    maxWidth: '100%',
                    maxHeight: '100%',
                    borderRadius: '8px'
                  }}
                  onTimeUpdate={(e) => {
                    if (!isSeekingRef.current) {
                      setCurrentTime((e.target as HTMLVideoElement).currentTime * 1000);
                    }
                  }}
                  onLoadedMetadata={(e) => {
                    const video = e.target as HTMLVideoElement;
                    const videoDuration = video.duration;
                    
                    // WebM blob URLs often report Infinity - use stored metadata duration as primary source
                    // Only use video.duration if it's valid AND we don't have metadata duration
                    if (videoDurationMs > 0) {
                      // Already set from metadata, keep it
                      console.log('[Video] Using duration from metadata:', videoDurationMs, 'ms (video reports:', videoDuration, ')');
                    } else if (isFinite(videoDuration) && videoDuration > 0) {
                      // No metadata duration but video duration is valid
                      setVideoDurationMs(videoDuration * 1000);
                      console.log('[Video] Using duration from video element:', videoDuration, 's');
                    } else {
                      console.warn('[Video] No valid duration available - metadata:', videoDurationMs, 'video:', videoDuration);
                    }
                  }}
                  onError={(e) => {
                    const video = e.target as HTMLVideoElement;
                    console.error('[Video] Load error:', video.error);
                    console.error('[Video] Error code:', video.error?.code, 'message:', video.error?.message);
                  }}
                  onCanPlay={(e) => {
                    console.log('[Video] Ready for playback');
                  }}
                />
              ) : lectureData.recordingEnabled && !videoUrl ? (
                <div style={{ color: '#8a8a8a', fontSize: '13px' }}>Loading video...</div>
              ) : (
                <div style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: '8px',
                  color: '#8a8a8a',
                  fontSize: '14px'
                }}>
                  <div>No Recording Available</div>
                  <div style={{ fontSize: '12px', color: '#666666' }}>Recording was disabled for this lecture</div>
                </div>
              )}
            </div>

            {/* Playback Controls */}
            <div style={{
              backgroundColor: '#1a1a1a',
              borderRadius: '8px',
              padding: '8px',
              display: 'flex',
              flexDirection: 'column',
              gap: '8px',
              flexShrink: 0
            }}>
              {/* Timeline */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <button
                  onClick={handlePlayPause}
                  style={{
                    width: '32px',
                    height: '32px',
                    borderRadius: '6px',
                    backgroundColor: '#0E72ED',
                    border: 'none',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    cursor: 'pointer',
                    transition: 'all 0.15s'
                  }}
                  onMouseEnter={(e) => (e.currentTarget as HTMLButtonElement).style.backgroundColor = '#0d62cc'}
                  onMouseLeave={(e) => (e.currentTarget as HTMLButtonElement).style.backgroundColor = '#0E72ED'}
                >
                  {isPlaying ? <Pause size={16} color="#ffffff" /> : <Play size={16} color="#ffffff" />}
                </button>
                
                <span style={{ fontSize: '13px', color: '#8a8a8a', minWidth: '60px' }}>
                  {formatTime(currentTime)}
                </span>

                <input
                  type="range"
                  min="0"
                  max={totalDurationMs}
                  value={currentTime}
                  onChange={handleSeek}
                  style={{
                    flex: 1,
                    height: '4px',
                    borderRadius: '2px',
                    outline: 'none',
                    background: `linear-gradient(to right, #0E72ED 0%, #0E72ED ${(currentTime / totalDurationMs) * 100}%, #333333 ${(currentTime / totalDurationMs) * 100}%, #333333 100%)`,
                    cursor: 'pointer'
                  }}
                />

                <span style={{ fontSize: '13px', color: '#8a8a8a', minWidth: '60px', textAlign: 'right' }}>
                  {formatTime(totalDurationMs)}
                </span>
              </div>
            </div>
          </div>

          {/* Transcript Timeline */}
          <div style={{
            backgroundColor: '#242424',
            borderRadius: '12px',
            padding: '16px',
            border: '1px solid #333333',
            display: 'flex',
            flexDirection: 'column',
            gap: '12px',
            flex: 1,
            overflow: 'hidden'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <FileText size={18} color="#8a8a8a" />
                <span style={{ fontSize: '14px', fontWeight: 600, color: '#ffffff' }}>
                  Transcript Timeline
                </span>
                <span style={{ fontSize: '12px', color: '#666666' }}>
                  ({lectureData.transcripts.length} entries)
                </span>
              </div>

              <div style={{ display: 'flex', gap: '8px' }}>
                <button
                  style={{
                    padding: '6px 10px',
                    backgroundColor: 'transparent',
                    border: '1px solid #333333',
                    borderRadius: '6px',
                    color: '#8a8a8a',
                    fontSize: '12px',
                    cursor: 'pointer',
                    transition: 'all 0.15s'
                  }}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLButtonElement).style.borderColor = '#0E72ED';
                    (e.currentTarget as HTMLButtonElement).style.color = '#0E72ED';
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLButtonElement).style.borderColor = '#333333';
                    (e.currentTarget as HTMLButtonElement).style.color = '#8a8a8a';
                  }}
                >
                  Copy All
                </button>
                <button
                  style={{
                    padding: '6px 10px',
                    backgroundColor: 'transparent',
                    border: '1px solid #333333',
                    borderRadius: '6px',
                    color: '#8a8a8a',
                    fontSize: '12px',
                    cursor: 'pointer',
                    transition: 'all 0.15s',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '4px'
                  }}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLButtonElement).style.borderColor = '#0E72ED';
                    (e.currentTarget as HTMLButtonElement).style.color = '#0E72ED';
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLButtonElement).style.borderColor = '#333333';
                    (e.currentTarget as HTMLButtonElement).style.color = '#8a8a8a';
                  }}
                >
                  <Download size={12} />
                  Export
                </button>
              </div>
            </div>
            {/* Transcript Entries */}
            <div style={{
              flex: 1,
              overflow: 'auto',
              display: 'flex',
              flexDirection: 'column',
              gap: '8px',
              backgroundColor: '#1a1a1a',
              borderRadius: '8px',
              padding: '12px',
              minHeight: 0
            }}>
              {lectureData.transcripts.length > 0 ? (
                lectureData.transcripts.map((entry, idx) => (
                  <div
                    key={idx}
                    onClick={() => handleTranscriptClick(entry)}
                    style={{
                      padding: '10px 12px',
                      backgroundColor: activeTranscriptIndex === idx ? 'rgba(14, 114, 237, 0.15)' : '#242424',
                      border: activeTranscriptIndex === idx ? '1px solid #0E72ED' : '1px solid #333333',
                      borderRadius: '6px',
                      cursor: 'pointer',
                      transition: 'all 0.15s'
                    }}
                    onMouseEnter={(e) => {
                      if (activeTranscriptIndex !== idx) {
                        (e.currentTarget as HTMLDivElement).style.backgroundColor = '#2a2a2a';
                      }
                    }}
                    onMouseLeave={(e) => {
                      if (activeTranscriptIndex !== idx) {
                        (e.currentTarget as HTMLDivElement).style.backgroundColor = '#242424';
                      }
                    }}
                  >
                    <div style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                      marginBottom: '6px'
                    }}>
                      <Clock size={14} color={activeTranscriptIndex === idx ? '#0E72ED' : '#8a8a8a'} />
                      <span style={{
                        fontSize: '12px',
                        fontWeight: 600,
                        color: activeTranscriptIndex === idx ? '#0E72ED' : '#8a8a8a',
                        fontFamily: 'monospace'
                      }}>
                        {entry.timestamp}
                      </span>
                    </div>
                    <div style={{
                      fontSize: '13px',
                      color: '#cccccc',
                      lineHeight: '1.6'
                    }}>
                      {entry.text}
                    </div>
                  </div>
                ))
              ) : (
                <div style={{
                  flex: 1,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: '#666666',
                  fontSize: '13px'
                }}>
                  No transcripts available
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Right Column - Summaries Only */}
        <div style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden'
        }}>
          {/* Generated Summaries */}
          <div style={{
            backgroundColor: '#242424',
            border: '1px solid #333333',
            borderRadius: '12px',
            padding: '16px',
            display: 'flex',
            flexDirection: 'column',
            gap: '10px',
            flex: 1,
            overflow: 'hidden'
           }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <BarChart3 size={18} color="#8a8a8a" />
              <span style={{ fontSize: '14px', fontWeight: 600, color: '#ffffff' }}>
                Generated Summaries
              </span>
              <span style={{ fontSize: '12px', color: '#666666' }}>
                ({lectureData.summaries.length} summaries)
              </span>
            </div>

            {/* Summary Tabs */}
            <div style={{
              display: 'flex',
              gap: '8px',
              paddingBottom: '2px'
            }}>
              <button
                onClick={() => setSummaryTab('topics')}
                style={{
                  padding: '6px 10px',
                  backgroundColor: summaryTab === 'topics' ? '#1a1a1a' : 'transparent',
                  border: `1px solid ${summaryTab === 'topics' ? '#0E72ED' : '#333333'}`,
                  borderRadius: '8px',
                  color: summaryTab === 'topics' ? '#0E72ED' : '#8a8a8a',
                  fontSize: '12px',
                  cursor: 'pointer',
                  transition: 'all 0.15s',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px'
                }}
              >
                <BarChart3 size={14} color={summaryTab === 'topics' ? '#0E72ED' : '#8a8a8a'} />
                3-Minute Topics ({topicSummaries.length})
              </button>
              <button
                onClick={() => setSummaryTab('short')}
                style={{
                  padding: '6px 10px',
                  backgroundColor: summaryTab === 'short' ? '#1a1a1a' : 'transparent',
                  border: `1px solid ${summaryTab === 'short' ? '#0E72ED' : '#333333'}`,
                  borderRadius: '8px',
                  color: summaryTab === 'short' ? '#0E72ED' : '#8a8a8a',
                  fontSize: '12px',
                  cursor: 'pointer',
                  transition: 'all 0.15s',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px'
                }}
              >
                <Film size={14} color={summaryTab === 'short' ? '#0E72ED' : '#8a8a8a'} />
                Short (5-frame) ({shortSummaries.length})
              </button>
              <button
                onClick={() => setSummaryTab('chat')}
                style={{
                  padding: '6px 10px',
                  backgroundColor: summaryTab === 'chat' ? '#1a1a1a' : 'transparent',
                  border: `1px solid ${summaryTab === 'chat' ? '#0E72ED' : '#333333'}`,
                  borderRadius: '8px',
                  color: summaryTab === 'chat' ? '#0E72ED' : '#8a8a8a',
                  fontSize: '12px',
                  cursor: 'pointer',
                  transition: 'all 0.15s',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px'
                }}
              >
                <MessageSquare size={14} color={summaryTab === 'chat' ? '#0E72ED' : '#8a8a8a'} />
                Chat
              </button>
            </div>

            {/* Tab Content */}
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minHeight: 0 }}>
              {summaryTab === 'chat' ? (
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minHeight: 0 }}>
                  <div style={{ flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: '8px', minHeight: 0 }}>
                    <div style={{
                      backgroundColor: '#1a1a1a',
                      border: '1px solid #333333',
                      borderRadius: '8px',
                      padding: '10px'
                    }}>
                      <div style={{ fontSize: '12px', fontWeight: 600, color: '#8a8a8a', marginBottom: '6px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <MessageSquare size={14} color="#8a8a8a" />
                        Ask about this lecture
                      </div>
                      <div style={{ fontSize: '13px', color: '#cccccc', lineHeight: '1.6' }}>
                        {getQwenMode() !== 'local'
                          ? 'Chat is available only in local mode for v1.'
                          : lectureData?.embeddingIndex?.status === 'ready'
                            ? 'Indexed. Ask anything and I will answer with timestamps.'
                            : lectureData?.embeddingIndex?.status === 'indexing'
                              ? 'Indexing in progress. Chat will enable once it finishes.'
                              : lectureData?.embeddingIndex?.status === 'error'
                                ? `Indexing failed: ${lectureData.embeddingIndex?.error || 'Unknown error'}`
                                : 'No embeddings index found for this lecture yet.'}
                      </div>

                      {getQwenMode() === 'local' && (lectureData?.embeddingIndex?.status === 'indexing' || indexingProgress?.status === 'indexing') ? (
                        <div style={{ marginTop: '10px' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '10px' }}>
                            <div style={{ fontSize: '12px', color: '#8a8a8a' }}>
                              {indexingProgress?.phase || 'Indexing'}
                            </div>
                            <div style={{ fontSize: '12px', color: '#8a8a8a' }}>
                              {Number.isFinite(indexingProgress?.percentage as any) ? `${indexingProgress?.percentage}%` : ''}
                            </div>
                          </div>
                          <div style={{ height: '8px', backgroundColor: '#111111', border: '1px solid #333333', borderRadius: '999px', overflow: 'hidden', marginTop: '6px' }}>
                            <div
                              style={{
                                height: '100%',
                                width: `${Math.max(0, Math.min(100, indexingProgress?.percentage ?? 0))}%`,
                                backgroundColor: '#0E72ED',
                                transition: 'width 0.2s ease',
                              }}
                            />
                          </div>
                          {indexingProgress?.counts ? (
                            <div style={{ marginTop: '8px', fontSize: '12px', color: '#8a8a8a', display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
                              <span>
                                Transcripts: {indexingProgress.counts.transcriptsDone}/{indexingProgress.counts.transcriptsTotal}
                              </span>
                              <span>
                                Summaries: {indexingProgress.counts.summariesDone}/{indexingProgress.counts.summariesTotal}
                              </span>
                              <span>
                                Frames: {indexingProgress.counts.framesDone}/{indexingProgress.counts.framesTotal ?? '?'}
                              </span>
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                    </div>

                    {false ? (
                      <>
                    <div style={{
                      alignSelf: 'flex-end',
                      maxWidth: '90%',
                      backgroundColor: '#0f2a4a',
                      border: '1px solid #0E72ED',
                      borderRadius: '10px',
                      padding: '10px'
                    }}>
                      <div style={{ fontSize: '12px', fontWeight: 600, color: '#0E72ED', marginBottom: '6px' }}>
                        You
                      </div>
                      <div style={{ fontSize: '13px', color: '#ffffff', lineHeight: '1.6' }}>
                        When does the lecturer explain “Project One”?
                      </div>
                    </div>

                    <div style={{
                      alignSelf: 'flex-start',
                      maxWidth: '90%',
                      backgroundColor: '#1a1a1a',
                      border: '1px solid #333333',
                      borderRadius: '10px',
                      padding: '10px'
                    }}>
                      <div style={{ fontSize: '12px', fontWeight: 600, color: '#8a8a8a', marginBottom: '6px' }}>
                        Assistant
                      </div>
                      <div style={{ fontSize: '13px', color: '#cccccc', lineHeight: '1.6' }}>
                        (Example) I’ll answer with timestamps and frame evidence once retrieval is wired up.
                      </div>
                      <div style={{ marginTop: '8px', display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                        {['[58:05]', '[58:10]', '[58:15]'].map((c) => (
                          <div
                            key={c}
                            style={{
                              color: '#0E72ED',
                              fontSize: '12px',
                              fontWeight: 600,
                              userSelect: 'none',
                              lineHeight: '1.2'
                            }}
                            title="Citations will be clickable when wired up"
                          >
                            {c}
                          </div>
                        ))}
                      </div>
                    </div>
                      </>
                    ) : null}

                    {chatMessages.map((m) => (
                      <div
                        key={m.id}
                        style={{
                          alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
                          maxWidth: '92%',
                          backgroundColor: m.role === 'user' ? '#0f2a4a' : '#1a1a1a',
                          border: `1px solid ${m.role === 'user' ? '#0E72ED' : '#333333'}`,
                          borderRadius: '10px',
                          padding: '10px'
                        }}
                      >
                        <div style={{ fontSize: '12px', fontWeight: 600, color: '#8a8a8a', marginBottom: '6px' }}>
                          {m.role === 'user' ? 'You' : 'Assistant'}
                        </div>
                        <div style={{ fontSize: '13px', color: m.role === 'user' ? '#ffffff' : '#cccccc', lineHeight: '1.6', whiteSpace: 'pre-wrap' }}>
                          {m.content}
                        </div>

                        {m.role === 'assistant' && m.evidence ? (
                          <div style={{ marginTop: '8px', display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                            {(() => {
                              const seen = new Set<string>();
                              const chips: Array<{ label: string; t0_ms: number }> = [];
                              const push = (t0_ms: number, t1_ms: number) => {
                                const label = formatEvidenceTimestamp(t0_ms, t1_ms);
                                if (seen.has(label)) return;
                                seen.add(label);
                                chips.push({ label, t0_ms });
                              };

                              m.evidence.summaries.slice(0, 4).forEach((e) => push(e.t0_ms, e.t1_ms));
                              m.evidence.transcripts.slice(0, 4).forEach((e) => push(e.t0_ms, e.t1_ms));
                              m.evidence.frames.slice(0, 2).forEach((e) => push(e.t0_ms, e.t1_ms));

                              return chips.slice(0, 10).map((c) => (
                                <button
                                  key={c.label}
                                  onClick={() => seekToMs(c.t0_ms)}
                                  style={{
                                    background: 'transparent',
                                    border: 'none',
                                    padding: 0,
                                    margin: 0,
                                    color: '#0E72ED',
                                    fontSize: '12px',
                                    fontWeight: 600,
                                    cursor: 'pointer',
                                    lineHeight: '1.2'
                                  }}
                                  title="Jump to evidence"
                                >
                                  {c.label}
                                </button>
                              ));
                            })()}
                          </div>
                        ) : null}
                      </div>
                    ))}

                    {isChatBusy ? (
                      <div style={{
                        alignSelf: 'flex-start',
                        maxWidth: '92%',
                        backgroundColor: '#1a1a1a',
                        border: '1px solid #333333',
                        borderRadius: '10px',
                        padding: '10px'
                      }}>
                        <div style={{ fontSize: '12px', fontWeight: 600, color: '#8a8a8a', marginBottom: '6px' }}>
                          Assistant
                        </div>
                        <div style={{ fontSize: '13px', color: '#cccccc', lineHeight: '1.6' }}>
                          Thinking...
                        </div>
                      </div>
                    ) : null}

                    <div ref={chatBottomRef} />
                  </div>

                  <div style={{ borderTop: '1px solid #333333', paddingTop: '10px', display: 'flex', gap: '8px', flexDirection: 'column' }}>
                    {chatError ? (
                      <div style={{ fontSize: '12px', color: '#ff6b6b' }}>
                        {chatError}
                      </div>
                    ) : null}
                    <div style={{ display: 'flex', gap: '8px' }}>
                    <input
                      type="text"
                      value={chatInput}
                      onChange={(e) => setChatInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void handleSendChat();
                      }}
                      placeholder="Ask a question…"
                      disabled={!canUseChat() || isChatBusy}
                      style={{
                        flex: 1,
                        backgroundColor: '#1a1a1a',
                        border: '1px solid #333333',
                        borderRadius: '8px',
                        padding: '10px',
                        fontSize: '13px',
                        color: '#ffffff',
                        outline: 'none'
                      }}
                    />
                    <button
                      onClick={() => void handleSendChat()}
                      disabled={!canUseChat() || isChatBusy || !chatInput.trim()}
                      style={{
                        padding: '10px 14px',
                        backgroundColor: !canUseChat() || isChatBusy || !chatInput.trim() ? '#1a1a1a' : '#0E72ED',
                        border: `1px solid ${!canUseChat() || isChatBusy || !chatInput.trim() ? '#333333' : '#0E72ED'}`,
                        borderRadius: '8px',
                        color: !canUseChat() || isChatBusy || !chatInput.trim() ? '#8a8a8a' : '#ffffff',
                        fontSize: '13px',
                        cursor: !canUseChat() || isChatBusy || !chatInput.trim() ? 'not-allowed' : 'pointer',
                        transition: 'all 0.15s'
                      }}
                      title={canUseChat() ? 'Send' : 'Chat not ready'}
                    >
                      Send
                    </button>
                    </div>
                  </div>
                </div>
              ) : (
                <div style={{ flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: '8px', minHeight: 0 }}>
                  {(summaryTab === 'topics' ? topicSummaries : shortSummaries).length > 0 ? (
                    (summaryTab === 'topics' ? topicSummaries : shortSummaries).map((summary, idx) => (
                      <div
                        key={`${summaryTab}-${idx}`}
                        style={{
                          backgroundColor: '#1a1a1a',
                          border: '1px solid #333333',
                          borderRadius: '8px',
                          padding: '10px',
                          transition: 'all 0.15s'
                        }}
                        onMouseEnter={(e) => {
                          (e.currentTarget as HTMLDivElement).style.borderColor = '#0E72ED';
                          (e.currentTarget as HTMLDivElement).style.backgroundColor = '#242424';
                        }}
                        onMouseLeave={(e) => {
                          (e.currentTarget as HTMLDivElement).style.borderColor = '#333333';
                          (e.currentTarget as HTMLDivElement).style.backgroundColor = '#1a1a1a';
                        }}
                      >
                        <div style={{ fontSize: '12px', fontWeight: 600, color: '#0E72ED', marginBottom: '6px' }}>
                          {summary.windowLabel}
                        </div>
                        <MarkdownRenderer content={summary.text} />
                      </div>
                    ))
                  ) : (
                    <div style={{
                      flex: 1,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: '#666666',
                      fontSize: '13px'
                    }}>
                      No summaries available
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default LectureDetails;
