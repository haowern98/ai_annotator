
import React from 'react';
import { BrainCircuitIcon } from './icons';

const Header: React.FC = () => {
  return (
    <header className="bg-base-200/50 backdrop-blur-sm border-b border-base-300 shadow-md sticky top-0 z-10">
      <div className="container mx-auto px-4 md:px-6 py-4 flex items-center gap-4">
        <BrainCircuitIcon className="w-8 h-8 text-brand-secondary" />
        <div>
          <h1 className="text-xl md:text-2xl font-bold text-content-100 tracking-tight">
            Project ALEA
          </h1>
          <p className="text-sm text-content-200">Real-time screen analysis</p>
        </div>
      </div>
    </header>
  );
};

export default Header;
