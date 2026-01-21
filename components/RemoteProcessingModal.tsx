import React, { useState } from 'react';
import { Server, Monitor, Wifi, Globe, Copy, Lightbulb, Check, X, Plug2 } from 'lucide-react';

type Mode = 'server' | 'client';

interface RemoteProcessingModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: () => void; // Called when client successfully connects
}

const RemoteProcessingModal: React.FC<RemoteProcessingModalProps> = ({ isOpen, onClose, onSuccess }) => {
  const [mode, setMode] = useState<Mode>('server');
  const [serverUrl, setServerUrl] = useState('');
  const [localIP, setLocalIP] = useState('192.168.1.100'); // Will be populated by IPC
  const [publicIP, setPublicIP] = useState('Loading...'); // Will be populated by API
  const [connectionStatus, setConnectionStatus] = useState<'idle' | 'testing' | 'connected' | 'error'>('idle');
  const [copiedField, setCopiedField] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleCopy = (text: string, field: string) => {
    navigator.clipboard.writeText(text);
    setCopiedField(field);
    setTimeout(() => setCopiedField(null), 2000);
  };

  const handleStartServer = () => {
    // Server mode: Start Qwen server with --host 0.0.0.0 and close modal
    // TODO: IPC call to start server
    onClose();
  };

  const handleSaveAndConnect = () => {
    // Client mode: Save config, close modal, and trigger upload modal
    // TODO: Save serverUrl to localStorage
    onClose();
    onSuccess?.(); // Opens UploadLectureModal
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
        zIndex: 1000,
        animation: 'fadeIn 0.2s ease-out'
      }}
      onClick={onClose}
    >
      <div
        style={{
          backgroundColor: '#242424',
          border: '1px solid #333333',
          borderRadius: '12px',
          width: '600px',
          maxHeight: '90vh',
          overflow: 'auto',
          animation: 'slideIn 0.3s ease-out'
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{ padding: '24px 24px 20px 24px', borderBottom: '1px solid #333333' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <Plug2 size={24} color="#0E72ED" />
            <h2 style={{ margin: 0, fontSize: '20px', fontWeight: 600, color: '#ffffff' }}>
              Remote Processing Setup
            </h2>
          </div>
          <p style={{ margin: '8px 0 0 36px', fontSize: '14px', color: '#888888' }}>
            Process videos using another computer's GPU
          </p>
        </div>

        {/* Mode Selector */}
        <div style={{ padding: '20px 24px' }}>
          <div style={{ display: 'flex', gap: '12px' }}>
            {/* Server Mode Button */}
            <button
              onClick={() => setMode('server')}
              style={{
                flex: 1,
                padding: '16px',
                backgroundColor: mode === 'server' ? 'rgba(14, 114, 237, 0.15)' : '#1a1a1a',
                border: mode === 'server' ? '1px solid #0E72ED' : '1px solid #333333',
                borderRadius: '8px',
                cursor: 'pointer',
                transition: 'all 0.2s',
                position: 'relative'
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '4px' }}>
                <Server size={20} color={mode === 'server' ? '#0E72ED' : '#888888'} />
                <span style={{ fontSize: '15px', fontWeight: 600, color: mode === 'server' ? '#ffffff' : '#aaaaaa' }}>
                  Server Mode
                </span>
                {mode === 'server' && (
                  <Check size={16} color="#0E72ED" style={{ marginLeft: 'auto' }} />
                )}
              </div>
              <div style={{ fontSize: '13px', color: '#888888', marginLeft: '30px' }}>
                This PC processes videos
              </div>
            </button>

            {/* Client Mode Button */}
            <button
              onClick={() => setMode('client')}
              style={{
                flex: 1,
                padding: '16px',
                backgroundColor: mode === 'client' ? 'rgba(14, 114, 237, 0.15)' : '#1a1a1a',
                border: mode === 'client' ? '1px solid #0E72ED' : '1px solid #333333',
                borderRadius: '8px',
                cursor: 'pointer',
                transition: 'all 0.2s',
                position: 'relative'
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '4px' }}>
                <Monitor size={20} color={mode === 'client' ? '#0E72ED' : '#888888'} />
                <span style={{ fontSize: '15px', fontWeight: 600, color: mode === 'client' ? '#ffffff' : '#aaaaaa' }}>
                  Client Mode
                </span>
                {mode === 'client' && (
                  <Check size={16} color="#0E72ED" style={{ marginLeft: 'auto' }} />
                )}
              </div>
              <div style={{ fontSize: '13px', color: '#888888', marginLeft: '30px' }}>
                Connect to another PC
              </div>
            </button>
          </div>
        </div>

        {/* Server Mode Content */}
        {mode === 'server' && (
          <>
            {/* Network Information */}
            <div style={{ padding: '0 24px 20px 24px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px' }}>
                <Wifi size={18} color="#888888" />
                <h3 style={{ margin: 0, fontSize: '15px', fontWeight: 600, color: '#ffffff' }}>
                  Network Information
                </h3>
              </div>

              {/* Local IP */}
              <div style={{ marginBottom: '16px' }}>
                <label style={{ display: 'block', fontSize: '13px', color: '#aaaaaa', marginBottom: '6px' }}>
                  Local IP Address
                </label>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <input
                    type="text"
                    value={localIP}
                    readOnly
                    style={{
                      flex: 1,
                      padding: '10px 12px',
                      backgroundColor: '#1a1a1a',
                      border: '1px solid #333333',
                      borderRadius: '6px',
                      color: '#ffffff',
                      fontSize: '14px',
                      fontFamily: 'monospace'
                    }}
                  />
                  <button
                    onClick={() => handleCopy(localIP, 'local')}
                    style={{
                      padding: '10px 16px',
                      backgroundColor: copiedField === 'local' ? '#10b981' : '#0E72ED',
                      border: 'none',
                      borderRadius: '6px',
                      color: '#ffffff',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '6px',
                      fontSize: '13px',
                      fontWeight: 500,
                      transition: 'all 0.2s'
                    }}
                  >
                    {copiedField === 'local' ? <Check size={16} /> : <Copy size={16} />}
                    {copiedField === 'local' ? 'Copied' : 'Copy'}
                  </button>
                </div>
              </div>

              {/* Public IP */}
              <div style={{ marginBottom: '16px' }}>
                <label style={{ display: 'block', fontSize: '13px', color: '#aaaaaa', marginBottom: '6px' }}>
                  Public IP Address
                </label>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <input
                    type="text"
                    value={publicIP}
                    readOnly
                    style={{
                      flex: 1,
                      padding: '10px 12px',
                      backgroundColor: '#1a1a1a',
                      border: '1px solid #333333',
                      borderRadius: '6px',
                      color: '#ffffff',
                      fontSize: '14px',
                      fontFamily: 'monospace'
                    }}
                  />
                  <button
                    onClick={() => handleCopy(publicIP, 'public')}
                    disabled={publicIP === 'Loading...'}
                    style={{
                      padding: '10px 16px',
                      backgroundColor: copiedField === 'public' ? '#10b981' : '#0E72ED',
                      border: 'none',
                      borderRadius: '6px',
                      color: '#ffffff',
                      cursor: publicIP === 'Loading...' ? 'not-allowed' : 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '6px',
                      fontSize: '13px',
                      fontWeight: 500,
                      opacity: publicIP === 'Loading...' ? 0.5 : 1,
                      transition: 'all 0.2s'
                    }}
                  >
                    {copiedField === 'public' ? <Check size={16} /> : <Copy size={16} />}
                    {copiedField === 'public' ? 'Copied' : 'Copy'}
                  </button>
                </div>
              </div>

              {/* Port Info */}
              <div>
                <label style={{ display: 'block', fontSize: '13px', color: '#aaaaaa', marginBottom: '6px' }}>
                  Port
                </label>
                <div
                  style={{
                    padding: '10px 12px',
                    backgroundColor: '#1a1a1a',
                    border: '1px solid #333333',
                    borderRadius: '6px',
                    color: '#ffffff',
                    fontSize: '14px',
                    fontFamily: 'monospace'
                  }}
                >
                  7556 (TCP)
                </div>
              </div>
            </div>

            {/* Port Forwarding Warning */}
            <div style={{ padding: '0 24px 20px 24px' }}>
              <div
                style={{
                  padding: '16px',
                  backgroundColor: 'rgba(245, 158, 11, 0.1)',
                  border: '1px solid rgba(245, 158, 11, 0.3)',
                  borderRadius: '8px'
                }}
              >
                <div style={{ display: 'flex', gap: '12px' }}>
                  <Lightbulb size={20} color="#F59E0B" style={{ flexShrink: 0, marginTop: '2px' }} />
                  <div>
                    <div style={{ fontSize: '14px', fontWeight: 600, color: '#F59E0B', marginBottom: '6px' }}>
                      Port Forwarding Required
                    </div>
                    <div style={{ fontSize: '13px', color: '#cccccc', lineHeight: '1.5' }}>
                      You must configure your router to forward TCP port 7556 to this computer's local IP ({localIP}).
                    </div>
                    <button
                      style={{
                        marginTop: '10px',
                        padding: '6px 12px',
                        backgroundColor: 'transparent',
                        border: '1px solid rgba(245, 158, 11, 0.5)',
                        borderRadius: '4px',
                        color: '#F59E0B',
                        fontSize: '12px',
                        cursor: 'pointer',
                        fontWeight: 500
                      }}
                    >
                      View Setup Guide
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </>
        )}

        {/* Client Mode Content */}
        {mode === 'client' && (
          <>
            {/* Connection Settings */}
            <div style={{ padding: '0 24px 20px 24px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px' }}>
                <Globe size={18} color="#888888" />
                <h3 style={{ margin: 0, fontSize: '15px', fontWeight: 600, color: '#ffffff' }}>
                  Connection Settings
                </h3>
              </div>

              {/* Server URL Input */}
              <div style={{ marginBottom: '16px' }}>
                <label style={{ display: 'block', fontSize: '13px', color: '#aaaaaa', marginBottom: '6px' }}>
                  Server URL
                </label>
                <input
                  type="text"
                  value={serverUrl}
                  onChange={(e) => setServerUrl(e.target.value)}
                  placeholder="http://203.0.113.45:7556"
                  style={{
                    width: '100%',
                    padding: '10px 12px',
                    backgroundColor: '#1a1a1a',
                    border: '1px solid #333333',
                    borderRadius: '6px',
                    color: '#ffffff',
                    fontSize: '14px',
                    fontFamily: 'monospace',
                    outline: 'none'
                  }}
                  onFocus={(e) => e.target.style.borderColor = '#0E72ED'}
                  onBlur={(e) => e.target.style.borderColor = '#333333'}
                />
              </div>

              {/* Test Connection */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <button
                  style={{
                    padding: '10px 20px',
                    backgroundColor: '#0E72ED',
                    border: 'none',
                    borderRadius: '6px',
                    color: '#ffffff',
                    fontSize: '13px',
                    fontWeight: 500,
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px'
                  }}
                >
                  <Plug2 size={16} />
                  Test Connection
                </button>

                {connectionStatus === 'connected' && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <div
                      style={{
                        width: '8px',
                        height: '8px',
                        borderRadius: '50%',
                        backgroundColor: '#10b981'
                      }}
                    />
                    <span style={{ fontSize: '13px', color: '#10b981' }}>
                      Connected (45ms)
                    </span>
                  </div>
                )}

                {connectionStatus === 'error' && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <div
                      style={{
                        width: '8px',
                        height: '8px',
                        borderRadius: '50%',
                        backgroundColor: '#ef4444'
                      }}
                    />
                    <span style={{ fontSize: '13px', color: '#ef4444' }}>
                      Connection failed
                    </span>
                  </div>
                )}
              </div>
            </div>

            {/* Info Box */}
            <div style={{ padding: '0 24px 20px 24px' }}>
              <div
                style={{
                  padding: '16px',
                  backgroundColor: 'rgba(245, 158, 11, 0.1)',
                  border: '1px solid rgba(245, 158, 11, 0.3)',
                  borderRadius: '8px'
                }}
              >
                <div style={{ display: 'flex', gap: '12px' }}>
                  <Lightbulb size={20} color="#F59E0B" style={{ flexShrink: 0, marginTop: '2px' }} />
                  <div>
                    <div style={{ fontSize: '14px', fontWeight: 600, color: '#F59E0B', marginBottom: '6px' }}>
                      How It Works
                    </div>
                    <div style={{ fontSize: '13px', color: '#cccccc', lineHeight: '1.5' }}>
                      Audio transcription runs locally on this PC. Only video frames are sent to the remote server for processing (~144MB per hour of video).
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </>
        )}

        {/* Footer */}
        <div
          style={{
            padding: '16px 24px',
            borderTop: '1px solid #333333',
            display: 'flex',
            gap: '12px',
            justifyContent: 'flex-end'
          }}
        >
          <button
            onClick={onClose}
            style={{
              padding: '10px 24px',
              backgroundColor: 'transparent',
              border: '1px solid #333333',
              borderRadius: '6px',
              color: '#aaaaaa',
              fontSize: '14px',
              fontWeight: 500,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '6px'
            }}
          >
            <X size={16} />
            Cancel
          </button>

          {mode === 'server' ? (
            <>
              <button
                style={{
                  padding: '10px 24px',
                  backgroundColor: '#333333',
                  border: 'none',
                  borderRadius: '6px',
                  color: '#ffffff',
                  fontSize: '14px',
                  fontWeight: 500,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px'
                }}
              >
                <Plug2 size={16} />
                Test Connection
              </button>
              <button
                onClick={handleStartServer}
                style={{
                  padding: '10px 24px',
                  backgroundColor: '#10b981',
                  border: 'none',
                  borderRadius: '6px',
                  color: '#ffffff',
                  fontSize: '14px',
                  fontWeight: 500,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px'
                }}
              >
                <Check size={16} />
                Start Server
              </button>
            </>
          ) : (
            <>
              <button
                style={{
                  padding: '10px 24px',
                  backgroundColor: '#333333',
                  border: 'none',
                  borderRadius: '6px',
                  color: '#ffffff',
                  fontSize: '14px',
                  fontWeight: 500,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px'
                }}
              >
                <Plug2 size={16} />
                Test Connection
              </button>
              <button
                onClick={handleSaveAndConnect}
                style={{
                  padding: '10px 24px',
                  backgroundColor: '#0E72ED',
                  border: 'none',
                  borderRadius: '6px',
                  color: '#ffffff',
                  fontSize: '14px',
                  fontWeight: 500,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px'
                }}
              >
                <Check size={16} />
                Save & Connect
              </button>
            </>
          )}
        </div>
      </div>

      <style>{`
        @keyframes fadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes slideIn {
          from { 
            opacity: 0;
            transform: translateY(-20px);
          }
          to { 
            opacity: 1;
            transform: translateY(0);
          }
        }
      `}</style>
    </div>
  );
};

export default RemoteProcessingModal;
