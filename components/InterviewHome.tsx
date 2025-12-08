import React from 'react';
import { Monitor, FileText, User, Briefcase, Building2, FileText as FileTextIcon, ClipboardList, StickyNote, Plus, Save, Trash2, X, Tag, AlertCircle } from 'lucide-react';
import { AppStatus, LogLevel, NavigationView, InterviewContext, InterviewProfile, InterviewProfilesState } from '../types';
import { ScreenSourcePicker } from './ScreenSourcePicker';
import { DualGeminiSessionManager } from '../services/dualGeminiSessionManager';
import screenAnalysisService from '../services/screenAnalysisService';

// localStorage key for interview profiles
const PROFILES_STORAGE_KEY = 'interview_profiles';

// Default empty context
const emptyContext: InterviewContext = {
  profileName: '',
  name: '',
  role: '',
  company: '',
  resume: '',
  jobDescription: '',
  notes: '',
};

// Load profiles from localStorage
const loadProfiles = (): InterviewProfilesState => {
  try {
    const stored = localStorage.getItem(PROFILES_STORAGE_KEY);
    if (stored) {
      return JSON.parse(stored);
    }
  } catch (e) {
    console.error('Failed to load profiles:', e);
  }
  return { profiles: [null, null, null], activeProfileId: null };
};

