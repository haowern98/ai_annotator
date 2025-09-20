import React, { useState } from 'react';
import { AppStatus } from '../types';
import { PlayIcon, StopIcon, LoadingIcon, ChevronDownIcon } from './icons';

interface ControlsProps {
  status: AppStatus;
  onStart: () => void;
  onStop: () => void;
}

const statusMap: Record<AppStatus, { text: string; icon: React.ReactElement; color: string; disabled: boolean }> = {
  [AppStatus.IDLE]: { text: 'Start Analysis', icon: <PlayIcon />, color: 'bg-blue-600 hover:bg-blue-700', disabled: false },
  [AppStatus.ERROR]: { text: 'Start Analysis', icon: <PlayIcon />, color: 'bg-blue-600 hover:bg-blue-700', disabled: false },
  [AppStatus.CAPTURING]: { text: 'Starting Capture...', icon: <LoadingIcon />, color: 'bg-gray-500', disabled: true },
  [AppStatus.CONNECTING]: { text: 'Connecting AI...', icon: <LoadingIcon />, color: 'bg-gray-500', disabled: true },
  [AppStatus.ANALYZING]: { text: 'Analysis in Progress', icon: <LoadingIcon />, color: 'bg-gray-500', disabled: true },
  [AppStatus.STOPPING]: { text: 'Stopping...', icon: <LoadingIcon />, color: 'bg-gray-500', disabled: true },
};

const Controls: React.FC<ControlsProps> = ({ status, onStart, onStop }) => {
  const isAnalyzing = status === AppStatus.ANALYZING;
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [selectedMode, setSelectedMode] = useState('Lecture Mode');
  const [isModeDropdownOpen, setIsModeDropdownOpen] = useState(false);

  return (
    <div className="bg-base-200 p-4 rounded-lg shadow-lg">
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="font-bold text-lg">Control Panel</h2>
            <button
              className="flex items-center gap-1 px-2 py-1 text-xs font-medium text-content-200 hover:bg-base-300/50 rounded transition-colors"
              onClick={() => setIsDropdownOpen(!isDropdownOpen)}
              aria-expanded={isDropdownOpen}
            >
              <ChevronDownIcon className={`w-4 h-4 transition-transform ${isDropdownOpen ? 'rotate-180' : ''}`} />
            </button>
          </div>
          <p className="text-sm text-content-200">Select your screen and start the analysis.</p>
        </div>
        <div className="flex items-center gap-4">
          <button
            onClick={onStart}
            disabled={statusMap[status].disabled}
            className={`flex items-center gap-2 px-4 py-2 text-white font-semibold rounded-md transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-base-100 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed ${statusMap[status].color}`}
          >
            {statusMap[status].icon}
            {statusMap[status].text}
          </button>
          <button
            onClick={onStop}
            disabled={!isAnalyzing}
            className="flex items-center gap-2 px-4 py-2 bg-red-600 text-white font-semibold rounded-md hover:bg-red-700 transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-base-100 focus:ring-red-500 disabled:bg-red-900/50 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <StopIcon />
            Stop Analysis
          </button>
        </div>
      </div>
      
      {isDropdownOpen && (
        <div className="mt-4 pt-4 border-t border-base-300">
          <div className="relative">
            <label className="block text-sm font-medium text-content-200 mb-2">Analysis Mode</label>
            <button
              className="w-full flex justify-between items-center p-3 text-left text-sm font-medium text-content-200 hover:bg-base-300/50 bg-base-300/30 rounded border border-base-300"
              onClick={() => setIsModeDropdownOpen(!isModeDropdownOpen)}
              aria-expanded={isModeDropdownOpen}
            >
              <span>{selectedMode}</span>
              <ChevronDownIcon className={`w-4 h-4 transition-transform ${isModeDropdownOpen ? 'rotate-180' : ''}`} />
            </button>
            
            {isModeDropdownOpen && (
              <div className="absolute top-full left-0 right-0 mt-1 bg-base-200 border border-base-300 rounded shadow-lg z-10">
                <button
                  className="w-full text-left px-3 py-2 text-sm text-content-200 hover:bg-base-300/50 first:rounded-t last:rounded-b"
                  onClick={() => {
                    setSelectedMode('Lecture Mode');
                    setIsModeDropdownOpen(false);
                  }}
                >
                  Lecture Mode
                </button>
                <button
                  className="w-full text-left px-3 py-2 text-sm text-content-200 hover:bg-base-300/50 first:rounded-t last:rounded-b"
                  onClick={() => {
                    setSelectedMode('Video Mode');
                    setIsModeDropdownOpen(false);
                  }}
                >
                  Video Mode
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default Controls;