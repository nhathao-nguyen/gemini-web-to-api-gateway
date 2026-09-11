import React, { useMemo } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  BarChart3,
  Clock,
  RefreshCw,
  Search,
  Filter,
  CheckCircle2,
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  X,
} from 'lucide-react';
import { fetchLogs, fetchAnalytics } from '../lib/api-client.js';
import { RequestLogItem } from '../types/client.js';
import { useDocumentTitle } from '../hooks/useDocumentTitle.js';
import { EmptyState } from '../components/EmptyState.js';
import { ErrorState } from '../components/ErrorState.js';

export const LogsPage: React.FC = () => {
  useDocumentTitle('Request Logs');
  const [searchParams, setSearchParams] = useSearchParams();

  const page = parseInt(searchParams.get('page') || '1', 10);
  const statusFilter = searchParams.get('status') || 'ALL';
  const modelFilter = searchParams.get('model') || 'ALL';
  const selectedRequestId = searchParams.get('request');
  const pageSize = 20;

  const {
    data: logs = [],
    isLoading: loadingLogs,
    isError: errorLogs,
    refetch: refetchLogs,
    isFetching,
  } = useQuery({
    queryKey: ['logs'],
    queryFn: fetchLogs,
    refetchInterval: 8000,
  });

  const { data: analytics } = useQuery({
    queryKey: ['analytics'],
    queryFn: fetchAnalytics,
    refetchInterval: 8000,
  });

  // Unique models list for filter dropdown
  const uniqueModels = useMemo(() => {
    const set = new Set<string>();
    logs.forEach((l) => {
      if (l.model) set.add(l.model);
    });
    return Array.from(set);
  }, [logs]);

  // Filter logs
  const filteredLogs = useMemo(() => {
    return logs.filter((log) => {
      const matchesStatus =
        statusFilter === 'ALL' ||
        (statusFilter === '200' && log.status === 200) ||
        (statusFilter === 'error' && log.status !== 200);

      const matchesModel = modelFilter === 'ALL' || log.model === modelFilter;

      return matchesStatus && matchesModel;
    });
  }, [logs, statusFilter, modelFilter]);

  // Paginated slice
  const totalPages = Math.max(1, Math.ceil(filteredLogs.length / pageSize));
  const currentPage = Math.min(Math.max(1, page), totalPages);
  const paginatedLogs = useMemo(() => {
    const start = (currentPage - 1) * pageSize;
    return filteredLogs.slice(start, start + pageSize);
  }, [filteredLogs, currentPage, pageSize]);

  // Selected request for detail modal
  const selectedRequest = useMemo(() => {
    if (!selectedRequestId) return null;
    return logs.find((l) => l.request_id === selectedRequestId) || null;
  }, [logs, selectedRequestId]);

  const updateParam = (key: string, val: string | null) => {
    const params = new URLSearchParams(searchParams);
    if (!val || val === 'ALL') {
      params.delete(key);
    } else {
      params.set(key, val);
    }
    if (key !== 'page') {
      params.delete('page'); // Reset to page 1 on filter change
    }
    setSearchParams(params);
  };

  const openRequestDetail = (reqId: string) => {
    const params = new URLSearchParams(searchParams);
    params.set('request', reqId);
    setSearchParams(params);
  };

  const closeRequestDetail = () => {
    const params = new URLSearchParams(searchParams);
    params.delete('request');
    setSearchParams(params);
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-zinc-900 tracking-tight">HTTP Request Telemetry</h2>
          <p className="text-sm text-zinc-500">
            Real-time access logs and performance metrics for <code className="font-mono text-xs bg-zinc-100 px-1.5 py-0.5 rounded">/v1/chat/completions</code>.
          </p>
        </div>
        <button
          onClick={() => refetchLogs()}
          disabled={isFetching}
          className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-zinc-700 bg-white border border-zinc-200 rounded-xl hover:bg-zinc-50 transition-colors disabled:opacity-50 self-start sm:self-auto"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isFetching ? 'animate-spin' : ''}`} />
          <span>Auto-refreshing</span>
        </button>
      </div>

      {/* Metrics Row */}
      {analytics && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="bg-white border border-zinc-200 rounded-2xl p-4 shadow-2xs">
            <span className="text-xs font-medium text-zinc-500 uppercase tracking-wider block">Total Requests</span>
            <div className="mt-1 text-2xl font-bold text-zinc-900 font-mono">{analytics.totalRequests}</div>
            <span className="text-[11px] text-zinc-400">All clients combined</span>
          </div>

          <div className="bg-white border border-zinc-200 rounded-2xl p-4 shadow-2xs">
            <span className="text-xs font-medium text-zinc-500 uppercase tracking-wider block">Success Rate</span>
            <div className="mt-1 text-2xl font-bold text-emerald-600 font-mono">{analytics.successRate}%</div>
            <span className="text-[11px] text-zinc-400">{analytics.successfulRequests} ok / {analytics.errorRequests} err</span>
          </div>

          <div className="bg-white border border-zinc-200 rounded-2xl p-4 shadow-2xs">
            <span className="text-xs font-medium text-zinc-500 uppercase tracking-wider block">Average Latency</span>
            <div className="mt-1 text-2xl font-bold text-zinc-900 font-mono">{analytics.avgLatency}ms</div>
            <span className="text-[11px] text-zinc-400">Upstream round-trip</span>
          </div>

          <div className="bg-white border border-zinc-200 rounded-2xl p-4 shadow-2xs">
            <span className="text-xs font-medium text-zinc-500 uppercase tracking-wider block">Active Models</span>
            <div className="mt-1 text-2xl font-bold text-zinc-900 font-mono">
              {Object.keys(analytics.requestsByModel).length}
            </div>
            <span className="text-[11px] text-zinc-400">Model aliases used</span>
          </div>
        </div>
      )}

      {/* Filters Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3 bg-white p-3 rounded-2xl border border-zinc-200 shadow-2xs">
        <div className="flex flex-wrap items-center gap-2">
          {/* Status Filter */}
          <div className="flex items-center gap-1 bg-zinc-100 p-1 rounded-xl">
            <button
              onClick={() => updateParam('status', 'ALL')}
              className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-colors ${
                statusFilter === 'ALL' ? 'bg-white text-zinc-900 shadow-2xs' : 'text-zinc-600 hover:text-zinc-900'
              }`}
            >
              All Statuses
            </button>
            <button
              onClick={() => updateParam('status', '200')}
              className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-colors ${
                statusFilter === '200' ? 'bg-white text-emerald-700 shadow-2xs' : 'text-zinc-600 hover:text-zinc-900'
              }`}
            >
              200 OK
            </button>
            <button
              onClick={() => updateParam('status', 'error')}
              className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-colors ${
                statusFilter === 'error' ? 'bg-white text-rose-700 shadow-2xs' : 'text-zinc-600 hover:text-zinc-900'
              }`}
            >
              Errors
            </button>
          </div>

          {/* Model Filter */}
          {uniqueModels.length > 0 && (
            <select
              value={modelFilter}
              onChange={(e) => updateParam('model', e.target.value)}
              className="px-3 py-1.5 border border-zinc-200 rounded-xl text-xs bg-white text-zinc-800 focus:outline-none focus:ring-2 focus:ring-zinc-900 font-mono"
            >
              <option value="ALL">All Models</option>
              {uniqueModels.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          )}
        </div>

        <span className="text-xs text-zinc-400 font-mono">
          Showing {filteredLogs.length} requests
        </span>
      </div>

      {/* Logs Table */}
      {loadingLogs ? (
        <div className="bg-white border border-zinc-200 rounded-2xl p-12 text-center text-zinc-400">
          <RefreshCw className="w-6 h-6 animate-spin mx-auto mb-2 text-zinc-500" />
          <p className="text-sm">Loading request logs from database...</p>
        </div>
      ) : errorLogs ? (
        <ErrorState
          title="Error loading logs"
          message="Failed to fetch HTTP request logs."
          onRetry={() => refetchLogs()}
        />
      ) : paginatedLogs.length === 0 ? (
        <EmptyState
          icon={Activity}
          title="No request logs recorded"
          description="Execute a completion in the Playground or send OpenAI SDK requests to populate live logs."
        />
      ) : (
        <div className="bg-white border border-zinc-200 rounded-2xl overflow-hidden shadow-2xs">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm text-zinc-600">
              <thead className="bg-zinc-50/75 border-b border-zinc-200 text-xs uppercase font-medium text-zinc-500">
                <tr>
                  <th className="px-5 py-3.5">Request ID</th>
                  <th className="px-5 py-3.5">Model</th>
                  <th className="px-5 py-3.5">Status</th>
                  <th className="px-5 py-3.5">Latency</th>
                  <th className="px-5 py-3.5">Account Routing</th>
                  <th className="px-5 py-3.5 text-right">Timestamp</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-200/75 font-mono text-xs">
                {paginatedLogs.map((log) => (
                  <tr
                    key={log.request_id}
                    onClick={() => openRequestDetail(log.request_id)}
                    className="hover:bg-zinc-50/70 transition-colors cursor-pointer"
                  >
                    <td className="px-5 py-3.5 text-zinc-900 font-semibold">{log.request_id}</td>
                    <td className="px-5 py-3.5 text-zinc-800">{log.model}</td>
                    <td className="px-5 py-3.5">
                      <span
                        className={`px-2 py-0.5 rounded-md text-[11px] font-medium ${
                          log.status === 200
                            ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                            : 'bg-rose-50 text-rose-700 border border-rose-200'
                        }`}
                      >
                        {log.status} {log.error_code ? `(${log.error_code})` : ''}
                      </span>
                    </td>
                    <td className="px-5 py-3.5 text-zinc-700">{log.latency_ms}ms</td>
                    <td className="px-5 py-3.5 text-zinc-500">
                      {log.account_id ? (
                        <Link
                          to={`/accounts/${log.account_id}`}
                          onClick={(e) => e.stopPropagation()}
                          className="hover:text-zinc-900 underline decoration-zinc-300"
                        >
                          {log.account_id}
                        </Link>
                      ) : (
                        'None'
                      )}
                    </td>
                    <td className="px-5 py-3.5 text-right text-zinc-400 font-sans">
                      {new Date(log.created_at).toLocaleTimeString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination Controls */}
          {totalPages > 1 && (
            <div className="px-5 py-3 border-t border-zinc-200 flex items-center justify-between text-xs text-zinc-600">
              <span>
                Page {currentPage} of {totalPages}
              </span>
              <div className="flex items-center gap-1">
                <button
                  disabled={currentPage <= 1}
                  onClick={() => updateParam('page', (currentPage - 1).toString())}
                  className="p-1.5 rounded-lg border border-zinc-200 hover:bg-zinc-50 disabled:opacity-40 transition-colors"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <button
                  disabled={currentPage >= totalPages}
                  onClick={() => updateParam('page', (currentPage + 1).toString())}
                  className="p-1.5 rounded-lg border border-zinc-200 hover:bg-zinc-50 disabled:opacity-40 transition-colors"
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* REQUEST DETAIL DEEP LINK MODAL */}
      {selectedRequest && (
        <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-lg w-full p-6 shadow-xl border border-zinc-200 space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-zinc-100">
              <div className="flex items-center gap-2">
                <Activity className="w-4 h-4 text-zinc-600" />
                <h3 className="font-semibold text-zinc-900 text-sm">Request Telemetry Details</h3>
              </div>
              <button
                onClick={closeRequestDetail}
                className="p-1 rounded-lg text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-2.5 text-xs font-mono">
              <div className="flex justify-between py-1 border-b border-zinc-100">
                <span className="text-zinc-500 font-sans">Request ID:</span>
                <span className="font-bold text-zinc-900">{selectedRequest.request_id}</span>
              </div>
              <div className="flex justify-between py-1 border-b border-zinc-100">
                <span className="text-zinc-500 font-sans">Model Requested:</span>
                <span className="text-zinc-900">{selectedRequest.model}</span>
              </div>
              <div className="flex justify-between py-1 border-b border-zinc-100">
                <span className="text-zinc-500 font-sans">Response Status:</span>
                <span
                  className={
                    selectedRequest.status === 200 ? 'text-emerald-700 font-bold' : 'text-rose-700 font-bold'
                  }
                >
                  {selectedRequest.status}
                </span>
              </div>
              <div className="flex justify-between py-1 border-b border-zinc-100">
                <span className="text-zinc-500 font-sans">Round-trip Latency:</span>
                <span className="text-zinc-900">{selectedRequest.latency_ms}ms</span>
              </div>
              <div className="flex justify-between py-1 border-b border-zinc-100">
                <span className="text-zinc-500 font-sans">Account Used:</span>
                <span className="text-zinc-900">{selectedRequest.account_id || 'None (Failed before route)'}</span>
              </div>
              <div className="flex justify-between py-1 border-b border-zinc-100">
                <span className="text-zinc-500 font-sans">API Key ID:</span>
                <span className="text-zinc-900">{selectedRequest.api_key_id}</span>
              </div>
              {selectedRequest.error_code && (
                <div className="flex justify-between py-1 border-b border-zinc-100">
                  <span className="text-zinc-500 font-sans">Error Code:</span>
                  <span className="text-rose-600 font-bold">{selectedRequest.error_code}</span>
                </div>
              )}
              <div className="flex justify-between py-1">
                <span className="text-zinc-500 font-sans">Timestamp:</span>
                <span className="text-zinc-700">{new Date(selectedRequest.created_at).toLocaleString()}</span>
              </div>
            </div>

            <div className="pt-2 flex justify-end">
              <button
                onClick={closeRequestDetail}
                className="px-4 py-2 bg-zinc-900 text-white rounded-xl text-xs font-medium hover:bg-zinc-800"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