// Save profiles to localStorage
const saveProfiles = (state: InterviewProfilesState) => {
  try {
    localStorage.setItem(PROFILES_STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    console.error('Failed to save profiles:', e);
  }
};

interface InterviewHomeProps {
  onSessionStart?: () => void;
  currentView?: NavigationView;
  onNavigate?: (view: NavigationView) => void;
}

const InterviewHome: React.FC<InterviewHomeProps> = ({ onSessionStart, currentView = 'home', onNavigate }) => {
  const [status, setStatus] = React.useState<AppStatus>(AppStatus.IDLE);
  const [error, setError] = React.useState<string | null>(null);
  const [hoveredButton, setHoveredButton] = React.useState<string | null>(null);

  // Interview Details state
  const [profilesState, setProfilesState] = React.useState<InterviewProfilesState>({
    profiles: [null, null, null],
    activeProfileId: null
  });
  const [activeTab, setActiveTab] = React.useState<'profile' | 'resume' | 'job'>('profile');
  const [formData, setFormData] = React.useState<InterviewContext>({
    profileName: '',
    name: '',
    role: '',
    company: '',
    resume: '',
    jobDescription: '',
    notes: ''
  });
  const [hoveredSlot, setHoveredSlot] = React.useState<number | null>(null);
  const [hoveredTab, setHoveredTab] = React.useState<string | null>(null);
  const [hoveredAction, setHoveredAction] = React.useState<string | null>(null);
  const [hoveredHomeSlot, setHoveredHomeSlot] = React.useState<number | null>(null);
  const [hoveredEditLink, setHoveredEditLink] = React.useState<number | null>(null);

  // Toast state (Interview Details only)
  const [toastMessage, setToastMessage] = React.useState<string | null>(null);
  const toastTimeoutRef = React.useRef<number | null>(null);

  // Screen source picker state
  const [isPickerOpen, setIsPickerOpen] = React.useState(false);
  const [pickerSources, setPickerSources] = React.useState<Array<{id: string; name: string; thumbnail: string; appIcon?: string | null}> | null>(null);
  const pickerResolveRef = React.useRef<((sourceId: string) => void) | null>(null);

  const sessionManagerRef = React.useRef<DualGeminiSessionManager | null>(null);
  const overlayCreatedRef = React.useRef<boolean>(false);
  const analysisActiveRef = React.useRef<boolean>(false);
  const analysisIntervalRef = React.useRef<number | null>(null);
  const analysisCanvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const analysisVideoRef = React.useRef<HTMLVideoElement | null>(null);
  const analysisStreamRef = React.useRef<MediaStream | null>(null); // Separate stream for primary screen capture

  // Load profiles from localStorage on mount
  React.useEffect(() => {
    try {
      const saved = localStorage.getItem('interview_profiles');
      if (saved) {
        const parsed = JSON.parse(saved);
        // Handle both old format (array) and new format (object with activeProfileId)
        if (Array.isArray(parsed) && parsed.length === 3) {
          setProfilesState(prev => ({ ...prev, profiles: parsed }));
        } else if (parsed && Array.isArray(parsed.profiles)) {
          setProfilesState({
            profiles: parsed.profiles,
            activeProfileId: parsed.activeProfileId || null
          });
        }
        console.log('[InterviewHome] Loaded profiles from localStorage');
      }
    } catch (err) {
      console.error('[InterviewHome] Failed to load profiles:', err);
    }
  }, []);

  // Show toast helper
  const showToast = React.useCallback((message: string) => {
    if (toastTimeoutRef.current) {
      clearTimeout(toastTimeoutRef.current);
    }
    setToastMessage(message);
    toastTimeoutRef.current = window.setTimeout(() => {
      setToastMessage(null);
    }, 3000);
  }, []);

  const addLog = React.useCallback((message: string, level: LogLevel = LogLevel.INFO) => {
    const timestamp = new Date().toLocaleTimeString();
    const prefix = `[${timestamp}]`;
    switch (level) {
      case LogLevel.ERROR: console.error(`${prefix} ❌ ${message}`); break;
      case LogLevel.WARN: console.warn(`${prefix} ⚠️  ${message}`); break;
      case LogLevel.SUCCESS: console.log(`%c${prefix} ✓ ${message}`, 'color: #4ade80'); break;
      default: console.log(`${prefix} ${message}`);
    }
  }, []);

  // Frame capture functions for screen analysis - captures PRIMARY SCREEN (not the picker source)
  const startAnalysisFrameCapture = React.useCallback(async () => {
    // Get the primary screen source ID
    const api = window.electronAPI as any;
    if (!api?.getPrimaryScreenSourceId) {
      addLog('getPrimaryScreenSourceId not available', LogLevel.ERROR);
      return;
    }

    try {
      const result = await api.getPrimaryScreenSourceId();
      if (!result.success || !result.sourceId) {
        addLog(`Failed to get primary screen: ${result.error}`, LogLevel.ERROR);
        return;
      }

      addLog(`Capturing primary screen: ${result.name}`, LogLevel.INFO);

      // Create a separate media stream for the primary screen
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          // @ts-ignore - Electron-specific constraint
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: result.sourceId,
          },
        },
      });

      analysisStreamRef.current = stream;

      // Create video element for frame capture
      const video = document.createElement('video');
      video.srcObject = stream;
      video.muted = true;
      video.play();
      analysisVideoRef.current = video;

      // Create canvas for frame extraction
      const canvas = document.createElement('canvas');
      analysisCanvasRef.current = canvas;

      // Start frame capture interval (every 2 seconds)
      analysisIntervalRef.current = window.setInterval(async () => {
        if (!analysisActiveRef.current || !video.videoWidth) return;

        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        ctx.drawImage(video, 0, 0);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.7);
        const base64 = dataUrl.split(',')[1];

        try {
          await screenAnalysisService.sendVideoFrame(base64);
        } catch (err) {
          // Silently ignore frame send errors
        }
      }, 2000);

      addLog('Analysis frame capture started (primary screen)', LogLevel.SUCCESS);
    } catch (err) {
      addLog(`Failed to start analysis frame capture: ${err}`, LogLevel.ERROR);
    }
  }, [addLog]);

  const stopAnalysisFrameCapture = React.useCallback(() => {
    if (analysisIntervalRef.current) {
      clearInterval(analysisIntervalRef.current);
      analysisIntervalRef.current = null;
    }
    if (analysisVideoRef.current) {
      analysisVideoRef.current.srcObject = null;
      analysisVideoRef.current = null;
    }
    // Stop the separate analysis stream
    if (analysisStreamRef.current) {
      analysisStreamRef.current.getTracks().forEach(track => track.stop());
      analysisStreamRef.current = null;
    }
    analysisActiveRef.current = false;
  }, []);

  // Initialize session manager
  React.useEffect(() => {
    sessionManagerRef.current = new DualGeminiSessionManager(
      {
        onStatusChange: (newStatus) => setStatus(newStatus),
        onError: (errorMsg) => setError(errorMsg),
        onTranscriptUpdate: (transcripts, current) => {
          // Send to overlay
          if (window.electronAPI?.updateOverlayTranscript) {
            window.electronAPI.updateOverlayTranscript(JSON.stringify({
              completed: transcripts,
              current: current
            }));
          }
        },
        onReplyUpdate: (replyList, current) => {
          // Send to overlay
          if (window.electronAPI?.updateOverlayReply) {
            window.electronAPI.updateOverlayReply(JSON.stringify({
              completed: replyList,
              current: current
            }));
          }
        },
      },
      addLog
    );

    // Listen for stop control from overlay
    const handleOverlayControl = (_event: any, command: string) => {
      if (command === 'stop') {
        handleStopFromOverlay();
      } else if (command === 'pause') {
        sessionManagerRef.current?.pause();
      } else if (command === 'resume') {
        sessionManagerRef.current?.resume();
      }
    };

    if (window.electronAPI?.onOverlayControl) {
      window.electronAPI.onOverlayControl(handleOverlayControl);
    }

    // Listen for screen analysis control from overlay
    const handleAnalysisControl = async (_event: any, command: any) => {
      console.log('[InterviewHome] Received analysis control command:', command);
      
      if (command === 'start') {
        addLog('Starting screen analysis service...', LogLevel.INFO);
        
        try {
          analysisActiveRef.current = true;
          
          const connected = await screenAnalysisService.connect({
            onAnalysisReady: (analysis: string) => {
              // Send analysis to overlay
              if (window.electronAPI?.updateOverlayAnalysis) {
                window.electronAPI.updateOverlayAnalysis(JSON.stringify({
                  text: analysis,
                  isGenerating: false
                }));
              }
            },
            onError: (error: Error) => {
              addLog(`Screen analysis error: ${error.message}`, LogLevel.ERROR);
            },
            onConnectionChange: (connected: boolean) => {
              addLog(`Screen analysis ${connected ? 'connected' : 'disconnected'}`, connected ? LogLevel.SUCCESS : LogLevel.INFO);
              // Notify overlay of connection status
              if (window.electronAPI?.updateOverlayAnalysis) {
                window.electronAPI.updateOverlayAnalysis(JSON.stringify({
                  isConnected: connected
                }));
              }
            }
          });
          
          if (connected) {
            addLog('Screen analysis connected, starting frame capture', LogLevel.SUCCESS);
            startAnalysisFrameCapture();
          }
        } catch (err) {
          addLog(`Failed to start screen analysis: ${err}`, LogLevel.ERROR);
          analysisActiveRef.current = false;
        }
      } else if (command === 'stop') {
        addLog('Stopping screen analysis service...', LogLevel.INFO);
        stopAnalysisFrameCapture();
        await screenAnalysisService.disconnect();
      } else if (command === 'generate') {
        addLog('Generating screen analysis...', LogLevel.INFO);
        await screenAnalysisService.generateReply();
      } else if (typeof command === 'object' && command.command === 'question') {
        addLog(`Sending question to analysis: ${command.text.substring(0, 30)}...`, LogLevel.INFO);
        await screenAnalysisService.sendUserQuestion(command.text);
      }
    };

    if ((window.electronAPI as any)?.onAnalysisControl) {
      console.log('[InterviewHome] Registering onAnalysisControl listener');
      (window.electronAPI as any).onAnalysisControl(handleAnalysisControl);
    } else {
      console.log('[InterviewHome] onAnalysisControl not available');
    }

    return () => {
      sessionManagerRef.current?.stop();
      stopAnalysisFrameCapture();
      screenAnalysisService.disconnect();
      if (window.electronAPI?.removeOverlayControlListener) {
        window.electronAPI.removeOverlayControlListener(handleOverlayControl);
      }
      if ((window.electronAPI as any)?.removeAnalysisControlListener) {
        (window.electronAPI as any).removeAnalysisControlListener();
      }
    };
  }, [addLog, startAnalysisFrameCapture, stopAnalysisFrameCapture]);

  const handleStopFromOverlay = React.useCallback(async () => {
    addLog('Stop requested from overlay');
    sessionManagerRef.current?.stop();

    if (window.electronAPI?.closeOverlay && overlayCreatedRef.current) {
      try {
        await window.electronAPI.closeOverlay();
        overlayCreatedRef.current = false;
        addLog('Overlay window closed', LogLevel.INFO);
      } catch (err) {
        addLog(`Error closing overlay: ${err}`, LogLevel.ERROR);
      }
    }
  }, [addLog]);

  // Picker handlers
  const handlePickerSelect = React.useCallback(async (sourceId: string) => {
    setIsPickerOpen(false);
    if (pickerResolveRef.current) {
      pickerResolveRef.current(sourceId);
      pickerResolveRef.current = null;
    }
    setPickerSources(null);

    // Focus the selected window (Zoom-like behavior)
    if (window.electronAPI?.focusCapturedWindow) {
      try {
        const result = await window.electronAPI.focusCapturedWindow(sourceId);
        if (result.success) {
          addLog(result.isScreen ? 'Screen selected' : 'Focused selected window', LogLevel.SUCCESS);
        } else if (result.error) {
          addLog(`Could not focus window: ${result.error}`, LogLevel.WARN);
        }
      } catch (err) {
        addLog(`Error focusing window: ${err}`, LogLevel.WARN);
      }
    }

    // Create overlay window after source selection
    if (window.electronAPI?.createOverlay && !overlayCreatedRef.current) {
      try {
        const result = await window.electronAPI.createOverlay();
        if (result.success) {
          overlayCreatedRef.current = true;
          addLog('Overlay window created', LogLevel.SUCCESS);
        } else {
          addLog(`Failed to create overlay: ${result.error}`, LogLevel.ERROR);
        }
      } catch (err) {
        addLog(`Error creating overlay: ${err}`, LogLevel.ERROR);
      }
    }
  }, [addLog]);

  const handlePickerCancel = React.useCallback(() => {
    setIsPickerOpen(false);
    if (pickerResolveRef.current) {
      pickerResolveRef.current('');
      pickerResolveRef.current = null;
    }
    setPickerSources(null);
    setStatus(AppStatus.IDLE);
    addLog('Screen selection cancelled', LogLevel.INFO);
  }, [addLog]);

  const handleOpenOverlay = async () => {
    addLog('Interview Mode: Open Overlay clicked');
    if (!process.env.API_KEY) {
      const msg = "API_KEY environment variable not set.";
      addLog(msg, LogLevel.ERROR);
      setError(msg);
      setStatus(AppStatus.ERROR);
      return;
    }

    setError(null);

    // Pass the picker callback to the session manager
    const onSourceRequired = async (sources: any[]) => {
      return new Promise<string>((resolve) => {
        setPickerSources(sources);
        setIsPickerOpen(true);
        pickerResolveRef.current = resolve;
      });
    };

    // Get active profile context (if any)
    const activeContext = profilesState.activeProfileId !== null 
      ? profilesState.profiles[profilesState.activeProfileId - 1]?.context 
      : undefined;
    
    if (activeContext) {
      addLog(`Starting with profile: ${activeContext.profileName || activeContext.company || activeContext.role || 'Unnamed'}`, LogLevel.INFO);
    } else {
      addLog('Starting with default context (no profile selected)', LogLevel.INFO);
    }

    await sessionManagerRef.current?.start(process.env.API_KEY, onSourceRequired, activeContext);
    onSessionStart?.();
  };

  const handleInterviewDetails = () => {
    onNavigate?.('interview-details');
    addLog('Navigated to Interview Details', LogLevel.INFO);
  };

  const handleSlotClick = (slotIndex: number, isHomeView: boolean = false) => {
    const profileId = (slotIndex + 1) as 1 | 2 | 3;
    const profile = profilesState.profiles[slotIndex];
    
    if (profile) {
      // Load existing profile
      setFormData(profile.context);
      setProfilesState(prev => ({ ...prev, activeProfileId: profileId }));
    } else {
      // Empty slot
      if (isHomeView) {
        // From Home view: navigate to Interview Details with empty form
        setFormData({ profileName: '', name: '', role: '', company: '', resume: '', jobDescription: '', notes: '' });
        setProfilesState(prev => ({ ...prev, activeProfileId: profileId }));
        onNavigate?.('interview-details');
      } else {
        // From Interview Details: show toast, still select the slot
        setFormData({ profileName: '', name: '', role: '', company: '', resume: '', jobDescription: '', notes: '' });
        setProfilesState(prev => ({ ...prev, activeProfileId: profileId }));
        showToast('This slot is empty. Fill in the form and save to create a profile.');
      }
    }
    addLog(`Selected profile slot ${profileId}`, LogLevel.INFO);
  };

  const handleSaveProfile = () => {
    if (profilesState.activeProfileId === null) return;
    
    setHoveredAction(null); // Reset hover state after click
    
    const slotIndex = profilesState.activeProfileId - 1;
    const newProfile: InterviewProfile = {
      id: profilesState.activeProfileId,
      context: { ...formData },
      lastModified: new Date().toISOString()
    };
    
    const newProfiles = [...profilesState.profiles];
    newProfiles[slotIndex] = newProfile;
    const newState = { profiles: newProfiles, activeProfileId: profilesState.activeProfileId };
    setProfilesState(newState);
    
    // Save to localStorage (including activeProfileId)
    localStorage.setItem('interview_profiles', JSON.stringify(newState));
    addLog(`Saved profile to slot ${profilesState.activeProfileId}`, LogLevel.SUCCESS);
  };

  const handleClearForm = () => {
    setFormData({ profileName: '', name: '', role: '', company: '', resume: '', jobDescription: '', notes: '' });
    addLog('Cleared form data', LogLevel.INFO);
  };

  // Render Interview Details view
  if (currentView === 'interview-details') {
    const tabs = [
      { id: 'profile', icon: User, label: 'Profile' },
      { id: 'resume', icon: FileTextIcon, label: 'Resume' },
      { id: 'job', icon: Briefcase, label: 'Job Details' }
    ];

    return (
      <div style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        padding: '24px',
        backgroundColor: '#1a1a1a',
        overflow: 'auto'
      }}>
        {/* Profile Slots */}
        <div style={{ display: 'flex', gap: '12px', marginBottom: '24px' }}>
          {[0, 1, 2].map((slotIndex) => {
            const profile = profilesState.profiles[slotIndex];
            const isActive = profilesState.activeProfileId === slotIndex + 1;
            const isHovered = hoveredSlot === slotIndex;
            
            return (
              <button
                key={slotIndex}
                onClick={() => handleSlotClick(slotIndex, false)}
                onMouseEnter={() => setHoveredSlot(slotIndex)}
                onMouseLeave={() => setHoveredSlot(null)}
                style={{
                  flex: 1,
                  display: 'flex',
                  alignItems: 'center',
                  gap: '10px',
                  padding: '12px 14px',
                  backgroundColor: isActive ? 'rgba(14, 114, 237, 0.15)' : isHovered ? '#2a2a2a' : '#242424',
                  border: isActive ? '1px solid #0E72ED' : '1px solid #333333',
                  borderRadius: '8px',
                  cursor: 'pointer',
                  transition: 'all 0.15s ease'
                }}
              >
                <User size={18} color={isActive ? '#0E72ED' : isHovered ? '#ffffff' : '#8a8a8a'} />
                <div style={{ flex: 1, textAlign: 'left' }}>
                  <div style={{ 
                    color: isActive ? '#ffffff' : isHovered ? '#ffffff' : '#cccccc', 
                    fontSize: '13px', 
                    fontWeight: 500 
                  }}>
                    {profile ? (profile.context.profileName || profile.context.company || profile.context.role || `Profile ${slotIndex + 1}`) : `Slot ${slotIndex + 1}`}
                  </div>
                  {profile && (
                    <div style={{ color: '#666666', fontSize: '11px', marginTop: '2px' }}>
                      {profile.context.role || 'No role'}
                    </div>
                  )}
                  {!profile && (
                    <div style={{ color: '#555555', fontSize: '11px', marginTop: '2px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                      <Plus size={10} /> Empty
                    </div>
                  )}
                </div>
              </button>
            );
          })}
        </div>

        {/* Tab Bar */}
        <div style={{ 
          display: 'flex', 
          gap: '4px', 
          marginBottom: '20px',
          backgroundColor: '#242424',
          padding: '4px',
          borderRadius: '8px',
          width: 'fit-content'
        }}>
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            const isHovered = hoveredTab === tab.id;
            
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id as 'profile' | 'resume' | 'job')}
                onMouseEnter={() => setHoveredTab(tab.id)}
                onMouseLeave={() => setHoveredTab(null)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  padding: '8px 14px',
                  backgroundColor: isActive ? '#333333' : 'transparent',
                  border: 'none',
                  borderRadius: '6px',
                  cursor: 'pointer',
                  transition: 'all 0.15s ease'
                }}
              >
                <Icon size={16} color={isActive ? '#0E72ED' : isHovered ? '#ffffff' : '#8a8a8a'} />
                <span style={{ 
                  fontSize: '13px', 
                  color: isActive ? '#ffffff' : isHovered ? '#ffffff' : '#8a8a8a',
                  fontWeight: isActive ? 500 : 400
                }}>
                  {tab.label}
                </span>
              </button>
            );
          })}
        </div>

        {/* Form Content */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {activeTab === 'profile' && (
            <>
              {/* Profile Name Field */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <Tag size={18} color="#8a8a8a" style={{ flexShrink: 0 }} />
                <input
                  type="text"
                  value={formData.profileName}
                  onChange={(e) => setFormData(prev => ({ ...prev, profileName: e.target.value }))}
                  placeholder="Profile name (e.g., Google SWE)"
                  style={{
                    flex: 1,
                    backgroundColor: '#242424',
                    border: '1px solid #333333',
                    borderRadius: '6px',
                    padding: '10px 12px',
                    color: '#ffffff',
                    fontSize: '14px',
                    outline: 'none'
                  }}
                />
              </div>

              {/* Name Field */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <User size={18} color="#8a8a8a" style={{ flexShrink: 0 }} />
                <input
                  type="text"
                  value={formData.name}
                  onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
                  placeholder="Your name"
                  style={{
                    flex: 1,
                    backgroundColor: '#242424',
                    border: '1px solid #333333',
                    borderRadius: '6px',
                    padding: '10px 12px',
                    color: '#ffffff',
                    fontSize: '14px',
                    outline: 'none'
                  }}
                />
              </div>
              
              {/* Notes Field */}
              <div style={{ display: 'flex', gap: '12px' }}>
                <StickyNote size={18} color="#8a8a8a" style={{ flexShrink: 0, marginTop: '10px' }} />
                <div style={{ flex: 1 }}>
                  <textarea
                    value={formData.notes}
                    onChange={(e) => setFormData(prev => ({ ...prev, notes: e.target.value }))}
                    placeholder="Additional notes..."
                    style={{
                      width: '100%',
                      minHeight: '100px',
                      backgroundColor: '#242424',
                      border: '1px solid #333333',
                      borderRadius: '6px',
                      padding: '10px 12px',
                      color: '#ffffff',
                      fontSize: '14px',
                      outline: 'none',
                      resize: 'none',
                      fontFamily: 'inherit'
                    }}
                  />
                  <div style={{ color: '#555555', fontSize: '11px', textAlign: 'right', marginTop: '4px' }}>
                    {formData.notes.length} chars
                  </div>
                </div>
              </div>
            </>
          )}

          {activeTab === 'resume' && (
            <div style={{ display: 'flex', gap: '12px', flex: 1 }}>
              <FileTextIcon size={18} color="#8a8a8a" style={{ flexShrink: 0, marginTop: '10px' }} />
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
                <textarea
                  value={formData.resume}
                  onChange={(e) => setFormData(prev => ({ ...prev, resume: e.target.value }))}
                  placeholder="Paste your resume content here..."
                  style={{
                    flex: 1,
                    minHeight: '200px',
                    backgroundColor: '#242424',
                    border: '1px solid #333333',
                    borderRadius: '6px',
                    padding: '12px',
                    color: '#ffffff',
                    fontSize: '13px',
                    outline: 'none',
                    resize: 'none',
                    fontFamily: 'inherit',
                    lineHeight: '1.5'
                  }}
                />
                <div style={{ color: '#555555', fontSize: '11px', textAlign: 'right', marginTop: '4px' }}>
                  {formData.resume.length} chars
                </div>
              </div>
            </div>
          )}

          {activeTab === 'job' && (
            <>
              {/* Role Field */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <Briefcase size={18} color="#8a8a8a" style={{ flexShrink: 0 }} />
                <input
                  type="text"
                  value={formData.role}
                  onChange={(e) => setFormData(prev => ({ ...prev, role: e.target.value }))}
                  placeholder="Job title / Role"
                  style={{
                    flex: 1,
                    backgroundColor: '#242424',
                    border: '1px solid #333333',
                    borderRadius: '6px',
                    padding: '10px 12px',
                    color: '#ffffff',
                    fontSize: '14px',
                    outline: 'none'
                  }}
                />
              </div>

              {/* Company Field */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <Building2 size={18} color="#8a8a8a" style={{ flexShrink: 0 }} />
                <input
                  type="text"
                  value={formData.company}
                  onChange={(e) => setFormData(prev => ({ ...prev, company: e.target.value }))}
                  placeholder="Company name"
                  style={{
                    flex: 1,
                    backgroundColor: '#242424',
                    border: '1px solid #333333',
                    borderRadius: '6px',
                    padding: '10px 12px',
                    color: '#ffffff',
                    fontSize: '14px',
                    outline: 'none'
                  }}
                />
              </div>

              {/* Job Description Field */}
              <div style={{ display: 'flex', gap: '12px', flex: 1 }}>
                <ClipboardList size={18} color="#8a8a8a" style={{ flexShrink: 0, marginTop: '10px' }} />
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
                  <textarea
                    value={formData.jobDescription}
                    onChange={(e) => setFormData(prev => ({ ...prev, jobDescription: e.target.value }))}
                    placeholder="Paste job description here..."
                    style={{
                      flex: 1,
                      minHeight: '150px',
                      backgroundColor: '#242424',
                      border: '1px solid #333333',
                      borderRadius: '6px',
                      padding: '12px',
                      color: '#ffffff',
                      fontSize: '13px',
                      outline: 'none',
                      resize: 'none',
                      fontFamily: 'inherit',
                      lineHeight: '1.5'
                    }}
                  />
                  <div style={{ color: '#555555', fontSize: '11px', textAlign: 'right', marginTop: '4px' }}>
                    {formData.jobDescription.length} chars
                  </div>
                </div>
              </div>
            </>
          )}
        </div>

        {/* Action Buttons */}
        <div style={{ 
          display: 'flex', 
          gap: '12px', 
          marginTop: '24px',
          paddingTop: '16px',
          borderTop: '1px solid #333333',
          position: 'relative'
        }}>
          {/* Toast Message - absolute positioned */}
          {toastMessage && (
            <div style={{
              position: 'absolute',
              bottom: '100%',
              left: 0,
              right: 0,
              marginBottom: '12px',
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
              padding: '12px 16px',
              backgroundColor: '#333333',
              borderRadius: '6px'
            }}>
              <AlertCircle size={16} color="#F59E0B" />
              <span style={{ color: '#ffffff', fontSize: '13px' }}>{toastMessage}</span>
            </div>
          )}
          <button
            onClick={handleClearForm}
            onMouseEnter={() => setHoveredAction('clear')}
            onMouseLeave={() => setHoveredAction(null)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              padding: '10px 16px',
              backgroundColor: hoveredAction === 'clear' ? '#3a3a3a' : '#2a2a2a',
              border: '1px solid #444444',
              borderRadius: '6px',
              color: hoveredAction === 'clear' ? '#ffffff' : '#8a8a8a',
              fontSize: '13px',
              cursor: 'pointer',
              transition: 'all 0.15s ease'
            }}
          >
            <Trash2 size={16} />
            Clear
          </button>
          
          <button
            onClick={handleSaveProfile}
            disabled={profilesState.activeProfileId === null}
            onMouseEnter={() => setHoveredAction('save')}
            onMouseLeave={() => setHoveredAction(null)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              padding: '10px 16px',
              backgroundColor: profilesState.activeProfileId === null 
                ? '#1a1a1a' 
                : hoveredAction === 'save' 
                  ? '#0E72ED' 
                  : 'rgba(14, 114, 237, 0.2)',
              border: profilesState.activeProfileId === null 
                ? '1px solid #333333' 
                : '1px solid #0E72ED',
              borderRadius: '6px',
              color: profilesState.activeProfileId === null 
                ? '#555555' 
                : '#ffffff',
              fontSize: '13px',
              cursor: profilesState.activeProfileId === null ? 'not-allowed' : 'pointer',
              transition: 'all 0.15s ease'
            }}
          >
            <Save size={16} />
            Save
          </button>
        </div>
      </div>
    );
  }

  // Render Home view
  // Get active profile for indicator
  const activeProfile = profilesState.activeProfileId !== null 
    ? profilesState.profiles[profilesState.activeProfileId - 1] 
    : null;
  const activeProfileName = activeProfile?.context.profileName || activeProfile?.context.company || activeProfile?.context.role || `Profile ${profilesState.activeProfileId}`;
  const isOverlayDisabled = status !== AppStatus.IDLE || profilesState.activeProfileId === null;

  return (
    <div style={{
      flex: 1,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '32px',
      backgroundColor: '#1a1a1a'
    }}>
      {/* Error Display */}
      {error && (
        <div style={{
          marginBottom: '32px',
          backgroundColor: 'rgba(127, 29, 29, 0.5)',
          border: '1px solid #b91c1c',
          color: '#fca5a5',
          padding: '16px',
          borderRadius: '8px',
          maxWidth: '400px'
        }}>
          <p style={{ fontWeight: 'bold', marginBottom: '4px' }}>An Error Occurred</p>
          <p style={{ fontSize: '14px' }}>{error}</p>
        </div>
      )}

      {/* Select Profile Header */}
      <div style={{ color: '#8a8a8a', fontSize: '14px', marginBottom: '16px' }}>
        Select Profile
      </div>

      {/* Profile Slots */}
      <div style={{ display: 'flex', gap: '12px', marginBottom: '16px', width: '100%', maxWidth: '500px' }}>
        {[0, 1, 2].map((slotIndex) => {
          const profile = profilesState.profiles[slotIndex];
          const isActive = profilesState.activeProfileId === slotIndex + 1;
          const isHovered = hoveredHomeSlot === slotIndex;
          const isEditHovered = hoveredEditLink === slotIndex;
          
          return (
            <button
              key={slotIndex}
              onClick={() => handleSlotClick(slotIndex, true)}
              onMouseEnter={() => setHoveredHomeSlot(slotIndex)}
              onMouseLeave={() => setHoveredHomeSlot(null)}
              style={{
                flex: 1,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'flex-start',
                gap: '4px',
                padding: '12px 14px',
                backgroundColor: isActive ? 'rgba(14, 114, 237, 0.15)' : isHovered ? '#2a2a2a' : '#242424',
                border: isActive ? '1px solid #0E72ED' : '1px solid #333333',
                borderRadius: '8px',
                cursor: 'pointer',
                transition: 'all 0.15s ease',
                position: 'relative'
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', width: '100%' }}>
                <User size={16} color={isActive ? '#0E72ED' : isHovered ? '#ffffff' : '#8a8a8a'} />
                <span style={{ 
                  color: isActive ? '#ffffff' : isHovered ? '#ffffff' : '#cccccc', 
                  fontSize: '14px', 
                  fontWeight: 500,
                  flex: 1,
                  textAlign: 'left'
                }}>
                  {profile ? (profile.context.profileName || profile.context.company || profile.context.role || `Profile ${slotIndex + 1}`) : `Slot ${slotIndex + 1}`}
                </span>
              </div>
              {profile && (
                <div style={{ display: 'flex', justifyContent: 'space-between', width: '100%', alignItems: 'center' }}>
                  <span style={{ color: '#666666', fontSize: '12px', marginLeft: '24px' }}>
                    {profile.context.role || 'No role'}
                  </span>
                  <span
                    onClick={(e) => {
                      e.stopPropagation();
                      setFormData(profile.context);
                      setProfilesState(prev => ({ ...prev, activeProfileId: (slotIndex + 1) as 1 | 2 | 3 }));
                      onNavigate?.('interview-details');
                    }}
                    onMouseEnter={() => setHoveredEditLink(slotIndex)}
                    onMouseLeave={() => setHoveredEditLink(null)}
                    style={{ 
                      color: isEditHovered ? '#0E72ED' : '#8a8a8a', 
                      fontSize: '11px', 
                      cursor: 'pointer',
                      transition: 'color 0.15s ease'
                    }}
                  >
                    Edit
                  </span>
                </div>
              )}
              {!profile && (
                <div style={{ color: '#555555', fontSize: '11px', marginLeft: '24px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <Plus size={10} /> Empty
                </div>
              )}
            </button>
          );
        })}
      </div>

      {/* Profile Indicator */}
      <div style={{ 
        marginBottom: '24px', 
        fontSize: '13px',
        display: 'flex',
        alignItems: 'center',
        gap: '6px'
      }}>
        {profilesState.activeProfileId !== null && activeProfile ? (
          <>
            <span style={{ color: '#4ade80' }}>✓</span>
            <span style={{ color: '#4ade80' }}>Using: {activeProfileName}</span>
          </>
        ) : (
          <span style={{ color: '#8a8a8a' }}>No profile selected</span>
        )}
      </div>

      {/* Action Buttons Grid */}
      <div style={{ display: 'flex', gap: '16px' }}>
        {/* Open Overlay Button */}
        <button
          onClick={handleOpenOverlay}
          disabled={isOverlayDisabled}
          onMouseEnter={() => setHoveredButton('overlay')}
          onMouseLeave={() => setHoveredButton(null)}
          title={profilesState.activeProfileId === null ? 'Select a profile first' : ''}
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: '16px',
            padding: '24px',
            borderRadius: '16px',
            border: 'none',
            backgroundColor: hoveredButton === 'overlay' && !isOverlayDisabled ? '#3a3a3a' : 'transparent',
            cursor: isOverlayDisabled ? 'not-allowed' : 'pointer',
            opacity: isOverlayDisabled ? 0.5 : 1,
            transition: 'all 0.2s'
          }}
        >
          <div style={{
            width: '80px',
            height: '80px',
            borderRadius: '16px',
            backgroundColor: '#F26D21',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            transform: hoveredButton === 'overlay' && !isOverlayDisabled ? 'scale(1.05)' : 'scale(1)',
            transition: 'transform 0.2s'
          }}>
            <Monitor style={{ width: '40px', height: '40px', color: '#ffffff' }} />
          </div>
          <span style={{ color: '#ffffff', fontWeight: 500 }}>Open Overlay</span>
        </button>

        {/* Interview Details Button */}
        <button
          onClick={handleInterviewDetails}
          onMouseEnter={() => setHoveredButton('details')}
          onMouseLeave={() => setHoveredButton(null)}
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: '16px',
            padding: '24px',
            borderRadius: '16px',
            border: 'none',
            backgroundColor: hoveredButton === 'details' ? '#3a3a3a' : 'transparent',
            cursor: 'pointer',
            transition: 'all 0.2s'
          }}
        >
          <div style={{
            width: '80px',
            height: '80px',
            borderRadius: '16px',
            backgroundColor: '#0E72ED',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            transform: hoveredButton === 'details' ? 'scale(1.05)' : 'scale(1)',
            transition: 'transform 0.2s'
          }}>
            <FileText style={{ width: '40px', height: '40px', color: '#ffffff' }} />
          </div>
          <span style={{ color: '#ffffff', fontWeight: 500 }}>Interview Details</span>
        </button>
      </div>

      {/* Status indicator */}
      {status !== AppStatus.IDLE && (
        <div style={{ marginTop: '32px', color: '#8a8a8a', fontSize: '14px' }}>
          {status === AppStatus.CONNECTING && 'Connecting...'}
          {status === AppStatus.CAPTURING && 'Setting up capture...'}
          {status === AppStatus.ANALYZING && 'Session active'}
        </div>
      )}

      {/* Screen Source Picker Modal */}
      {isPickerOpen && pickerSources && (
        <ScreenSourcePicker
          isOpen={isPickerOpen}
          sources={pickerSources}
          onSelect={handlePickerSelect}
          onCancel={handlePickerCancel}
        />
      )}
    </div>
  );
};

export default InterviewHome;
