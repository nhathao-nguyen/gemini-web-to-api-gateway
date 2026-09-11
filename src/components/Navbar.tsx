import React from 'react';
import { Server, Key, Terminal, BarChart3, BookOpen, ShieldCheck, Activity, LogOut } from 'lucide-react';

interface NavbarProps {
  activeTab: 'overview' | 'accounts' | 'api-keys' | 'playground' | 'logs' | 'docs';
  setActiveTab: (tab: 'overview' | 'accounts' | 'api-keys' | 'playground' | 'logs' | 'docs') => void;
  activeAccountsCount: number;
  isAuthenticated?: boolean;
  onLogout?: () => void;
}

export const Navbar: React.FC<NavbarProps> = ({
  activeTab,
  setActiveTab,
  activeAccountsCount,
  isAuthenticated,
  onLogout,
}) => {
  const tabs = [
    { id: 'overview', label: 'Overview', icon: BarChart3 },
    { id: 'accounts', label: 'Gemini Accounts', icon: Server },
    { id: 'api-keys', label: 'API Keys', icon: Key },
    { id: 'playground', label: 'Playground', icon: Terminal },
    { id: 'logs', label: 'Logs & Events', icon: Activity },
    { id: 'docs', label: 'SDK Guide', icon: BookOpen },
  ] as const;

  return (
    <header className="border-b border-zinc-200 bg-white sticky top-0 z-40">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          {/* Brand Logo & Title */}
          <div className="flex items-center space-x-3">
            <div className="w-10 h-10 rounded-xl bg-zinc-900 flex items-center justify-center text-white shadow-sm">
              <ShieldCheck className="w-5 h-5 text-emerald-400" />
            </div>
            <div>
              <div className="flex items-center space-x-2">
                <span className="font-semibold text-zinc-900 tracking-tight text-base">Gemini Web Gateway</span>
                <span className="text-[11px] px-2 py-0.5 rounded-full bg-zinc-100 font-medium text-zinc-600 border border-zinc-200">
                  OpenAI v1
                </span>
              </div>
              <p className="text-xs text-zinc-500">Reverse-engineered Gemini Session Proxy</p>
            </div>
          </div>

          {/* Navigation Items */}
          <nav className="hidden md:flex space-x-1">
            {tabs.map((tab) => {
              const Icon = tab.icon;
              const isActive = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`flex items-center space-x-2 px-3.5 py-2 rounded-lg text-sm font-medium transition-colors ${
                    isActive
                      ? 'bg-zinc-900 text-white'
                      : 'text-zinc-600 hover:text-zinc-900 hover:bg-zinc-100'
                  }`}
                >
                  <Icon className="w-4 h-4" />
                  <span>{tab.label}</span>
                </button>
              );
            })}
          </nav>

          {/* Status Indicator & Logout */}
          <div className="flex items-center space-x-3">
            <div className="flex items-center space-x-2 px-3 py-1.5 rounded-full bg-emerald-50 border border-emerald-200 text-xs font-medium text-emerald-800">
              <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
              <span>{activeAccountsCount} Active Pool</span>
            </div>
            {isAuthenticated && onLogout && (
              <button
                onClick={onLogout}
                title="Log out of Admin Dashboard"
                className="p-2 rounded-lg border border-zinc-200 text-zinc-600 hover:text-zinc-900 hover:bg-zinc-100 text-xs flex items-center gap-1.5 transition-colors"
              >
                <LogOut className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Logout</span>
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Mobile navigation tab scroll */}
      <div className="flex md:hidden overflow-x-auto border-t border-zinc-100 px-4 py-2 space-x-2">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center space-x-1.5 px-3 py-1.5 rounded-md text-xs font-medium whitespace-nowrap ${
                isActive ? 'bg-zinc-900 text-white' : 'bg-zinc-100 text-zinc-600'
              }`}
            >
              <Icon className="w-3.5 h-3.5" />
              <span>{tab.label}</span>
            </button>
          );
        })}
      </div>
    </header>
  );
};
