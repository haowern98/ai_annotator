import React, { useState, useEffect } from 'react';
import { 
  Wifi, 
  WifiOff, 
  Plug2, 
  X, 
  FileVideo, 
  Film, 
  Mic, 
  Brain, 
  Save, 
  CheckCircle2, 
  XCircle, 
  Loader2,
  Monitor,
  Circle,
  Clock,
  Activity
} from 'lucide-react';
import { QueuedVideo } from '../services/uploadQueueManager';
import { QwenHttpClient } from '../services/qwenHttpClient';

interface RemoteConfig {
  mode: 'local' | 'server' | 'client';
  remoteUrl?: string;
  lastConnected?: number;
}

interface LectureHomeSidebarProps {
  uploadQueue: QueuedVideo[];
  onCancelVideo?: (videoId: string) => void;
  onClearCompleted?: () => void;
}

const LectureHomeSidebar: React.FC<LectureHomeSidebarProps> = ({
  uploadQueue,
  onCancelVideo,
  onClearCompleted,
}) => {
  const [remoteConfig, setRemoteConfig] = useState<RemoteConfig | null>(null);
  const [isTesting, setIsTesting] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);
  const [latency, setLatency] = useState<number | null>(null);
  const [isDisconnecting, setIsDisconnecting] = useState(false);
  const [isServerRunning, setIsServerRunning] = useState(false);
  const [isCheckingServer, setIsCheckingServer] = useState(false);

  // Load remote config on mount
  useEffect(() => {
    const loadConfig = () => {
      try {
        const saved = localStorage.getItem('qwen_remote_config');
        if (saved) {
          setRemoteConfig(JSON.parse(saved));
        } else {
          setRemoteConfig({ mode: 'local' });
        }
      } catch (e) {
        console.error('Failed to load remote config:', e);
        setRemoteConfig({ mode: 'local' });
      }
    };

    loadConfig();

    // Listen for storage changes (when modal updates config)
    const handleStorageChange = (e: StorageEvent) => {
      if (e.key === 'qwen_remote_config') {
        loadConfig();
      }
    };

    // Also listen for custom event from same window
    const handleConfigChange = () => {
      loadConfig();
    };

    window.addEventListener('storage', handleStorageChange);
    window.addEventListener('qwen-config-changed', handleConfigChange);

    return () => {
      window.removeEventListener('storage', handleStorageChange);
      window.removeEventListener('qwen-config-changed', handleConfigChange);
    };
  }, []);

  // Check server mode status using IPC flag (source of truth)
  useEffect(() => {
    const checkServerMode = async () => {
      setIsCheckingServer(true);
      try {
        if (window.electronAPI?.getServerMode) {
          const result = await window.electronAPI.getServerMode();
          if (result.success) {
            setIsServerRunning(result.isServerMode);
          }
        }
      } catch (error) {
        console.warn('[Sidebar] Failed to check server mode:', error);
      } finally {
        setIsCheckingServer(false);
      }
    };

    checkServerMode();
    // Re-check every 10 seconds
    const interval = setInterval(checkServerMode, 10000);
    return () => clearInterval(interval);
  }, [remoteConfig?.mode]);

  const handleTestConnection = async () => {
    if (!remoteConfig?.remoteUrl) return;

    setIsTesting(true);
    setTestError(null);
    setLatency(null);

    try {
      const startTime = Date.now();
      const client = new QwenHttpClient(remoteConfig.remoteUrl);

      await client.connect({
        onReady: () => {
          const latencyMs = Date.now() - startTime;
          setLatency(latencyMs);
          setIsTesting(false);
        },
        onError: (msg) => {
          setTestError(msg);
          setIsTesting(false);
        }
      });
    } catch (error) {
      setTestError('Connection failed');
      setIsTesting(false);
    }
  };

  const handleDisconnect = async () => {
    setIsDisconnecting(true);

    try {
      // Clear remote config
      localStorage.setItem('qwen_remote_config', JSON.stringify({ mode: 'local' }));

      // Restart local Qwen server
      if (window.electronAPI?.startQwenLocal) {
        const result = await window.electronAPI.startQwenLocal();
        if (result.success) {
          console.log('Local Qwen server restarted');
          // Reload page to reinitialize with local config
          window.location.reload();
        } else {
          console.error('Failed to restart local Qwen:', result.error);
          alert('Failed to restart local server. Please restart the application.');
          setIsDisconnecting(false);
        }
      }
    } catch (error) {
      console.error('Disconnect error:', error);
      alert('Disconnect failed. Please restart the application.');
      setIsDisconnecting(false);
    }
  };

  const getPhaseIcon = (phase: string) => {
    switch (phase) {
      case 'extracting':
        return <Film className="w-4 h-4 text-[#8a8a8a]" />;
      case 'transcribing':
        return <Mic className="w-4 h-4 text-[#8a8a8a]" />;
      case 'analyzing':
        return <Brain className="w-4 h-4 text-[#8a8a8a]" />;
      case 'saving':
        return <Save className="w-4 h-4 text-[#8a8a8a]" />;
      case 'complete':
        return <CheckCircle2 className="w-4 h-4 text-[#10b981]" />;
      case 'error':
        return <XCircle className="w-4 h-4 text-[#ef4444]" />;
      case 'pending':
        return <Clock className="w-4 h-4 text-[#8a8a8a]" />;
      default:
        return <Loader2 className="w-4 h-4 animate-spin text-[#0E72ED]" />;
    }
  };

  const getPhaseText = (phase: string) => {
    switch (phase) {
      case 'extracting':
        return 'Extracting frames';
      case 'transcribing':
        return 'Transcribing audio';
      case 'analyzing':
        return 'Analyzing with VLM';
      case 'saving':
        return 'Saving results';
      case 'complete':
        return 'Complete';
      case 'error':
        return 'Error';
      case 'pending':
        return 'Pending';
      default:
        return phase;
    }
  };

  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
  };

  const getDetailedStatus = (video: QueuedVideo): string => {
    const size = formatFileSize(video.fileSize);
    const phase = getPhaseText(video.status);
    
    if (video.status === 'pending') {
      return `${size} · Pending`;
    }
    
    if (video.status === 'complete') {
      return `${size} · Complete`;
    }
    
    if (video.status === 'error') {
      return `${size} · Error`;
    }
    
    // Show progress details for active phases
    if (video.progress?.currentStep && video.progress?.totalSteps) {
      return `${size} · ${phase} (${video.progress.currentStep}/${video.progress.totalSteps})`;
    }
    
    return `${size} · ${phase}`;
  };

  const stats = {
    total: uploadQueue.length,
    pending: uploadQueue.filter((v) => v.status === 'pending').length,
    processing: uploadQueue.filter((v) =>
      v.status === 'downloading' ||
      v.status === 'extracting' ||
      v.status === 'transcribing' ||
      v.status === 'analyzing' ||
      v.status === 'saving'
    ).length,
    complete: uploadQueue.filter((v) => v.status === 'complete').length,
    error: uploadQueue.filter((v) => v.status === 'error').length,
  };

  const isConnectedToRemote = remoteConfig?.mode === 'client' && remoteConfig?.remoteUrl;
  const isServerMode = remoteConfig?.mode === 'server';

  return (
    <div className="w-[400px] bg-[#1a1a1a] border-l border-[#3a3a3a] flex flex-col overflow-y-auto p-4 space-y-4 rounded-r-lg">
      {/* Connection Status Card */}
      <div className="bg-[#242424] rounded-lg border border-[#333333] p-5">
        <div className="flex items-center gap-2 mb-3">
          <Wifi className="w-5 h-5 text-[#0E72ED]" />
          <h3 className="text-sm font-semibold text-white">Connection Status</h3>
        </div>
        <div className="border-t border-[#3a3a3a] pt-3 mt-3">
          {isConnectedToRemote ? (
            <>
              <div className="text-sm text-white mb-2">Connected to Remote Server</div>
              <div className="text-sm text-[#0E72ED] mb-3 break-all">
                {remoteConfig.remoteUrl}
              </div>
              {latency !== null && (
                <div className="text-xs text-[#8a8a8a] mb-3">
                  Latency: {latency}ms
                </div>
              )}
              {testError && (
                <div className="text-xs text-[#ef4444] mb-3">
                  {testError}
                </div>
              )}
              <div className="flex gap-2">
                <button
                  onClick={handleTestConnection}
                  disabled={isTesting}
                  className="flex-1 flex items-center justify-center gap-2 px-3 py-2 bg-[#3a3a3a] hover:bg-[#444444] text-white rounded text-sm transition-colors disabled:opacity-50"
                >
                  {isTesting ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Plug2 className="w-4 h-4" />
                  )}
                  Test
                </button>
                <button
                  onClick={handleDisconnect}
                  disabled={isDisconnecting}
                  className="flex-1 flex items-center justify-center gap-2 px-3 py-2 bg-[#3a3a3a] hover:bg-[#ef4444] text-white rounded text-sm transition-colors disabled:opacity-50"
                >
                  {isDisconnecting ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <X className="w-4 h-4" />
                  )}
                  Disconnect
                </button>
              </div>
            </>
          ) : isServerMode ? (
            <>
              <div className="flex items-center gap-2 text-sm text-white mb-2">
                <Monitor className="w-4 h-4 text-[#0E72ED]" />
                <span>Server Mode</span>
              </div>
              {isCheckingServer ? (
                <div className="text-sm text-[#8a8a8a]">
                  Checking server status...
                </div>
              ) : isServerRunning ? (
                <div className="text-sm text-[#10b981]">
                  Accepting connections on 0.0.0.0:7556
                </div>
              ) : (
                <div className="text-sm text-[#ef4444]">
                  Server not running
                </div>
              )}
            </>
          ) : (
            <div className="text-sm text-[#8a8a8a]">
              Local Mode
            </div>
          )}
        </div>
      </div>

      {/* Processing Queue Card */}
      <div className="bg-[#242424] rounded-lg border border-[#333333] p-5 flex-1 overflow-hidden flex flex-col">
        <div className="flex items-center justify-between gap-3 mb-3">
          <div className="flex items-center gap-2">
            <Activity className="w-5 h-5 text-[#0E72ED]" />
            <h3 className="text-sm font-semibold text-white">Upload Queue</h3>
          </div>
          <div className="text-xs text-[#8a8a8a]">
            {stats.processing > 0 ? `Processing ${stats.processing}` : `${stats.complete} / ${stats.total} complete`}
          </div>
        </div>
        <div className="border-t border-[#3a3a3a] pt-3 mt-3 overflow-y-auto flex-1">
          {uploadQueue.length === 0 ? (
            <div className="text-center py-8 text-[#8a8a8a] text-sm">
              No videos in queue
            </div>
          ) : (
            <div className="space-y-4">
              {uploadQueue.map((video) => (
                <div
                  key={video.id}
                  className={`space-y-2 p-3 rounded-lg border ${
                    video.status === 'error' ? 'border-[#ef4444]' : 'border-[#333333]'
                  } bg-[#1a1a1a]`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2 flex-1 min-w-0">
                      {video.status === 'downloading' ||
                      video.status === 'analyzing' ||
                      video.status === 'extracting' ||
                      video.status === 'transcribing' ||
                      video.status === 'saving' ? (
                        <Loader2 className="w-5 h-5 text-[#0E72ED] animate-spin flex-shrink-0" />
                      ) : video.status === 'complete' ? (
                        <CheckCircle2 className="w-5 h-5 text-[#10b981] flex-shrink-0" />
                      ) : video.status === 'error' ? (
                        <XCircle className="w-5 h-5 text-[#ef4444] flex-shrink-0" />
                      ) : video.status === 'cancelled' ? (
                        <X className="w-5 h-5 text-[#8a8a8a] flex-shrink-0" />
                      ) : (
                        <Clock className="w-5 h-5 text-[#8a8a8a] flex-shrink-0" />
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="text-sm text-white font-medium truncate">
                          {video.fileName}
                        </div>
                        <div className="text-xs text-[#8a8a8a] truncate">
                          {formatFileSize(video.fileSize)} {'\u00b7'} {video.progress?.phase || getPhaseText(video.status)}
                        </div>
                      </div>
                    </div>
                    {(video.status === 'pending' ||
                      video.status === 'downloading' ||
                      video.status === 'extracting' ||
                      video.status === 'transcribing' ||
                      video.status === 'analyzing' ||
                      video.status === 'saving') &&
                      onCancelVideo && (
                      <button
                        onClick={() => onCancelVideo(video.id)}
                        className="px-3 py-1 text-xs text-[#8a8a8a] hover:text-white hover:bg-[#2a2a2a] rounded transition-colors flex-shrink-0 border border-[#444444]"
                      >
                        Cancel
                      </button>
                    )}
                  </div>

                  {(video.status === 'downloading' ||
                    video.status === 'extracting' ||
                    video.status === 'transcribing' ||
                    video.status === 'analyzing' ||
                    video.status === 'saving') && (
                    <div className="w-full bg-[#2a2a2a] rounded-full h-1 overflow-hidden">
                      <div
                        className="bg-[#0E72ED] h-full rounded-full transition-all duration-300"
                        style={{ width: `${video.progress?.percentage || 0}%` }}
                      />
                    </div>
                  )}

                  {video.status === 'error' && video.error && (
                    <div className="mt-1 p-2 bg-[rgba(239,68,68,0.1)] border border-[rgba(239,68,68,0.3)] rounded text-xs text-[#ef4444]">
                      {video.error}
                    </div>
                  )}

                  {video.status === 'complete' && video.startTime && video.endTime && (
                    <div className="text-xs text-[#4ade80]">
                      Completed in {Math.floor((video.endTime - video.startTime) / 1000)}s
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="border-t border-[#3a3a3a] pt-3 mt-3 flex items-center justify-between gap-3">
          <button
            onClick={() => onClearCompleted?.()}
            disabled={!onClearCompleted || (stats.complete === 0 && stats.error === 0)}
            className={`px-4 py-2 text-sm rounded border transition-colors ${
              !onClearCompleted || (stats.complete === 0 && stats.error === 0)
                ? 'opacity-50 cursor-not-allowed border-[#444444] text-[#8a8a8a]'
                : 'border-[#444444] text-[#8a8a8a] hover:text-white hover:bg-[#2a2a2a]'
            }`}
          >
            Clear Completed
          </button>
          <div className="text-xs text-[#8a8a8a]">
            {stats.total > 0 ? `${stats.complete} complete \u00b7 ${stats.error} errors` : ''}
          </div>
        </div>
      </div>

      {/* Server Activity Card (only in server mode) */}
      {isServerMode && (
        <div className="bg-[#242424] rounded-lg border border-[#333333] p-5">
          <div className="flex items-center gap-2 mb-3">
            <Monitor className="w-5 h-5 text-[#0E72ED]" />
            <h3 className="text-sm font-semibold text-white">Server Activity</h3>
          </div>
          <div className="border-t border-[#3a3a3a] pt-3 mt-3">
            <div className="text-center py-8 text-[#8a8a8a] text-sm">
              No active connections
            </div>
            {/* TODO: Add real-time server activity monitoring */}
          </div>
        </div>
      )}
    </div>
  );
};

export default LectureHomeSidebar;
