import React, { useState } from 'react';
import {
  Server,
  Plus,
  RefreshCw,
  KeyRound,
  Trash2,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Clock,
  Shield,
  Sparkles,
} from 'lucide-react';
import { SafeAccount, AccountStatus } from '../types/client.js';
import { adminFetch } from '../utils/api.js';

interface AccountsViewProps {
  accounts: SafeAccount[];
  onRefresh: () => void;
}

export const AccountsView: React.FC<AccountsViewProps> = ({ accounts, onRefresh }) => {
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [isReplaceModalOpen, setIsReplaceModalOpen] = useState(false);
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);

  // Form states
  const [name, setName] = useState('');
  const [emailLabel, setEmailLabel] = useState('');
  const [cookie, setCookie] = useState('');
  const [authUser, setAuthUser] = useState('0');
  const [priority, setPriority] = useState(10);
  const [weight, setWeight] = useState(1);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [actionFeedback, setActionFeedback] = useState<string | null>(null);

  // Replace cookie form
  const [newCookie, setNewCookie] = useState('');

  const handleAddAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await adminFetch('/api/admin/accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          email_label: emailLabel,
          cookie,
          auth_user: authUser,
          priority: Number(priority),
          weight: Number(weight),
          supported_models: [],
        }),
      });
      if (res.ok) {
        setIsAddModalOpen(false);
        setName('');
        setEmailLabel('');
        setCookie('');
        setActionFeedback('Account securely added and session cookie encrypted!');
        onRefresh();
      } else {
        const data = await res.json();
        alert(`Failed to add account: ${data.error}`);
      }
    } catch (err: any) {
      alert(`Error: ${err.message}`);
    }
  };

  const handleReplaceCookie = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedAccountId || !newCookie) return;
    try {
      const res = await adminFetch(`/api/admin/accounts/${selectedAccountId}/cookie`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cookie: newCookie }),
      });
      if (res.ok) {
        setIsReplaceModalOpen(false);
        setNewCookie('');
        setSelectedAccountId(null);
        setActionFeedback('Session cookie successfully replaced and re-encrypted.');
        onRefresh();
      }
    } catch (err: any) {
      alert(`Error replacing cookie: ${err.message}`);
    }
  };

  const handleTestSession = async (id: string) => {
    setTestingId(id);
    setActionFeedback(null);
    try {
      const res = await adminFetch(`/api/admin/accounts/${id}/test`, { method: 'POST' });
      const data = await res.json();
      if (data.valid) {
        setActionFeedback(`Session valid! Status updated to ${data.status}`);
      } else {
        setActionFeedback(`Session test warning: ${data.error}`);
      }
      onRefresh();
    } catch (err: any) {
      setActionFeedback(`Error running test: ${err.message}`);
    } finally {
      setTestingId(null);
    }
  };

  const handleToggleStatus = async (account: SafeAccount) => {
    const nextStatus: AccountStatus = account.status === 'DISABLED' ? 'ACTIVE' : 'DISABLED';
    try {
      await adminFetch(`/api/admin/accounts/${account.id}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: nextStatus, reason: 'Toggled in Admin UI' }),
      });
      onRefresh();
    } catch (err) {
      console.error(err);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Are you sure you want to delete this account from the gateway pool?')) return;
    try {
      await adminFetch(`/api/admin/accounts/${id}`, { method: 'DELETE' });
      onRefresh();
    } catch (err) {
      console.error(err);
    }
  };

  const getStatusBadge = (status: AccountStatus) => {
    switch (status) {
      case 'ACTIVE':
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-emerald-50 text-emerald-700 border border-emerald-200">
            <CheckCircle2 className="w-3.5 h-3.5" /> Active
          </span>
        );
      case 'COOLDOWN':
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-amber-50 text-amber-700 border border-amber-200">
            <Clock className="w-3.5 h-3.5" /> Cooldown
          </span>
        );
      case 'QUOTA_EXHAUSTED':
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-orange-50 text-orange-700 border border-orange-200">
            <AlertTriangle className="w-3.5 h-3.5" /> Quota Exhausted
          </span>
        );
      case 'SESSION_EXPIRED':
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-rose-50 text-rose-700 border border-rose-200">
            <XCircle className="w-3.5 h-3.5" /> Session Expired
          </span>
        );
      case 'DISABLED':
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-zinc-100 text-zinc-600 border border-zinc-200">
            Disabled
          </span>
        );
      case 'ERROR':
      default:
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-red-50 text-red-700 border border-red-200">
            <AlertTriangle className="w-3.5 h-3.5" /> Error
          </span>
        );
    }
  };

  return (
    <div className="space-y-6">
      {/* Header and Controls */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-zinc-900 tracking-tight">Gemini Upstream Accounts</h2>
          <p className="text-sm text-zinc-500">
            Manage authenticated Gemini Web browser sessions. Cookies are encrypted at rest with AES-256-GCM.
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
            onClick={() => setIsAddModalOpen(true)}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-zinc-900 rounded-lg hover:bg-zinc-800 transition-colors shadow-sm"
          >
            <Plus className="w-4 h-4" />
            Add Account
          </button>
        </div>
      </div>

      {/* Action feedback message */}
      {actionFeedback && (
        <div className="p-3.5 rounded-lg bg-zinc-900 text-zinc-100 text-sm flex items-center justify-between shadow-sm">
          <span>{actionFeedback}</span>
          <button onClick={() => setActionFeedback(null)} className="text-zinc-400 hover:text-white text-xs">
            Dismiss
          </button>
        </div>
      )}

      {/* Accounts List Table */}
      <div className="bg-white border border-zinc-200 rounded-xl overflow-hidden shadow-xs">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm text-zinc-600">
            <thead className="bg-zinc-50/75 border-b border-zinc-200 text-xs uppercase font-medium text-zinc-500">
              <tr>
                <th className="px-5 py-3.5">Account & Label</th>
                <th className="px-5 py-3.5">Status</th>
                <th className="px-5 py-3.5">Priority / Weight</th>
                <th className="px-5 py-3.5">Models</th>
                <th className="px-5 py-3.5">Requests</th>
                <th className="px-5 py-3.5">Last Success</th>
                <th className="px-5 py-3.5 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-200/75">
              {accounts.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-5 py-12 text-center text-zinc-400">
                    No accounts registered in pool. Click "Add Account" to import a Gemini Web session.
                  </td>
                </tr>
              ) : (
                accounts.map((acc) => (
                  <tr key={acc.id} className="hover:bg-zinc-50/50 transition-colors">
                    <td className="px-5 py-4">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-lg bg-zinc-100 flex items-center justify-center text-zinc-700 font-medium text-xs">
                          {acc.name.slice(0, 2).toUpperCase()}
                        </div>
                        <div>
                          <div className="font-medium text-zinc-900">
                            {acc.name}
                          </div>
                          <div className="text-xs text-zinc-500">{acc.email_label}</div>
                        </div>
                      </div>
                    </td>
                    <td className="px-5 py-4">{getStatusBadge(acc.status)}</td>
                    <td className="px-5 py-4 text-xs font-mono">
                      P: {acc.priority} / W: {acc.weight}
                    </td>
                    <td className="px-5 py-4">
                      <div className="flex flex-wrap gap-1 max-w-xs">
                        {acc.supported_models.map((m) => (
                          <span
                            key={m}
                            className="text-[11px] px-2 py-0.5 rounded bg-zinc-100 font-mono text-zinc-600 border border-zinc-200"
                          >
                            {m}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="px-5 py-4 font-mono text-xs">{acc.request_count}</td>
                    <td className="px-5 py-4 text-xs text-zinc-500">
                      {acc.last_success_at ? new Date(acc.last_success_at).toLocaleTimeString() : 'Never'}
                    </td>
                    <td className="px-5 py-4 text-right">
                      <div className="flex items-center justify-end gap-1.5">
                        <button
                          title="Test Upstream Session"
                          disabled={testingId === acc.id}
                          onClick={() => handleTestSession(acc.id)}
                          className="p-1.5 rounded-md hover:bg-zinc-100 text-zinc-600 hover:text-zinc-900 transition-colors disabled:opacity-50"
                        >
                          <RefreshCw className={`w-4 h-4 ${testingId === acc.id ? 'animate-spin text-zinc-900' : ''}`} />
                        </button>
                        <button
                          title="Replace Cookie"
                          onClick={() => {
                            setSelectedAccountId(acc.id);
                            setIsReplaceModalOpen(true);
                          }}
                          className="p-1.5 rounded-md hover:bg-zinc-100 text-zinc-600 hover:text-zinc-900 transition-colors"
                        >
                          <KeyRound className="w-4 h-4" />
                        </button>
                        <button
                          title={acc.status === 'DISABLED' ? 'Enable' : 'Disable'}
                          onClick={() => handleToggleStatus(acc)}
                          className="text-xs px-2 py-1 rounded border border-zinc-200 hover:bg-zinc-100 text-zinc-700"
                        >
                          {acc.status === 'DISABLED' ? 'Enable' : 'Disable'}
                        </button>
                        <button
                          title="Delete Account"
                          onClick={() => handleDelete(acc.id)}
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

      {/* ADD ACCOUNT MODAL */}
      {isAddModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-lg w-full p-6 shadow-xl border border-zinc-200">
            <div className="flex items-center justify-between pb-4 border-b border-zinc-100">
              <h3 className="text-lg font-semibold text-zinc-900">Add Gemini Account Session</h3>
              <button onClick={() => setIsAddModalOpen(false)} className="text-zinc-400 hover:text-zinc-600 text-lg">
                ✕
              </button>
            </div>

            <form onSubmit={handleAddAccount} className="space-y-4 pt-4">
              <div>
                <label className="block text-xs font-medium text-zinc-700 mb-1">Account Name</label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Primary Gemini Account"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-zinc-200 text-sm focus:outline-none focus:ring-2 focus:ring-zinc-900"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-zinc-700 mb-1">Email Label</label>
                <input
                  type="email"
                  required
                  placeholder="operator.account@gmail.com"
                  value={emailLabel}
                  onChange={(e) => setEmailLabel(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-zinc-200 text-sm focus:outline-none focus:ring-2 focus:ring-zinc-900"
                />
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="block text-xs font-medium text-zinc-700">Browser Cookie String</label>
                  <span className="text-[11px] text-zinc-400 flex items-center gap-1">
                    <Shield className="w-3 h-3 text-emerald-600" /> AES-256-GCM Encrypted
                  </span>
                </div>
                <textarea
                  required
                  rows={4}
                  placeholder="__Secure-1PSID=...; __Secure-1PSIDTS=...; __Secure-1PSIDCC=..."
                  value={cookie}
                  onChange={(e) => setCookie(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-zinc-200 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-zinc-900"
                />
                <p className="text-[11px] text-zinc-500 mt-1">
                  Copy from your browser storage for gemini.google.com. Cookie is never returned to the UI after saving.
                </p>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-zinc-700 mb-1">Priority Weight</label>
                  <input
                    type="number"
                    min="1"
                    max="100"
                    value={priority}
                    onChange={(e) => setPriority(Number(e.target.value))}
                    className="w-full px-3 py-2 rounded-lg border border-zinc-200 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-zinc-700 mb-1">Traffic Weight</label>
                  <input
                    type="number"
                    min="1"
                    max="10"
                    value={weight}
                    onChange={(e) => setWeight(Number(e.target.value))}
                    className="w-full px-3 py-2 rounded-lg border border-zinc-200 text-sm"
                  />
                </div>
              </div>

              <div className="p-3 bg-zinc-50 rounded-lg border border-zinc-200">
                <div className="text-xs font-medium text-zinc-800 mb-1">Supported Formats</div>
                <div className="text-[11px] text-zinc-500 leading-relaxed">
                  Accepts raw browser header (<code className="font-mono text-zinc-700">__Secure-1PSID=...; __Secure-1PSIDTS=...</code>) or JSON export from extensions (EditThisCookie, Cookie-Editor).
                </div>
              </div>

              <div className="flex justify-end gap-3 pt-3 border-t border-zinc-100">
                <button
                  type="button"
                  onClick={() => setIsAddModalOpen(false)}
                  className="px-4 py-2 text-sm text-zinc-600 hover:text-zinc-900"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 text-sm font-medium text-white bg-zinc-900 rounded-lg hover:bg-zinc-800"
                >
                  Save & Encrypt Session
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* REPLACE COOKIE MODAL */}
      {isReplaceModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-xl border border-zinc-200">
            <h3 className="text-lg font-semibold text-zinc-900 mb-2">Replace Session Cookie</h3>
            <p className="text-xs text-zinc-500 mb-4">
              Update refreshed cookies when upstream tokens expire. The new value will be encrypted with AES-256-GCM.
            </p>
            <form onSubmit={handleReplaceCookie} className="space-y-4">
              <textarea
                required
                rows={4}
                placeholder="__Secure-1PSID=...; __Secure-1PSIDTS=..."
                value={newCookie}
                onChange={(e) => setNewCookie(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-zinc-200 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-zinc-900"
              />
              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setIsReplaceModalOpen(false)}
                  className="px-4 py-2 text-sm text-zinc-600 hover:text-zinc-900"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 text-sm font-medium text-white bg-zinc-900 rounded-lg hover:bg-zinc-800"
                >
                  Update & Encrypt
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
