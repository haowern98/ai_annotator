import React, { useState } from 'react';

interface SidebarProps {
  defaultCollapsed?: boolean;
  onModeChange?: (mode: 'lecture' | 'interview') => void;
  currentMode?: 'lecture' | 'interview';
}

export const Sidebar: React.FC<SidebarProps> = ({ defaultCollapsed = false, onModeChange, currentMode = 'lecture' }) => {
  const [isCollapsed, setIsCollapsed] = useState(defaultCollapsed);

  return (
    <div
      className={`sidebar ${isCollapsed ? 'collapsed' : 'expanded'}`}
      style={{
        position: 'fixed',
        left: 0,
        top: 0,
        height: '100vh',
        width: isCollapsed ? '50px' : '300px',
        backgroundColor: '#0f172a',
        borderRight: '1px solid #334155',
        transition: 'width 0.3s ease',
        display: 'flex',
        flexDirection: 'column',
        zIndex: 1000,
      }}
    >
      {/* Toggle Button */}
      <button
        onClick={() => setIsCollapsed(!isCollapsed)}
        style={{
          position: 'absolute',
          top: '20px',
          left: '10px',
          background: 'transparent',
          border: 'none',
          color: '#fff',
          cursor: 'pointer',
          fontSize: '24px',
          padding: '5px',
          display: 'flex',
          flexDirection: 'column',
          gap: '4px',
        }}
      >
        <div style={{ width: '24px', height: '3px', backgroundColor: '#fff', borderRadius: '2px' }}></div>
        <div style={{ width: '24px', height: '3px', backgroundColor: '#fff', borderRadius: '2px' }}></div>
        <div style={{ width: '24px', height: '3px', backgroundColor: '#fff', borderRadius: '2px' }}></div>
      </button>

      {/* Sidebar Content */}
      <div
        style={{
          padding: isCollapsed ? '70px 0 0 0' : '70px 20px 20px 20px',
          color: '#fff',
          overflow: 'auto',
          display: 'flex',
          flexDirection: 'column',
          gap: '12px',
        }}
      >
        {/* Lecture Mode Button */}
        <button
          onClick={() => onModeChange?.('lecture')}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
            padding: isCollapsed ? '12px' : '12px 16px',
            backgroundColor: currentMode === 'lecture' ? '#1e40af' : 'transparent',
            border: 'none',
            borderRadius: '8px',
            color: '#fff',
            cursor: 'pointer',
            transition: 'background-color 0.2s',
            justifyContent: isCollapsed ? 'center' : 'flex-start',
            width: '100%',
          }}
          onMouseEnter={(e) => {
            if (currentMode !== 'lecture') {
              e.currentTarget.style.backgroundColor = '#1e293b';
            }
          }}
          onMouseLeave={(e) => {
            if (currentMode !== 'lecture') {
              e.currentTarget.style.backgroundColor = 'transparent';
            }
          }}
          title="Lecture Mode"
        >
          {/* Lecture Icon (Book/Document) */}
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
            <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
          </svg>
          {!isCollapsed && <span style={{ fontSize: '14px', fontWeight: '500' }}>Lecture Mode</span>}
        </button>

        {/* Interview Mode Button */}
        <button
          onClick={() => onModeChange?.('interview')}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
            padding: isCollapsed ? '12px' : '12px 16px',
            backgroundColor: currentMode === 'interview' ? '#1e40af' : 'transparent',
            border: 'none',
            borderRadius: '8px',
            color: '#fff',
            cursor: 'pointer',
            transition: 'background-color 0.2s',
            justifyContent: isCollapsed ? 'center' : 'flex-start',
            width: '100%',
          }}
          onMouseEnter={(e) => {
            if (currentMode !== 'interview') {
              e.currentTarget.style.backgroundColor = '#1e293b';
            }
          }}
          onMouseLeave={(e) => {
            if (currentMode !== 'interview') {
              e.currentTarget.style.backgroundColor = 'transparent';
            }
          }}
          title="Interview Mode"
        >
          {/* Interview Icon (Microphone) */}
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
            <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
            <line x1="12" y1="19" x2="12" y2="23" />
            <line x1="8" y1="23" x2="16" y2="23" />
          </svg>
          {!isCollapsed && <span style={{ fontSize: '14px', fontWeight: '500' }}>Interview Mode</span>}
        </button>
      </div>
    </div>
  );
};
