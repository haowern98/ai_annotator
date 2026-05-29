import React, { useEffect, useMemo, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import {
  BarChart3,
  BookOpen,
  Calendar,
  ChevronRight,
  Clock,
  FileText,
  Film,
  Pencil,
  Search,
  Check,
  X,
} from 'lucide-react';

type SummaryTab = 'transcript' | 'topics' | 'short';

interface LectureListItem {
  id: string;
  title: string;
  date: string;
  time: string;
  duration: string;
  transcriptCount: number;
  summaryCount: number;
  recordingEnabled: boolean;
  quality: string | null;
  fileSize: string;
  lastModified?: string;
}

interface TranscriptEntry {
  text: string;
  timestamp: string;
  timestampMs?: number;
}

interface SummaryEntry {
  text: string;
  windowLabel: string;
}

interface LectureDetailsData extends LectureListItem {
  transcripts: TranscriptEntry[];
  summaries: SummaryEntry[];
  hasVideo: boolean;
  hasMp4?: boolean;
  hasWebm?: boolean;
}

interface TranscodeJob {
  lectureId: string;
  state: 'idle' | 'queued' | 'running' | 'complete' | 'cancelled' | 'error';
  phase: string;
  percent: number;
  error?: string | null;
}

function isSafariLikeDevice(): boolean {
  try {
    const ua = String(navigator.userAgent || '');
    const platform = String((navigator as any).platform || '');
    const maxTouchPoints = Number((navigator as any).maxTouchPoints || 0);

    const isIPhone = /iPhone/i.test(ua);
    const isIPad = /iPad/i.test(ua);
    const isIPod = /iPod/i.test(ua);
    const isIOS = isIPhone || isIPad || isIPod;

    // iPadOS can report as "Macintosh" but with touch points.
    const isIPadOS13Plus = /Macintosh/i.test(ua) && maxTouchPoints > 1 && /Mac/i.test(platform);

    if (isIOS || isIPadOS13Plus) return true;

    // Desktop Safari (macOS): contains "Safari" but not Chrome/Edge/Opera.
    const isSafari = /Safari/i.test(ua) && !/Chrome|Chromium|Edg|OPR|Opera/i.test(ua);
    if (isSafari) return true;

    return false;
  } catch {
    return false;
  }
}

function parseTimestampToMs(timestamp: string): number {
  // [HH:MM:SS]
  let match = timestamp.match(/\[?(\d+):(\d+):(\d+)\]?/);
  if (match) {
    const [, hours, minutes, seconds] = match;
    return (Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds)) * 1000;
  }

  // [MM:SS]
  match = timestamp.match(/\[?(\d+):(\d+)\]?/);
  if (match) {
    const [, minutes, seconds] = match;
    return (Number(minutes) * 60 + Number(seconds)) * 1000;
  }

  return 0;
}

function useRoute() {
  const parse = () => {
    const raw = String(window.location.hash || '').trim();
    const hash = raw.startsWith('#') ? raw.slice(1) : raw;
    const parts = hash.split('/').filter(Boolean);
    if (parts[0] === 'lecture' && parts[1]) return { page: 'detail' as const, id: decodeURIComponent(parts[1]) };
    return { page: 'list' as const, id: null as string | null };
  };

  const [route, setRoute] = useState(parse);

  useEffect(() => {
    const onChange = () => setRoute(parse());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  return route;
}

const MarkdownBlock: React.FC<{ content: string }> = ({ content }) => {
  const html = useMemo(() => {
    const raw = marked.parse(content || '', { breaks: true }) as string;
    return DOMPurify.sanitize(raw);
  }, [content]);

  return <div className="wv-markdown" dangerouslySetInnerHTML={{ __html: html }} />;
};

async function fetchJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { Accept: 'application/json' } });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    // ignore
  }
  if (!res.ok) {
    const msg = json?.error || `${res.status} ${res.statusText}` || 'Request failed';
    throw new Error(msg);
  }
  return json as T;
}

