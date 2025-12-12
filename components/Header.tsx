
import React, { useState, useEffect } from 'react';
import { BrainCircuitIcon } from './icons';

const Header: React.FC = () => {
  const [overlayHidden, setOverlayHidden] = useState<boolean>(false);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        if (window.electronAPI && typeof window.electronAPI.overlayExists === 'function') {
          const res = await window.electronAPI.overlayExists();
          if (mounted && res?.exists === true) setOverlayHidden(false);
        }
      } catch (e) {
        // ignore
      }
    })();
    return () => { mounted = false; };
  }, []);

  const toggleOverlay = async () => {
    try {
      if (!window.electronAPI) return;
      if (overlayHidden) {
        await window.electronAPI.showOverlay();
        setOverlayHidden(false);
      } else {
        await window.electronAPI.hideOverlay();
        setOverlayHidden(true);
      }
    } catch (e) {
      console.warn('Error toggling overlay:', e);
    }
  };

  return (
    <header className="bg-base-200/50 backdrop-blur-sm border-b border-base-300 shadow-md sticky top-0 z-10">
      <div className="container mx-auto px-4 md:px-6 py-4 flex items-center gap-4">
        <BrainCircuitIcon className="w-8 h-8 text-brand-secondary" />
        <div className="flex-1">
          <h1 className="text-xl md:text-2xl font-bold text-content-100 tracking-tight">
            Project ALEA
          </h1>
          <p className="text-sm text-content-200">Real-time screen analysis</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={toggleOverlay}
            className="btn btn-sm btn-ghost"
            title="Hide/show overlay for external sharing"
          >
            {overlayHidden ? 'Show Overlay' : 'Hide Overlay'}
          </button>
        </div>
      </div>
    </header>
  );
};

export default Header;
