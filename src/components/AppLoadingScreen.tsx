import React from 'react';
import { ShieldCheck, Loader2 } from 'lucide-react';

export const AppLoadingScreen: React.FC = () => {
  return (
    <div className="min-h-screen bg-zinc-50 flex flex-col items-center justify-center p-4 font-sans selection:bg-zinc-900 selection:text-white">
      <div className="flex flex-col items-center space-y-4 max-w-sm text-center">
        <div className="w-12 h-12 rounded-2xl bg-zinc-900 flex items-center justify-center text-white shadow-md animate-pulse">
          <ShieldCheck className="w-7 h-7 text-emerald-400" />
        </div>
        <div>
          <h1 className="text-lg font-bold text-zinc-900 tracking-tight">Gemini Web Gateway</h1>
          <p className="text-xs text-zinc-500 mt-1">Verifying secure admin session...</p>
        </div>
        <div className="flex items-center gap-2 text-xs text-zinc-400 font-mono">
          <Loader2 className="w-4 h-4 animate-spin text-zinc-600" />
          <span>Authenticating</span>
        </div>
      </div>
    </div>
  );
};
