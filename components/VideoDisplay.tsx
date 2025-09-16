
import React from 'react';
import { AppStatus } from '../types';
import { ScreenShareIcon, LoadingIcon } from './icons';

interface VideoDisplayProps {
  stream: MediaStream | null;
  videoRef: React.RefObject<HTMLVideoElement>;
  status: AppStatus;
}

const VideoDisplay: React.FC<VideoDisplayProps> = ({ stream, videoRef, status }) => {
  if (stream) {
    if (videoRef.current && videoRef.current.srcObject !== stream) {
      videoRef.current.srcObject = stream;
    }
  }

  const showVideo = stream && (status === AppStatus.ANALYZING || status === AppStatus.CONNECTING || status === AppStatus.STOPPING);

  return (
    <div className="aspect-video bg-base-200 rounded-lg shadow-lg flex items-center justify-center relative overflow-hidden border-2 border-base-300">
      <video
        ref={videoRef}
        autoPlay
        className={`w-full h-full object-contain transition-opacity duration-300 ${showVideo ? 'opacity-100' : 'opacity-0'}`}
      />
      
      {!showVideo && (
        <div className="absolute inset-0 flex flex-col items-center justify-center text-center p-4">
            {status === AppStatus.CONNECTING || status === AppStatus.CAPTURING ? (
                <>
                    <LoadingIcon className="w-12 h-12 text-brand-secondary mb-4" />
                    <h3 className="text-xl font-semibold text-content-100">
                        {status === AppStatus.CAPTURING ? 'Waiting for Screen Selection...' : 'Connecting to AI Service...'}
                    </h3>
                    <p className="text-content-200 mt-1">Please follow browser prompts.</p>
                </>
            ) : (
                 <>
                    <ScreenShareIcon className="w-16 h-16 text-base-300 mb-4" />
                    <h3 className="text-xl font-semibold text-content-100">Screen Capture Preview</h3>
                    <p className="text-content-200 mt-1">Your selected screen will appear here once you start the analysis.</p>
                 </>
            )}
        </div>
      )}
    </div>
  );
};

export default VideoDisplay;