const LectureListPage: React.FC<{ onOpen: (id: string) => void }> = ({ onOpen }) => {
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [lectures, setLectures] = useState<LectureListItem[]>([]);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      setIsLoading(true);
      setError(null);
      try {
        const data = await fetchJson<{ success: boolean; lectures: LectureListItem[] }>('/api/lectures');
        if (!cancelled) setLectures(Array.isArray(data.lectures) ? data.lectures : []);
      } catch (e: any) {
        if (!cancelled) setError(String(e?.message || e));
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };
    run();
    return () => {
      cancelled = true;
    };
  }, []);

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return lectures;
    return lectures.filter((l) => l.title.toLowerCase().includes(q) || l.date.toLowerCase().includes(q));
  }, [lectures, searchQuery]);

  return (
    <div className="wv-container">
      <div className="wv-header">
        <div className="wv-title-row">
          <div>
            <div className="wv-title">
              <BookOpen size={18} color="var(--accent)" />
              Recent Lectures
            </div>
            <div className="wv-subtitle">{isLoading ? 'Loading…' : `${lectures.length} recordings`}</div>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <Search size={16} color="var(--muted)" />
          <input
            className="wv-search"
            placeholder="Search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>
      </div>

      {error && <div className="wv-error">{error}</div>}

      {!error && !isLoading && filtered.length === 0 && <div className="wv-empty">No lectures found</div>}

      <div className="wv-list">
        {filtered.map((lecture) => (
          <div
            key={lecture.id}
            className="wv-card wv-card-pressable"
            onClick={() => onOpen(lecture.id)}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLDivElement).style.borderColor = 'var(--accent)';
              (e.currentTarget as HTMLDivElement).style.backgroundColor = '#2a2a2a';
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLDivElement).style.borderColor = 'var(--border)';
              (e.currentTarget as HTMLDivElement).style.backgroundColor = 'var(--panel)';
            }}
          >
            <div className="wv-row">
              <div className="wv-left">
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <BookOpen size={18} color="var(--accent)" />
                  <h3 className="wv-h1" style={{ margin: 0, fontSize: 15 }}>
                    {lecture.title}
                  </h3>
                </div>

                <div className="wv-meta">
                  <span className="wv-meta-item">
                    <Calendar size={14} color="var(--muted)" />
                    {lecture.date} | {lecture.time}
                  </span>
                  <span className="wv-meta-item">
                    <Clock size={14} color="var(--muted)" />
                    Duration: {lecture.duration}
                  </span>
                  <span className="wv-meta-item">
                    <FileText size={14} color="var(--muted)" />
                    {lecture.transcriptCount}
                  </span>
                  <span className="wv-meta-item">
                    <BarChart3 size={14} color="var(--muted)" />
                    {lecture.summaryCount}
                  </span>
                  <span className={lecture.recordingEnabled ? 'wv-badge-ok' : 'wv-badge-muted'}>
                    Recording: {lecture.recordingEnabled ? `Yes (${lecture.quality || 'N/A'})` : 'No'}
                  </span>
                </div>
              </div>

              <ChevronRight size={18} color="var(--muted)" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

