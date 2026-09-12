import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Activity, AlertTriangle, CheckCircle2, Clock3, RefreshCw, Server, Zap } from 'lucide-react';
import {
  fetchAccounts,
  fetchEvents,
  fetchKeepAliveStatus,
  triggerKeepAlive,
} from '../lib/api-client.js';
import { useDocumentTitle } from '../hooks/useDocumentTitle.js';
import { ErrorState } from '../components/ErrorState.js';

const formatDate = (value: string | null | undefined) =>
  value ? new Date(value).toLocaleString() : '—';

export const KeepAlivePage: React.FC = () => {
  useDocumentTitle('Keep-Alive Monitor');

  const accountsQuery = useQuery({
    queryKey: ['accounts'],
    queryFn: fetchAccounts,
    refetchInterval: 10000,
  });
  const statusQuery = useQuery({
    queryKey: ['keepalive-status'],
    queryFn: fetchKeepAliveStatus,
    refetchInterval: 5000,
  });
  const eventsQuery = useQuery({
    queryKey: ['events'],
    queryFn: fetchEvents,
    refetchInterval: 10000,
  });

  const [actionMessage, setActionMessage] = React.useState<string | null>(null);
  const [actionError, setActionError] = React.useState<string | null>(null);
  const [isRunningNow, setIsRunningNow] = React.useState(false);

  const accounts = accountsQuery.data ?? [];
  const status = statusQuery.data;
  const events = (eventsQuery.data ?? []).filter((event) => event.event_type.startsWith('KEEPALIVE_'));
  const eligibleAccount = accounts.find((account) => account.status === 'ACTIVE') ?? accounts[0];

  const refresh = () => {
    void accountsQuery.refetch();
    void statusQuery.refetch();
    void eventsQuery.refetch();
  };

  const runNow = async () => {
    if (!eligibleAccount) {
      setActionError('No account is available for a keep-alive run.');
      setActionMessage(null);
      return;
    }

    setIsRunningNow(true);
    setActionError(null);
    setActionMessage(null);
    try {
      const result = await triggerKeepAlive(eligibleAccount.id);
      if (!result.success) throw new Error(result.message);
      setActionMessage(result.message);
      refresh();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Keep-alive failed.');
    } finally {
      setIsRunningNow(false);
    }
  };

  if (accountsQuery.isError && statusQuery.isError && eventsQuery.isError) {
    return (
      <ErrorState
        title="Could not load keep-alive monitor"
        message="The admin API did not return worker telemetry."
        onRetry={refresh}
      />
    );
  }

  const workerHealthy = Boolean(status?.isWorkerRunning);
  const workerBusy = Boolean(status?.isCurrentlyRefreshing);

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
        <div>
          <div className="inline-flex items-center gap-2 text-xs font-semibold text-emerald-700 uppercase tracking-wider">
            <Activity className="w-3.5 h-3.5" /> Session maintenance
          </div>
          <h1 className="mt-2 text-2xl font-bold tracking-tight text-zinc-900">Keep-Alive Monitor</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Monitor background session refreshes and run a verified refresh for one account.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={refresh}
            disabled={accountsQuery.isFetching || statusQuery.isFetching || eventsQuery.isFetching}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-zinc-700 bg-white border border-zinc-200 rounded-xl hover:bg-zinc-50 disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${statusQuery.isFetching ? 'animate-spin' : ''}`} />
            Refresh
          </button>
          <button
            type="button"
            onClick={runNow}
            disabled={isRunningNow || workerBusy || !eligibleAccount}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-white bg-zinc-900 rounded-xl hover:bg-zinc-800 disabled:opacity-50"
          >
            <Zap className={`w-3.5 h-3.5 ${isRunningNow ? 'animate-pulse' : ''}`} />
            Run now
          </button>
        </div>
      </div>

      {(actionMessage || actionError) && (
        <div
          role="status"
          className={`rounded-xl border px-4 py-3 text-sm ${
            actionError
              ? 'border-red-200 bg-red-50 text-red-700'
              : 'border-emerald-200 bg-emerald-50 text-emerald-700'
          }`}
        >
          {actionError || actionMessage}
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <div className="bg-white border border-zinc-200 rounded-2xl p-5 shadow-2xs">
          <div className="flex items-center justify-between text-xs text-zinc-500">
            Worker status
            {workerHealthy ? <CheckCircle2 className="w-4 h-4 text-emerald-500" /> : <AlertTriangle className="w-4 h-4 text-amber-500" />}
          </div>
          <div className="mt-2 text-xl font-semibold text-zinc-900">{workerHealthy ? 'Running' : 'Stopped'}</div>
          <div className="mt-1 text-xs text-zinc-400">{workerBusy ? 'Refreshing an account now' : 'Queue is idle'}</div>
        </div>
        <div className="bg-white border border-zinc-200 rounded-2xl p-5 shadow-2xs">
          <div className="flex items-center justify-between text-xs text-zinc-500">
            Last run
            <Clock3 className="w-4 h-4 text-zinc-400" />
          </div>
          <div className="mt-2 text-sm font-semibold text-zinc-900">{formatDate(status?.lastRunAt ?? null)}</div>
          <div className="mt-1 text-xs text-zinc-400">Next: {formatDate(status?.nextRunAt ?? null)}</div>
        </div>
        <div className="bg-white border border-zinc-200 rounded-2xl p-5 shadow-2xs">
          <div className="flex items-center justify-between text-xs text-zinc-500">
            Successful refreshes
            <CheckCircle2 className="w-4 h-4 text-emerald-500" />
          </div>
          <div className="mt-2 text-xl font-semibold text-zinc-900">{status?.totalRefreshedSuccess ?? 0}</div>
          <div className="mt-1 text-xs text-zinc-400">Failed: {status?.totalRefreshedFailed ?? 0}</div>
        </div>
        <div className="bg-white border border-zinc-200 rounded-2xl p-5 shadow-2xs">
          <div className="flex items-center justify-between text-xs text-zinc-500">
            Accounts in pool
            <Server className="w-4 h-4 text-zinc-400" />
          </div>
          <div className="mt-2 text-xl font-semibold text-zinc-900">{accounts.length}</div>
          <div className="mt-1 text-xs text-zinc-400">Eligible now: {eligibleAccount ? eligibleAccount.name : 'none'}</div>
        </div>
      </div>

      <div className="bg-white border border-zinc-200 rounded-2xl p-5 shadow-2xs">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-zinc-900">Worker summary</h2>
            <p className="mt-1 text-xs text-zinc-500">{status?.lastSummary || 'No keep-alive cycle has completed yet.'}</p>
          </div>
          {status?.currentAccountId && <span className="font-mono text-[11px] text-zinc-400">{status.currentAccountId}</span>}
        </div>
      </div>

      <div className="bg-white border border-zinc-200 rounded-2xl overflow-hidden shadow-2xs">
        <div className="px-5 py-4 border-b border-zinc-200">
          <h2 className="text-sm font-semibold text-zinc-900">Recent keep-alive events</h2>
        </div>
        {events.length === 0 ? (
          <div className="px-5 py-10 text-center text-sm text-zinc-400">No keep-alive events recorded.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs text-zinc-600">
              <thead className="bg-zinc-50 border-b border-zinc-200 text-[11px] uppercase text-zinc-500">
                <tr>
                  <th className="px-5 py-3">Account</th>
                  <th className="px-5 py-3">Event</th>
                  <th className="px-5 py-3">Transition</th>
                  <th className="px-5 py-3">Reason</th>
                  <th className="px-5 py-3 text-right">Time</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100">
                {events.slice(0, 25).map((event) => (
                  <tr key={event.id}>
                    <td className="px-5 py-3 font-mono text-zinc-900">{event.account_id}</td>
                    <td className="px-5 py-3 font-medium">{event.event_type}</td>
                    <td className="px-5 py-3 font-mono">{event.from_status || 'INIT'} → {event.to_status}</td>
                    <td className="px-5 py-3 max-w-md truncate">{event.reason}</td>
                    <td className="px-5 py-3 text-right text-zinc-400">{formatDate(event.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};
