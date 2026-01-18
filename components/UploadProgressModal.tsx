/**
 * Upload Progress Modal
 * Shows queue and progress for batch-uploaded lecture videos
 * Matches RecordingConfirmModal styling
 */

import React from 'react';
import { Upload, X, Check, AlertCircle, Loader } from 'lucide-react';
import { QueuedVideo, VideoStatus } from '../services/uploadQueueManager';

interface UploadProgressModalProps {
  isOpen: boolean;
  queue: QueuedVideo[];
  onClose: () => void;
  onCancel: (videoId: string) => void;
  onClearCompleted: () => void;
}

export function UploadProgressModal({
  isOpen,
  queue,
  onClose,
  onCancel,
  onClearCompleted,
}: UploadProgressModalProps) {
  const [hoveredButton, setHoveredButton] = React.useState<string | null>(null);

  if (!isOpen) return null;

  const stats = {
    total: queue.length,
    pending: queue.filter((v) => v.status === 'pending').length,
    processing: queue.filter((v) =>
      v.status === 'downloading' ||
      v.status === 'extracting' ||
      v.status === 'transcribing' ||
      v.status === 'analyzing' ||
      v.status === 'saving'
    ).length,
    complete: queue.filter((v) => v.status === 'complete').length,
    error: queue.filter((v) => v.status === 'error').length,
  };

  const getStatusIcon = (status: VideoStatus) => {
    switch (status) {
      case 'complete':
        return <Check size={18} color="#4ade80" />;
      case 'error':
        return <AlertCircle size={18} color="#ef4444" />;
      case 'cancelled':
        return <X size={18} color="#8a8a8a" />;
      case 'downloading':
      case 'extracting':
      case 'transcribing':
      case 'analyzing':
      case 'saving':
        return <Loader size={18} color="#0E72ED" className="animate-spin" />;
      default:
        return <div style={{ width: '18px', height: '18px' }} />;
    }
  };

  const getStatusColor = (status: VideoStatus): string => {
    switch (status) {
      case 'complete':
        return '#4ade80';
      case 'error':
        return '#ef4444';
      case 'cancelled':
        return '#8a8a8a';
      case 'downloading':
      case 'extracting':
      case 'transcribing':
      case 'analyzing':
      case 'saving':
        return '#0E72ED';
      default:
        return '#666666';
    }
  };

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.75)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 9999,
      }}
      onClick={handleBackdropClick}
    >
      <div
        style={{
          width: '600px',
          maxHeight: '80vh',
          backgroundColor: '#242424',
          border: '1px solid #333333',
          borderRadius: '12px',
          overflow: 'hidden',
          animation: 'slideIn 0.2s ease-out',
          display: 'flex',
          flexDirection: 'column',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          style={{
            padding: '20px',
            borderBottom: '1px solid #333333',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <Upload size={24} color="#0E72ED" />
            <span style={{ fontSize: '18px', fontWeight: 600, color: '#ffffff' }}>
              Upload Queue
            </span>
          </div>
          <div style={{ fontSize: '13px', color: '#8a8a8a' }}>
            {stats.processing > 0 ? `Processing ${stats.processing}` : `${stats.complete} / ${stats.total} complete`}
          </div>
        </div>

        {/* Queue List */}
        <div
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: '16px 20px',
          }}
        >
          {queue.length === 0 ? (
            <div
              style={{
                padding: '40px 20px',
                textAlign: 'center',
                color: '#666666',
                fontSize: '14px',
              }}
            >
              No videos in queue
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {queue.map((video) => (
                <div
                  key={video.id}
                  style={{
                    padding: '12px',
                    backgroundColor: '#1a1a1a',
                    border: `1px solid ${video.status === 'error' ? '#ef4444' : '#333333'}`,
                    borderRadius: '8px',
                  }}
                >
                  {/* Video Info Row */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '8px' }}>
                    {getStatusIcon(video.status)}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div
                        style={{
                          fontSize: '13px',
                          color: '#ffffff',
                          fontWeight: 500,
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                        }}
                      >
                        {video.fileName}
                      </div>
                      <div style={{ fontSize: '11px', color: '#8a8a8a', marginTop: '2px' }}>
                        {(video.fileSize / 1024 / 1024).toFixed(2)} MB · {video.progress.phase}
                      </div>
                    </div>
                    {(video.status === 'pending' ||
                      video.status === 'downloading' ||
                      video.status === 'extracting' ||
                      video.status === 'transcribing' ||
                      video.status === 'analyzing' ||
                      video.status === 'saving') && (
                      <button
                        onClick={() => onCancel(video.id)}
                        style={{
                          padding: '4px 8px',
                          backgroundColor: 'transparent',
                          border: '1px solid #444444',
                          borderRadius: '4px',
                          color: '#8a8a8a',
                          fontSize: '11px',
                          cursor: 'pointer',
                          transition: 'all 0.15s ease',
                        }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.backgroundColor = '#2a2a2a';
                          e.currentTarget.style.color = '#ffffff';
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.backgroundColor = 'transparent';
                          e.currentTarget.style.color = '#8a8a8a';
                        }}
                      >
                        Cancel
                      </button>
                    )}
                  </div>

                  {/* Progress Bar */}
                  {(video.status === 'downloading' ||
                    video.status === 'extracting' ||
                    video.status === 'transcribing' ||
                    video.status === 'analyzing' ||
                    video.status === 'saving') && (
                    <div
                      style={{
                        height: '4px',
                        backgroundColor: '#2a2a2a',
                        borderRadius: '2px',
                        overflow: 'hidden',
                      }}
                    >
                      <div
                        style={{
                          height: '100%',
                          width: `${video.progress.percentage}%`,
                          backgroundColor: '#0E72ED',
                          transition: 'width 0.3s ease',
                        }}
                      />
                    </div>
                  )}

                  {/* Error Message */}
                  {video.status === 'error' && video.error && (
                    <div
                      style={{
                        marginTop: '8px',
                        padding: '8px',
                        backgroundColor: 'rgba(239, 68, 68, 0.1)',
                        border: '1px solid rgba(239, 68, 68, 0.3)',
                        borderRadius: '4px',
                        fontSize: '11px',
                        color: '#ef4444',
                      }}
                    >
                      {video.error}
                    </div>
                  )}

                  {/* Completion Time */}
                  {video.status === 'complete' && video.startTime && video.endTime && (
                    <div style={{ marginTop: '4px', fontSize: '11px', color: '#4ade80' }}>
                      Completed in {Math.floor((video.endTime - video.startTime) / 1000)}s
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Action Buttons */}
        <div
          style={{
            padding: '16px 20px',
            borderTop: '1px solid #333333',
            display: 'flex',
            gap: '12px',
            justifyContent: 'space-between',
          }}
        >
          <button
            onClick={onClearCompleted}
            disabled={stats.complete === 0 && stats.error === 0}
            onMouseEnter={() => setHoveredButton('clear')}
            onMouseLeave={() => setHoveredButton(null)}
            style={{
              padding: '10px 20px',
              backgroundColor: hoveredButton === 'clear' ? '#2a2a2a' : 'transparent',
              border: '1px solid #444444',
              borderRadius: '6px',
              color: hoveredButton === 'clear' ? '#ffffff' : '#8a8a8a',
              fontSize: '13px',
              fontWeight: 500,
              cursor: stats.complete === 0 && stats.error === 0 ? 'not-allowed' : 'pointer',
              transition: 'all 0.15s ease',
              opacity: stats.complete === 0 && stats.error === 0 ? 0.5 : 1,
            }}
          >
            Clear Completed
          </button>

          <button
            onClick={onClose}
            onMouseEnter={() => setHoveredButton('close')}
            onMouseLeave={() => setHoveredButton(null)}
            style={{
              padding: '10px 20px',
              backgroundColor: hoveredButton === 'close' ? '#0d62cc' : '#0E72ED',
              border: 'none',
              borderRadius: '6px',
              color: '#ffffff',
              fontSize: '13px',
              fontWeight: 500,
              cursor: 'pointer',
              transition: 'all 0.15s ease',
            }}
          >
            Close
          </button>
        </div>
      </div>

      <style>{`
        @keyframes slideIn {
          from {
            opacity: 0;
            transform: translateY(-10px) scale(0.98);
          }
          to {
            opacity: 1;
            transform: translateY(0) scale(1);
          }
        }
        .animate-spin {
          animation: spin 1s linear infinite;
        }
        @keyframes spin {
          from {
            transform: rotate(0deg);
          }
          to {
            transform: rotate(360deg);
          }
        }
      `}</style>
    </div>
  );
}
