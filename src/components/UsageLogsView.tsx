import React, { useState } from 'react';
import { Activity, ShieldAlert, CheckCircle2, Clock, BarChart3, Database } from 'lucide-react';
import { AnalyticsData, RequestLogItem, AccountEventItem } from '../types/client.js';

interface UsageLogsViewProps {
  analytics: AnalyticsData;
  logs: RequestLogItem[];
  events: AccountEventItem[];
  onRefresh: () => void;
}

export const UsageLogsView: React.FC<UsageLogsViewProps> = ({ analytics, logs, events, onRefresh }) => {
  const [activeSubTab, setActiveSubTab] = useState<'requests' | 'events'>('requests');

  return (
    <div className="space-y-6">
      {/* Overview Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white border border-zinc-200 rounded-xl p-4 shadow-xs">
          <div className="text-xs font-medium text-zinc-500 uppercase tracking-wider">Total Requests</div>
          <div className="mt-1 text-2xl font-bold text-zinc-900 font-mono">{analytics.totalRequests}</div>
          <div className="mt-1 text-xs text-zinc-400">Processed by gateway</div>
        </div>

        <div className="bg-white border border-zinc-200 rounded-xl p-4 shadow-xs">
          <div className="text-xs font-medium text-zinc-500 uppercase tracking-wider">Success Rate</div>
          <div className="mt-1 text-2xl font-bold text-emerald-600 font-mono">{analytics.successRate}%</div>
          <div className="mt-1 text-xs text-zinc-400">{analytics.successfulRequests} successful / {analytics.errorRequests} errors</div>
        </div>

        <div className="bg-white border border-zinc-200 rounded-xl p-4 shadow-xs">
          <div className="text-xs font-medium text-zinc-500 uppercase tracking-wider">Average Latency</div>
          <div className="mt-1 text-2xl font-bold text-zinc-900 font-mono">{analytics.avgLatency}ms</div>
          <div className="mt-1 text-xs text-zinc-400">Round-trip response time</div>
        </div>

        <div className="bg-white border border-zinc-200 rounded-xl p-4 shadow-xs">
          <div className="text-xs font-medium text-zinc-500 uppercase tracking-wider">Active Models</div>
          <div className="mt-1 text-2xl font-bold text-zinc-900 font-mono">
            {Object.keys(analytics.requestsByModel).length}
          </div>
          <div className="mt-1 text-xs text-zinc-400">Gemini Web model aliases</div>
        </div>
      </div>

      {/* Model Distribution Breakdown */}
      <div className="bg-white border border-zinc-200 rounded-xl p-5 shadow-xs">
        <div className="flex items-center gap-2 mb-4 font-semibold text-sm text-zinc-900">
          <BarChart3 className="w-4 h-4 text-zinc-500" />
          <span>Requests by Model</span>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3">
          {Object.entries(analytics.requestsByModel).length === 0 ? (
            <div className="text-xs text-zinc-400 col-span-4 py-2">No request distribution recorded yet.</div>
          ) : (
            Object.entries(analytics.requestsByModel).map(([model, count]) => (
              <div key={model} className="p-3 rounded-lg bg-zinc-50 border border-zinc-200">
                <div className="text-xs font-mono font-medium text-zinc-800 truncate">{model}</div>
                <div className="text-lg font-bold text-zinc-900 mt-1 font-mono">{count}</div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Toggle between Request Logs and Account Events */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 p-1 bg-zinc-100 rounded-lg border border-zinc-200">
          <button
            onClick={() => setActiveSubTab('requests')}
            className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
              activeSubTab === 'requests' ? 'bg-white text-zinc-900 shadow-xs' : 'text-zinc-600 hover:text-zinc-900'
            }`}
          >
            HTTP Request Logs ({logs.length})
          </button>
          <button
            onClick={() => setActiveSubTab('events')}
            className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
              activeSubTab === 'events' ? 'bg-white text-zinc-900 shadow-xs' : 'text-zinc-600 hover:text-zinc-900'
            }`}
          >
            Account State Audit Trail ({events.length})
          </button>
        </div>

        <button
          onClick={onRefresh}
          className="text-xs text-zinc-600 hover:text-zinc-900 flex items-center gap-1 font-medium"
        >
          <Clock className="w-3.5 h-3.5" />
          Auto-refreshing
        </button>
      </div>

      {/* REQUEST LOGS TABLE */}
      {activeSubTab === 'requests' && (
        <div className="bg-white border border-zinc-200 rounded-xl overflow-hidden shadow-xs">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm text-zinc-600">
              <thead className="bg-zinc-50/75 border-b border-zinc-200 text-xs uppercase font-medium text-zinc-500">
                <tr>
                  <th className="px-5 py-3">Request ID</th>
                  <th className="px-5 py-3">Model</th>
                  <th className="px-5 py-3">Status</th>
                  <th className="px-5 py-3">Latency</th>
                  <th className="px-5 py-3">Account ID</th>
                  <th className="px-5 py-3 text-right">Time</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-200/75 font-mono text-xs">
                {logs.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-5 py-8 text-center text-zinc-400 font-sans text-xs">
                      No incoming requests recorded. Run a completion in the Playground or connect an OpenAI client.
                    </td>
                  </tr>
                ) : (
                  logs.map((log) => (
                    <tr key={log.request_id} className="hover:bg-zinc-50/50">
                      <td className="px-5 py-3 text-zinc-900">{log.request_id}</td>
                      <td className="px-5 py-3">{log.model}</td>
                      <td className="px-5 py-3">
                        <span
                          className={`px-2 py-0.5 rounded text-[11px] font-medium ${
                            log.status === 200
                              ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                              : 'bg-rose-50 text-rose-700 border border-rose-200'
                          }`}
                        >
                          {log.status} {log.error_code ? `(${log.error_code})` : ''}
                        </span>
                      </td>
                      <td className="px-5 py-3">{log.latency_ms}ms</td>
                      <td className="px-5 py-3 text-zinc-500">{log.account_id || 'n/a'}</td>
                      <td className="px-5 py-3 text-right text-zinc-400 font-sans">
                        {new Date(log.created_at).toLocaleTimeString()}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ACCOUNT EVENTS AUDIT TRAIL TABLE */}
      {activeSubTab === 'events' && (
        <div className="bg-white border border-zinc-200 rounded-xl overflow-hidden shadow-xs">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm text-zinc-600">
              <thead className="bg-zinc-50/75 border-b border-zinc-200 text-xs uppercase font-medium text-zinc-500">
                <tr>
                  <th className="px-5 py-3">Account</th>
                  <th className="px-5 py-3">Event Type</th>
                  <th className="px-5 py-3">Transition</th>
                  <th className="px-5 py-3">Reason / Details</th>
                  <th className="px-5 py-3 text-right">Timestamp</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-200/75 text-xs">
                {events.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-5 py-8 text-center text-zinc-400">
                      No account events logged yet.
                    </td>
                  </tr>
                ) : (
                  events.map((evt) => (
                    <tr key={evt.id} className="hover:bg-zinc-50/50">
                      <td className="px-5 py-3 font-mono text-zinc-900">{evt.account_id}</td>
                      <td className="px-5 py-3 font-medium text-zinc-800">{evt.event_type}</td>
                      <td className="px-5 py-3 font-mono text-[11px]">
                        {evt.from_status || 'INIT'} → <strong className="text-zinc-900">{evt.to_status}</strong>
                      </td>
                      <td className="px-5 py-3 text-zinc-600 max-w-md truncate">{evt.reason}</td>
                      <td className="px-5 py-3 text-right text-zinc-400">
                        {new Date(evt.created_at).toLocaleTimeString()}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};
