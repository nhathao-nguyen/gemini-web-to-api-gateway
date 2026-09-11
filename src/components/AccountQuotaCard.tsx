import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { RefreshCw, Info, Clock, AlertCircle } from 'lucide-react';
import { fetchAccountQuota } from '../lib/api-client.js';

interface AccountQuotaCardProps {
  accountId: string;
  compact?: boolean;
}

export const AccountQuotaCard: React.FC<AccountQuotaCardProps> = ({ accountId, compact = false }) => {
  const {
    data: quota,
    isLoading,
    isFetching,
    isError,
    error,
    refetch,
  } = useQuery({
    queryKey: ['quota', accountId],
    queryFn: () => fetchAccountQuota(accountId),
    staleTime: 60000,
    retry: 1,
  });

  if (compact) {
    if (isLoading) {
      return (
        <div className="flex items-center gap-1.5 text-xs text-zinc-400">
          <RefreshCw className="w-3 h-3 animate-spin text-zinc-500" />
          <span>Đang tải...</span>
        </div>
      );
    }
    if (isError || !quota) {
      return (
        <button
          onClick={() => refetch()}
          title="Bấm để thử lại tải hạn mức"
          className="inline-flex items-center gap-1 text-[11px] text-zinc-400 hover:text-zinc-600 transition-colors"
        >
          <AlertCircle className="w-3 h-3 text-amber-500" />
          <span>Xem hạn mức</span>
        </button>
      );
    }

    return (
      <div className="flex items-center gap-2 text-xs">
        <div className="flex items-center gap-1.5" title={`Hiện tại: ${quota.current_reset_label}`}>
          <span className="text-[11px] text-zinc-500 font-medium">Hiện tại:</span>
          <span className={`font-semibold ${quota.current_usage_percent > 80 ? 'text-rose-600' : 'text-zinc-900'}`}>
            {quota.current_usage_percent}%
          </span>
          <div className="w-12 h-1.5 bg-zinc-100 rounded-full overflow-hidden border border-zinc-200/80">
            <div
              className={`h-full rounded-full ${
                quota.current_usage_percent > 80 ? 'bg-rose-500' : 'bg-zinc-800'
              }`}
              style={{ width: `${Math.min(100, quota.current_usage_percent)}%` }}
            />
          </div>
        </div>

        <button
          onClick={() => refetch()}
          disabled={isFetching}
          title="Làm mới hạn mức realtime"
          className="p-1 rounded-md text-zinc-400 hover:text-zinc-800 hover:bg-zinc-100 transition-colors"
        >
          <RefreshCw className={`w-3 h-3 ${isFetching ? 'animate-spin text-zinc-800' : ''}`} />
        </button>
      </div>
    );
  }

  return (
    <div className="bg-zinc-950 text-white rounded-2xl p-5 sm:p-6 border border-zinc-800/80 shadow-sm relative overflow-hidden">
      {/* Glow background accent */}
      <div className="absolute top-0 right-0 w-64 h-64 bg-indigo-500/10 rounded-full blur-3xl pointer-events-none -mr-16 -mt-16" />

      {/* Header */}
      <div className="flex items-start justify-between gap-4 mb-3 relative z-10">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-lg font-semibold tracking-tight text-white flex items-center gap-2">
              <span>Hạn mức sử dụng</span>
              <span className="px-2 py-0.5 rounded-md bg-zinc-800/90 text-zinc-200 text-[11px] font-mono tracking-wider font-semibold border border-zinc-700">
                {quota?.tier || 'PRO'}
              </span>
            </h3>
          </div>
          <p className="text-xs text-zinc-400 mt-1 max-w-xl leading-relaxed">
            Hạn mức của gói sẽ quyết định mức độ bạn có thể sử dụng Gemini theo thời gian. Các mô hình và tính năng nâng
            cao đòi hỏi mức sử dụng cao hơn.
          </p>
        </div>

        <button
          onClick={() => refetch()}
          disabled={isFetching}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-zinc-900 hover:bg-zinc-800 text-xs font-medium text-zinc-300 hover:text-white border border-zinc-800 transition-all shadow-2xs disabled:opacity-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isFetching ? 'animate-spin text-indigo-400' : ''}`} />
          <span>{isFetching ? 'Đang cập nhật...' : 'Làm mới'}</span>
        </button>
      </div>

      <div className="text-[11px] text-zinc-500 mb-4 flex items-center gap-1 relative z-10">
        <Clock className="w-3 h-3" />
        <span>
          {quota?.fetched_at ? `Cập nhật lúc ${new Date(quota.fetched_at).toLocaleTimeString()}` : 'Realtime'}
        </span>
      </div>

      {isLoading ? (
        <div className="p-8 text-center text-zinc-400 border border-zinc-900 rounded-xl bg-zinc-900/40">
          <RefreshCw className="w-5 h-5 animate-spin mx-auto mb-2 text-zinc-500" />
          <p className="text-xs">Đang lấy dữ liệu hạn mức realtime từ Google Gemini Web...</p>
        </div>
      ) : isError ? (
        <div className="p-4 rounded-xl bg-rose-950/40 border border-rose-900/60 text-rose-300 text-xs flex items-center justify-between">
          <div className="flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
            <span>{(error as any)?.message || 'Không thể lấy hạn mức từ Google Gemini Web.'}</span>
          </div>
          <button
            onClick={() => refetch()}
            className="px-2.5 py-1 rounded-lg bg-rose-900/60 hover:bg-rose-800 text-white text-[11px] font-medium transition-colors"
          >
            Thử lại
          </button>
        </div>
      ) : quota ? (
        <div className="space-y-3 relative z-10">
          {/* Mức sử dụng hiện tại (5 giờ) */}
          <div className="p-4 rounded-xl bg-zinc-900/80 border border-zinc-800/80 hover:border-zinc-700 transition-colors">
            <div className="flex items-center justify-between text-xs mb-2">
              <span className="font-medium text-zinc-200 flex items-center gap-1.5">
                <span>Mức sử dụng hiện tại</span>
                <Info className="w-3.5 h-3.5 text-zinc-500" />
              </span>
              <span
                className={`font-semibold font-mono ${
                  quota.current_usage_percent >= 90
                    ? 'text-rose-400'
                    : quota.current_usage_percent >= 70
                    ? 'text-amber-400'
                    : 'text-zinc-100'
                }`}
              >
                Đã sử dụng {quota.current_usage_percent}%
              </span>
            </div>

            {/* Progress Bar */}
            <div className="w-full h-2 bg-zinc-950 rounded-full overflow-hidden border border-zinc-800">
              <div
                className={`h-full rounded-full transition-all duration-500 ${
                  quota.current_usage_percent >= 90
                    ? 'bg-rose-500'
                    : quota.current_usage_percent >= 70
                    ? 'bg-amber-500'
                    : 'bg-white'
                }`}
                style={{ width: `${Math.min(100, quota.current_usage_percent)}%` }}
              />
            </div>

            <div className="text-[11px] text-zinc-400 mt-2 flex items-center justify-between">
              <span>{quota.current_reset_label || 'Đặt lại sau chu kỳ 5h'}</span>
              <span className="text-zinc-500 text-[10px]">Chu kỳ 5 giờ</span>
            </div>
          </div>

          {/* Hạn mức hằng tuần */}
          <div className="p-4 rounded-xl bg-zinc-900/80 border border-zinc-800/80 hover:border-zinc-700 transition-colors">
            <div className="flex items-center justify-between text-xs mb-2">
              <span className="font-medium text-zinc-200">Hạn mức hằng tuần</span>
              <span className="font-semibold font-mono text-zinc-100">
                Đã sử dụng {quota.weekly_usage_percent}%
              </span>
            </div>

            {/* Progress Bar */}
            <div className="w-full h-2 bg-zinc-950 rounded-full overflow-hidden border border-zinc-800">
              <div
                className="h-full rounded-full bg-white transition-all duration-500"
                style={{ width: `${Math.min(100, quota.weekly_usage_percent)}%` }}
              />
            </div>

            <div className="text-[11px] text-zinc-400 mt-2 flex items-center justify-between">
              <span>{quota.weekly_reset_label || 'Đặt lại theo tuần'}</span>
              <span className="text-zinc-500 text-[10px]">Chu kỳ 7 ngày</span>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
};
