import React, { useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  Key,
  Trash2,
  CheckCircle2,
  Clock,
  Shield,
  Sliders,
  Calendar,
  RefreshCw,
} from 'lucide-react';
import { fetchApiKey, updateApiKey, deleteApiKey } from '../lib/api-client.js';
import { useDocumentTitle } from '../hooks/useDocumentTitle.js';

export const ApiKeyDetailPage: React.FC = () => {
  const { keyId = '' } = useParams<{ keyId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [isEditing, setIsEditing] = useState(false);
  const [rpmLimit, setRpmLimit] = useState(60);
  const [concurrentLimit, setConcurrentLimit] = useState(5);
  const [dailyLimit, setDailyLimit] = useState(5000);
  const [actionFeedback, setActionFeedback] = useState<string | null>(null);

  const {
    data: keyRecord,
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery({
    queryKey: ['api-key', keyId],
    queryFn: () => fetchApiKey(keyId),
    enabled: Boolean(keyId),
  });

  useDocumentTitle(keyRecord ? `${keyRecord.name}` : 'API Key Details');

  // Populate form defaults when keyRecord loads
  React.useEffect(() => {
    if (keyRecord) {
      setRpmLimit(keyRecord.rpm_limit);
      setConcurrentLimit(keyRecord.concurrent_limit);
      setDailyLimit(keyRecord.daily_request_limit);
    }
  }, [keyRecord]);

  const updateMutation = useMutation({
    mutationFn: (updates: any) => updateApiKey(keyId, updates),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['api-key', keyId] });
      queryClient.invalidateQueries({ queryKey: ['api-keys'] });
      setIsEditing(false);
      setActionFeedback('API key settings updated successfully.');
    },
    onError: (err: any) => {
      alert(`Error updating API key: ${err.message}`);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteApiKey(keyId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['api-keys'] });
      navigate('/api-keys', { replace: true });
    },
  });

  const handleSaveLimits = (e: React.FormEvent) => {
    e.preventDefault();
    updateMutation.mutate({
      rpm_limit: Number(rpmLimit),
      concurrent_limit: Number(concurrentLimit),
      daily_request_limit: Number(dailyLimit),
    });
  };

  const handleToggle = () => {
    if (!keyRecord) return;
    updateMutation.mutate({ enabled: !keyRecord.enabled });
  };

  const handleDelete = () => {
    if (!confirm(`Are you sure you want to revoke and delete API key "${keyRecord?.name}"?`)) return;
    deleteMutation.mutate();
  };

  if (isLoading) {
    return (
      <div className="bg-white border border-zinc-200 rounded-2xl p-16 text-center text-zinc-400">
        <RefreshCw className="w-6 h-6 animate-spin mx-auto mb-2 text-zinc-500" />
        <p className="text-sm">Loading API key metadata...</p>
      </div>
    );
  }

  if (isError || !keyRecord) {
    return (
      <div className="bg-white border border-zinc-200 rounded-2xl p-12 text-center max-w-lg mx-auto space-y-4">
        <div className="w-12 h-12 rounded-2xl bg-zinc-100 flex items-center justify-center mx-auto text-zinc-500">
          <Key className="w-6 h-6" />
        </div>
        <h2 className="text-lg font-bold text-zinc-900">API Key Not Found</h2>
        <p className="text-sm text-zinc-500">
          {(error as any)?.message || `No API key with ID "${keyId}" exists in the gateway.`}
        </p>
        <Link
          to="/api-keys"
          className="inline-flex items-center gap-2 px-4 py-2 bg-zinc-900 text-white rounded-xl text-xs font-medium hover:bg-zinc-800 transition-colors"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          <span>Back to API Keys</span>
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header & Breadcrumb */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Link
            to="/api-keys"
            className="p-2 rounded-xl border border-zinc-200 text-zinc-600 hover:text-zinc-900 hover:bg-white transition-colors"
            title="Back to API Keys"
          >
            <ArrowLeft className="w-4 h-4" />
          </Link>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-xl font-bold text-zinc-900 tracking-tight">{keyRecord.name}</h2>
              {keyRecord.enabled ? (
                <span className="inline-flex items-center gap-1.5 px-3 py-0.5 rounded-full text-xs font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200">
                  <CheckCircle2 className="w-3.5 h-3.5" /> Active
                </span>
              ) : (
                <span className="inline-flex items-center px-3 py-0.5 rounded-full text-xs font-semibold bg-zinc-100 text-zinc-600 border border-zinc-200">
                  Disabled
                </span>
              )}
            </div>
            <p className="text-xs text-zinc-500 font-mono mt-0.5">
              Prefix: <code className="bg-zinc-100 px-1 py-0.5 rounded">{keyRecord.key_prefix}••••••••••••</code> • ID: {keyRecord.id}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={handleToggle}
            className="px-3 py-2 text-xs font-medium rounded-xl border border-zinc-200 bg-white hover:bg-zinc-50 text-zinc-700 transition-colors"
          >
            {keyRecord.enabled ? 'Disable Key' : 'Enable Key'}
          </button>
          <button
            onClick={() => setIsEditing(!isEditing)}
            className="px-3 py-2 text-xs font-medium rounded-xl border border-zinc-200 bg-white hover:bg-zinc-50 text-zinc-700 transition-colors"
          >
            {isEditing ? 'Cancel Edit' : 'Edit Rate Limits'}
          </button>
          <button
            onClick={handleDelete}
            className="p-2 rounded-xl border border-zinc-200 bg-white hover:bg-rose-50 text-zinc-400 hover:text-rose-600 transition-colors"
            title="Revoke & Delete"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </div>

      {actionFeedback && (
        <div className="p-3.5 rounded-xl bg-zinc-900 text-zinc-100 text-sm flex items-center justify-between shadow-sm">
          <span>{actionFeedback}</span>
          <button onClick={() => setActionFeedback(null)} className="text-zinc-400 hover:text-white text-xs">
            Dismiss
          </button>
        </div>
      )}

      {/* Editing Form */}
      {isEditing && (
        <div className="bg-white border border-zinc-200 rounded-2xl p-5 shadow-sm">
          <h3 className="text-sm font-semibold text-zinc-900 mb-3">Modify Rate Limits & Quotas</h3>
          <form onSubmit={handleSaveLimits} className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-medium text-zinc-700 mb-1">Requests / Min (RPM)</label>
              <input
                type="number"
                min="1"
                max="1000"
                value={rpmLimit}
                onChange={(e) => setRpmLimit(Number(e.target.value))}
                className="w-full px-3 py-2 border border-zinc-200 rounded-xl text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-zinc-700 mb-1">Concurrency</label>
              <input
                type="number"
                min="1"
                max="50"
                value={concurrentLimit}
                onChange={(e) => setConcurrentLimit(Number(e.target.value))}
                className="w-full px-3 py-2 border border-zinc-200 rounded-xl text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-zinc-700 mb-1">Daily Limit</label>
              <input
                type="number"
                min="100"
                max="100000"
                value={dailyLimit}
                onChange={(e) => setDailyLimit(Number(e.target.value))}
                className="w-full px-3 py-2 border border-zinc-200 rounded-xl text-sm"
              />
            </div>
            <div className="sm:col-span-3 flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setIsEditing(false)}
                className="px-3 py-1.5 text-xs text-zinc-600 hover:text-zinc-900"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={updateMutation.isPending}
                className="px-4 py-1.5 text-xs font-medium text-white bg-zinc-900 rounded-xl hover:bg-zinc-800 disabled:opacity-50"
              >
                {updateMutation.isPending ? 'Saving...' : 'Save Changes'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Details Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
        <div className="bg-white border border-zinc-200 rounded-2xl p-5 shadow-2xs space-y-3">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-zinc-500 pb-2 border-b border-zinc-100">
            <Sliders className="w-4 h-4 text-zinc-600" />
            <span>Rate Limit Policy</span>
          </div>
          <div className="space-y-2.5 text-xs">
            <div className="flex justify-between py-1 border-b border-zinc-50">
              <span className="text-zinc-500">Sliding Window RPM:</span>
              <span className="font-mono font-bold text-zinc-900">{keyRecord.rpm_limit} RPM</span>
            </div>
            <div className="flex justify-between py-1 border-b border-zinc-50">
              <span className="text-zinc-500">In-flight Concurrency:</span>
              <span className="font-mono font-bold text-zinc-900">{keyRecord.concurrent_limit} parallel</span>
            </div>
            <div className="flex justify-between py-1 border-b border-zinc-50">
              <span className="text-zinc-500">Daily Request Cap:</span>
              <span className="font-mono font-bold text-zinc-900">{keyRecord.daily_request_limit} req/day</span>
            </div>
          </div>
        </div>

        <div className="bg-white border border-zinc-200 rounded-2xl p-5 shadow-2xs space-y-3">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-zinc-500 pb-2 border-b border-zinc-100">
            <Calendar className="w-4 h-4 text-zinc-600" />
            <span>Timestamps</span>
          </div>
          <div className="space-y-2.5 text-xs">
            <div className="flex justify-between py-1 border-b border-zinc-50">
              <span className="text-zinc-500">Created:</span>
              <span className="text-zinc-700">{new Date(keyRecord.created_at).toLocaleString()}</span>
            </div>
            <div className="flex justify-between py-1 border-b border-zinc-50">
              <span className="text-zinc-500">Last Used:</span>
              <span className="text-zinc-700">
                {keyRecord.last_used_at ? new Date(keyRecord.last_used_at).toLocaleString() : 'Never'}
              </span>
            </div>
            <div className="flex justify-between py-1 border-b border-zinc-50">
              <span className="text-zinc-500">Expiration:</span>
              <span className="text-zinc-700">
                {keyRecord.expires_at ? new Date(keyRecord.expires_at).toLocaleDateString() : 'Never'}
              </span>
            </div>
          </div>
        </div>

        <div className="bg-white border border-zinc-200 rounded-2xl p-5 shadow-2xs space-y-3">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-zinc-500 pb-2 border-b border-zinc-100">
            <Shield className="w-4 h-4 text-zinc-600" />
            <span>Security</span>
          </div>
          <div className="space-y-2.5 text-xs">
            <div className="flex justify-between py-1 border-b border-zinc-50">
              <span className="text-zinc-500">Hash Algorithm:</span>
              <span className="font-mono text-zinc-900">SHA-256</span>
            </div>
            <div className="flex justify-between py-1 border-b border-zinc-50">
              <span className="text-zinc-500">Allowed Models:</span>
              <span className="font-mono text-zinc-900">{keyRecord.allowed_models.join(', ')}</span>
            </div>
            <p className="text-[11px] text-zinc-400 pt-1">
              Plaintext key is discarded after generation and is never recoverable from the server database.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};
