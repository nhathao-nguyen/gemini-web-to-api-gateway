import React, { useState } from 'react';
import { Key, Plus, Copy, Check, Trash2, Shield, AlertCircle, RefreshCw } from 'lucide-react';
import { ApiKeyItem } from '../types/client.js';
import { adminFetch } from '../utils/api.js';

interface ApiKeysViewProps {
  apiKeys: ApiKeyItem[];
  onRefresh: () => void;
}

export const ApiKeysView: React.FC<ApiKeysViewProps> = ({ apiKeys, onRefresh }) => {
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [createdPlainKey, setCreatedPlainKey] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState(false);

  // Form states
  const [name, setName] = useState('');
  const [rpmLimit, setRpmLimit] = useState(60);
  const [concurrentLimit, setConcurrentLimit] = useState(5);
  const [dailyLimit, setDailyLimit] = useState(5000);
  const [expiresInDays, setExpiresInDays] = useState(0);

  const handleCreateKey = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await adminFetch('/api/admin/api-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          allowed_models: ['*'],
          rpm_limit: Number(rpmLimit),
          concurrent_limit: Number(concurrentLimit),
          daily_request_limit: Number(dailyLimit),
          expires_in_days: expiresInDays > 0 ? Number(expiresInDays) : undefined,
        }),
      });

      if (res.ok) {
        const data = await res.json();
        setCreatedPlainKey(data.apiKey);
        setIsCreateModalOpen(false);
        setName('');
        onRefresh();
      } else {
        const data = await res.json();
        alert(`Failed to create API key: ${data.error}`);
      }
    } catch (err: any) {
      alert(`Error: ${err.message}`);
    }
  };

  const handleToggleEnabled = async (key: ApiKeyItem) => {
    try {
      await adminFetch(`/api/admin/api-keys/${key.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !key.enabled }),
      });
      onRefresh();
    } catch (err) {
      console.error(err);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Are you sure you want to revoke and delete this API key? Client requests will immediately fail.')) return;
    try {
      await adminFetch(`/api/admin/api-keys/${id}`, { method: 'DELETE' });
      onRefresh();
    } catch (err) {
      console.error(err);
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(true);
    setTimeout(() => setCopiedKey(false), 2500);
  };

  return (
    <div className="space-y-6">
      {/* Header and Controls */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-zinc-900 tracking-tight">Gateway API Keys</h2>
          <p className="text-sm text-zinc-500">
            Generate client keys for internal apps and OpenAI SDKs. Keys are stored as SHA-256 hashes.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={onRefresh}
            className="inline-flex items-center gap-2 px-3 py-2 text-sm font-medium text-zinc-700 bg-white border border-zinc-200 rounded-lg hover:bg-zinc-50 transition-colors"
          >
            <RefreshCw className="w-4 h-4 text-zinc-500" />
            Refresh
          </button>
          <button
            onClick={() => {
              setCreatedPlainKey(null);
              setIsCreateModalOpen(true);
            }}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-zinc-900 rounded-lg hover:bg-zinc-800 transition-colors shadow-sm"
          >
            <Plus className="w-4 h-4" />
            Generate New Key
          </button>
        </div>
      </div>

      {/* NEW KEY DISPLAY BANNER (Shown once) */}
      {createdPlainKey && (
        <div className="p-5 rounded-xl bg-amber-50 border border-amber-200 shadow-sm space-y-3">
          <div className="flex items-center gap-2 text-amber-900 font-semibold text-sm">
            <AlertCircle className="w-5 h-5 text-amber-600" />
            <span>Copy your new Gateway API Key</span>
          </div>
          <p className="text-xs text-amber-800">
            This plaintext key will <strong>never be shown again</strong>. Please copy and store it securely in your
            secrets manager or <code className="bg-amber-100 px-1 py-0.5 rounded">.env</code> file.
          </p>
          <div className="flex items-center gap-2">
            <input
              type="text"
              readOnly
              value={createdPlainKey}
              className="flex-1 px-3 py-2 bg-white border border-amber-300 rounded-lg font-mono text-sm text-zinc-900 selection:bg-amber-200"
            />
            <button
              onClick={() => copyToClipboard(createdPlainKey)}
              className="inline-flex items-center gap-1.5 px-4 py-2 bg-zinc-900 text-white rounded-lg text-sm font-medium hover:bg-zinc-800 transition-colors"
            >
              {copiedKey ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
              {copiedKey ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>
      )}

      {/* API Keys Table */}
      <div className="bg-white border border-zinc-200 rounded-xl overflow-hidden shadow-xs">
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
              {apiKeys.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-5 py-12 text-center text-zinc-400">
                    No API keys created yet. Generate one above to access the OpenAI endpoints.
                  </td>
                </tr>
              ) : (
                apiKeys.map((key) => (
                  <tr key={key.id} className="hover:bg-zinc-50/50 transition-colors">
                    <td className="px-5 py-4">
                      <div className="font-medium text-zinc-900">{key.name}</div>
                      <div className="text-xs font-mono text-zinc-500">{key.key_prefix}••••••••••••</div>
                    </td>
                    <td className="px-5 py-4">
                      {key.enabled ? (
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
                      {key.rpm_limit} RPM / {key.concurrent_limit} Concur
                    </td>
                    <td className="px-5 py-4 text-xs font-mono">{key.daily_request_limit} req/day</td>
                    <td className="px-5 py-4 text-xs text-zinc-500">
                      {key.last_used_at ? new Date(key.last_used_at).toLocaleTimeString() : 'Never'}
                    </td>
                    <td className="px-5 py-4 text-xs text-zinc-500">{new Date(key.created_at).toLocaleDateString()}</td>
                    <td className="px-5 py-4 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <button
                          onClick={() => handleToggleEnabled(key)}
                          className="text-xs px-2 py-1 rounded border border-zinc-200 hover:bg-zinc-100 text-zinc-700"
                        >
                          {key.enabled ? 'Disable' : 'Enable'}
                        </button>
                        <button
                          title="Revoke Key"
                          onClick={() => handleDelete(key.id)}
                          className="p-1.5 rounded-md hover:bg-rose-50 text-zinc-400 hover:text-rose-600 transition-colors"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* CREATE API KEY MODAL */}
      {isCreateModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-xl border border-zinc-200">
            <h3 className="text-lg font-semibold text-zinc-900 mb-2">Create Gateway API Key</h3>
            <p className="text-xs text-zinc-500 mb-4">
              Configure name and independent rate limits for this API key.
            </p>

            <form onSubmit={handleCreateKey} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-zinc-700 mb-1">Key Name / Client App</label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Internal Assistant Chatbot"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-zinc-200 text-sm focus:outline-none focus:ring-2 focus:ring-zinc-900"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-zinc-700 mb-1">Requests / Min (RPM)</label>
                  <input
                    type="number"
                    min="1"
                    max="1000"
                    value={rpmLimit}
                    onChange={(e) => setRpmLimit(Number(e.target.value))}
                    className="w-full px-3 py-2 rounded-lg border border-zinc-200 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-zinc-700 mb-1">Concurrent Limit</label>
                  <input
                    type="number"
                    min="1"
                    max="50"
                    value={concurrentLimit}
                    onChange={(e) => setConcurrentLimit(Number(e.target.value))}
                    className="w-full px-3 py-2 rounded-lg border border-zinc-200 text-sm"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-zinc-700 mb-1">Daily Quota Limit</label>
                  <input
                    type="number"
                    min="100"
                    max="100000"
                    value={dailyLimit}
                    onChange={(e) => setDailyLimit(Number(e.target.value))}
                    className="w-full px-3 py-2 rounded-lg border border-zinc-200 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-zinc-700 mb-1">Expires in Days (0 = never)</label>
                  <input
                    type="number"
                    min="0"
                    max="365"
                    value={expiresInDays}
                    onChange={(e) => setExpiresInDays(Number(e.target.value))}
                    className="w-full px-3 py-2 rounded-lg border border-zinc-200 text-sm"
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
                  className="px-4 py-2 text-sm font-medium text-white bg-zinc-900 rounded-lg hover:bg-zinc-800"
                >
                  Generate Key
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
