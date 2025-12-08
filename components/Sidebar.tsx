import React from 'react';
import { Mic, BookOpen, Clock, Settings } from 'lucide-react';

interface SidebarProps {
  onModeChange?: (mode: 'lecture' | 'interview' | 'history') => void;
  currentMode?: 'lecture' | 'interview' | 'history';
}

export const Sidebar: React.FC<SidebarProps> = ({ onModeChange, currentMode = 'lecture' }) => {
  const [hoveredButton, setHoveredButton] = React.useState<string | null>(null);

  const getButtonStyle = (mode: string): React.CSSProperties => {
    const isActive = currentMode === mode;
    const isHovered = hoveredButton === mode;
    
    return {
      position: 'relative',
      width: '34px',
      height: '34px',
      borderRadius: '8px',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      cursor: 'pointer',
      border: 'none',
      transition: 'all 0.2s',
      backgroundColor: isActive ? '#0E72ED' : (isHovered ? '#3a3a3a' : 'transparent'),
      color: isActive ? '#ffffff' : (isHovered ? '#ffffff' : '#8a8a8a'),
    };
  };

  return (
    <div style={{
      width: '46px',
      backgroundColor: '#232323',
      borderRight: '1px solid #3a3a3a',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      padding: '12px 0',
      gap: '8px'
    }}>
      {/* Interview Mode Button */}
      <button
        onClick={() => onModeChange?.('interview')}
        style={getButtonStyle('interview')}
        onMouseEnter={() => setHoveredButton('interview')}
        onMouseLeave={() => setHoveredButton(null)}
        title="Interview Mode"
      >
        {/* Active indicator bar */}
        {currentMode === 'interview' && (
          <div style={{
            position: 'absolute',
            left: 0,
            top: '50%',
            transform: 'translateY(-50%)',
            width: '3px',
            height: '16px',
            backgroundColor: '#0E72ED',
            borderRadius: '0 3px 3px 0'
          }} />
        )}
        <Mic style={{ width: '18px', height: '18px' }} />
      </button>

      {/* Lecture Mode Button */}
      <button
        onClick={() => onModeChange?.('lecture')}
        style={getButtonStyle('lecture')}
        onMouseEnter={() => setHoveredButton('lecture')}
        onMouseLeave={() => setHoveredButton(null)}
        title="Lecture Mode"
      >
        {/* Active indicator bar */}
        {currentMode === 'lecture' && (
          <div style={{
            position: 'absolute',
            left: 0,
            top: '50%',
            transform: 'translateY(-50%)',
            width: '3px',
            height: '16px',
            backgroundColor: '#0E72ED',
            borderRadius: '0 3px 3px 0'
          }} />
        )}
        <BookOpen style={{ width: '18px', height: '18px' }} />
      </button>

      {/* History Mode Button */}
      <button
        onClick={() => onModeChange?.('history')}
        style={getButtonStyle('history')}
        onMouseEnter={() => setHoveredButton('history')}
        onMouseLeave={() => setHoveredButton(null)}
        title="History"
      >
        {/* Active indicator bar */}
        {currentMode === 'history' && (
          <div style={{
            position: 'absolute',
            left: 0,
            top: '50%',
            transform: 'translateY(-50%)',
            width: '3px',
            height: '16px',
            backgroundColor: '#0E72ED',
            borderRadius: '0 3px 3px 0'
          }} />
        )}
        <Clock style={{ width: '18px', height: '18px' }} />
      </button>

      {/* Spacer */}
      <div style={{ flex: 1 }} />

      {/* Settings Button */}
      <button
        style={{
          width: '34px',
          height: '34px',
          borderRadius: '8px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'pointer',
          border: 'none',
          backgroundColor: hoveredButton === 'settings' ? '#3a3a3a' : 'transparent',
          color: hoveredButton === 'settings' ? '#ffffff' : '#8a8a8a',
          transition: 'all 0.2s'
        }}
        onMouseEnter={() => setHoveredButton('settings')}
        onMouseLeave={() => setHoveredButton(null)}
        title="Settings"
      >
        <Settings style={{ width: '18px', height: '18px' }} />
      </button>
    </div>
  );
};
