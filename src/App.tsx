import React, { useState, useEffect, useCallback } from 'react';
import { Navbar } from './components/Navbar.js';
import { AccountsView } from './components/AccountsView.js';
import { ApiKeysView } from './components/ApiKeysView.js';
import { PlaygroundView } from './components/PlaygroundView.js';
import { UsageLogsView } from './components/UsageLogsView.js';
import { DocsView } from './components/DocsView.js';
import { SafeAccount, ApiKeyItem, AnalyticsData, RequestLogItem, AccountEventItem } from './types/client.js';
import { adminFetch, loginAdmin, logoutAdmin } from './utils/api.js';
import {
  Server,
  Key,
  Terminal,
  Activity,
  CheckCircle2,
  AlertTriangle,
  ArrowRight,
  ShieldCheck,
  Cpu,
  Layers,
  Lock,
} from 'lucide-react';

export default function App() {
  const [activeTab, setActiveTab] = useState<'overview' | 'accounts' | 'api-keys' | 'playground' | 'logs' | 'docs'>(
    'overview'
  );

  const [accounts, setAccounts] = useState<SafeAccount[]>([]);
  const [apiKeys, setApiKeys] = useState<ApiKeyItem[]>([]);
  const [analytics, setAnalytics] = useState<AnalyticsData>({
    totalRequests: 0,
    successfulRequests: 0,
    errorRequests: 0,
    successRate: 0,
    avgLatency: 0,
    requestsByModel: {},
    requestsByAccount: {},
    requestsByApiKey: {},
  });
  const [logs, setLogs] = useState<RequestLogItem[]>([]);
  const [events, setEvents] = useState<AccountEventItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isAuthRequired, setIsAuthRequired] = useState(false);
  const [enteredAdminKey, setEnteredAdminKey] = useState('');
  const [authErrorMessage, setAuthErrorMessage] = useState('');

  const loadData = useCallback(async () => {
    try {
      const [accRes, keyRes, anaRes, logRes, evtRes] = await Promise.all([
        adminFetch('/api/admin/accounts').catch(() => null),
        adminFetch('/api/admin/api-keys').catch(() => null),
        adminFetch('/api/admin/analytics').catch(() => null),
        adminFetch('/api/admin/logs').catch(() => null),
        adminFetch('/api/admin/events').catch(() => null),
      ]);

      if (accRes?.status === 401) {
        setIsAuthRequired(true);
        return;
      }

      if (accRes?.ok) {
        setIsAuthRequired(false);
        const d = await accRes.json();
        setAccounts(d.accounts || []);
      }
      if (keyRes?.ok) {
        const d = await keyRes.json();
        setApiKeys(d.keys || []);
      }
      if (anaRes?.ok) {
        const d = await anaRes.json();
        setAnalytics(d);
      }
      if (logRes?.ok) {
        const d = await logRes.json();
        setLogs(d.logs || []);
      }
      if (evtRes?.ok) {
        const d = await evtRes.json();
        setEvents(d.events || []);
      }
    } finally {
      setIsLoading(false);
    }
  }, []);

  const handleAdminLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!enteredAdminKey.trim()) return;
    setAuthErrorMessage('');
    const res = await loginAdmin(enteredAdminKey.trim());
    if (res.success) {
      setIsAuthRequired(false);
      setEnteredAdminKey('');
      await loadData();
    } else {
      setAuthErrorMessage(res.error || 'Invalid admin credential. Please verify your configured ADMIN_PASSWORD.');
    }
  };

  const handleAdminLogout = async () => {
    await logoutAdmin();
    setIsAuthRequired(true);
    setAccounts([]);
    setApiKeys([]);
  };

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 6000);
    return () => clearInterval(interval);
  }, [loadData]);

  const activeAccountsCount = accounts.filter((a) => a.status === 'ACTIVE').length;

  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900 flex flex-col font-sans selection:bg-zinc-900 selection:text-white">
      {/* Top Navbar */}
      <Navbar
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        activeAccountsCount={activeAccountsCount}
        isAuthenticated={!isAuthRequired}
        onLogout={handleAdminLogout}
      />

      {/* Main Container */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {isAuthRequired ? (
          <div className="max-w-md mx-auto my-12 p-6 bg-white border border-zinc-200 rounded-2xl shadow-sm text-center">
            <div className="w-12 h-12 rounded-full bg-zinc-100 flex items-center justify-center mx-auto mb-4 text-zinc-700">
              <Lock className="w-6 h-6" />
            </div>
            <h2 className="text-xl font-bold text-zinc-900">Admin Authentication Required</h2>
            <p className="mt-2 text-sm text-zinc-500">
              This gateway dashboard is secured. Please enter the configured <code className="text-xs bg-zinc-100 px-1 py-0.5 rounded">ADMIN_API_KEY</code> or <code className="text-xs bg-zinc-100 px-1 py-0.5 rounded">ADMIN_PASSWORD</code> to unlock.
            </p>
            <form onSubmit={handleAdminLogin} className="mt-6 space-y-4">
              <div>
                <input
                  type="password"
                  placeholder="Enter Admin Key / Secret"
                  value={enteredAdminKey}
                  onChange={(e) => setEnteredAdminKey(e.target.value)}
                  className="w-full px-3.5 py-2.5 bg-zinc-50 border border-zinc-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-zinc-900"
                  required
                />
              </div>
              {authErrorMessage && (
                <div className="text-xs text-rose-600 bg-rose-50 p-2 rounded-lg border border-rose-200">
                  {authErrorMessage}
                </div>
              )}
              <button
                type="submit"
                className="w-full py-2.5 px-4 bg-zinc-900 text-white rounded-xl text-sm font-medium hover:bg-zinc-800 transition-colors shadow-xs"
              >
                Unlock Dashboard
              </button>
            </form>
          </div>
        ) : (
          <>
            {/* OVERVIEW TAB */}
        {activeTab === 'overview' && (
          <div className="space-y-8">
            {/* Hero / System Summary */}
            <div className="bg-white border border-zinc-200 rounded-2xl p-6 sm:p-8 shadow-xs">
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
                <div>
                  <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-zinc-100 text-xs font-semibold text-zinc-800 mb-3 border border-zinc-200">
                    <ShieldCheck className="w-4 h-4 text-emerald-600" /> Production Gemini Web Proxy
                  </div>
                  <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-zinc-900">
                    Gemini Web-to-API Gateway
                  </h1>
                  <p className="mt-2 text-sm sm:text-base text-zinc-500 max-w-2xl leading-relaxed">
                    Expose authenticated <code className="text-xs bg-zinc-100 px-1 py-0.5 rounded">gemini.google.com</code>{' '}
                    sessions as drop-in OpenAI-compatible chat endpoints with automatic failover, AES-256 cookie encryption,
                    and SSE streaming.
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-3">
                  <button
                    onClick={() => setActiveTab('playground')}
                    className="inline-flex items-center gap-2 px-4 py-2.5 bg-zinc-900 text-white rounded-xl text-sm font-medium hover:bg-zinc-800 transition-colors shadow-sm"
                  >
                    <Terminal className="w-4 h-4 text-emerald-400" />
                    Open Playground
                  </button>
                  <button
                    onClick={() => setActiveTab('accounts')}
                    className="inline-flex items-center gap-2 px-4 py-2.5 bg-white border border-zinc-200 text-zinc-700 rounded-xl text-sm font-medium hover:bg-zinc-50 transition-colors"
                  >
                    <Server className="w-4 h-4 text-zinc-500" />
                    Manage Pool
                  </button>
                </div>
              </div>

              {/* Status Grid */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-8 pt-6 border-t border-zinc-100">
                <div>
                  <span className="text-xs text-zinc-500 uppercase tracking-wider block font-medium">Pool Health</span>
                  <div className="flex items-center gap-2 mt-1">
                    <span className="w-2.5 h-2.5 rounded-full bg-emerald-500"></span>
                    <span className="text-xl font-bold text-zinc-900 font-mono">{activeAccountsCount} / {accounts.length}</span>
                  </div>
                  <span className="text-xs text-zinc-400">Active Gemini accounts</span>
                </div>

                <div>
                  <span className="text-xs text-zinc-500 uppercase tracking-wider block font-medium">Gateway Keys</span>
                  <div className="mt-1 text-xl font-bold text-zinc-900 font-mono">{apiKeys.filter((k) => k.enabled).length}</div>
                  <span className="text-xs text-zinc-400">Authenticated client keys</span>
                </div>

                <div>
                  <span className="text-xs text-zinc-500 uppercase tracking-wider block font-medium">Total Requests</span>
                  <div className="mt-1 text-xl font-bold text-zinc-900 font-mono">{analytics.totalRequests}</div>
                  <span className="text-xs text-zinc-400">{analytics.successRate}% success rate</span>
                </div>

                <div>
                  <span className="text-xs text-zinc-500 uppercase tracking-wider block font-medium">Avg Latency</span>
                  <div className="mt-1 text-xl font-bold text-zinc-900 font-mono">{analytics.avgLatency}ms</div>
                  <span className="text-xs text-zinc-400">Upstream round-trip</span>
                </div>
              </div>
            </div>

            {/* Architecture Flow Pipeline */}
            <div className="bg-white border border-zinc-200 rounded-2xl p-6 shadow-xs space-y-4">
              <div className="flex items-center gap-2 font-semibold text-zinc-900 text-base">
                <Layers className="w-5 h-5 text-zinc-700" />
                <span>Gateway Request Pipeline</span>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-5 gap-3 text-xs">
                <div className="p-4 rounded-xl bg-zinc-50 border border-zinc-200 flex flex-col justify-between">
                  <div>
                    <div className="font-semibold text-zinc-800 mb-1">1. Client Request</div>
                    <p className="text-zinc-500">
                      Standard OpenAI SDK calls <code className="font-mono">POST /v1/chat/completions</code> with{' '}
                      <code className="font-mono">Bearer sk-gmgw-...</code>
                    </p>
                  </div>
                  <span className="mt-3 text-[10px] text-zinc-400 font-mono uppercase">OpenAI Spec</span>
                </div>

                <div className="p-4 rounded-xl bg-zinc-50 border border-zinc-200 flex flex-col justify-between">
                  <div>
                    <div className="font-semibold text-zinc-800 mb-1">2. Auth & Rate Limits</div>
                    <p className="text-zinc-500">
                      SHA-256 key verification, sliding-window RPM check, and in-flight concurrency limiter.
                    </p>
                  </div>
                  <span className="mt-3 text-[10px] text-zinc-400 font-mono uppercase">Security Layer</span>
                </div>

                <div className="p-4 rounded-xl bg-zinc-50 border border-zinc-200 flex flex-col justify-between">
                  <div>
                    <div className="font-semibold text-zinc-800 mb-1">3. Weighted Scheduler</div>
                    <p className="text-zinc-500">
                      Evaluates account health, priority, weights, and active loads to select the optimal session.
                    </p>
                  </div>
                  <span className="mt-3 text-[10px] text-zinc-400 font-mono uppercase">Account Pool</span>
                </div>

                <div className="p-4 rounded-xl bg-zinc-50 border border-zinc-200 flex flex-col justify-between">
                  <div>
                    <div className="font-semibold text-zinc-800 mb-1">4. Gemini Web RPC</div>
                    <p className="text-zinc-500">
                      Decodes AES-256 cookie, queries <code className="font-mono">gemini.google.com</code> via{' '}
                      <code className="font-mono">StreamGenerate</code>.
                    </p>
                  </div>
                  <span className="mt-3 text-[10px] text-zinc-400 font-mono uppercase">Upstream Adapter</span>
                </div>

                <div className="p-4 rounded-xl bg-zinc-50 border border-zinc-200 flex flex-col justify-between">
                  <div>
                    <div className="font-semibold text-zinc-800 mb-1">5. OpenAI Response</div>
                    <p className="text-zinc-500">
                      Normalizes Gemini stream chunks into standard OpenAI SSE events and usage tokens.
                    </p>
                  </div>
                  <span className="mt-3 text-[10px] text-zinc-400 font-mono uppercase">Formatter</span>
                </div>
              </div>
            </div>

            {/* Quick Actions & Recent Activity */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {/* Accounts Card */}
              <div className="bg-white border border-zinc-200 rounded-2xl p-6 shadow-xs flex flex-col justify-between">
                <div>
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2 font-semibold text-zinc-900 text-sm">
                      <Server className="w-4 h-4 text-zinc-500" />
                      <span>Account Pool Status</span>
                    </div>
                    <button
                      onClick={() => setActiveTab('accounts')}
                      className="text-xs text-zinc-600 hover:text-zinc-900 flex items-center gap-1 font-medium"
                    >
                      View All <ArrowRight className="w-3 h-3" />
                    </button>
                  </div>

                  <div className="space-y-2.5 mt-4">
                    {accounts.slice(0, 3).map((acc) => (
                      <div
                        key={acc.id}
                        className="flex items-center justify-between p-3 rounded-xl bg-zinc-50 border border-zinc-200 text-xs"
                      >
                        <div>
                          <div className="font-medium text-zinc-900">{acc.name}</div>
                          <div className="text-zinc-400">{acc.email_label}</div>
                        </div>
                        <span className="font-mono text-zinc-600">{acc.status}</span>
                      </div>
                    ))}
                    {accounts.length === 0 && (
                      <p className="text-xs text-zinc-400 py-4 text-center">No accounts added yet.</p>
                    )}
                  </div>
                </div>

                <button
                  onClick={() => setActiveTab('accounts')}
                  className="mt-5 w-full py-2 bg-zinc-100 hover:bg-zinc-200 text-zinc-800 rounded-xl text-xs font-medium transition-colors"
                >
                  Configure Account Cookies
                </button>
              </div>

              {/* API Keys Card */}
              <div className="bg-white border border-zinc-200 rounded-2xl p-6 shadow-xs flex flex-col justify-between">
                <div>
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2 font-semibold text-zinc-900 text-sm">
                      <Key className="w-4 h-4 text-zinc-500" />
                      <span>Active Client API Keys</span>
                    </div>
                    <button
                      onClick={() => setActiveTab('api-keys')}
                      className="text-xs text-zinc-600 hover:text-zinc-900 flex items-center gap-1 font-medium"
                    >
                      View All <ArrowRight className="w-3 h-3" />
                    </button>
                  </div>

                  <div className="space-y-2.5 mt-4">
                    {apiKeys.slice(0, 3).map((k) => (
                      <div
                        key={k.id}
                        className="flex items-center justify-between p-3 rounded-xl bg-zinc-50 border border-zinc-200 text-xs"
                      >
                        <div>
                          <div className="font-medium text-zinc-900">{k.name}</div>
                          <div className="text-zinc-400 font-mono">{k.key_prefix}••••••••</div>
                        </div>
                        <span className="font-mono text-zinc-600">{k.rpm_limit} RPM</span>
                      </div>
                    ))}
                  </div>
                </div>

                <button
                  onClick={() => setActiveTab('api-keys')}
                  className="mt-5 w-full py-2 bg-zinc-100 hover:bg-zinc-200 text-zinc-800 rounded-xl text-xs font-medium transition-colors"
                >
                  Create & Manage API Keys
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ACCOUNTS TAB */}
        {activeTab === 'accounts' && <AccountsView accounts={accounts} onRefresh={loadData} />}

        {/* API KEYS TAB */}
        {activeTab === 'api-keys' && <ApiKeysView apiKeys={apiKeys} onRefresh={loadData} />}

        {/* PLAYGROUND TAB */}
        {activeTab === 'playground' && <PlaygroundView apiKeys={apiKeys} />}

        {/* LOGS TAB */}
        {activeTab === 'logs' && (
          <UsageLogsView analytics={analytics} logs={logs} events={events} onRefresh={loadData} />
        )}

        {/* DOCS TAB */}
        {activeTab === 'docs' && <DocsView />}
          </>
        )}
      </main>
    </div>
  );
}
