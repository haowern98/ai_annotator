
import React from 'react';
import { AppStatus } from '../types';
import { PlayIcon, StopIcon, LoadingIcon } from './icons';

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

  return (
    <div className="bg-base-200 p-4 rounded-lg shadow-lg flex items-center justify-between">
      <div>
        <h2 className="font-bold text-lg">Control Panel</h2>
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
  );
};

export default Controls;
