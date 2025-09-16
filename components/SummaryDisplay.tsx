import React, { useRef, useEffect } from 'react';
import { marked } from 'https://cdn.jsdelivr.net/npm/marked@12.0.2/lib/marked.esm.js';
import DOMPurify from 'https://cdn.jsdelivr.net/npm/dompurify@3.1.5/dist/purify.es.mjs';
import { Summary, AppStatus, LogEntry } from '../types';
import { BotMessageSquareIcon, SparklesIcon } from './icons';
import LogPanel from './LogPanel';

interface SummaryDisplayProps {
  summaries: Summary[];
  status: AppStatus;
  logs: LogEntry[];
}

const SummaryDisplay: React.FC<SummaryDisplayProps> = ({ summaries, status, logs }) => {
  const endOfMessagesRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endOfMessagesRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [summaries]);

  const getSanitizedHtml = (markdownText: string) => {
    const rawHtml = marked.parse(markdownText, { async: false }) as string;
    return DOMPurify.sanitize(rawHtml);
  };

  const renderContent = () => {
    if (summaries.length === 0) {
      if (status === AppStatus.ANALYZING || status === AppStatus.CONNECTING) {
        return (
          <div className="text-center p-8">
             <SparklesIcon className="w-12 h-12 text-brand-secondary mx-auto mb-4 animate-pulse" />
             <h3 className="text-lg font-semibold">Waiting for first summary...</h3>
             <p className="text-content-200 text-sm">The AI is analyzing the initial content. The first summary will appear shortly.</p>
          </div>
        );
      }
      return (
        <div className="text-center p-8">
          <BotMessageSquareIcon className="w-12 h-12 text-base-300 mx-auto mb-4" />
          <h3 className="text-lg font-semibold">Summaries will appear here</h3>
          <p className="text-content-200 text-sm">Start the analysis to get real-time summaries of your lecture.</p>
        </div>
      );
    }

    return (
      <div className="space-y-6 p-4">
        {summaries.map((summary) => (
          <div key={summary.id} className="flex items-start gap-4">
            <div className="flex-shrink-0 w-8 h-8 rounded-full bg-brand-primary flex items-center justify-center">
                <SparklesIcon className="w-5 h-5 text-white" />
            </div>
            <div className="flex-grow bg-base-300/50 p-3 rounded-lg rounded-tl-none">
              <div className="prose prose-sm prose-invert max-w-none text-content-100" dangerouslySetInnerHTML={{ __html: getSanitizedHtml(summary.text) }} />
              <p className="text-xs text-content-200/70 mt-2 text-right">{summary.timestamp}</p>
            </div>
          </div>
        ))}
         {status === AppStatus.ANALYZING && (
            <div className="flex items-center gap-4 animate-pulse">
                <div className="flex-shrink-0 w-8 h-8 rounded-full bg-brand-primary flex items-center justify-center">
                    <SparklesIcon className="w-5 h-5 text-white" />
                </div>
                <div className="flex-grow">
                    <div className="h-2.5 bg-base-300 rounded-full w-48 mb-2"></div>
                    <div className="h-2 bg-base-300 rounded-full w-full"></div>
                </div>
            </div>
         )}
      </div>
    );
  };

  return (
    <div className="bg-base-200 rounded-lg shadow-lg flex flex-col h-[30rem] lg:h-full max-h-[75vh]">
      <h2 className="text-lg font-bold p-4 border-b border-base-300">AI-Generated Summaries</h2>
      <div className="flex-grow overflow-y-auto">
        {renderContent()}
        <div ref={endOfMessagesRef} />
      </div>
      <LogPanel logs={logs} />
    </div>
  );
};

export default SummaryDisplay;