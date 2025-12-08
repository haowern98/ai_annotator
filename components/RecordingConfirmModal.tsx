import React, { useState, useEffect } from 'react';
import { Monitor, Settings, Lightbulb, Check, X } from 'lucide-react';

export type RecordingQuality = 'high' | 'medium' | 'low';

interface RecordingConfirmModalProps {
  isOpen: boolean;
  onConfirm: (quality: RecordingQuality) => void;
  onStartWithoutRecording: () => void;
  onCancel: () => void;
}

const qualityOptions = [
  { value: 'high' as RecordingQuality, label: 'High Quality (Original)', description: 'Full resolution capture' },
  { value: 'medium' as RecordingQuality, label: 'Medium Quality (1280px)', description: 'Recommended', recommended: true },
  { value: 'low' as RecordingQuality, label: 'Low Quality (480px)', description: 'Lower bandwidth' }
];

export function RecordingConfirmModal({ isOpen, onConfirm, onStartWithoutRecording, onCancel }: RecordingConfirmModalProps) {
  const [selectedQuality, setSelectedQuality] = useState<RecordingQuality>('medium');
  const [hoveredQuality, setHoveredQuality] = useState<RecordingQuality | null>(null);
  const [hoveredButton, setHoveredButton] = useState<'cancel' | 'noRecording' | 'confirm' | null>(null);

  // Reset to default when modal opens
  useEffect(() => {
    if (isOpen) {
      setSelectedQuality('medium');
    }
  }, [isOpen]);

  // Keyboard handlers
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onCancel();
      } else if (e.key === 'Enter') {
        onConfirm(selectedQuality);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, selectedQuality, onConfirm, onCancel]);

  // Close on backdrop click
  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onCancel();
    }
  };

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
          <Monitor size={24} color="#0E72ED" />
          <span style={{ fontSize: '18px', fontWeight: 600, color: '#ffffff' }}>
            Start Recording Session?
          </span>
        </div>

        {/* Description */}
        <div style={{ padding: '16px 20px' }}>
          <p style={{ fontSize: '14px', color: '#8a8a8a', lineHeight: '1.6', margin: 0 }}>
            Your screen will be captured and analyzed for lecture summarization.
          </p>
        </div>

        {/* Quality Selector */}
        <div style={{ padding: '0 20px 16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px' }}>
            <Settings size={18} color="#8a8a8a" />
            <span style={{ fontSize: '14px', color: '#cccccc', fontWeight: 500 }}>
              Recording Quality
            </span>
          </div>

          {/* Quality Options */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {qualityOptions.map((option) => {
              const isSelected = selectedQuality === option.value;
              const isHovered = hoveredQuality === option.value;

              return (
                <button
                  key={option.value}
                  onClick={() => setSelectedQuality(option.value)}
                  onMouseEnter={() => setHoveredQuality(option.value)}
                  onMouseLeave={() => setHoveredQuality(null)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '12px',
                    backgroundColor: isSelected 
                      ? 'rgba(14, 114, 237, 0.15)' 
                      : isHovered 
                        ? '#2a2a2a' 
                        : '#1a1a1a',
                    border: isSelected ? '1px solid #0E72ED' : '1px solid #333333',
                    borderRadius: '6px',
                    cursor: 'pointer',
                    transition: 'all 0.15s ease',
                    textAlign: 'left'
                  }}
                >
                  <div style={{ flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span style={{ 
                        fontSize: '13px', 
                        color: isSelected ? '#ffffff' : isHovered ? '#ffffff' : '#cccccc',
                        fontWeight: 500
                      }}>
                        {option.label}
                      </span>
                      {option.recommended && (
                        <span style={{
                          fontSize: '11px',
                          color: '#0E72ED',
                          backgroundColor: 'rgba(14, 114, 237, 0.2)',
                          padding: '2px 6px',
                          borderRadius: '4px',
                          fontWeight: 500
                        }}>
                          ★
                        </span>
                      )}
                    </div>
                    <div style={{ 
                      fontSize: '12px', 
                      color: '#666666', 
                      marginTop: '2px' 
                    }}>
                      {option.description}
                    </div>
                  </div>
                  {isSelected && (
                    <Check size={18} color="#0E72ED" />
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* Recommendation Hint */}
        <div style={{ padding: '0 20px 16px' }}>
          <div style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: '10px',
            padding: '10px 12px',
            backgroundColor: 'rgba(245, 158, 11, 0.1)',
            border: '1px solid rgba(245, 158, 11, 0.3)',
            borderRadius: '6px'
          }}>
            <Lightbulb size={16} color="#F59E0B" style={{ flexShrink: 0, marginTop: '2px' }} />
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: '12px', color: '#F59E0B', fontWeight: 500 }}>
                Recommended: Medium Quality
              </div>
              <div style={{ fontSize: '11px', color: '#8a8a8a', marginTop: '2px' }}>
                Balances performance and accuracy
              </div>
            </div>
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
            onClick={onStartWithoutRecording}
            onMouseEnter={() => setHoveredButton('noRecording')}
            onMouseLeave={() => setHoveredButton(null)}
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '6px',
              padding: '10px 20px',
              backgroundColor: hoveredButton === 'noRecording' ? '#2a2a2a' : 'transparent',
              border: '1px solid #444444',
              borderRadius: '6px',
              color: hoveredButton === 'noRecording' ? '#ffffff' : '#8a8a8a',
              fontSize: '13px',
              fontWeight: 500,
              cursor: 'pointer',
              transition: 'all 0.15s ease'
            }}
          >
            Start with No Recording
          </button>

          <button
            onClick={() => onConfirm(selectedQuality)}
            onMouseEnter={() => setHoveredButton('confirm')}
            onMouseLeave={() => setHoveredButton(null)}
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '6px',
              padding: '10px 20px',
              backgroundColor: hoveredButton === 'confirm' ? '#0d62cc' : '#0E72ED',
              border: 'none',
              borderRadius: '6px',
              color: '#ffffff',
              fontSize: '13px',
              fontWeight: 500,
              cursor: 'pointer',
              transition: 'all 0.15s ease'
            }}
          >
            <Check size={16} />
            Start Recording
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
