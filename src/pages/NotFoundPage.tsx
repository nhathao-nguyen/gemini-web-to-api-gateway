import React from 'react';
import { Link } from 'react-router-dom';
import { Compass, ArrowLeft } from 'lucide-react';
import { useDocumentTitle } from '../hooks/useDocumentTitle.js';

export const NotFoundPage: React.FC = () => {
  useDocumentTitle('Page Not Found');

  return (
    <div className="min-h-screen bg-zinc-50 flex flex-col items-center justify-center p-4 font-sans selection:bg-zinc-900 selection:text-white">
      <div className="max-w-md w-full text-center space-y-4 bg-white p-8 rounded-3xl border border-zinc-200 shadow-sm">
        <div className="w-14 h-14 rounded-2xl bg-zinc-100 flex items-center justify-center text-zinc-500 mx-auto">
          <Compass className="w-7 h-7 text-zinc-700" />
        </div>
        <h1 className="text-3xl font-extrabold text-zinc-900 tracking-tight font-mono">404</h1>
        <h2 className="text-base font-semibold text-zinc-800">Page Not Found</h2>
        <p className="text-xs text-zinc-500 max-w-sm mx-auto leading-relaxed">
          The dashboard route you requested does not exist or may have been relocated.
        </p>
        <div className="pt-2">
          <Link
            to="/overview"
            className="inline-flex items-center gap-2 px-5 py-2.5 bg-zinc-900 text-white rounded-xl text-xs font-medium hover:bg-zinc-800 transition-colors shadow-xs"
          >
            <ArrowLeft className="w-4 h-4" />
            <span>Go to Overview</span>
          </Link>
        </div>
      </div>
    </div>
  );
};