const LectureDetailPage: React.FC<{ lectureId: string; onBack: () => void }> = ({ lectureId, onBack }) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const safariLikeRef = useRef<boolean>(isSafariLikeDevice());
  const [tab, setTab] = useState<SummaryTab>('transcript');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lecture, setLecture] = useState<LectureDetailsData | null>(null);
  const [videoError, setVideoError] = useState<string | null>(null);
  const [transcodeJob, setTranscodeJob] = useState<TranscodeJob | null>(null);
  const [videoSrcToken, setVideoSrcToken] = useState<number>(() => Date.now());
  const [isStartingTranscode, setIsStartingTranscode] = useState(false);
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [draftTitle, setDraftTitle] = useState('');
  const [isSavingTitle, setIsSavingTitle] = useState(false);
  const [titleError, setTitleError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      setIsLoading(true);
      setError(null);
      setVideoError(null);
      setTranscodeJob(null);
      try {
        const data = await fetchJson<{ success: boolean; lecture: LectureDetailsData }>(
          `/api/lectures/${encodeURIComponent(lectureId)}`
        );
        if (!cancelled) setLecture(data.lecture);
      } catch (e: any) {
        if (!cancelled) setError(String(e?.message || e));
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };
    run();
    return () => {
      cancelled = true;
    };
  }, [lectureId]);

  const fetchTranscodeStatus = async (): Promise<TranscodeJob | null> => {
    if (!lecture) return null;
    try {
      const data = await fetchJson<{ success: boolean; job: TranscodeJob }>(
        `/api/lectures/${encodeURIComponent(lecture.id)}/transcode`
      );
      if (!data?.job) return null;
      setTranscodeJob(data.job);
      return data.job;
    } catch {
      return null;
    }
  };

  // Safari/iOS sometimes won't fire a useful <video> error; proactively show the MP4 prompt.
  useEffect(() => {
    if (!lecture) return;
    if (!safariLikeRef.current) return;
    if (lecture.hasMp4) return;

    void fetchTranscodeStatus();
  }, [lecture?.id, lecture?.hasMp4]);

  useEffect(() => {
    if (!lecture) return;
    if (!transcodeJob) return;
    if (transcodeJob.state !== 'queued' && transcodeJob.state !== 'running') return;

    let cancelled = false;
    const interval = window.setInterval(async () => {
      if (cancelled) return;
      const job = await fetchTranscodeStatus();
      if (!job) return;
      if (job.state === 'complete') {
        setLecture((prev) => (prev ? { ...prev, hasMp4: true } : prev));
        setVideoError(null);
        setVideoSrcToken(Date.now());
      }
    }, 1000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [lecture, transcodeJob?.state]);

  const handleStartTranscode = async () => {
    if (!lecture) return;
    setIsStartingTranscode(true);
    try {
      const res = await fetch(`/api/lectures/${encodeURIComponent(lecture.id)}/transcode`, { method: 'POST' });
      const text = await res.text();
      const json = JSON.parse(text);
      if (!res.ok || !json?.success) {
        throw new Error(json?.error || `${res.status} ${res.statusText}` || 'Failed to start transcode');
      }
      if (json?.job) setTranscodeJob(json.job);
      await fetchTranscodeStatus();
    } catch (e: any) {
      setTranscodeJob({
        lectureId: lecture.id,
        state: 'error',
        phase: 'Error',
        percent: 0,
        error: String(e?.message || e),
      });
    } finally {
      setIsStartingTranscode(false);
    }
  };

  const handleCancelTranscode = async () => {
    if (!lecture) return;
    try {
      await fetch(`/api/lectures/${encodeURIComponent(lecture.id)}/transcode`, { method: 'DELETE' });
    } catch {
      // ignore
    } finally {
      await fetchTranscodeStatus();
    }
  };

  const { topicSummaries, shortSummaries } = useMemo(() => {
    const summaries = lecture?.summaries || [];
    const isTopic = (s: SummaryEntry) => String(s?.windowLabel || '').trim().toLowerCase().startsWith('topics:');
    return {
      topicSummaries: summaries.filter(isTopic),
      shortSummaries: summaries.filter((s) => !isTopic(s)),
    };
  }, [lecture?.summaries]);

  const handleSeek = (ms: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = Math.max(0, ms / 1000);
  };

  const handleStartEditTitle = () => {
    if (!lecture) return;
    setTitleError(null);
    setDraftTitle(lecture.title || '');
    setIsEditingTitle(true);
  };

  const handleCancelEditTitle = () => {
    setTitleError(null);
    setIsEditingTitle(false);
  };

  const handleSaveTitle = async () => {
    if (!lecture) return;
    const next = String(draftTitle || '').trim().replace(/\s+/g, ' ');
    if (!next) {
      setTitleError('Title cannot be empty');
      return;
    }
    setIsSavingTitle(true);
    setTitleError(null);
    try {
      const res = await fetch(`/api/lectures/${encodeURIComponent(lecture.id)}/title`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ title: next }),
      });
      const text = await res.text();
      let json: any = null;
      try {
        json = JSON.parse(text);
      } catch {
        // ignore
      }
      if (!res.ok || !json?.success) {
        throw new Error(json?.error || `${res.status} ${res.statusText}` || 'Failed to save title');
      }
      setLecture((prev) => (prev ? { ...prev, title: next } : prev));
      setIsEditingTitle(false);
    } catch (e: any) {
      setTitleError(String(e?.message || e));
    } finally {
      setIsSavingTitle(false);
    }
  };

  return (
    <div className="wv-container wv-detail-container">
      {!lecture && isLoading && <div className="wv-card wv-subtitle">Loading…</div>}
      {!lecture && error && <div className="wv-card wv-error">{error}</div>}

      {lecture && (
        <>
          <div className="wv-card wv-detail-top">
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
              <BookOpen size={18} color="var(--accent)" />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, justifyContent: 'space-between' }}>
                  {!isEditingTitle ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, flex: 1 }}>
                      <div
                        style={{
                          fontSize: 16,
                          fontWeight: 700,
                          minWidth: 0,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          flex: 1,
                        }}
                      >
                        {lecture.title}
                      </div>
                      <button
                        onClick={handleStartEditTitle}
                        title="Rename lecture"
                        style={{
                          flexShrink: 0,
                          background: 'transparent',
                          border: '1px solid var(--border)',
                          borderRadius: 10,
                          padding: 8,
                          color: 'var(--muted)',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}
                      >
                        <Pencil size={14} />
                      </button>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flex: 1 }}>
                      <input
                        value={draftTitle}
                        onChange={(e) => setDraftTitle(e.target.value)}
                        placeholder="Lecture title"
                        style={{
                          flex: 1,
                          minWidth: 0,
                          padding: '10px 12px',
                          borderRadius: 12,
                          border: '1px solid var(--border)',
                          background: 'var(--panel-2)',
                          color: 'var(--text)',
                          fontSize: 14,
                          outline: 'none',
                        }}
                      />
                      <button
                        onClick={handleSaveTitle}
                        disabled={isSavingTitle}
                        title="Save"
                        style={{
                          flexShrink: 0,
                          background: 'var(--accent)',
                          border: '1px solid var(--accent)',
                          borderRadius: 12,
                          padding: 10,
                          color: 'white',
                          opacity: isSavingTitle ? 0.6 : 1,
                          cursor: isSavingTitle ? 'not-allowed' : 'pointer',
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
                          flexShrink: 0,
                          background: 'transparent',
                          border: '1px solid var(--border)',
                          borderRadius: 12,
                          padding: 10,
                          color: 'var(--muted)',
                          opacity: isSavingTitle ? 0.6 : 1,
                          cursor: isSavingTitle ? 'not-allowed' : 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}
                      >
                        <X size={14} />
                      </button>
                    </div>
                  )}
                  {(isLoading || error) && (
                    <div
                      className={error ? 'wv-badge-danger' : 'wv-badge-muted'}
                      style={{ fontSize: 12, whiteSpace: 'nowrap', flexShrink: 0 }}
                    >
                      {error ? 'Error' : 'Loading…'}
                    </div>
                  )}
                </div>
                {titleError && <div className="wv-error">{titleError}</div>}
                <div className="wv-meta">
                  <span className="wv-meta-item">
                    <Calendar size={14} color="var(--muted)" />
                    {lecture.date} | {lecture.time}
                  </span>
                  <span className="wv-meta-item">
                    <Clock size={14} color="var(--muted)" />
                    {lecture.duration}
                  </span>
                </div>
              </div>
            </div>

            {error && <div className="wv-error">{error}</div>}

            {lecture.hasVideo ? (
              <div className="wv-video-wrap">
                <video
                  key={videoSrcToken}
                  ref={videoRef}
                  className="wv-video"
                  controls
                  playsInline
                  preload="metadata"
                  src={`/api/lectures/${encodeURIComponent(lecture.id)}/video?v=${videoSrcToken}`}
                  onError={async () => {
                    setVideoError(safariLikeRef.current ? 'MP4 required for this device' : 'Playback failed');
                    // If MP4 isn't available yet, show prompt/progress for on-demand conversion.
                    if (!lecture.hasMp4) {
                      await fetchTranscodeStatus();
                    }
                  }}
                  onCanPlay={() => setVideoError(null)}
                />

                {(!lecture.hasMp4 && (videoError || safariLikeRef.current)) && (
                  <div className="wv-video-overlay">
                    <div className="wv-video-overlay-card">
                      <div className="wv-video-overlay-title">
                        {safariLikeRef.current ? 'MP4 required for playback on this device' : 'This device can’t play this video'}
                      </div>
                      <div className="wv-video-overlay-sub">
                        Generate an MP4 copy (Safari-compatible). The original WebM will be kept.
                      </div>

                      {(transcodeJob?.state === 'queued' || transcodeJob?.state === 'running') && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                          <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                            {transcodeJob.phase} {Number.isFinite(transcodeJob.percent) ? `(${transcodeJob.percent}%)` : ''}
                          </div>
                          <div className="wv-progress">
                            <div className="wv-progress-bar" style={{ width: `${Math.max(0, Math.min(100, transcodeJob.percent || 0))}%` }} />
                          </div>
                        </div>
                      )}

                      {transcodeJob?.state === 'error' && transcodeJob?.error && (
                        <div className="wv-error" style={{ marginTop: 8 }}>
                          {transcodeJob.error}
                        </div>
                      )}

                      <div className="wv-video-overlay-actions">
                        {(transcodeJob?.state === 'queued' || transcodeJob?.state === 'running') ? (
                          <button className="wv-btn wv-btn-secondary" onClick={handleCancelTranscode}>
                            Cancel
                          </button>
                        ) : (
                          <button className="wv-btn wv-btn-secondary" onClick={() => setVideoSrcToken(Date.now())}>
                            Retry
                          </button>
                        )}

                        <button
                          className="wv-btn wv-btn-primary"
                          onClick={handleStartTranscode}
                          disabled={isStartingTranscode || transcodeJob?.state === 'queued' || transcodeJob?.state === 'running'}
                        >
                          {isStartingTranscode
                            ? 'Starting…'
                            : (transcodeJob?.state === 'queued' || transcodeJob?.state === 'running')
                              ? 'Generating…'
                              : 'Generate MP4'}
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="wv-empty">No video available for this recording.</div>
            )}
          </div>

          <div className="wv-card wv-detail-bottom">
            <div className="wv-tabs">
              <button className={`wv-tab ${tab === 'transcript' ? 'wv-tab-active' : ''}`} onClick={() => setTab('transcript')}>
                <FileText size={14} color={tab === 'transcript' ? 'var(--accent)' : 'var(--muted)'} />
                Transcript ({lecture.transcripts.length})
              </button>
              <button className={`wv-tab ${tab === 'topics' ? 'wv-tab-active' : ''}`} onClick={() => setTab('topics')}>
                <BarChart3 size={14} color={tab === 'topics' ? 'var(--accent)' : 'var(--muted)'} />
                3-Min Topics ({topicSummaries.length})
              </button>
              <button className={`wv-tab ${tab === 'short' ? 'wv-tab-active' : ''}`} onClick={() => setTab('short')}>
                <Film size={14} color={tab === 'short' ? 'var(--accent)' : 'var(--muted)'} />
                Short ({shortSummaries.length})
              </button>
            </div>

            <div className="wv-detail-scroll">
              {tab === 'transcript' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {lecture.transcripts.length === 0 ? (
                    <div className="wv-empty">No transcripts available</div>
                  ) : (
                    lecture.transcripts.map((t, idx) => {
                      const ms = typeof t.timestampMs === 'number' ? t.timestampMs : parseTimestampToMs(t.timestamp);
                      return (
                        <div
                          key={idx}
                          className="wv-block wv-card-pressable"
                          onClick={() => handleSeek(ms)}
                          onMouseEnter={(e) => {
                            (e.currentTarget as HTMLDivElement).style.borderColor = 'var(--accent)';
                          }}
                          onMouseLeave={(e) => {
                            (e.currentTarget as HTMLDivElement).style.borderColor = 'var(--border)';
                          }}
                        >
                          <div className="wv-block-title">{t.timestamp}</div>
                          <div style={{ fontSize: 13, color: '#cccccc', lineHeight: 1.6 }}>{t.text}</div>
                        </div>
                      );
                    })
                  )}
                </div>
              )}

              {tab !== 'transcript' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {(tab === 'topics' ? topicSummaries : shortSummaries).length === 0 ? (
                    <div className="wv-empty">No summaries available</div>
                  ) : (
                    (tab === 'topics' ? topicSummaries : shortSummaries).map((s, idx) => (
                      <div key={idx} className="wv-block">
                        <div className="wv-block-title">{s.windowLabel}</div>
                        <MarkdownBlock content={s.text} />
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
};

const WebViewerApp: React.FC = () => {
  const route = useRoute();

  if (route.page === 'detail' && route.id) {
    return (
      <LectureDetailPage
        lectureId={route.id}
        onBack={() => {
          window.location.hash = '#/';
        }}
      />
    );
  }

  return (
    <LectureListPage
      onOpen={(id) => {
        window.location.hash = `#/lecture/${encodeURIComponent(id)}`;
      }}
    />
  );
};

export default WebViewerApp;
