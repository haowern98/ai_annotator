import React, { useState, useEffect, useRef } from 'react';

import { ScreenSource } from '../utils/screenCapture';

interface ScreenSourcePickerProps {
  isOpen: boolean;
  sources: ScreenSource[];
  onSelect: (sourceId: string) => void;
  onCancel: () => void;
}

type TabType = 'window' | 'screen';

export function ScreenSourcePicker({ isOpen, sources, onSelect, onCancel }: ScreenSourcePickerProps) {
  const [selectedTab, setSelectedTab] = useState<TabType>('window');
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const firstSourceRef = useRef<HTMLButtonElement>(null);

  // Filter sources based on selected tab
  const filteredSources = sources.filter(source => {
    if (selectedTab === 'screen') {
      // Screens typically have "Screen" or "Entire Screen" in the name
      return source.name.toLowerCase().includes('screen') || source.display_id !== undefined;
    } else {
      // Windows are everything else
      return !source.name.toLowerCase().includes('entire screen');
    }
  });

  // Auto-select first source when tab changes
  useEffect(() => {
    if (filteredSources.length > 0) {
      setSelectedSourceId(filteredSources[0].id);
    } else {
      setSelectedSourceId(null);
    }
  }, [selectedTab, sources]);

  // Focus management
  useEffect(() => {
    if (isOpen && firstSourceRef.current) {
      firstSourceRef.current.focus();
    }
  }, [isOpen, selectedTab]);

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isOpen) return;

      if (e.key === 'Escape') {
        onCancel();
        return;
      }

      if (e.key === 'Enter' && selectedSourceId) {
        onSelect(selectedSourceId);
        return;
      }

      // Arrow key navigation
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault();
        const currentIndex = filteredSources.findIndex(s => s.id === selectedSourceId);
        let newIndex = currentIndex;

        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
          newIndex = (currentIndex + 1) % filteredSources.length;
        } else {
          newIndex = currentIndex - 1 < 0 ? filteredSources.length - 1 : currentIndex - 1;
        }

        setSelectedSourceId(filteredSources[newIndex].id);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, selectedSourceId, filteredSources, onSelect, onCancel]);

  // Close on backdrop click
  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onCancel();
    }
  };

  const handleShare = () => {
    if (selectedSourceId) {
      onSelect(selectedSourceId);
    }
  };

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 animate-in fade-in duration-200"
      onClick={handleBackdropClick}
      role="dialog"
      aria-modal="true"
      aria-labelledby="picker-title"
    >
      <div
        ref={dialogRef}
        className="bg-base-200 rounded-xl shadow-2xl border border-base-300 max-w-4xl w-full mx-4 max-h-[90vh] flex flex-col animate-in zoom-in-95 duration-200"
      >
        {/* Header */}
        <div className="p-6 pb-4">
          <h2 id="picker-title" className="text-2xl font-semibold text-content-100">
            Choose what to share with Live Lecture Summarizer
          </h2>
          <p className="text-sm text-content-200 mt-2">
            The app will be able to see the contents of your screen
          </p>
        </div>

        {/* Tab Navigation */}
        <div className="px-6">
          <div className="flex gap-1 border-b border-base-300">
            <button
              className={`px-4 py-2 text-sm font-medium transition-colors ${
                selectedTab === 'window'
                  ? 'border-b-2 border-brand-secondary text-content-100'
                  : 'text-content-200 hover:text-content-100'
              }`}
              onClick={() => setSelectedTab('window')}
              role="tab"
              aria-selected={selectedTab === 'window'}
            >
              Window
            </button>
            <button
              className={`px-4 py-2 text-sm font-medium transition-colors ${
                selectedTab === 'screen'
                  ? 'border-b-2 border-brand-secondary text-content-100'
                  : 'text-content-200 hover:text-content-100'
              }`}
              onClick={() => setSelectedTab('screen')}
              role="tab"
              aria-selected={selectedTab === 'screen'}
            >
              Entire Screen
            </button>
          </div>
        </div>

        {/* Source Grid */}
        <div className="p-6 overflow-y-auto flex-1">
          {filteredSources.length === 0 ? (
            <div className="text-center py-12 text-content-200">
              <p>No {selectedTab === 'screen' ? 'screens' : 'windows'} available</p>
            </div>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
              {filteredSources.map((source, index) => (
                <button
                  key={source.id}
                  ref={index === 0 ? firstSourceRef : null}
                  onClick={() => setSelectedSourceId(source.id)}
                  className={`relative group cursor-pointer rounded-lg overflow-hidden transition-all duration-200 ${
                    selectedSourceId === source.id
                      ? 'border-2 border-brand-secondary ring-2 ring-brand-secondary/50'
                      : 'border-2 border-base-300 hover:border-brand-secondary'
                  }`}
                  aria-label={`Share ${source.name}`}
                  aria-pressed={selectedSourceId === source.id}
                >
                  {/* Thumbnail */}
                  <div className="relative aspect-video bg-base-300">
                    <img
                      src={source.thumbnail}
                      alt={source.name}
                      className="w-full h-full object-cover group-hover:brightness-110 transition-all"
                    />

                    {/* Label Overlay */}
                    <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 via-black/60 to-transparent p-3 pt-6">
                      <div className="flex items-center gap-2">
                        {source.appIcon && (
                          <img
                            src={source.appIcon}
                            alt=""
                            className="w-5 h-5 flex-shrink-0"
                          />
                        )}
                        <span className="text-sm font-medium text-white truncate">
                          {source.name}
                        </span>
                      </div>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Action Buttons */}
        <div className="flex justify-end gap-3 p-6 pt-4 border-t border-base-300">
          <button
            onClick={onCancel}
            className="px-4 py-2 bg-base-300 hover:bg-base-300/80 text-content-100 rounded-lg transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleShare}
            disabled={!selectedSourceId}
            className="px-6 py-2 bg-brand-secondary hover:bg-brand-primary text-white rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Share
          </button>
        </div>
      </div>
    </div>
  );
}
