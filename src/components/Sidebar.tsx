import React from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import {
  BarChart3,
  Server,
  Key,
  Terminal,
  Activity,
  FileText,
  Settings,
  ShieldCheck,
  X,
  HeartPulse,
} from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { fetchAccounts } from '../lib/api-client.js';

interface SidebarProps {
  mobileOpen?: boolean;
  onCloseMobile?: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({ mobileOpen, onCloseMobile }) => {
  const location = useLocation();

  // Fetch accounts count for live pool badge in sidebar
  const { data: accounts = [] } = useQuery({
    queryKey: ['accounts'],
    queryFn: fetchAccounts,
    staleTime: 10000,
  });

  const activeAccountsCount = accounts.filter((a) => a.status === 'ACTIVE').length;

  const navSections = [
    {
      title: 'Gateway',
      items: [
        { to: '/overview', label: 'Overview', icon: BarChart3, exact: true },
        { to: '/playground', label: 'Playground', icon: Terminal },
      ],
    },
    {
      title: 'Resources',
      items: [
        {
          to: '/accounts',
          label: 'Gemini Accounts',
          icon: Server,
          badge: activeAccountsCount > 0 ? `${activeAccountsCount} active` : undefined,
          isActiveMatcher: (path: string) => path.startsWith('/accounts'),
        },
        {
          to: '/keepalive',
          label: 'Keep-Alive',
          icon: HeartPulse,
          isActiveMatcher: (path: string) => path.startsWith('/keepalive'),
        },
        {
          to: '/api-keys',
          label: 'API Keys',
          icon: Key,
          isActiveMatcher: (path: string) => path.startsWith('/api-keys'),
        },
      ],
    },
    {
      title: 'Observability',
      items: [
        {
          to: '/logs',
          label: 'Request Logs',
          icon: Activity,
          isActiveMatcher: (path: string) => path.startsWith('/logs'),
        },
        {
          to: '/audit',
          label: 'Audit Trail',
          icon: FileText,
          isActiveMatcher: (path: string) => path.startsWith('/audit'),
        },
      ],
    },
    {
      title: 'System',
      items: [
        {
          to: '/settings',
          label: 'Settings & Guide',
          icon: Settings,
          isActiveMatcher: (path: string) => path.startsWith('/settings'),
        },
      ],
    },
  ];

  const sidebarContent = (
    <div className="flex flex-col h-full bg-white border-r border-zinc-200 select-none">
      {/* Brand Header */}
      <div className="flex items-center justify-between h-16 px-5 border-b border-zinc-200">
        <NavLink to="/overview" className="flex items-center gap-3 group focus:outline-none">
          <div className="w-9 h-9 rounded-xl bg-zinc-900 flex items-center justify-center text-white shadow-xs group-hover:bg-zinc-800 transition-colors">
            <ShieldCheck className="w-5 h-5 text-emerald-400" />
          </div>
          <div>
            <div className="flex items-center gap-1.5">
              <span className="font-semibold text-zinc-900 text-sm tracking-tight">Gemini Gateway</span>
              <span className="text-[10px] px-1.5 py-0.2 rounded bg-zinc-100 font-mono text-zinc-600 border border-zinc-200 font-medium">
                v1
              </span>
            </div>
            <p className="text-[11px] text-zinc-400">Web Session Proxy</p>
          </div>
        </NavLink>

        {onCloseMobile && (
          <button
            onClick={onCloseMobile}
            className="md:hidden p-1.5 rounded-lg text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100 transition-colors"
            aria-label="Close sidebar"
          >
            <X className="w-5 h-5" />
          </button>
        )}
      </div>

      {/* Navigation Sections */}
      <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-6" aria-label="Main navigation">
        {navSections.map((section) => (
          <div key={section.title}>
            <div className="px-3 text-[11px] font-semibold text-zinc-400 uppercase tracking-wider mb-2">
              {section.title}
            </div>
            <div className="space-y-1">
              {section.items.map((item) => {
                const Icon = item.icon;
                const isCurrentActive = item.isActiveMatcher
                  ? item.isActiveMatcher(location.pathname)
                  : item.exact
                  ? location.pathname === item.to
                  : location.pathname.startsWith(item.to);

                return (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    onClick={onCloseMobile}
                    aria-current={isCurrentActive ? 'page' : undefined}
                    className={`flex items-center justify-between px-3 py-2 rounded-xl text-sm font-medium transition-all group ${
                      isCurrentActive
                        ? 'bg-zinc-900 text-white shadow-xs'
                        : 'text-zinc-600 hover:text-zinc-900 hover:bg-zinc-100'
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      <Icon
                        className={`w-4 h-4 transition-colors ${
                          isCurrentActive ? 'text-white' : 'text-zinc-400 group-hover:text-zinc-700'
                        }`}
                      />
                      <span>{item.label}</span>
                    </div>

                    {item.badge && (
                      <span
                        className={`text-[10px] px-2 py-0.5 rounded-full font-mono font-medium ${
                          isCurrentActive
                            ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-400/30'
                            : 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                        }`}
                      >
                        {item.badge}
                      </span>
                    )}
                  </NavLink>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      {/* Footer System Status */}
      <div className="p-4 border-t border-zinc-200">
        <div className="p-3 rounded-xl bg-zinc-50 border border-zinc-200 flex items-center justify-between text-xs">
          <div className="flex items-center gap-2">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
            </span>
            <span className="font-medium text-zinc-700">Pool Running</span>
          </div>
          <span className="text-zinc-400 font-mono text-[11px]">
            {activeAccountsCount}/{accounts.length} Up
          </span>
        </div>
      </div>
    </div>
  );

  return (
    <>
      {/* Desktop Fixed Sidebar */}
      <aside className="hidden md:block w-64 shrink-0 h-screen sticky top-0">
        {sidebarContent}
      </aside>

      {/* Mobile Drawer Backdrop & Sidebar */}
      {mobileOpen && (
        <div className="md:hidden fixed inset-0 z-50 flex">
          <div
            className="fixed inset-0 bg-black/40 backdrop-blur-xs transition-opacity"
            onClick={onCloseMobile}
            aria-hidden="true"
          />
          <div className="relative flex-1 flex flex-col max-w-xs w-full bg-white shadow-xl z-10">
            {sidebarContent}
          </div>
        </div>
      )}
    </>
  );
};
