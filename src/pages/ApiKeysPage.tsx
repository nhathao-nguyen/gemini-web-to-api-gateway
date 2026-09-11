import React, { useState, useMemo } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Key,
  Plus,
  Copy,
  Check,
  Trash2,
  AlertCircle,
  RefreshCw,
  Search,
  ArrowUpRight,
} from 'lucide-react';
import {
  fetchApiKeys,
  createApiKey,
  updateApiKey,
  deleteApiKey,
} from '../lib/api-client.js';
import { ApiKeyItem } from '../types/client.js';
import { useDocumentTitle } from '../hooks/useDocumentTitle.js';
import { EmptyState } from '../components/EmptyState.js';
import { ErrorState } from '../components/ErrorState.js';

export const ApiKeysPage: React.FC = () => {
  useDocumentTitle('API Keys');
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();

  const statusFilter = searchParams.get('status') || 'ALL';
  const searchQuery = searchParams.get('q') || '';

  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [createdPlainKey, setCreatedPlainKey] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState(false);

  // Form states
  const [name, setName] = useState('');
  const [rpmLimit, setRpmLimit] = useState(60);
  const [concurrentLimit, setConcurrentLimit] = useState(5);
  const [dailyLimit, setDailyLimit] = useState(5000);
  const [expiresInDays, setExpiresInDays] = useState(0);

  const {
    data: apiKeys = [],
    isLoading,
    isError,
    error,
    refetch,
    isFetching,
  } = useQuery({
    queryKey: ['api-keys'],
    queryFn: fetchApiKeys,
  });

  const createMutation = useMutation({
    mutationFn: createApiKey,
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['api-keys'] });
      setCreatedPlainKey(data.apiKey);
      setIsCreateModalOpen(false);
      setName('');
    },
    onError: (err: any) => {
      alert(`Failed to create API key: ${err.message}`);
    },
  });

  const toggleMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      updateApiKey(id, { enabled }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['api-keys'] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: deleteApiKey,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['api-keys'] });
    },
  });

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    createMutation.mutate({
      name,
      allowed_models: ['*'],
      rpm_limit: Number(rpmLimit),
      concurrent_limit: Number(concurrentLimit),
      daily_request_limit: Number(dailyLimit),
      expires_in_days: expiresInDays > 0 ? Number(expiresInDays) : undefined,
    });
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(true);
    setTimeout(() => setCopiedKey(false), 2500);
  };

  const updateFilters = (newStatus?: string, newSearch?: string) => {
    const params = new URLSearchParams(searchParams);
    if (newStatus !== undefined) {
      if (newStatus === 'ALL') params.delete('status');
      else params.set('status', newStatus);
    }
    if (newSearch !== undefined) {
      if (!newSearch) params.delete('q');
      else params.set('q', newSearch);
    }
    setSearchParams(params);
  };

  const filteredKeys = useMemo(() => {
    return apiKeys.filter((k) => {
      const matchesStatus =
        statusFilter === 'ALL' ||
        (statusFilter === 'enabled' && k.enabled) ||
        (statusFilter === 'disabled' && !k.enabled);
      const matchesSearch =
        !searchQuery ||
        k.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        k.key_prefix.toLowerCase().includes(searchQuery.toLowerCase());
      return matchesStatus && matchesSearch;
    });
  }, [apiKeys, statusFilter, searchQuery]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-zinc-900 tracking-tight">Gateway API Keys</h2>
          <p className="text-sm text-zinc-500">
            Generate client keys for OpenAI SDKs and external applications. Keys are stored as SHA-256 hashes.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => refetch()}
            disabled={isFetching}
            className="inline-flex items-center gap-2 px-3 py-2 text-sm font-medium text-zinc-700 bg-white border border-zinc-200 rounded-xl hover:bg-zinc-50 transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 text-zinc-500 ${isFetching ? 'animate-spin' : ''}`} />
            <span>Refresh</span>
          </button>
          <button
            onClick={() => {
              setCreatedPlainKey(null);
              setIsCreateModalOpen(true);
            }}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-zinc-900 rounded-xl hover:bg-zinc-800 transition-colors shadow-xs"
          >
            <Plus className="w-4 h-4" />
            <span>Generate New Key</span>
          </button>
        </div>
      </div>

      {/* SINGLE-TIME DISPLAY BANNER FOR NEWLY CREATED KEY */}
      {createdPlainKey && (
        <div className="p-5 rounded-2xl bg-amber-50 border border-amber-200 shadow-sm space-y-3">
          <div className="flex items-center gap-2 text-amber-900 font-semibold text-sm">
            <AlertCircle className="w-5 h-5 text-amber-600 shrink-0" />
            <span>Copy your new Gateway API Key</span>
          </div>
          <p className="text-xs text-amber-800">
            This plaintext key will <strong>never be shown again</strong>. Please copy and store it safely in your
            application environment variables. It is never stored in browser memory or storage.
          </p>
          <div className="flex items-center gap-2">
            <input
              type="text"
              readOnly
              value={createdPlainKey}
              className="flex-1 px-3 py-2 bg-white border border-amber-300 rounded-xl font-mono text-sm text-zinc-900 selection:bg-amber-200"
            />
            <button
              onClick={() => copyToClipboard(createdPlainKey)}
              className="inline-flex items-center gap-1.5 px-4 py-2 bg-zinc-900 text-white rounded-xl text-sm font-medium hover:bg-zinc-800 transition-colors shadow-xs"
            >
              {copiedKey ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
              <span>{copiedKey ? 'Copied' : 'Copy'}</span>
            </button>
          </div>
        </div>
      )}

      {/* Filters Toolbar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-white p-3 rounded-2xl border border-zinc-200 shadow-2xs">
        <div className="flex items-center gap-1.5">
          {['ALL', 'enabled', 'disabled'].map((st) => (
            <button
              key={st}
              onClick={() => updateFilters(st)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                statusFilter === st
                  ? 'bg-zinc-900 text-white shadow-2xs'
                  : 'text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900'
              }`}
            >
              {st === 'ALL' ? 'All Keys' : st === 'enabled' ? 'Active Only' : 'Disabled Only'}
            </button>
          ))}
        </div>

        <div className="relative w-full sm:w-64">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
          <input
            type="text"
            placeholder="Search keys..."
            value={searchQuery}
            onChange={(e) => updateFilters(undefined, e.target.value)}
            className="w-full pl-9 pr-3 py-1.5 bg-zinc-50 border border-zinc-200 rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:bg-white transition-all"
          />
        </div>
      </div>

      {/* Main Content */}
      {isLoading ? (
        <div className="bg-white border border-zinc-200 rounded-2xl p-12 text-center text-zinc-400">
          <RefreshCw className="w-6 h-6 animate-spin mx-auto mb-2 text-zinc-500" />
          <p className="text-sm">Loading API keys...</p>
        </div>
      ) : isError ? (
        <ErrorState
          title="Error loading API keys"
          message={(error as any)?.message || 'Failed to fetch API keys.'}
          onRetry={() => refetch()}
        />
      ) : filteredKeys.length === 0 ? (
        <EmptyState
          icon={Key}
          title={apiKeys.length === 0 ? 'No API keys generated' : 'No matching keys found'}
          description={
            apiKeys.length === 0
              ? 'Generate your first client token to start routing OpenAI-compatible requests.'
              : 'Try clearing your filter or search query.'
          }
          actionLabel={apiKeys.length === 0 ? 'Generate Key' : 'Clear Filters'}
          onAction={apiKeys.length === 0 ? () => setIsCreateModalOpen(true) : () => updateFilters('ALL', '')}
        />
      ) : (
        <div className="bg-white border border-zinc-200 rounded-2xl overflow-hidden shadow-2xs">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm text-zinc-600">
              <thead className="bg-zinc-50/75 border-b border-zinc-200 text-xs uppercase font-medium text-zinc-500">
                <tr>
                  <th className="px-5 py-3.5">Key Name & Prefix</th>
                  <th className="px-5 py-3.5">Status</th>
                  <th className="px-5 py-3.5">Rate Limits</th>
                  <th className="px-5 py-3.5">Daily Quota</th>
                  <th className="px-5 py-3.5">Last Used</th>
                  <th className="px-5 py-3.5">Created</th>
                  <th className="px-5 py-3.5 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-200/75">
                {filteredKeys.map((k) => (
                  <tr key={k.id} className="hover:bg-zinc-50/60 transition-colors group">
                    <td className="px-5 py-4">
                      <Link to={`/api-keys/${k.id}`} className="group-hover:text-zinc-900 block">
                        <div className="font-semibold text-zinc-900 flex items-center gap-1">
                          <span>{k.name}</span>
                          <ArrowUpRight className="w-3.5 h-3.5 text-zinc-400 group-hover:text-zinc-900 transition-colors" />
                        </div>
                        <div className="text-xs font-mono text-zinc-500">{k.key_prefix}••••••••••••</div>
                      </Link>
                    </td>

                    <td className="px-5 py-4">
                      {k.enabled ? (
                        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-emerald-50 text-emerald-700 border border-emerald-200">
                          Active
                        </span>
                      ) : (
                        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-zinc-100 text-zinc-600 border border-zinc-200">
                          Disabled
                        </span>
                      )}
                    </td>

                    <td className="px-5 py-4 text-xs font-mono">
                      {k.rpm_limit} RPM / {k.concurrent_limit} Concur
                    </td>

                    <td className="px-5 py-4 text-xs font-mono">{k.daily_request_limit} req/day</td>

                    <td className="px-5 py-4 text-xs text-zinc-500">
                      {k.last_used_at ? new Date(k.last_used_at).toLocaleTimeString() : 'Never'}
                    </td>

                    <td className="px-5 py-4 text-xs text-zinc-500">
                      {new Date(k.created_at).toLocaleDateString()}
                    </td>

                    <td className="px-5 py-4 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <button
                          onClick={() => toggleMutation.mutate({ id: k.id, enabled: !k.enabled })}
                          className="text-xs px-2.5 py-1 rounded-lg border border-zinc-200 hover:bg-zinc-100 text-zinc-700 font-medium"
                        >
                          {k.enabled ? 'Disable' : 'Enable'}
                        </button>
                        <button
                          title="Revoke Key"
                          onClick={() => {
                            if (confirm(`Revoke and delete API key "${k.name}"?`)) {
                              deleteMutation.mutate(k.id);
                            }
                          }}
                          className="p-1.5 rounded-lg hover:bg-rose-50 text-zinc-400 hover:text-rose-600 transition-colors"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* CREATE API KEY MODAL */}
      {isCreateModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-xl border border-zinc-200">
            <h3 className="text-lg font-semibold text-zinc-900 mb-1">Create Gateway API Key</h3>
            <p className="text-xs text-zinc-500 mb-4">
              Set application identifier and rate limit quotas.
            </p>

            <form onSubmit={handleCreate} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-zinc-700 uppercase tracking-wider mb-1">
                  Key Name / Client App
                </label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Next.js Assistant"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl border border-zinc-200 text-sm focus:outline-none focus:ring-2 focus:ring-zinc-900"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-zinc-700 uppercase tracking-wider mb-1">
                    RPM Limit
                  </label>
                  <input
                    type="number"
                    min="1"
                    max="1000"
                    value={rpmLimit}
                    onChange={(e) => setRpmLimit(Number(e.target.value))}
                    className="w-full px-3 py-2 rounded-xl border border-zinc-200 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-zinc-700 uppercase tracking-wider mb-1">
                    Concurrency
                  </label>
                  <input
                    type="number"
                    min="1"
                    max="50"
                    value={concurrentLimit}
                    onChange={(e) => setConcurrentLimit(Number(e.target.value))}
                    className="w-full px-3 py-2 rounded-xl border border-zinc-200 text-sm"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-zinc-700 uppercase tracking-wider mb-1">
                    Daily Limit
                  </label>
                  <input
                    type="number"
                    min="100"
                    max="100000"
                    value={dailyLimit}
                    onChange={(e) => setDailyLimit(Number(e.target.value))}
                    className="w-full px-3 py-2 rounded-xl border border-zinc-200 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-zinc-700 uppercase tracking-wider mb-1">
                    Expires in Days (0 = never)
                  </label>
                  <input
                    type="number"
                    min="0"
                    max="365"
                    value={expiresInDays}
                    onChange={(e) => setExpiresInDays(Number(e.target.value))}
                    className="w-full px-3 py-2 rounded-xl border border-zinc-200 text-sm"
                  />
                </div>
              </div>

              <div className="flex justify-end gap-3 pt-3 border-t border-zinc-100">
                <button
                  type="button"
                  onClick={() => setIsCreateModalOpen(false)}
                  className="px-4 py-2 text-sm text-zinc-600 hover:text-zinc-900"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={createMutation.isPending}
                  className="px-4 py-2 text-sm font-medium text-white bg-zinc-900 rounded-xl hover:bg-zinc-800 disabled:opacity-50"
                >
                  {createMutation.isPending ? 'Generating...' : 'Generate Key'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
