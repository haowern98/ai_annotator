import React, { useState, useRef, useEffect } from 'react';
import { LogEntry, LogLevel } from '../types';
import { ChevronDownIcon, FileTextIcon } from './icons';

interface LogPanelProps {
  logs: LogEntry[];
}

const logLevelColors: Record<LogLevel, string> = {
  [LogLevel.INFO]: 'text-gray-400',
  [LogLevel.SUCCESS]: 'text-green-400',
  [LogLevel.WARN]: 'text-yellow-400',
  [LogLevel.ERROR]: 'text-red-400',
};

const LogPanel: React.FC<LogPanelProps> = ({ logs }) => {
  const [isOpen, setIsOpen] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs]);

  return (
    <div className="border-t border-base-300 bg-base-200/50">
      <button
        className="w-full flex justify-between items-center p-3 text-left text-sm font-medium text-content-200 hover:bg-base-300/50"
        onClick={() => setIsOpen(!isOpen)}
        aria-expanded={isOpen}
      >
        <div className="flex items-center gap-2">
            <FileTextIcon className="w-4 h-4" />
            <span>Live Logs</span>
        </div>
        <ChevronDownIcon className={`w-5 h-5 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </button>
      {isOpen && (
        <div ref={scrollRef} className="bg-base-100/50 h-48 overflow-y-auto p-3 font-mono text-xs">
          {logs.length === 0 ? (
            <p className="text-gray-500">No logs yet. Start the analysis to see output.</p>
          ) : (
            <ul className="space-y-1">
              {logs.map((log) => (
                <li key={log.id} className="flex gap-2 items-start">
                  <span className="text-gray-500 flex-shrink-0">{log.timestamp}</span>
                  <span className={`flex-shrink-0 font-bold ${logLevelColors[log.level]}`}>
                    [{log.level}]
                  </span>
                  <span className={`whitespace-pre-wrap break-all ${logLevelColors[log.level]}`}>
                    {log.message}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
};

export default LogPanel;