import React, { useState, useEffect } from 'react';
import { Search, Minus, Square, X, ChevronLeft, ChevronRight } from 'lucide-react';
import '../types'; // Import to ensure types are loaded

interface TitleBarProps {
  onSearch?: (query: string) => void;
  canGoBack?: boolean;
  canGoForward?: boolean;
  onBack?: () => void;
  onForward?: () => void;
}

export const TitleBar: React.FC<TitleBarProps> = ({ 
  onSearch,
  canGoBack = false,
  canGoForward = false,
  onBack,
  onForward
}) => {
  const [isMaximized, setIsMaximized] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [hoveredButton, setHoveredButton] = useState<string | null>(null);

  useEffect(() => {
    // Check initial maximized state
    const checkMaximized = async () => {
      if (window.electronAPI?.isMaximized) {
        const maximized = await window.electronAPI.isMaximized();
        setIsMaximized(maximized);
      }
    };
    checkMaximized();

    // Listen for maximize/unmaximize events from main process
    if ((window.electronAPI as any)?.onMaximizeChange) {
      (window.electronAPI as any).onMaximizeChange((maximized: boolean) => {
        setIsMaximized(maximized);
      });
    }
    
    return () => {
      if ((window.electronAPI as any)?.removeMaximizeChangeListener) {
        (window.electronAPI as any).removeMaximizeChangeListener();
      }
    };
  }, []);

  const handleMinimize = () => {
    window.electronAPI?.minimizeWindow?.();
  };

  const handleMaximize = () => {
    window.electronAPI?.maximizeWindow?.();
    // State will be updated by the onMaximizeChange event listener
  };

  const handleClose = () => {
    window.electronAPI?.closeWindow?.();
  };

  return (
    <div 
      style={{ 
        height: '46px',
        backgroundColor: '#202020',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        userSelect: 'none',
        borderRadius: '10px 10px 0 0',
        WebkitAppRegion: 'drag'
      } as React.CSSProperties}
    >
      {/* Left Section - Navigation Arrows */}
      <div 
        style={{ 
          display: 'flex',
          alignItems: 'center',
          height: '100%',
          marginLeft: '8px',
          gap: '4px',
          WebkitAppRegion: 'no-drag'
        } as React.CSSProperties}
      >
        {/* Back Button */}
        <button
          onClick={onBack}
          disabled={!canGoBack}
          onMouseEnter={() => setHoveredButton('back')}
          onMouseLeave={() => setHoveredButton(null)}
          style={{
            width: '32px',
            height: '32px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: hoveredButton === 'back' && canGoBack ? '#383838' : 'transparent',
            border: 'none',
            borderRadius: '6px',
            cursor: canGoBack ? 'pointer' : 'default',
            opacity: canGoBack ? 1 : 0.3,
            transition: 'all 0.15s',
            padding: 0
          }}
          title="Go back"
        >
          <ChevronLeft style={{ width: '24px', height: '24px', color: '#cccccc' }} />
        </button>

        {/* Forward Button */}
        <button
          onClick={onForward}
          disabled={!canGoForward}
          onMouseEnter={() => setHoveredButton('forward')}
          onMouseLeave={() => setHoveredButton(null)}
          style={{
            width: '32px',
            height: '32px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: hoveredButton === 'forward' && canGoForward ? '#383838' : 'transparent',
            border: 'none',
            borderRadius: '6px',
            cursor: canGoForward ? 'pointer' : 'default',
            opacity: canGoForward ? 1 : 0.3,
            transition: 'all 0.15s',
            padding: 0
          }}
          title="Go forward"
        >
          <ChevronRight style={{ width: '24px', height: '24px', color: '#cccccc' }} />
        </button>
      </div>

      {/* Center Section - Search */}
      <div 
        style={{ 
          position: 'absolute',
          left: '50%',
          transform: 'translateX(-50%)',
          display: 'flex',
          alignItems: 'center',
          WebkitAppRegion: 'no-drag'
        } as React.CSSProperties}
      >
        <div style={{
          display: 'flex',
          alignItems: 'center',
          backgroundColor: '#383838',
          borderRadius: '8px',
          padding: '6px 12px',
          gap: '8px'
        }}>
          <Search style={{ width: '16px', height: '16px', color: '#999999' }} />
          <input
            type="text"
            placeholder="Search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            style={{
              backgroundColor: 'transparent',
              border: 'none',
              outline: 'none',
              fontSize: '13px',
              color: '#cccccc',
              width: isMaximized ? '400px' : '200px',
              transition: 'width 0.2s ease'
            }}
          />
        </div>
      </div>

      {/* Right Section - Window Controls */}
      <div 
        style={{ 
          display: 'flex',
          alignItems: 'center',
          height: '100%',
          WebkitAppRegion: 'no-drag'
        } as React.CSSProperties}
      >
        {/* Minimize Button */}
        <button
          onClick={handleMinimize}
          onMouseEnter={() => setHoveredButton('min')}
          onMouseLeave={() => setHoveredButton(null)}
          style={{
            width: '46px',
            height: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: hoveredButton === 'min' ? '#383838' : 'transparent',
            border: 'none',
            cursor: 'pointer',
            padding: 0
          }}
          title="Minimize"
        >
          <Minus style={{ width: '16px', height: '16px', color: '#cccccc' }} />
        </button>

        {/* Maximize Button */}
        <button
          onClick={handleMaximize}
          onMouseEnter={() => setHoveredButton('max')}
          onMouseLeave={() => setHoveredButton(null)}
          style={{
            width: '46px',
            height: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: hoveredButton === 'max' ? '#383838' : 'transparent',
            border: 'none',
            cursor: 'pointer',
            padding: 0
          }}
          title={isMaximized ? "Restore" : "Maximize"}
        >
          <Square style={{ width: '12px', height: '12px', color: '#cccccc' }} />
        </button>

        {/* Close Button */}
        <button
          onClick={handleClose}
          onMouseEnter={() => setHoveredButton('close')}
          onMouseLeave={() => setHoveredButton(null)}
          style={{
            width: '46px',
            height: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: hoveredButton === 'close' ? '#e81123' : 'transparent',
            border: 'none',
            cursor: 'pointer',
            padding: 0
          }}
          title="Close"
        >
          <X style={{ width: '16px', height: '16px', color: hoveredButton === 'close' ? '#ffffff' : '#cccccc' }} />
        </button>
      </div>
    </div>
  );
};

export default TitleBar;
