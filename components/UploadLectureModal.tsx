import React, { useState, useEffect } from 'react';
import { VideoIcon, FileVideoIcon } from './icons';
import { Check, X, Upload } from 'lucide-react';

type SelectedVideoFile = { path: string; name: string; size: number };

interface UploadLectureModalProps {
  isOpen: boolean;
  onUpload: (source: { type: 'youtube'; value: string } | { type: 'file'; value: SelectedVideoFile }) => void;
  onCancel: () => void;
}

export function UploadLectureModal({ isOpen, onUpload, onCancel }: UploadLectureModalProps) {
  const [youtubeUrl, setYoutubeUrl] = useState('');
  const [selectedFile, setSelectedFile] = useState<SelectedVideoFile | null>(null);
  const [selectedSource, setSelectedSource] = useState<'youtube' | 'file' | null>(null);
  const [hoveredSource, setHoveredSource] = useState<'youtube' | 'file' | null>(null);
  const [hoveredButton, setHoveredButton] = useState<'cancel' | 'upload' | null>(null);

  // Reset when modal opens
  useEffect(() => {
    if (isOpen) {
      setYoutubeUrl('');
      setSelectedFile(null);
      setSelectedSource(null);
    }
  }, [isOpen]);

  // Keyboard handlers
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onCancel();
      } else if (e.key === 'Enter' && canUpload) {
        handleUpload();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, youtubeUrl, selectedFile]);

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onCancel();
    }
  };

  const handlePickFile = async () => {
    const api = (window as any).electronAPI;
    if (!api?.pickVideoFile) {
      console.error('electronAPI.pickVideoFile not available');
      return;
    }

    const res = await api.pickVideoFile();
    if (!res?.success || res?.canceled) return;
    if (!res?.path) return;

    setSelectedFile({
      path: String(res.path),
      name: String(res.name || 'video'),
      size: Number(res.size || 0),
    });
    setSelectedSource('file');
    setYoutubeUrl('');
  };

  const handleYoutubeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const url = e.target.value;
    setYoutubeUrl(url);
    if (url.trim()) {
      setSelectedSource('youtube');
      setSelectedFile(null);
    } else {
      setSelectedSource(null);
    }
  };

  const handleUpload = () => {
    if (youtubeUrl.trim()) {
      onUpload({ type: 'youtube', value: youtubeUrl.trim() });
    } else if (selectedFile) {
      onUpload({ type: 'file', value: selectedFile });
    }
  };

  const canUpload = youtubeUrl.trim().length > 0 || selectedFile !== null;

  if (!isOpen) return null;

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
        zIndex: 9999
      }}
      onClick={handleBackdropClick}
    >
      <div
        style={{
          width: '480px',
          backgroundColor: '#242424',
          border: '1px solid #333333',
          borderRadius: '12px',
          overflow: 'hidden',
          animation: 'slideIn 0.2s ease-out'
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
            gap: '12px'
          }}
        >
          <Upload size={24} color="#0E72ED" />
          <span style={{ fontSize: '18px', fontWeight: 600, color: '#ffffff' }}>
            Upload Lecture
          </span>
        </div>

        {/* Description */}
        <div style={{ padding: '16px 20px' }}>
          <p style={{ fontSize: '14px', color: '#8a8a8a', lineHeight: '1.6', margin: 0 }}>
            Choose your lecture source
          </p>
        </div>

        {/* Source Options */}
        <div style={{ padding: '0 20px 16px' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {/* YouTube Option */}
            <button
              onClick={() => {
                setSelectedSource('youtube');
                setSelectedFile(null);
              }}
              onMouseEnter={() => setHoveredSource('youtube')}
              onMouseLeave={() => setHoveredSource(null)}
              style={{
                display: 'flex',
                flexDirection: 'column',
                padding: '12px',
                backgroundColor: selectedSource === 'youtube'
                  ? 'rgba(14, 114, 237, 0.15)'
                  : hoveredSource === 'youtube'
                    ? '#2a2a2a'
                    : '#1a1a1a',
                border: selectedSource === 'youtube' ? '1px solid #0E72ED' : '1px solid #333333',
                borderRadius: '6px',
                cursor: 'pointer',
                transition: 'all 0.15s ease',
                textAlign: 'left'
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <VideoIcon 
                    style={{ width: '18px', height: '18px' }} 
                    color="#8a8a8a"
                  />
                  <span style={{
                    fontSize: '13px',
                    color: selectedSource === 'youtube' ? '#ffffff' : hoveredSource === 'youtube' ? '#ffffff' : '#cccccc',
                    fontWeight: 500
                  }}>
                    YouTube Video
                  </span>
                </div>
                {selectedSource === 'youtube' && <Check size={18} color="#0E72ED" />}
              </div>
              <input
                type="text"
                placeholder="Enter YouTube URL..."
                value={youtubeUrl}
                onChange={handleYoutubeChange}
                onClick={(e) => e.stopPropagation()}
                style={{
                  width: '100%',
                  padding: '8px 12px',
                  backgroundColor: '#1a1a1a',
                  color: '#ffffff',
                  border: '1px solid #333333',
                  borderRadius: '4px',
                  fontSize: '12px',
                  outline: 'none',
                  transition: 'border-color 0.15s ease'
                }}
                onFocus={(e) => {
                  e.target.style.borderColor = '#0E72ED';
                }}
                onBlur={(e) => {
                  e.target.style.borderColor = '#333333';
                }}
              />
            </button>

            {/* File Option */}
            <button
              onClick={handlePickFile}
              onMouseEnter={() => setHoveredSource('file')}
              onMouseLeave={() => setHoveredSource(null)}
              style={{
                display: 'flex',
                flexDirection: 'column',
                padding: '12px',
                backgroundColor: selectedSource === 'file'
                  ? 'rgba(14, 114, 237, 0.15)'
                  : hoveredSource === 'file'
                    ? '#2a2a2a'
                    : '#1a1a1a',
                border: selectedSource === 'file' ? '1px solid #0E72ED' : '1px solid #333333',
                borderRadius: '6px',
                cursor: 'pointer',
                transition: 'all 0.15s ease',
                textAlign: 'left'
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <FileVideoIcon 
                    style={{ width: '18px', height: '18px' }} 
                    color="#8a8a8a"
                  />
                  <span style={{
                    fontSize: '13px',
                    color: selectedSource === 'file' ? '#ffffff' : hoveredSource === 'file' ? '#ffffff' : '#cccccc',
                    fontWeight: 500
                  }}>
                    Video File
                  </span>
                </div>
                {selectedSource === 'file' && <Check size={18} color="#0E72ED" />}
              </div>
              <div style={{
                padding: '8px 12px',
                backgroundColor: '#1a1a1a',
                border: '1px solid #333333',
                borderRadius: '4px',
                fontSize: '12px',
                color: selectedFile ? '#ffffff' : '#666666',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center'
              }}>
                <span>{selectedFile ? selectedFile.name : 'Click to browse'}</span>
                {!selectedFile && <span style={{ fontSize: '11px', color: '#666666' }}>No file selected</span>}
              </div>
              <div style={{ fontSize: '11px', color: '#666666', marginTop: '4px' }}>
                Supported: MP4, WebM, MKV
              </div>
            </button>
          </div>
        </div>

        {/* Action Buttons */}
        <div
          style={{
            padding: '16px 20px',
            borderTop: '1px solid #333333',
            display: 'flex',
            gap: '12px'
          }}
        >
          <button
            onClick={onCancel}
            onMouseEnter={() => setHoveredButton('cancel')}
            onMouseLeave={() => setHoveredButton(null)}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '6px',
              padding: '10px 20px',
              backgroundColor: hoveredButton === 'cancel' ? '#2a2a2a' : 'transparent',
              border: '1px solid #444444',
              borderRadius: '6px',
              color: hoveredButton === 'cancel' ? '#ffffff' : '#8a8a8a',
              fontSize: '13px',
              fontWeight: 500,
              cursor: 'pointer',
              transition: 'all 0.15s ease'
            }}
          >
            <X size={16} />
            Cancel
          </button>

          <button
            onClick={handleUpload}
            disabled={!canUpload}
            onMouseEnter={() => setHoveredButton('upload')}
            onMouseLeave={() => setHoveredButton(null)}
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '6px',
              padding: '10px 20px',
              backgroundColor: !canUpload 
                ? '#2a2a2a' 
                : hoveredButton === 'upload' 
                  ? '#0d62cc' 
                  : '#0E72ED',
              border: 'none',
              borderRadius: '6px',
              color: !canUpload ? '#666666' : '#ffffff',
              fontSize: '13px',
              fontWeight: 500,
              cursor: !canUpload ? 'not-allowed' : 'pointer',
              transition: 'all 0.15s ease',
              opacity: !canUpload ? 0.5 : 1
            }}
          >
            <Check size={16} />
            Upload
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
      `}</style>
    </div>
  );
}
