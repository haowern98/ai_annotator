import React, { useState, useEffect } from 'react';
import { Search, ChevronDown, ChevronUp, ExternalLink, Trash2, BookOpen, Calendar, Clock, FileText, BarChart3 } from 'lucide-react';
import { NavigationView } from '../types';
import LectureDetails from './LectureDetails.tsx';

interface Lecture {
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
  filePath: string;
  videoPath: string;
  lastModified: string;
}

interface RecordingMetadata {
  quality: string | null;
  duration: number;
  transcriptCount: number;
  summaryCount: number;
  transcripts: any[];
  summaries: any[];
  videoFilename: string;
  videoPath: string;
  savedAt: string;
  fileSize: number;
}

interface HistoryHomeProps {
  currentView?: NavigationView;
  onNavigate?: (view: NavigationView) => void;
}

const HistoryHome: React.FC<HistoryHomeProps> = ({ currentView, onNavigate }) => {
  const [activeTab, setActiveTab] = useState<'lectures' | 'interviews'>('lectures');
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [lectures, setLectures] = useState<Lecture[]>([]);
  const [selectedLectureId, setSelectedLectureId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Load recordings from IPC
  useEffect(() => {
    const loadRecordings = async () => {
      try {
        const electronAPI = (window as any).electronAPI;
        if (!electronAPI?.listRecordings) {
          console.error('electronAPI.listRecordings not available');
          setIsLoading(false);
          return;
        }

        const result = await electronAPI.listRecordings();
        if (result.success && result.recordings) {
          const formattedLectures: Lecture[] = result.recordings.map((rec: RecordingMetadata, index: number) => {
            const rawVideoFilename =
              rec.videoFilename ||
              (typeof rec.videoPath === 'string' && rec.videoPath
                ? rec.videoPath.split(/[\\/]/).pop() || ''
                : '') ||
              '';

            // Extract filename without extension - support both .mp4 and .webm
            const videoExtension = rawVideoFilename.match(/\.(webm|mp4)$/)?.[0] || '.webm';
            let filename = rawVideoFilename ? rawVideoFilename.replace(/\.(webm|mp4)$/, '') : '';

            // If the filename isn't in the expected lecture_YYYYMMDD_HHMMSS format, fall back to savedAt.
            if ((!filename || filename.split('_')[1]?.length !== 8) && rec.savedAt) {
              const d = new Date(rec.savedAt);
              if (!Number.isNaN(d.getTime())) {
                const yyyy = String(d.getFullYear());
                const mm = String(d.getMonth() + 1).padStart(2, '0');
                const dd = String(d.getDate()).padStart(2, '0');
                const hh = String(d.getHours()).padStart(2, '0');
                const mi = String(d.getMinutes()).padStart(2, '0');
                const ss = String(d.getSeconds()).padStart(2, '0');
                filename = filename || `lecture_${yyyy}${mm}${dd}_${hh}${mi}${ss}`;
              }
            }

            if (!filename) {
              filename = `lecture_unknown_${index}`;
            }

            const titleParts = filename.split('_');
            const dateStr = titleParts[1] || '';
            const timeStr = titleParts[2] || '';

            // Format date: YYYYMMDD -> Mon DD, YYYY
            let formattedDate = 'Unknown Date';
            let formattedTime = 'Unknown Time';
            if (dateStr.length === 8) {
              const year = dateStr.substring(0, 4);
              const month = dateStr.substring(4, 6);
              const day = dateStr.substring(6, 8);
              const date = new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
              formattedDate = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
            }

            // Format time: HHMMSS -> HH:MM AM/PM
            if (timeStr.length === 6) {
              const hours = parseInt(timeStr.substring(0, 2));
              const minutes = timeStr.substring(2, 4);
              const ampm = hours >= 12 ? 'PM' : 'AM';
              const displayHours = hours % 12 || 12;
              formattedTime = `${displayHours}:${minutes} ${ampm}`;
            }

            // Format duration: milliseconds -> Xh Ym or Xm Ys
            let formattedDuration = '0s';
            if (rec.duration) {
              const totalSeconds = Math.floor(rec.duration / 1000);
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

            // Format file size: bytes -> MB
            const fileSizeMB = rec.fileSize ? (rec.fileSize / 1024 / 1024).toFixed(2) : '0';

            // Format quality display
            let qualityDisplay = 'N/A';
            if (rec.quality) {
              if (rec.quality === 'low') qualityDisplay = '480p';
              else if (rec.quality === 'medium') qualityDisplay = '1280p';
              else if (rec.quality === 'high') qualityDisplay = 'Original';
              else qualityDisplay = rec.quality;
            }

            // Format last modified
            const savedDate = new Date(rec.savedAt);
            const lastModified = savedDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) + 
                               ' | ' + savedDate.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });

            return {
              id: filename,
              title: `Lecture ${formattedDate}`,
              date: formattedDate,
              time: formattedTime,
              duration: formattedDuration,
              transcriptCount: rec.transcriptCount || 0,
              summaryCount: rec.summaryCount || 0,
              recordingEnabled: rec.videoPath && rec.fileSize > 0, // Recording exists if we have video file
              quality: qualityDisplay,
              fileSize: `${fileSizeMB} MB`,
              filePath: (rec.videoPath || '').replace(/\\\\/g, '/'),
              videoPath: rec.videoPath || '',
              lastModified
            };
          });

          // Sort by date descending (newest first)
          formattedLectures.sort((a, b) => b.id.localeCompare(a.id));
          setLectures(formattedLectures);
        }
      } catch (err) {
        console.error('Failed to load recordings:', err);
      } finally {
        setIsLoading(false);
      }
    };

    loadRecordings();
  }, []);

  const filteredLectures = lectures.filter(lecture =>
    lecture.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
    lecture.date.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const toggleExpand = (id: string) => {
    setExpandedId(expandedId === id ? null : id);
  };

  const handleOpenLecture = (lectureId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setSelectedLectureId(lectureId);
    onNavigate?.('lecture-details');
  };

  const handleDelete = async (lecture: Lecture, e: React.MouseEvent) => {
    e.stopPropagation();

    // Show native Electron confirmation dialog
    const electronAPI = (window as any).electronAPI;
    if (!electronAPI?.showMessageBox) {
      console.error('electronAPI.showMessageBox not available');
      return;
    }

    const result = await electronAPI.showMessageBox({
      type: 'warning',
      buttons: ['Delete', 'Cancel'],
      defaultId: 1,
      title: 'Confirm Delete',
      message: `Delete "${lecture.title}"?`,
      detail: lecture.recordingEnabled 
        ? `This will permanently delete the recording (${lecture.fileSize}) and all associated data. This action cannot be undone.`
        : 'This will permanently delete all transcripts and summaries for this lecture. This action cannot be undone.'
    });

    if (result.response !== 0) {
      return; // User clicked Cancel
    }

    // Perform deletion
    try {
      // Use the actual videoFilename from metadata for proper deletion
      const deleteResult = await electronAPI.deleteRecording(lecture.id);
      
      if (deleteResult.success) {
        // Remove from local state
        setLectures(prev => prev.filter(l => l.id !== lecture.id));
        console.log('Recording deleted successfully');
      } else {
        console.error('Failed to delete recording:', deleteResult.error);
        // Could show error toast here
      }
    } catch (err) {
      console.error('Error during deletion:', err);
    }
  };

  // Show lecture details if navigated to that view
  if (currentView === 'lecture-details') {
    return <LectureDetails lectureId={selectedLectureId || undefined} />;
  }

  return (
    <div style={{
      flex: 1,
      display: 'flex',
      overflow: 'hidden',
      backgroundColor: '#1a1a1a'
    }}>
      {/* Left Sidebar - Tabs */}
      <div style={{
        width: '160px',
        backgroundColor: '#1a1a1a',
        borderRight: '1px solid #3a3a3a',
        padding: '16px',
        display: 'flex',
        flexDirection: 'column',
        gap: '12px'
      }}>
        {/* Lectures Tab */}
        <button
          onClick={() => setActiveTab('lectures')}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            padding: '12px 14px',
            backgroundColor: activeTab === 'lectures' ? 'rgba(14, 114, 237, 0.15)' : 'transparent',
            border: activeTab === 'lectures' ? '1px solid #0E72ED' : '1px solid #333333',
            borderRadius: '8px',
            color: activeTab === 'lectures' ? '#ffffff' : '#8a8a8a',
            cursor: 'pointer',
            fontWeight: activeTab === 'lectures' ? 500 : 400,
            fontSize: '14px',
            transition: 'all 0.2s'
          }}
          onMouseEnter={(e) => {
            if (activeTab !== 'lectures') {
              (e.currentTarget as HTMLButtonElement).style.backgroundColor = '#2a2a2a';
            }
          }}
          onMouseLeave={(e) => {
            if (activeTab !== 'lectures') {
              (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'transparent';
            }
          }}
        >
          <BookOpen size={16} color={activeTab === 'lectures' ? '#0E72ED' : '#8a8a8a'} />
          Lectures
        </button>

        {/* Interviews Tab (disabled for now) */}
        <button
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            padding: '12px 14px',
            backgroundColor: 'transparent',
            border: '1px solid #333333',
            borderRadius: '8px',
            color: '#8a8a8a',
            cursor: 'not-allowed',
            fontWeight: 400,
            fontSize: '14px',
            opacity: 0.6,
            transition: 'all 0.2s'
          }}
          disabled
          title="Interviews not yet implemented"
        >
          <FileText size={16} color="#8a8a8a" />
          Interviews
        </button>
      </div>

      {/* Main Content Area */}
      {activeTab === 'lectures' && (
        <div style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          padding: '24px',
          overflow: 'auto',
          backgroundColor: '#1a1a1a'
        }}>
          {/* Search Bar */}
          <div style={{ marginBottom: '24px' }}>
            <label style={{ display: 'flex', alignItems: 'center', marginBottom: '8px', gap: '8px', color: '#ffffff', fontSize: '14px', fontWeight: 500 }}>
              <Search size={16} color="#8a8a8a" />
              Search Lectures:
            </label>
            <input
              type="text"
              placeholder="Search by title, date..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              style={{
                width: '100%',
                padding: '12px 16px',
                backgroundColor: '#242424',
                border: '1px solid #333333',
                borderRadius: '8px',
                color: '#cccccc',
                fontSize: '14px',
                outline: 'none',
                transition: 'all 0.2s'
              }}
              onFocus={(e) => {
                (e.target as HTMLInputElement).style.borderColor = '#0E72ED';
                (e.target as HTMLInputElement).style.boxShadow = '0 0 8px rgba(14, 114, 237, 0.3)';
              }}
              onBlur={(e) => {
                (e.target as HTMLInputElement).style.borderColor = '#333333';
                (e.target as HTMLInputElement).style.boxShadow = 'none';
              }}
            />
          </div>

          {/* Lecture Count */}
          <div style={{ marginBottom: '16px', color: '#8a8a8a', fontSize: '14px', display: 'flex', alignItems: 'center', gap: '6px' }}>
            <Calendar size={16} color="#0E72ED" />
            Recent Lectures ({filteredLectures.length})
          </div>

          {/* Loading State */}
          {isLoading ? (
            <div style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '16px',
              color: '#8a8a8a'
            }}>
              <BookOpen size={48} color="#0E72ED" style={{ animation: 'pulse 1.5s ease-in-out infinite' }} />
              <div style={{ fontSize: '18px', fontWeight: 600, color: '#ffffff' }}>Loading Lectures...</div>
              <div style={{ fontSize: '14px' }}>Please wait while we fetch your recordings</div>
            </div>
          ) : filteredLectures.length === 0 ? (
            <div style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '16px',
              color: '#8a8a8a'
            }}>
              <BookOpen size={48} color="#8a8a8a" />
              <div style={{ fontSize: '18px', fontWeight: 600, color: '#ffffff' }}>
                {lectures.length === 0 ? 'No Recordings Yet' : 'No Lectures Found'}
              </div>
              <div style={{ fontSize: '14px' }}>
                {lectures.length === 0 ? 'Start your first lecture session to see recordings here' : 'Try adjusting your search criteria'}
              </div>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {filteredLectures.map((lecture) => (
                <div
                  key={lecture.id}
                  style={{
                    backgroundColor: '#242424',
                    border: '1px solid #333333',
                    borderRadius: '12px',
                    padding: '16px',
                    cursor: 'pointer',
                    transition: 'all 0.2s',
                    transform: 'scale(1)'
                  }}
                  onMouseEnter={(e) => {
                    const el = e.currentTarget as HTMLDivElement;
                    el.style.borderColor = '#0E72ED';
                    el.style.backgroundColor = '#2a2a2a';
                    el.style.boxShadow = '0 4px 12px rgba(14, 114, 237, 0.2)';
                    el.style.transform = 'scale(1.01)';
                  }}
                  onMouseLeave={(e) => {
                    const el = e.currentTarget as HTMLDivElement;
                    el.style.borderColor = '#333333';
                    el.style.backgroundColor = '#242424';
                    el.style.boxShadow = 'none';
                    el.style.transform = 'scale(1)';
                  }}
                  onClick={() => toggleExpand(lecture.id)}
                >
                  {/* Collapsed Header */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                        <BookOpen size={16} color="#0E72ED" />
                        <span style={{ fontSize: '15px', fontWeight: 600, color: '#ffffff' }}>
                          {lecture.title}
                        </span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px', fontSize: '13px', color: '#cccccc' }}>
                        <Calendar size={14} color="#8a8a8a" />
                        {lecture.date} | {lecture.time}
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: '#8a8a8a' }}>
                        <Clock size={14} color="#8a8a8a" />
                        Duration: {lecture.duration}
                        <span style={{ marginLeft: '16px' }}>
                          <FileText size={14} color="#8a8a8a" style={{ display: 'inline', marginRight: '4px' }} />
                          {lecture.transcriptCount}
                        </span>
                        <span style={{ marginLeft: '8px' }}>
                          <BarChart3 size={14} color="#8a8a8a" style={{ display: 'inline', marginRight: '4px' }} />
                          {lecture.summaryCount}
                        </span>
                        <span style={{ 
                          marginLeft: '16px', 
                          color: lecture.recordingEnabled ? '#4ade80' : '#8a8a8a',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '4px'
                        }}>
                          Recording: {lecture.recordingEnabled ? `Yes (${lecture.quality})` : 'No'}
                        </span>
                      </div>
                    </div>
                    <div style={{ color: '#8a8a8a', marginLeft: '16px' }}>
                      {expandedId === lecture.id ? <ChevronUp size={20} /> : <ChevronDown size={20} />}
                    </div>
                  </div>

                  {/* Expanded Content */}
                  {expandedId === lecture.id && (
                    <div style={{
                      marginTop: '12px',
                      paddingTop: '12px',
                      borderTop: '1px solid #333333',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '8px'
                    }}>
                      {lecture.recordingEnabled ? (
                        <>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: '#cccccc' }}>
                            Recording Quality: {lecture.quality}
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: '#cccccc' }}>
                            File Size: {lecture.fileSize}
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: '#cccccc' }}>
                            Saved to: {lecture.filePath}
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: '#cccccc' }}>
                            Last Modified: {lecture.lastModified}
                          </div>

                          {/* Action Buttons */}
                          <div style={{ display: 'flex', gap: '8px', marginTop: '12px' }}>
                            <button
                              onClick={(e) => handleOpenLecture(lecture.id, e)}
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: '6px',
                                padding: '8px 14px',
                                backgroundColor: '#0E72ED',
                                border: 'none',
                                borderRadius: '6px',
                                color: '#ffffff',
                                fontSize: '12px',
                                fontWeight: 500,
                                cursor: 'pointer',
                                transition: 'all 0.15s'
                              }}
                              onMouseEnter={(e) => (e.currentTarget as HTMLButtonElement).style.backgroundColor = '#0d62cc'}
                              onMouseLeave={(e) => (e.currentTarget as HTMLButtonElement).style.backgroundColor = '#0E72ED'}
                            >
                              <ExternalLink size={14} />
                              Open Lecture
                            </button>
                            <button
                              onClick={(e) => handleDelete(lecture, e)}
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: '6px',
                                padding: '8px 14px',
                                backgroundColor: 'rgba(239, 68, 68, 0.1)',
                                border: '1px solid #ef4444',
                                borderRadius: '6px',
                                color: '#ef4444',
                                fontSize: '12px',
                                fontWeight: 500,
                                cursor: 'pointer',
                                transition: 'all 0.15s'
                              }}
                              onMouseEnter={(e) => (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'rgba(239, 68, 68, 0.2)'}
                              onMouseLeave={(e) => (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'rgba(239, 68, 68, 0.1)'}
                            >
                              <Trash2 size={14} />
                              Delete
                            </button>
                          </div>
                        </>
                      ) : (
                        <>
                          <div style={{ fontSize: '13px', color: '#cccccc', marginBottom: '8px' }}>
                            Recording was disabled for this lecture. Transcripts and summaries have been saved.
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: '#8a8a8a' }}>
                            Last Modified: {lecture.lastModified}
                          </div>
                          {/* Delete button for non-recorded sessions */}
                          <div style={{ display: 'flex', gap: '8px', marginTop: '12px' }}>
                            <button
                              onClick={(e) => handleDelete(lecture, e)}
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: '6px',
                                padding: '8px 14px',
                                backgroundColor: 'rgba(239, 68, 68, 0.1)',
                                border: '1px solid #ef4444',
                                borderRadius: '6px',
                                color: '#ef4444',
                                fontSize: '12px',
                                fontWeight: 500,
                                cursor: 'pointer',
                                transition: 'all 0.15s'
                              }}
                              onMouseEnter={(e) => (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'rgba(239, 68, 68, 0.2)'}
                              onMouseLeave={(e) => (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'rgba(239, 68, 68, 0.1)'}
                            >
                              <Trash2 size={14} />
                              Delete
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Load More Button */}
          {filteredLectures.length > 0 && (
            <button
              style={{
                marginTop: '16px',
                padding: '12px 16px',
                backgroundColor: 'transparent',
                border: '1px dashed #333333',
                borderRadius: '8px',
                color: '#8a8a8a',
                fontSize: '14px',
                cursor: 'pointer',
                transition: 'all 0.2s',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '8px'
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLButtonElement).style.borderColor = '#0E72ED';
                (e.currentTarget as HTMLButtonElement).style.color = '#0E72ED';
                (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'rgba(14, 114, 237, 0.05)';
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLButtonElement).style.borderColor = '#333333';
                (e.currentTarget as HTMLButtonElement).style.color = '#8a8a8a';
                (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'transparent';
              }}
            >
              <BookOpen size={16} />
              Load More Lectures
            </button>
          )}
        </div>
      )}
    </div>
  );
};

export default HistoryHome;
