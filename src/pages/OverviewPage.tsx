import React from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Server,
  Key,
  Terminal,
  ShieldCheck,
  Layers,
  ArrowRight,
  TrendingUp,
  Clock,
  CheckCircle2,
  RefreshCw,
} from 'lucide-react';
import { fetchAccounts, fetchApiKeys, fetchAnalytics } from '../lib/api-client.js';
import { useDocumentTitle } from '../hooks/useDocumentTitle.js';
import { ErrorState } from '../components/ErrorState.js';

export const OverviewPage: React.FC = () => {
  useDocumentTitle('Overview');

  const {
    data: accounts = [],
    isLoading: loadingAccounts,
    isError: errorAccounts,
    refetch: refetchAccounts,
  } = useQuery({
    queryKey: ['accounts'],
    queryFn: fetchAccounts,
  });

  const {
    data: apiKeys = [],
    isLoading: loadingKeys,
    isError: errorKeys,
    refetch: refetchKeys,
  } = useQuery({
    queryKey: ['api-keys'],
    queryFn: fetchApiKeys,
  });

  const {
    data: analytics = {
      totalRequests: 0,
      successfulRequests: 0,
      errorRequests: 0,
      successRate: 0,
      avgLatency: 0,
      requestsByModel: {},
      requestsByAccount: {},
      requestsByApiKey: {},
    },
    isLoading: loadingAnalytics,
    isError: errorAnalytics,
    refetch: refetchAnalytics,
  } = useQuery({
    queryKey: ['analytics'],
    queryFn: fetchAnalytics,
    refetchInterval: 6000,
  });

  const activeAccountsCount = accounts.filter((a) => a.status === 'ACTIVE').length;
  const activeKeysCount = apiKeys.filter((k) => k.enabled).length;

  const handleRefreshAll = () => {
    refetchAccounts();
    refetchKeys();
    refetchAnalytics();
  };

  if (errorAccounts && errorKeys && errorAnalytics) {
    return (
      <ErrorState
        title="Could not connect to Gateway"
        message="Failed to fetch initial telemetry from backend server."
        onRetry={handleRefreshAll}
      />
    );
  }

  return (
    <div className="space-y-8">
      {/* Hero Banner */}
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
              Expose authenticated <code className="text-xs bg-zinc-100 px-1.5 py-0.5 rounded text-zinc-800 font-mono">gemini.google.com</code>{' '}
              sessions as drop-in OpenAI-compatible chat endpoints with automatic failover, AES-256 cookie encryption,
              and SSE streaming.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Link
              to="/playground"
              className="inline-flex items-center gap-2 px-4 py-2.5 bg-zinc-900 text-white rounded-xl text-sm font-medium hover:bg-zinc-800 transition-colors shadow-sm"
            >
              <Terminal className="w-4 h-4 text-emerald-400" />
              Open Playground
            </Link>
            <Link
              to="/accounts"
              className="inline-flex items-center gap-2 px-4 py-2.5 bg-white border border-zinc-200 text-zinc-700 rounded-xl text-sm font-medium hover:bg-zinc-50 transition-colors"
            >
              <Server className="w-4 h-4 text-zinc-500" />
              Manage Pool
            </Link>
          </div>
        </div>

        {/* Status Metric Cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-8 pt-6 border-t border-zinc-100">
          <Link
            to="/accounts?status=ACTIVE"
            className="p-3.5 rounded-xl hover:bg-zinc-50 transition-colors group border border-transparent hover:border-zinc-200"
          >
            <div className="flex items-center justify-between">
              <span className="text-xs text-zinc-500 uppercase tracking-wider block font-medium">Pool Health</span>
              <ArrowRight className="w-3.5 h-3.5 text-zinc-300 group-hover:text-zinc-700 transition-colors" />
            </div>
            <div className="flex items-center gap-2 mt-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-emerald-500"></span>
              <span className="text-xl font-bold text-zinc-900 font-mono">
                {loadingAccounts ? '...' : `${activeAccountsCount} / ${accounts.length}`}
              </span>
            </div>
            <span className="text-xs text-zinc-400 mt-0.5 block">Active Gemini accounts</span>
          </Link>

          <Link
            to="/api-keys?status=enabled"
            className="p-3.5 rounded-xl hover:bg-zinc-50 transition-colors group border border-transparent hover:border-zinc-200"
          >
            <div className="flex items-center justify-between">
              <span className="text-xs text-zinc-500 uppercase tracking-wider block font-medium">Gateway Keys</span>
              <ArrowRight className="w-3.5 h-3.5 text-zinc-300 group-hover:text-zinc-700 transition-colors" />
            </div>
            <div className="mt-1.5 text-xl font-bold text-zinc-900 font-mono">
              {loadingKeys ? '...' : activeKeysCount}
            </div>
            <span className="text-xs text-zinc-400 mt-0.5 block">Active client API keys</span>
          </Link>

          <Link
            to="/logs"
            className="p-3.5 rounded-xl hover:bg-zinc-50 transition-colors group border border-transparent hover:border-zinc-200"
          >
            <div className="flex items-center justify-between">
              <span className="text-xs text-zinc-500 uppercase tracking-wider block font-medium">Total Requests</span>
              <ArrowRight className="w-3.5 h-3.5 text-zinc-300 group-hover:text-zinc-700 transition-colors" />
            </div>
            <div className="mt-1.5 text-xl font-bold text-zinc-900 font-mono">
              {loadingAnalytics ? '...' : analytics.totalRequests}
            </div>
            <span className="text-xs text-zinc-400 mt-0.5 block">{analytics.successRate}% success rate</span>
          </Link>

          <Link
            to="/logs"
            className="p-3.5 rounded-xl hover:bg-zinc-50 transition-colors group border border-transparent hover:border-zinc-200"
          >
            <div className="flex items-center justify-between">
              <span className="text-xs text-zinc-500 uppercase tracking-wider block font-medium">Avg Latency</span>
              <ArrowRight className="w-3.5 h-3.5 text-zinc-300 group-hover:text-zinc-700 transition-colors" />
            </div>
            <div className="mt-1.5 text-xl font-bold text-zinc-900 font-mono">
              {loadingAnalytics ? '...' : `${analytics.avgLatency}ms`}
            </div>
            <span className="text-xs text-zinc-400 mt-0.5 block">Upstream round-trip</span>
          </Link>
        </div>
      </div>

      {/* Architecture Pipeline Flow */}
      <div className="bg-white border border-zinc-200 rounded-2xl p-6 shadow-xs space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 font-semibold text-zinc-900 text-base">
            <Layers className="w-5 h-5 text-zinc-700" />
            <span>Gateway Request Pipeline</span>
          </div>
          <button
            onClick={handleRefreshAll}
            className="text-xs text-zinc-500 hover:text-zinc-800 flex items-center gap-1 font-medium transition-colors"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            <span>Refresh Telemetry</span>
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-5 gap-3 text-xs">
          <div className="p-4 rounded-xl bg-zinc-50 border border-zinc-200 flex flex-col justify-between">
            <div>
              <div className="font-semibold text-zinc-800 mb-1">1. Client Request</div>
              <p className="text-zinc-500">
                Standard OpenAI SDK calls <code className="font-mono text-zinc-700">POST /v1/chat/completions</code> with{' '}
                <code className="font-mono text-zinc-700">Bearer sk-gmgw-...</code>
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
                Decodes AES-256 cookie, queries <code className="font-mono text-zinc-700">gemini.google.com</code> via{' '}
                <code className="font-mono text-zinc-700">StreamGenerate</code>.
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

      {/* Quick Action Preview Panels */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Accounts Card */}
        <div className="bg-white border border-zinc-200 rounded-2xl p-6 shadow-xs flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2 font-semibold text-zinc-900 text-sm">
                <Server className="w-4 h-4 text-zinc-500" />
                <span>Account Pool Preview</span>
              </div>
              <Link
                to="/accounts"
                className="text-xs text-zinc-600 hover:text-zinc-900 flex items-center gap-1 font-medium"
              >
                View All <ArrowRight className="w-3 h-3" />
              </Link>
            </div>

            <div className="space-y-2.5 mt-4">
              {accounts.slice(0, 3).map((acc) => (
                <Link
                  key={acc.id}
                  to={`/accounts/${acc.id}`}
                  className="flex items-center justify-between p-3 rounded-xl bg-zinc-50 border border-zinc-200 text-xs hover:bg-zinc-100/70 transition-colors"
                >
                  <div>
                    <div className="font-medium text-zinc-900">{acc.name}</div>
                    <div className="text-zinc-400">{acc.email_label}</div>
                  </div>
                  <span className="font-mono text-zinc-600 font-medium">{acc.status}</span>
                </Link>
              ))}
              {accounts.length === 0 && (
                <p className="text-xs text-zinc-400 py-6 text-center">No accounts added yet.</p>
              )}
            </div>
          </div>

          <Link
            to="/accounts"
            className="mt-5 w-full py-2 bg-zinc-100 hover:bg-zinc-200 text-zinc-800 rounded-xl text-xs font-medium transition-colors text-center block"
          >
            Configure Account Cookies
          </Link>
        </div>

        {/* API Keys Card */}
        <div className="bg-white border border-zinc-200 rounded-2xl p-6 shadow-xs flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2 font-semibold text-zinc-900 text-sm">
                <Key className="w-4 h-4 text-zinc-500" />
                <span>Active API Keys</span>
              </div>
              <Link
                to="/api-keys"
                className="text-xs text-zinc-600 hover:text-zinc-900 flex items-center gap-1 font-medium"
              >
                View All <ArrowRight className="w-3 h-3" />
              </Link>
            </div>

            <div className="space-y-2.5 mt-4">
              {apiKeys.slice(0, 3).map((k) => (
                <Link
                  key={k.id}
                  to={`/api-keys/${k.id}`}
                  className="flex items-center justify-between p-3 rounded-xl bg-zinc-50 border border-zinc-200 text-xs hover:bg-zinc-100/70 transition-colors"
                >
                  <div>
                    <div className="font-medium text-zinc-900">{k.name}</div>
                    <div className="text-zinc-400 font-mono">{k.key_prefix}••••••••</div>
                  </div>
                  <span className="font-mono text-zinc-600">{k.rpm_limit} RPM</span>
                </Link>
              ))}
              {apiKeys.length === 0 && (
                <p className="text-xs text-zinc-400 py-6 text-center">No API keys generated yet.</p>
              )}
            </div>
          </div>

          <Link
            to="/api-keys"
            className="mt-5 w-full py-2 bg-zinc-100 hover:bg-zinc-200 text-zinc-800 rounded-xl text-xs font-medium transition-colors text-center block"
          >
            Create & Manage API Keys
          </Link>
        </div>
      </div>
    </div>
  );
};
