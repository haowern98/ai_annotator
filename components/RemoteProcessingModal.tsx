import React, { useState, useEffect } from 'react';
import { Server, Monitor, Wifi, Globe, Copy, Lightbulb, Check, X, Plug2 } from 'lucide-react';
import { QwenHttpClient } from '../services/qwenHttpClient';

type Mode = 'server' | 'client';

interface RemoteConfig {
  mode: 'local' | 'server' | 'client';
  remoteUrl?: string;
  lastConnected?: number;
}

const REMOTE_CONFIG_KEY = 'qwen_remote_config';

const saveRemoteConfig = (config: RemoteConfig) => {
  try {
    localStorage.setItem(REMOTE_CONFIG_KEY, JSON.stringify(config));
    // Dispatch custom event to notify other components
    window.dispatchEvent(new Event('qwen-config-changed'));
  } catch (e) {
    console.error('Failed to save remote config:', e);
  }
};

const loadRemoteConfig = (): RemoteConfig | null => {
  try {
    const saved = localStorage.getItem(REMOTE_CONFIG_KEY);
    if (saved) {
      return JSON.parse(saved);
    }
  } catch (e) {
    console.error('Failed to load remote config:', e);
  }
  return null;
};


interface RemoteProcessingModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: () => void; // Called when client successfully connects
}

