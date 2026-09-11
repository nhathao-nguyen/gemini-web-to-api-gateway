import React from 'react';
import { Menu, LogOut, Activity } from 'lucide-react';
import { useLocation } from 'react-router-dom';
import { useAdminAuth } from '../hooks/useAdminAuth.js';
import { useQuery } from '@tanstack/react-query';
import { fetchAccounts } from '../lib/api-client.js';

interface HeaderProps {
  onOpenMobileMenu: () => void;
}

export const Header: React.FC<HeaderProps> = ({ onOpenMobileMenu }) => {
  const location = useLocation();
  const { logout } = useAdminAuth();

  const { data: accounts = [] } = useQuery({
    queryKey: ['accounts'],
    queryFn: fetchAccounts,
    staleTime: 10000,
  });

  const activeCount = accounts.filter((a) => a.status === 'ACTIVE').length;

  const getPageTitle = (pathname: string) => {
    if (pathname.startsWith('/overview')) return { title: 'Dashboard Overview', desc: 'Real-time proxy health & metrics' };
    if (pathname.startsWith('/accounts')) {
      if (pathname.split('/').length > 2) return { title: 'Account Details', desc: 'Inspect session and upstream state' };
      return { title: 'Gemini Accounts', desc: 'Manage authenticated upstream web sessions' };
    }
    if (pathname.startsWith('/api-keys')) {
      if (pathname.split('/').length > 2) return { title: 'API Key Details', desc: 'Rate limit policies and credentials' };
      return { title: 'API Keys', desc: 'Manage client authentication tokens' };
    }
    if (pathname.startsWith('/playground')) return { title: 'Interactive Playground', desc: 'Execute live OpenAI-compatible completions' };
    if (pathname.startsWith('/logs')) return { title: 'Request Logs', desc: 'HTTP request telemetry and upstream latency' };
    if (pathname.startsWith('/audit')) return { title: 'Audit Trail', desc: 'Account state transition audit log' };
    if (pathname.startsWith('/settings')) return { title: 'Settings & Integration', desc: 'System configuration and SDK guides' };
    return { title: 'Admin Console', desc: 'Gemini Web-to-API Gateway' };
  };

  const { title, desc } = getPageTitle(location.pathname);

  return (
    <header className="sticky top-0 z-30 bg-white/80 backdrop-blur-md border-b border-zinc-200">
      <div className="px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between gap-4">
        {/* Left: Mobile hamburger & Page Title */}
        <div className="flex items-center gap-3 min-w-0">
          <button
            onClick={onOpenMobileMenu}
            className="md:hidden p-2 rounded-xl text-zinc-600 hover:text-zinc-900 hover:bg-zinc-100 transition-colors"
            aria-label="Open navigation menu"
          >
            <Menu className="w-5 h-5" />
          </button>
          <div className="min-w-0">
            <h1 className="text-base sm:text-lg font-semibold text-zinc-900 tracking-tight truncate">
              {title}
            </h1>
            <p className="text-[11px] text-zinc-500 hidden sm:block truncate">{desc}</p>
          </div>
        </div>

        {/* Right: Quick actions & Logout */}
        <div className="flex items-center gap-3 shrink-0">
          <div className="hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-full bg-emerald-50 border border-emerald-200 text-xs font-medium text-emerald-800">
            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
            <span>{activeCount} Active Pool</span>
          </div>

          <button
            onClick={logout}
            title="Log out of Admin Dashboard"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-zinc-200 text-zinc-600 hover:text-zinc-900 hover:bg-zinc-100 text-xs font-medium transition-colors"
          >
            <LogOut className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Logout</span>
          </button>
        </div>
      </div>
    </header>
  );
};
