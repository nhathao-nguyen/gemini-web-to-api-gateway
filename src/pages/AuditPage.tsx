import React, { useMemo } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { FileText, RefreshCw, Filter, Search, ArrowUpRight } from 'lucide-react';
import { fetchEvents } from '../lib/api-client.js';
import { useDocumentTitle } from '../hooks/useDocumentTitle.js';
import { EmptyState } from '../components/EmptyState.js';
import { ErrorState } from '../components/ErrorState.js';

export const AuditPage: React.FC = () => {
  useDocumentTitle('Audit Trail');
  const [searchParams, setSearchParams] = useSearchParams();

  const accountFilter = searchParams.get('account') || '';
  const eventFilter = searchParams.get('type') || 'ALL';

  const {
    data: events = [],
    isLoading,
    isError,
    error,
    refetch,
    isFetching,
  } = useQuery({
    queryKey: ['events'],
    queryFn: fetchEvents,
    refetchInterval: 10000,
  });

  const uniqueEventTypes = useMemo(() => {
    const set = new Set<string>();
    events.forEach((e) => {
      if (e.event_type) set.add(e.event_type);
    });
    return Array.from(set);
  }, [events]);

  const updateFilters = (newAccount?: string, newType?: string) => {
    const params = new URLSearchParams(searchParams);
    if (newAccount !== undefined) {
      if (!newAccount) params.delete('account');
      else params.set('account', newAccount);
    }
    if (newType !== undefined) {
      if (!newType || newType === 'ALL') params.delete('type');
      else params.set('type', newType);
    }
    setSearchParams(params);
  };

  const filteredEvents = useMemo(() => {
    return events.filter((evt) => {
      const matchesAccount =
        !accountFilter || evt.account_id.toLowerCase().includes(accountFilter.toLowerCase());
      const matchesType = eventFilter === 'ALL' || evt.event_type === eventFilter;
      return matchesAccount && matchesType;
    });
  }, [events, accountFilter, eventFilter]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-zinc-900 tracking-tight">Account Events Audit Trail</h2>
          <p className="text-sm text-zinc-500">
            Immutable log of state transitions, health evaluations, cooldown triggers, and cookie rotations.
          </p>
        </div>
        <button
          onClick={() => refetch()}
          disabled={isFetching}
          className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-zinc-700 bg-white border border-zinc-200 rounded-xl hover:bg-zinc-50 transition-colors disabled:opacity-50 self-start sm:self-auto"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isFetching ? 'animate-spin' : ''}`} />
          <span>Refresh</span>
        </button>
      </div>

      {/* Filters Toolbar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-white p-3 rounded-2xl border border-zinc-200 shadow-2xs">
        <div className="flex flex-wrap items-center gap-2">
          {/* Event Type Filter */}
          {uniqueEventTypes.length > 0 && (
            <select
              value={eventFilter}
              onChange={(e) => updateFilters(undefined, e.target.value)}
              className="px-3 py-1.5 border border-zinc-200 rounded-xl text-xs bg-white text-zinc-800 focus:outline-none focus:ring-2 focus:ring-zinc-900"
            >
              <option value="ALL">All Event Types</option>
              {uniqueEventTypes.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          )}

          {accountFilter && (
            <button
              onClick={() => updateFilters('', undefined)}
              className="text-xs px-2.5 py-1 rounded-lg bg-zinc-100 hover:bg-zinc-200 text-zinc-700 font-mono flex items-center gap-1"
            >
              <span>Account: {accountFilter}</span>
              <span>✕</span>
            </button>
          )}
        </div>

        <div className="relative w-full sm:w-64">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
          <input
            type="text"
            placeholder="Filter by account ID..."
            value={accountFilter}
            onChange={(e) => updateFilters(e.target.value, undefined)}
            className="w-full pl-9 pr-3 py-1.5 bg-zinc-50 border border-zinc-200 rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:bg-white transition-all font-mono"
          />
        </div>
      </div>

      {/* Events Table */}
      {isLoading ? (
        <div className="bg-white border border-zinc-200 rounded-2xl p-12 text-center text-zinc-400">
          <RefreshCw className="w-6 h-6 animate-spin mx-auto mb-2 text-zinc-500" />
          <p className="text-sm">Loading audit events...</p>
        </div>
      ) : isError ? (
        <ErrorState
          title="Error loading audit trail"
          message="Failed to fetch account events."
          onRetry={() => refetch()}
        />
      ) : filteredEvents.length === 0 ? (
        <EmptyState
          icon={FileText}
          title="No audit events logged"
          description="Account status transitions and cooldown events will appear here automatically."
        />
      ) : (
        <div className="bg-white border border-zinc-200 rounded-2xl overflow-hidden shadow-2xs">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm text-zinc-600">
              <thead className="bg-zinc-50/75 border-b border-zinc-200 text-xs uppercase font-medium text-zinc-500">
                <tr>
                  <th className="px-5 py-3.5">Account ID</th>
                  <th className="px-5 py-3.5">Event Type</th>
                  <th className="px-5 py-3.5">State Transition</th>
                  <th className="px-5 py-3.5">Reason / Details</th>
                  <th className="px-5 py-3.5 text-right">Timestamp</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-200/75 text-xs">
                {filteredEvents.map((evt) => (
                  <tr key={evt.id} className="hover:bg-zinc-50/50 transition-colors">
                    <td className="px-5 py-3.5 font-mono text-zinc-900 font-medium">
                      <Link
                        to={`/accounts/${evt.account_id}`}
                        className="hover:underline flex items-center gap-1 group"
                      >
                        <span>{evt.account_id}</span>
                        <ArrowUpRight className="w-3 h-3 opacity-0 group-hover:opacity-100 transition-opacity" />
                      </Link>
                    </td>
                    <td className="px-5 py-3.5 font-semibold text-zinc-800">{evt.event_type}</td>
                    <td className="px-5 py-3.5 font-mono text-[11px]">
                      <span className="text-zinc-500">{evt.from_status || 'INIT'}</span>
                      <span className="mx-1 text-zinc-300">→</span>
                      <strong className="text-zinc-900">{evt.to_status}</strong>
                    </td>
                    <td className="px-5 py-3.5 text-zinc-600 max-w-md truncate">{evt.reason}</td>
                    <td className="px-5 py-3.5 text-right text-zinc-400 font-mono">
                      {new Date(evt.created_at).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};