const RemoteProcessingModal: React.FC<RemoteProcessingModalProps> = ({ isOpen, onClose, onSuccess }) => {
  const [mode, setMode] = useState<Mode>('server');
  const [serverUrl, setServerUrl] = useState('');
  const [localIP, setLocalIP] = useState('Detecting...');
  const [publicIP, setPublicIP] = useState('Loading...');
  const [connectionStatus, setConnectionStatus] = useState<'idle' | 'testing' | 'connected' | 'error'>('idle');
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const [latency, setLatency] = useState<number | null>(null);
  const [isServerRunning, setIsServerRunning] = useState(false);

  // Load saved config and detect IPs on mount
  useEffect(() => {
    if (!isOpen) return;

    // Check if server mode is already running
    const checkServerMode = async () => {
      if (window.electronAPI?.getServerMode) {
        const result = await window.electronAPI.getServerMode();
        if (result.success) {
          setIsServerRunning(result.isServerMode);
        }
      }
    };

    checkServerMode();

    // Load saved config
    const savedConfig = loadRemoteConfig();
    if (savedConfig?.mode === 'client' && savedConfig.remoteUrl) {
      setServerUrl(savedConfig.remoteUrl);
    }

    // Detect local and public IPs
    const detectIPs = async () => {
      if (window.electronAPI?.getLocalIP) {
        const localResult = await window.electronAPI.getLocalIP();
        if (localResult.success) {
          setLocalIP(localResult.ip);
        } else {
          setLocalIP('Not detected');
        }
      }

      if (window.electronAPI?.getPublicIP) {
        const publicResult = await window.electronAPI.getPublicIP();
        if (publicResult.success) {
          setPublicIP(publicResult.ip);
        } else {
          setPublicIP('Failed to detect');
        }
      }
    };

    detectIPs();
  }, [isOpen]);

  if (!isOpen) return null;

  const handleCopy = (text: string, field: string) => {
    navigator.clipboard.writeText(text);
    setCopiedField(field);
    setTimeout(() => setCopiedField(null), 2000);
  };

  const handleTestConnectionServer = async () => {
    setConnectionStatus('testing');
    setLatency(null);
    
    try {
      const startTime = Date.now();
      const client = new QwenHttpClient('http://127.0.0.1:7556');
      
      await client.connect({
        onReady: () => {
          const latencyMs = Date.now() - startTime;
          setLatency(latencyMs);
          setConnectionStatus('connected');
        },
        onError: (msg) => {
          console.error('Server connection test failed:', msg);
          setConnectionStatus('error');
        }
      });
    } catch (error) {
      console.error('Server connection test error:', error);
      setConnectionStatus('error');
    }
  };

  const handleTestConnectionClient = async () => {
    if (!serverUrl) {
      setConnectionStatus('error');
      return;
    }

    setConnectionStatus('testing');
    setLatency(null);
    
    try {
      const startTime = Date.now();
      const client = new QwenHttpClient(serverUrl);
      
      await client.connect({
        onReady: () => {
          const latencyMs = Date.now() - startTime;
          setLatency(latencyMs);
          setConnectionStatus('connected');
        },
        onError: (msg) => {
          console.error('Client connection test failed:', msg);
          setConnectionStatus('error');
        }
      });
    } catch (error) {
      console.error('Client connection test error:', error);
      setConnectionStatus('error');
    }
  };

  const handleStartServer = async () => {
    if (!window.electronAPI?.startQwenRemote) {
      console.error('Electron API not available');
      return;
    }

    setIsStarting(true);
    
    try {
      const result = await window.electronAPI.startQwenRemote();
      
      if (result.success) {
        // Web viewer is automatically enabled in server mode.
        try {
          await window.electronAPI?.startWebViewer?.(7558);
        } catch (e) {
          console.warn('[WebViewer] Failed to start:', e);
        }

        // Save server mode config
        saveRemoteConfig({ mode: 'server', lastConnected: Date.now() });
        setIsServerRunning(true);
        onClose();
      } else {
        console.error('Failed to start server:', result.error);
        alert(`Failed to start server: ${result.error}`);
      }
    } catch (error) {
      console.error('Server start error:', error);
      alert('Failed to start server');
    } finally {
      setIsStarting(false);
    }
  };

  const handleStopServer = async () => {
    // "Close Connection" in server mode should restore the default local worker (127.0.0.1)
    // so the app can immediately continue using Qwen without a reload.
    if (!window.electronAPI?.startQwenLocal) {
      console.error('Electron API not available');
      return;
    }

    setIsStarting(true);
    
    try {
      const result = await window.electronAPI.startQwenLocal();
      
      if (result.success) {
        // Web viewer is tied to server mode; stop it when leaving server mode.
        try {
          await window.electronAPI?.stopWebViewer?.();
        } catch (e) {
          console.warn('[WebViewer] Failed to stop:', e);
        }

        // Clear server mode config (back to local)
        saveRemoteConfig({ mode: 'local' });
        setIsServerRunning(false);
        onClose();
      } else {
        console.error('Failed to restart local server:', result.error);
        alert(`Failed to restart local server: ${result.error}`);
      }
    } catch (error) {
      console.error('Local restart error:', error);
      alert('Failed to restart local server');
    } finally {
      setIsStarting(false);
    }
  };

  const handleCloseClientConnection = async () => {
    // Match server-mode "Close Connection": switch back to local mode and ensure local Qwen is running,
    // without forcing a full renderer reload.
    if (!window.electronAPI?.startQwenLocal) {
      console.error('Electron API not available');
      return;
    }

    setIsStarting(true);

    try {
      const result = await window.electronAPI.startQwenLocal();

      if (result.success) {
        // Ensure web viewer is OFF outside server mode.
        try {
          await window.electronAPI?.stopWebViewer?.();
        } catch {
          // ignore
        }

        saveRemoteConfig({ mode: 'local' });
        setConnectionStatus('idle');
        setLatency(null);
        onClose();
      } else {
        console.error('Failed to restart local server:', result.error);
        alert(`Failed to restart local server: ${result.error}`);
      }
    } catch (error) {
      console.error('Local restart error:', error);
      alert('Failed to restart local server');
    } finally {
      setIsStarting(false);
    }
  };

  const handleSaveAndConnect = () => {
    if (!serverUrl) {
      alert('Please enter a server URL');
      return;
    }

    // Ensure web viewer is OFF outside server mode.
    try {
      void window.electronAPI?.stopWebViewer?.();
    } catch {
      // ignore
    }

    // Save client mode config
    saveRemoteConfig({
      mode: 'client',
      remoteUrl: serverUrl,
      lastConnected: Date.now()
    });

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
                  7556 (Qwen API) · 7557 (Video Inbox)
                </div>
              </div>

              {/* Access Token removed */}
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
                      You must configure your router to forward TCP ports 7556 and 7557 to this computer's local IP ({localIP}).
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
                  onClick={handleTestConnectionClient}
                  disabled={!serverUrl || connectionStatus === 'testing'}
                  style={{
                    padding: '10px 20px',
                    backgroundColor: '#0E72ED',
                    border: 'none',
                    borderRadius: '6px',
                    color: '#ffffff',
                    fontSize: '13px',
                    fontWeight: 500,
                    cursor: (!serverUrl || connectionStatus === 'testing') ? 'not-allowed' : 'pointer',
                    opacity: (!serverUrl || connectionStatus === 'testing') ? 0.5 : 1,
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px'
                  }}
                >
                  <Plug2 size={16} />
                  {connectionStatus === 'testing' ? 'Testing...' : 'Test Connection'}
                </button>

                {connectionStatus === 'connected' && latency !== null && (
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
                      Connected ({latency}ms)
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
                onClick={handleStopServer}
                disabled={isStarting}
                style={{
                  padding: '10px 24px',
                  backgroundColor: '#333333',
                  border: 'none',
                  borderRadius: '6px',
                  color: '#ffffff',
                  fontSize: '14px',
                  fontWeight: 500,
                  cursor: isStarting ? 'not-allowed' : 'pointer',
                  opacity: isStarting ? 0.5 : 1,
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px'
                }}
              >
                <X size={16} />
                {isStarting ? 'Stopping...' : 'Close Connection'}
              </button>
              <button
                onClick={handleStartServer}
                disabled={isStarting || isServerRunning}
                style={{
                  padding: '10px 24px',
                  backgroundColor: isServerRunning ? '#666666' : '#10b981',
                  border: 'none',
                  borderRadius: '6px',
                  color: '#ffffff',
                  fontSize: '14px',
                  fontWeight: 500,
                  cursor: (isStarting || isServerRunning) ? 'not-allowed' : 'pointer',
                  opacity: (isStarting || isServerRunning) ? 0.5 : 1,
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px'
                }}
              >
                <Check size={16} />
                {isStarting ? 'Starting...' : isServerRunning ? 'Server Running' : 'Start Server'}
              </button>
            </>
          ) : mode === 'client' ? (
            <>
              <button
                onClick={handleCloseClientConnection}
                disabled={isStarting}
                style={{
                  padding: '10px 24px',
                  backgroundColor: '#333333',
                  border: 'none',
                  borderRadius: '6px',
                  color: '#ffffff',
                  fontSize: '14px',
                  fontWeight: 500,
                  cursor: isStarting ? 'not-allowed' : 'pointer',
                  opacity: isStarting ? 0.5 : 1,
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px'
                }}
              >
                <X size={16} />
                {isStarting ? 'Disconnecting...' : 'Close Connection'}
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
          ) : null}
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
