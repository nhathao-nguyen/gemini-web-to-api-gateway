import React, { useState, useEffect, useRef } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  Server,
  RefreshCw,
  KeyRound,
  Trash2,
  CheckCircle2,
  Clock,
  AlertTriangle,
  XCircle,
  Shield,
  Activity,
  Calendar,
  Cpu,
  Globe,
  Bot,
  Sparkles,
  Wifi,
  Edit3,
  ExternalLink,
  ShieldCheck,
  Check,
  RotateCw,
  Loader2,
} from 'lucide-react';
import {
  fetchAccount,
  fetchEvents,
  replaceAccountCookie,
  toggleAccountStatus,
  testAccountSession,
  deleteAccount,
  triggerKeepAlive,
  testProxy,
  updateAccount,
  startBrowserOnboarding,
  getBrowserOnboardingStatus,
  cancelBrowserOnboarding,
  confirmBrowserLogin,
  isDesktopBridge,
  OnboardingSessionState,
} from '../lib/api-client.js';
import { AccountStatus, SafeAccount } from '../types/client.js';
import { useDocumentTitle } from '../hooks/useDocumentTitle.js';
import { ErrorState } from '../components/ErrorState.js';
import { AccountQuotaCard } from '../components/AccountQuotaCard.js';

export const AccountDetailPage: React.FC = () => {
  const { accountId = '' } = useParams<{ accountId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [isReplaceModalOpen, setIsReplaceModalOpen] = useState(false);
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [isBrowserModalOpen, setIsBrowserModalOpen] = useState(false);
  const [newCookie, setNewCookie] = useState('');
  const [actionFeedback, setActionFeedback] = useState<string | null>(null);
  const [testingSession, setTestingSession] = useState(false);
  const [keepaliveRunning, setKeepaliveRunning] = useState(false);

  // Edit states
  const [editName, setEditName] = useState('');
  const [editEmail, setEditEmail] = useState('');
  const [editProxy, setEditProxy] = useState('');
  const [editPriority, setEditPriority] = useState(10);
  const [editWeight, setEditWeight] = useState(1);
  const [editProxyTesting, setEditProxyTesting] = useState(false);
  const [editProxyResult, setEditProxyResult] = useState<{ success: boolean; ip?: string; latencyMs?: number; error?: string } | null>(null);

  // Direct proxy tester state on card
  const [cardProxyTesting, setCardProxyTesting] = useState(false);
  const [cardProxyResult, setCardProxyResult] = useState<{ success: boolean; ip?: string; latencyMs?: number; error?: string } | null>(null);

  // Browser re-login state
  const [onboardSession, setOnboardSession] = useState<OnboardingSessionState | null>(null);
  const [onboardStarting, setOnboardStarting] = useState(false);
  const [onboardConfirming, setOnboardConfirming] = useState(false);
  const [onboardError, setOnboardError] = useState<string | null>(null);
  const pollerRef = useRef<NodeJS.Timeout | null>(null);

  // Fetch account data
  const {
    data: account,
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery({
    queryKey: ['account', accountId],
    queryFn: () => fetchAccount(accountId),
    enabled: Boolean(accountId),
  });

  // Fetch events related to this account
  const { data: allEvents = [] } = useQuery({
    queryKey: ['events'],
    queryFn: fetchEvents,
  });

  const accountEvents = allEvents.filter((e) => e.account_id === accountId);

  useDocumentTitle(account ? `${account.name} | Account Detail` : 'Account Details');

  // Sync edit form when account loads
  useEffect(() => {
    if (account) {
      setEditName(account.name);
      setEditEmail(account.email_label);
      setEditProxy(account.proxy_url || '');
      setEditPriority(account.priority);
      setEditWeight(account.weight);
    }
  }, [account]);

  // Polling for browser re-login
  useEffect(() => {
    if (!onboardSession || ['COMPLETED', 'CANCELLED', 'TIMED_OUT', 'ERROR'].includes(onboardSession.step)) {
      if (pollerRef.current) {
        clearInterval(pollerRef.current);
        pollerRef.current = null;
      }
      return;
    }

    pollerRef.current = setInterval(async () => {
      try {
        const updated = await getBrowserOnboardingStatus(onboardSession.sessionId);
        setOnboardSession(updated);
        if (updated.step === 'COMPLETED') {
          queryClient.invalidateQueries({ queryKey: ['account', accountId] });
          queryClient.invalidateQueries({ queryKey: ['accounts'] });
          setActionFeedback('Đăng nhập lại qua trình duyệt thành công! Cookie đã được cập nhật.');
        }
      } catch (err) {
        console.warn(err);
      }
    }, 1800);

    return () => {
      if (pollerRef.current) {
        clearInterval(pollerRef.current);
        pollerRef.current = null;
      }
    };
  }, [onboardSession, accountId, queryClient]);

  // Mutations
  const editMutation = useMutation({
    mutationFn: (data: Partial<SafeAccount>) => updateAccount(accountId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['account', accountId] });
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
      setIsEditModalOpen(false);
      setActionFeedback('Cập nhật thông tin tài khoản thành công.');
    },
    onError: (err: any) => {
      alert(`Lỗi cập nhật: ${err.message}`);
    },
  });

  const replaceCookieMutation = useMutation({
    mutationFn: (cookie: string) => replaceAccountCookie(accountId, cookie),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['account', accountId] });
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
      setIsReplaceModalOpen(false);
      setNewCookie('');
      setActionFeedback('Session cookie đã được mã hóa lại và lưu vào database.');
    },
    onError: (err: any) => {
      alert(`Lỗi thay thế cookie: ${err.message}`);
    },
  });

  const toggleMutation = useMutation({
    mutationFn: (nextStatus: AccountStatus) =>
      toggleAccountStatus(accountId, nextStatus, 'Thay đổi trạng thái từ trang chi tiết'),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['account', accountId] });
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteAccount(accountId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
      navigate('/accounts', { replace: true });
    },
  });

  const handleTriggerKeepAlive = async () => {
    setKeepaliveRunning(true);
    setActionFeedback(null);
    try {
      const res = await triggerKeepAlive(accountId);
      queryClient.invalidateQueries({ queryKey: ['account', accountId] });
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
      setActionFeedback(res.message);
    } catch (err: any) {
      setActionFeedback(`Lỗi Keep-Alive: ${err.message}`);
    } finally {
      setKeepaliveRunning(false);
    }
  };

  const handleStartBrowserReLogin = async (mode: 'external' | 'window' = 'external') => {
    setOnboardStarting(true);
    setOnboardError(null);
    try {
      const session = await startBrowserOnboarding({
        accountId,
        mode,
        proxyUrl: account?.proxy_url || undefined,
      });
      setOnboardSession(session);
    } catch (err: any) {
      setOnboardError(err.message || 'Không thể khởi động phiên đăng nhập trình duyệt');
    } finally {
      setOnboardStarting(false);
    }
  };

  const handleCancelBrowserOnboard = async () => {
    if (!onboardSession) return;
    try {
      await cancelBrowserOnboarding(onboardSession.sessionId);
      setOnboardSession((prev) => (prev ? { ...prev, step: 'CANCELLED', message: 'Đã hủy phiên.' } : null));
    } catch (err) {
      console.warn(err);
    }
  };

  const handleTestCardProxy = async () => {
    if (!account?.proxy_url) return;
    setCardProxyTesting(true);
    setCardProxyResult(null);
    try {
      const res = await testProxy(account.proxy_url);
      setCardProxyResult(res);
    } catch (err: any) {
      setCardProxyResult({ success: false, error: err.message });
    } finally {
      setCardProxyTesting(false);
    }
  };

  const handleTestEditProxy = async () => {
    if (!editProxy.trim()) return;
    setEditProxyTesting(true);
    setEditProxyResult(null);
    try {
      const res = await testProxy(editProxy.trim());
      setEditProxyResult(res);
    } catch (err: any) {
      setEditProxyResult({ success: false, error: err.message });
    } finally {
      setEditProxyTesting(false);
    }
  };

  const handleSaveEdit = (e: React.FormEvent) => {
    e.preventDefault();
    editMutation.mutate({
      name: editName.trim(),
      email_label: editEmail.trim(),
      proxy_url: editProxy.trim() || null,
      priority: Number(editPriority),
      weight: Number(editWeight),
    });
  };

  const handleTestSession = async () => {
    setTestingSession(true);
    setActionFeedback('Đang kết nối kiểm tra tài khoản Gemini...');
    try {
      const res = await testAccountSession(accountId);
      queryClient.invalidateQueries({ queryKey: ['account', accountId] });
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
      if (res.valid) {
        setActionFeedback(`Phiên xác thực thành công! Trạng thái: ${res.status}`);
      } else {
        setActionFeedback(`Cảnh báo phiên: ${res.error}`);
      }
    } catch (err: any) {
      setActionFeedback(`Lỗi kiểm tra: ${err.message}`);
    } finally {
      setTestingSession(false);
    }
  };

  const handleToggle = () => {
    if (!account) return;
    const nextStatus: AccountStatus = account.status === 'DISABLED' ? 'ACTIVE' : 'DISABLED';
    toggleMutation.mutate(nextStatus);
  };

  const handleDelete = () => {
    if (!confirm('Bạn có chắc chắn muốn xóa tài khoản này? Thư mục profile Chromium cũng sẽ được dọn dẹp sạch sẽ.')) return;
    deleteMutation.mutate();
  };

  if (isLoading) {
    return (
      <div className="bg-white border border-zinc-200 rounded-2xl p-16 text-center text-zinc-400">
        <RefreshCw className="w-6 h-6 animate-spin mx-auto mb-2 text-indigo-600" />
        <p className="text-sm">Đang tải thông tin tài khoản...</p>
      </div>
    );
  }

  if (isError || !account) {
    const is404 = (error as any)?.message === 'NOT_FOUND' || !account;
    return (
      <div className="bg-white border border-zinc-200 rounded-2xl p-12 text-center max-w-lg mx-auto space-y-4">
        <div className="w-12 h-12 rounded-2xl bg-zinc-100 flex items-center justify-center mx-auto text-zinc-500">
          <Server className="w-6 h-6" />
        </div>
        <h2 className="text-lg font-bold text-zinc-900">
          {is404 ? 'Không tìm thấy tài khoản Gemini' : 'Lỗi tải tài khoản'}
        </h2>
        <p className="text-sm text-zinc-500">
          {is404
            ? `Tài khoản với mã "${accountId}" không tồn tại trong cơ sở dữ liệu.`
            : (error as any)?.message || 'Đã xảy ra lỗi khi tải dữ liệu tài khoản.'}
        </p>
        <Link
          to="/accounts"
          className="inline-flex items-center gap-2 px-4 py-2 bg-zinc-900 text-white rounded-xl text-xs font-medium hover:bg-zinc-800 transition-colors"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          <span>Quay lại danh sách</span>
        </Link>
      </div>
    );
  }

  const getStatusBadge = (status: AccountStatus) => {
    switch (status) {
      case 'ACTIVE':
        return (
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200">
            <CheckCircle2 className="w-3.5 h-3.5" /> Active & Routing
          </span>
        );
      case 'COOLDOWN':
        return (
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-amber-50 text-amber-700 border border-amber-200">
            <Clock className="w-3.5 h-3.5" /> In Cooldown
          </span>
        );
      case 'QUOTA_EXHAUSTED':
        return (
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-orange-50 text-orange-700 border border-orange-200">
            <AlertTriangle className="w-3.5 h-3.5" /> Quota Exhausted
          </span>
        );
      case 'SESSION_EXPIRED':
        return (
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-rose-50 text-rose-700 border border-rose-200 animate-pulse">
            <XCircle className="w-3.5 h-3.5" /> Session Expired
          </span>
        );
      case 'DISABLED':
        return (
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-zinc-100 text-zinc-600 border border-zinc-200">
            Disabled
          </span>
        );
      default:
        return (
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-red-50 text-red-700 border border-red-200">
            <AlertTriangle className="w-3.5 h-3.5" /> Error State
          </span>
        );
    }
  };

  return (
    <div className="space-y-6">
      {/* Top Breadcrumb & Actions */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Link
            to="/accounts"
            className="p-2 rounded-xl border border-zinc-200 text-zinc-600 hover:text-zinc-900 hover:bg-white transition-colors shadow-2xs"
            title="Quay lại danh sách"
          >
            <ArrowLeft className="w-4 h-4" />
          </Link>
          <div>
            <div className="flex items-center gap-2.5 flex-wrap">
              <h2 className="text-xl font-bold text-zinc-900 tracking-tight">{account.name}</h2>
              {getStatusBadge(account.status)}
            </div>
            <p className="text-xs text-zinc-500 font-mono mt-0.5">{account.id} • {account.email_label}</p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {account.status === 'SESSION_EXPIRED' && (
            <button
              onClick={() => {
                setOnboardSession(null);
                setIsBrowserModalOpen(true);
              }}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-white bg-rose-600 rounded-xl hover:bg-rose-700 transition-colors shadow-xs"
            >
              <Sparkles className="w-3.5 h-3.5 text-amber-300" />
              <span>Đăng nhập lại Google</span>
            </button>
          )}

          <button
            onClick={() => setIsEditModalOpen(true)}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-zinc-700 bg-white border border-zinc-200 rounded-xl hover:bg-zinc-50 transition-colors shadow-2xs"
          >
            <Edit3 className="w-3.5 h-3.5 text-zinc-500" />
            <span>Sửa Cấu Hình</span>
          </button>

          <button
            onClick={handleTestSession}
            disabled={testingSession}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-zinc-700 bg-white border border-zinc-200 rounded-xl hover:bg-zinc-50 transition-colors disabled:opacity-50 shadow-2xs"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${testingSession ? 'animate-spin' : ''}`} />
            <span>Test Upstream</span>
          </button>

          <button
            onClick={() => setIsReplaceModalOpen(true)}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-zinc-700 bg-white border border-zinc-200 rounded-xl hover:bg-zinc-50 transition-colors shadow-2xs"
          >
            <KeyRound className="w-3.5 h-3.5 text-zinc-500" />
            <span>Thay Cookie</span>
          </button>

          <button
            onClick={handleToggle}
            className="px-3 py-2 text-xs font-medium rounded-xl border border-zinc-200 bg-white hover:bg-zinc-50 text-zinc-700 transition-colors shadow-2xs"
          >
            {account.status === 'DISABLED' ? 'Kích hoạt' : 'Tạm dừng'}
          </button>

          <button
            onClick={handleDelete}
            className="p-2 rounded-xl border border-zinc-200 bg-white hover:bg-rose-50 text-zinc-400 hover:text-rose-600 transition-colors shadow-2xs"
            title="Xóa tài khoản"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Feedback Toast */}
      {actionFeedback && (
        <div className="p-3.5 rounded-xl bg-zinc-900 text-zinc-100 text-xs flex items-center justify-between shadow-sm">
          <div className="flex items-center gap-2">
            {actionFeedback.startsWith('Đang') ? (
              <Loader2 className="w-4 h-4 text-blue-400 animate-spin shrink-0" />
            ) : (
              <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
            )}
            <span>{actionFeedback}</span>
          </div>
          <button onClick={() => setActionFeedback(null)} className="text-zinc-400 hover:text-white text-xs underline">
            Đóng
          </button>
        </div>
      )}

      {/* Realtime Quota Card from Google Gemini Web */}
      <AccountQuotaCard accountId={accountId} />

      {/* 2x2 Feature Cards Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Card 1: Proxy & Browser Profile Isolation */}
        <div className="bg-white border border-zinc-200 rounded-2xl p-5 shadow-2xs space-y-4">
          <div className="flex items-center justify-between pb-3 border-b border-zinc-100">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-zinc-700">
              <Globe className="w-4 h-4 text-indigo-600" />
              <span>Proxy & Cô Lập Trình Duyệt (Profile)</span>
            </div>
            {account.proxy_url && (
              <button
                onClick={handleTestCardProxy}
                disabled={cardProxyTesting}
                className="text-[11px] text-indigo-600 hover:text-indigo-800 font-medium flex items-center gap-1 disabled:opacity-40"
              >
                <Wifi className="w-3.5 h-3.5" />
                <span>{cardProxyTesting ? 'Đang test...' : 'Kiểm tra Proxy'}</span>
              </button>
            )}
          </div>

          <div className="space-y-3 text-xs">
            <div className="flex justify-between py-1 border-b border-zinc-50 items-center">
              <span className="text-zinc-500">Dedicated Proxy:</span>
              <span className="font-mono text-zinc-900">
                {account.proxy_url ? account.proxy_url : <span className="text-zinc-400 italic">Direct LAN (Không Proxy)</span>}
              </span>
            </div>

            {cardProxyResult && (
              <div className="p-2.5 rounded-xl bg-zinc-50 border border-zinc-200 text-xs font-mono">
                {cardProxyResult.success ? (
                  <span className="text-emerald-700 flex items-center gap-1.5">
                    <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                    <span>IP phản hồi: <strong>{cardProxyResult.ip}</strong> (Ping: {cardProxyResult.latencyMs}ms)</span>
                  </span>
                ) : (
                  <span className="text-rose-700 flex items-center gap-1.5">
                    <XCircle className="w-4 h-4 text-rose-600 shrink-0" />
                    <span>Lỗi: {cardProxyResult.error}</span>
                  </span>
                )}
              </div>
            )}

            <div className="flex justify-between py-1 border-b border-zinc-50">
              <span className="text-zinc-500">Thư mục Profile Chromium:</span>
              <span className="font-mono text-zinc-700 text-[11px] truncate max-w-[220px]" title={account.profile_dir || `./browser-profiles/${account.id}`}>
                {account.profile_dir || `./browser-profiles/${account.id}`}
              </span>
            </div>

            <div className="flex justify-between py-1 border-b border-zinc-50">
              <span className="text-zinc-500">Timezone / Locale:</span>
              <span className="font-mono text-zinc-800">
                {account.timezone || 'America/New_York'} • {account.locale || 'en-US'}
              </span>
            </div>

            <div className="flex justify-between py-1">
              <span className="text-zinc-500">Stealth Engine:</span>
              <span className="text-emerald-700 font-mono font-medium flex items-center gap-1">
                <ShieldCheck className="w-3.5 h-3.5" /> Playwright-Extra (navigator.webdriver = false)
              </span>
            </div>
          </div>
        </div>

        {/* Card 2: Keep-Alive 24/7 & Cookie Session Bot */}
        <div className="bg-white border border-zinc-200 rounded-2xl p-5 shadow-2xs space-y-4">
          <div className="flex items-center justify-between pb-3 border-b border-zinc-100">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-zinc-700">
              <Bot className="w-4 h-4 text-indigo-600" />
              <span>Duy Trì Phiên 24/7 (Keep-Alive Bot)</span>
            </div>
            <button
              onClick={handleTriggerKeepAlive}
              disabled={keepaliveRunning}
              className="text-[11px] text-indigo-600 hover:text-indigo-800 font-medium flex items-center gap-1 disabled:opacity-40"
            >
              <RotateCw className={`w-3.5 h-3.5 ${keepaliveRunning ? 'animate-spin' : ''}`} />
              <span>{keepaliveRunning ? 'Đang làm mới...' : 'Làm mới ngay'}</span>
            </button>
          </div>

          <div className="space-y-3 text-xs">
            <div className="flex justify-between py-1 border-b border-zinc-50 items-center">
              <span className="text-zinc-500">Trạng thái làm mới:</span>
              <span className="font-semibold">
                {account.keepalive_status === 'SUCCESS' ? (
                  <span className="inline-flex items-center gap-1 text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded-md border border-emerald-200">
                    <Check className="w-3 h-3 text-emerald-600" /> Khỏe mạnh
                  </span>
                ) : account.keepalive_status === 'FAILED' ? (
                  <span className="inline-flex items-center gap-1 text-rose-700 bg-rose-50 px-2 py-0.5 rounded-md border border-rose-200">
                    <XCircle className="w-3 h-3 text-rose-600" /> Thất bại
                  </span>
                ) : account.keepalive_status === 'REFRESHING' ? (
                  <span className="inline-flex items-center gap-1 text-blue-700 bg-blue-50 px-2 py-0.5 rounded-md border border-blue-200">
                    <RotateCw className="w-3 h-3 animate-spin text-blue-600" /> Đang cập nhật...
                  </span>
                ) : (
                  <span className="text-zinc-500 bg-zinc-100 px-2 py-0.5 rounded-md">Chờ lượt</span>
                )}
              </span>
            </div>

            <div className="flex justify-between py-1 border-b border-zinc-50">
              <span className="text-zinc-500">Lần làm mới gần nhất:</span>
              <span className="font-mono text-zinc-800">
                {account.last_keepalive_at ? new Date(account.last_keepalive_at).toLocaleString() : 'Chưa có'}
              </span>
            </div>

            <div className="flex justify-between py-1 border-b border-zinc-50">
              <span className="text-zinc-500">Mã hóa lưu trữ:</span>
              <span className="font-mono text-emerald-700 font-medium">AES-256-GCM (At-Rest)</span>
            </div>

            <div className="pt-1 flex items-center justify-between">
              <span className="text-zinc-500">Đăng nhập lại khi hết hạn:</span>
              <button
                onClick={() => {
                  setOnboardSession(null);
                  setIsBrowserModalOpen(true);
                }}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium text-indigo-700 bg-indigo-50 border border-indigo-200 hover:bg-indigo-100 transition-colors"
              >
                <ExternalLink className="w-3.5 h-3.5 text-indigo-600" />
                <span>Mở Trình Duyệt Đăng Nhập</span>
              </button>
            </div>
          </div>
        </div>

        {/* Card 3: Routing Parameters */}
        <div className="bg-white border border-zinc-200 rounded-2xl p-5 shadow-2xs space-y-4">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-zinc-700 pb-3 border-b border-zinc-100">
            <Shield className="w-4 h-4 text-zinc-600" />
            <span>Tham Số Điều Phối (Routing)</span>
          </div>

          <div className="space-y-3 text-xs">
            <div className="flex justify-between py-1 border-b border-zinc-50">
              <span className="text-zinc-500">Priority Tier:</span>
              <span className="font-mono font-semibold text-zinc-900">{account.priority}</span>
            </div>
            <div className="flex justify-between py-1 border-b border-zinc-50">
              <span className="text-zinc-500">Traffic Weight:</span>
              <span className="font-mono font-semibold text-zinc-900">{account.weight}</span>
            </div>
            <div className="flex justify-between py-1 border-b border-zinc-50">
              <span className="text-zinc-500">Auth User Index:</span>
              <span className="font-mono text-zinc-900">{account.auth_user}</span>
            </div>
            <div className="flex justify-between py-1">
              <span className="text-zinc-500">Thời điểm tạo:</span>
              <span className="text-zinc-700">{new Date(account.created_at).toLocaleDateString()}</span>
            </div>
          </div>
        </div>

        {/* Card 4: Telemetry & Traffic */}
        <div className="bg-white border border-zinc-200 rounded-2xl p-5 shadow-2xs space-y-4">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-zinc-700 pb-3 border-b border-zinc-100">
            <Activity className="w-4 h-4 text-zinc-600" />
            <span>Thống Kê Lưu Lượng (Traffic)</span>
          </div>

          <div className="space-y-3 text-xs">
            <div className="flex justify-between py-1 border-b border-zinc-50">
              <span className="text-zinc-500">Tổng lượt gọi API:</span>
              <span className="font-mono font-bold text-zinc-900">{account.request_count}</span>
            </div>
            <div className="flex justify-between py-1 border-b border-zinc-50">
              <span className="text-zinc-500">Lỗi liên tiếp:</span>
              <span className={`font-mono ${account.consecutive_errors > 0 ? 'text-rose-600 font-bold' : 'text-zinc-900'}`}>
                {account.consecutive_errors}
              </span>
            </div>
            <div className="flex justify-between py-1 border-b border-zinc-50">
              <span className="text-zinc-500">Thành công gần nhất:</span>
              <span className="text-zinc-700">
                {account.last_success_at ? new Date(account.last_success_at).toLocaleString() : 'Chưa có'}
              </span>
            </div>
            <div className="flex justify-between py-1">
              <span className="text-zinc-500">Thời gian hạ nhiệt (Cooldown):</span>
              <span className="text-zinc-700">
                {account.cooldown_until ? new Date(account.cooldown_until).toLocaleTimeString() : 'Không'}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Account Audit History */}
      <div className="bg-white border border-zinc-200 rounded-2xl overflow-hidden shadow-2xs">
        <div className="px-5 py-4 border-b border-zinc-200 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Clock className="w-4 h-4 text-zinc-500" />
            <h3 className="font-semibold text-sm text-zinc-900">Lịch Sử Sự Kiện & Keep-Alive (Audit Trail)</h3>
          </div>
          <span className="text-xs text-zinc-400 font-mono">{accountEvents.length} sự kiện</span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm text-zinc-600">
            <thead className="bg-zinc-50/75 border-b border-zinc-200 text-xs uppercase font-medium text-zinc-500">
              <tr>
                <th className="px-5 py-3">Loại Sự Kiện</th>
                <th className="px-5 py-3">Chuyển Đổi Trạng Thái</th>
                <th className="px-5 py-3">Chi Tiết / Lý Do</th>
                <th className="px-5 py-3 text-right">Thời Gian</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-200/75 text-xs">
              {accountEvents.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-5 py-8 text-center text-zinc-400">
                    Chưa có sự kiện nào được ghi nhận cho tài khoản này.
                  </td>
                </tr>
              ) : (
                accountEvents.map((evt) => (
                  <tr key={evt.id} className="hover:bg-zinc-50/50">
                    <td className="px-5 py-3 font-mono font-medium text-zinc-900">{evt.event_type}</td>
                    <td className="px-5 py-3 font-mono">
                      <span className="text-zinc-400">{evt.from_status || 'NULL'}</span>
                      <span className="mx-1 text-zinc-300">→</span>
                      <span className="text-zinc-900 font-semibold">{evt.to_status}</span>
                    </td>
                    <td className="px-5 py-3 text-zinc-600">{evt.reason}</td>
                    <td className="px-5 py-3 text-right text-zinc-400 font-mono">
                      {new Date(evt.created_at).toLocaleString()}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* EDIT CONFIG & PROXY MODAL */}
      {isEditModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-lg w-full p-6 shadow-2xl border border-zinc-200">
            <div className="flex items-center justify-between pb-4 border-b border-zinc-100">
              <h3 className="text-base font-bold text-zinc-900">Chỉnh Sửa Cấu Hình Tài Khoản</h3>
              <button onClick={() => setIsEditModalOpen(false)} className="text-zinc-400 hover:text-zinc-600 text-lg">
                ✕
              </button>
            </div>

            <form onSubmit={handleSaveEdit} className="space-y-4 pt-4">
              <div>
                <label className="block text-xs font-semibold text-zinc-700 uppercase tracking-wider mb-1">
                  Tên tài khoản
                </label>
                <input
                  type="text"
                  required
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl border border-zinc-200 text-sm focus:outline-none focus:ring-2 focus:ring-zinc-900"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-zinc-700 uppercase tracking-wider mb-1">
                  Email Label
                </label>
                <input
                  type="email"
                  required
                  value={editEmail}
                  onChange={(e) => setEditEmail(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl border border-zinc-200 text-sm focus:outline-none focus:ring-2 focus:ring-zinc-900"
                />
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="block text-xs font-semibold text-zinc-700 uppercase tracking-wider">
                    Proxy URL
                  </label>
                  <button
                    type="button"
                    disabled={!editProxy.trim() || editProxyTesting}
                    onClick={handleTestEditProxy}
                    className="text-[11px] font-medium text-indigo-600 hover:text-indigo-800 disabled:opacity-40 flex items-center gap-1"
                  >
                    <Wifi className="w-3 h-3" />
                    {editProxyTesting ? 'Đang test...' : 'Kiểm tra Proxy'}
                  </button>
                </div>
                <input
                  type="text"
                  placeholder="http://user:pass@ip:port hoặc để trống"
                  value={editProxy}
                  onChange={(e) => {
                    setEditProxy(e.target.value);
                    setEditProxyResult(null);
                  }}
                  className="w-full px-3 py-2 rounded-xl border border-zinc-200 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-zinc-900"
                />
                {editProxyResult && (
                  <div className="mt-1.5 text-xs font-mono">
                    {editProxyResult.success ? (
                      <span className="text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-1 rounded-md inline-flex items-center gap-1">
                        <Check className="w-3.5 h-3.5 text-emerald-600" /> Kết nối OK! IP: {editProxyResult.ip} ({editProxyResult.latencyMs}ms)
                      </span>
                    ) : (
                      <span className="text-rose-700 bg-rose-50 border border-rose-200 px-2 py-1 rounded-md inline-block">
                        ✕ Lỗi: {editProxyResult.error}
                      </span>
                    )}
                  </div>
                )}
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-zinc-700 uppercase tracking-wider mb-1">
                    Độ ưu tiên (1-100)
                  </label>
                  <input
                    type="number"
                    min="1"
                    max="100"
                    value={editPriority}
                    onChange={(e) => setEditPriority(Number(e.target.value))}
                    className="w-full px-3 py-2 rounded-xl border border-zinc-200 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-zinc-700 uppercase tracking-wider mb-1">
                    Trọng số tải (1-10)
                  </label>
                  <input
                    type="number"
                    min="1"
                    max="10"
                    value={editWeight}
                    onChange={(e) => setEditWeight(Number(e.target.value))}
                    className="w-full px-3 py-2 rounded-xl border border-zinc-200 text-sm"
                  />
                </div>
              </div>

              <div className="flex justify-end gap-3 pt-3 border-t border-zinc-100">
                <button
                  type="button"
                  onClick={() => setIsEditModalOpen(false)}
                  className="px-4 py-2 text-sm text-zinc-600 hover:text-zinc-900"
                >
                  Hủy
                </button>
                <button
                  type="submit"
                  disabled={editMutation.isPending}
                  className="px-4 py-2 text-sm font-semibold text-white bg-zinc-900 rounded-xl hover:bg-zinc-800 disabled:opacity-50"
                >
                  {editMutation.isPending ? 'Đang lưu...' : 'Lưu Thay Đổi'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* BROWSER RE-LOGIN MODAL */}
      {isBrowserModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-lg w-full p-6 shadow-2xl border border-zinc-200">
            <div className="flex items-center justify-between pb-4 border-b border-zinc-100">
              <h3 className="text-base font-bold text-zinc-900">Đăng Nhập Lại Qua Trình Duyệt</h3>
              <button
                onClick={() => {
                  if (onboardSession && !['COMPLETED', 'CANCELLED', 'TIMED_OUT', 'ERROR'].includes(onboardSession.step)) {
                    handleCancelBrowserOnboard();
                  }
                  setIsBrowserModalOpen(false);
                }}
                className="text-zinc-400 hover:text-zinc-600 text-lg"
              >
                ✕
              </button>
            </div>

            {!onboardSession ? (
              <div className="space-y-4 pt-4">
                <p className="text-xs text-zinc-600 leading-relaxed">
                  Trang Gemini sẽ mở trong <b>Chrome đang dùng</b> của bạn. Đăng nhập nếu cần, <b>tắt hẳn Chrome</b>,
                  rồi quay lại đây bấm <b>Đã Đăng Nhập Xong — Xác Nhận</b> để app tự đọc session mới.
                  (Không muốn tắt Chrome? Dùng extension “Gemini Gateway” → “Gửi session về app”.)
                </p>

                {onboardError && (
                  <div className="p-3 bg-rose-50 border border-rose-200 rounded-xl text-xs text-rose-700">
                    {onboardError}
                  </div>
                )}

                <div className="flex justify-end gap-3 pt-2">
                  <button
                    type="button"
                    onClick={() => setIsBrowserModalOpen(false)}
                    className="px-4 py-2 text-sm text-zinc-600 hover:text-zinc-900"
                  >
                    Hủy
                  </button>
                  <button
                    onClick={() => handleStartBrowserReLogin('window')}
                    disabled={onboardStarting}
                    className="px-4 py-2 text-sm font-medium text-indigo-700 bg-indigo-50 border border-indigo-200 rounded-xl hover:bg-indigo-100 disabled:opacity-50"
                    title="Mở cửa sổ đăng nhập riêng của app (dự phòng)"
                  >
                    Dùng cửa sổ app
                  </button>
                  <button
                    onClick={() => handleStartBrowserReLogin('external')}
                    disabled={onboardStarting}
                    className="px-5 py-2 text-sm font-semibold text-white bg-indigo-600 rounded-xl hover:bg-indigo-700 flex items-center gap-2 shadow-sm"
                  >
                    {onboardStarting ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4 text-amber-300" />}
                    <span>Mở Chrome Ngay</span>
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-4 pt-4">
                <div className={`p-4 rounded-xl text-xs flex items-center gap-3 ${
                  onboardSession.step === 'COMPLETED'
                    ? 'bg-emerald-50 text-emerald-800 border border-emerald-200'
                    : ['CANCELLED', 'TIMED_OUT', 'ERROR'].includes(onboardSession.step)
                    ? 'bg-rose-50 text-rose-800 border border-rose-200'
                    : 'bg-zinc-900 text-zinc-100'
                }`}>
                  {onboardSession.step === 'COMPLETED' ? (
                    <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0" />
                  ) : ['CANCELLED', 'TIMED_OUT', 'ERROR'].includes(onboardSession.step) ? (
                    <AlertTriangle className="w-5 h-5 text-rose-600 shrink-0" />
                  ) : (
                    <RefreshCw className="w-5 h-5 animate-spin text-indigo-400 shrink-0" />
                  )}
                  <div>{onboardSession.message}</div>
                </div>

                <div className="flex justify-end gap-3 pt-2">
                  {onboardSession.step === 'COMPLETED' ? (
                    <button
                      onClick={() => {
                        setIsBrowserModalOpen(false);
                        setOnboardSession(null);
                      }}
                      className="px-5 py-2 text-sm font-semibold text-white bg-zinc-900 rounded-xl hover:bg-zinc-800"
                    >
                      Đóng
                    </button>
                  ) : (
                    <>
                      {isDesktopBridge() && onboardSession && ['INITIALIZING', 'WAITING_LOGIN'].includes(onboardSession.step) && (
                        <button
                          onClick={async () => {
                            setOnboardConfirming(true);
                            try {
                              const updated = await confirmBrowserLogin(onboardSession.sessionId);
                              setOnboardSession(updated);
                              if (updated.step === 'COMPLETED') {
                                queryClient.invalidateQueries({ queryKey: ['account', accountId] });
                                queryClient.invalidateQueries({ queryKey: ['accounts'] });
                              }
                            } catch (err: any) {
                              setOnboardError(err.message || 'Xác nhận đăng nhập thất bại');
                            } finally {
                              setOnboardConfirming(false);
                            }
                          }}
                          disabled={onboardConfirming}
                          className="px-5 py-2 text-sm font-semibold text-white bg-emerald-600 rounded-xl hover:bg-emerald-700 disabled:opacity-60"
                        >
                          {onboardConfirming ? 'Đang xác nhận...' : 'Đã Đăng Nhập Xong — Xác Nhận'}
                        </button>
                      )}
                      <button
                        onClick={handleCancelBrowserOnboard}
                        className="px-4 py-2 text-xs font-medium text-rose-600 bg-rose-50 border border-rose-200 rounded-xl hover:bg-rose-100"
                      >
                        Hủy Phiên & Đóng Cửa Sổ
                      </button>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* REPLACE COOKIE MODAL */}
      {isReplaceModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-xl border border-zinc-200">
            <h3 className="text-base font-bold text-zinc-900 mb-1">Cập Nhật Session Cookie</h3>
            <p className="text-xs text-zinc-500 mb-4">
              Dán chuỗi cookie mới khi phiên đăng nhập bị hết hạn.
            </p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (!newCookie) return;
                replaceCookieMutation.mutate(newCookie);
              }}
              className="space-y-4"
            >
              <textarea
                required
                rows={4}
                placeholder="__Secure-1PSID=...; __Secure-1PSIDTS=..."
                value={newCookie}
                onChange={(e) => setNewCookie(e.target.value)}
                className="w-full px-3 py-2 rounded-xl border border-zinc-200 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-zinc-900"
              />
              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setIsReplaceModalOpen(false)}
                  className="px-4 py-2 text-sm text-zinc-600 hover:text-zinc-900"
                >
                  Hủy
                </button>
                <button
                  type="submit"
                  disabled={replaceCookieMutation.isPending}
                  className="px-4 py-2 text-sm font-semibold text-white bg-zinc-900 rounded-xl hover:bg-zinc-800 disabled:opacity-50"
                >
                  {replaceCookieMutation.isPending ? 'Đang cập nhật...' : 'Cập Nhật & Mã Hóa'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
