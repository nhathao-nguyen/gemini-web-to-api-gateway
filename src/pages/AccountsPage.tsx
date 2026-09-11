import React, { useState, useMemo, useEffect, useRef } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
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
  Search,
  ArrowUpRight,
  Globe,
  Bot,
  Sparkles,
  Wifi,
  WifiOff,
  Edit3,
  ExternalLink,
  ShieldCheck,
  Check,
  Play,
  RotateCw,
} from 'lucide-react';
import {
  fetchAccounts,
  createAccount,
  replaceAccountCookie,
  toggleAccountStatus,
  testAccountSession,
  deleteAccount,
  fetchKeepAliveStatus,
  triggerKeepAlive,
  testProxy,
  updateAccount,
  startBrowserOnboarding,
  getBrowserOnboardingStatus,
  cancelBrowserOnboarding,
  OnboardingSessionState,
} from '../lib/api-client.js';
import { SafeAccount, AccountStatus } from '../types/client.js';
import { useDocumentTitle } from '../hooks/useDocumentTitle.js';
import { EmptyState } from '../components/EmptyState.js';
import { ErrorState } from '../components/ErrorState.js';
import { AccountQuotaCard } from '../components/AccountQuotaCard.js';

export const AccountsPage: React.FC = () => {
  useDocumentTitle('Gemini Accounts | Pool & Keep-Alive');
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();

  const statusFilter = searchParams.get('status') || 'ALL';
  const searchQuery = searchParams.get('q') || '';

  // Modals state
  const [isBrowserModalOpen, setIsBrowserModalOpen] = useState(false);
  const [isAddManualModalOpen, setIsAddManualModalOpen] = useState(false);
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [isReplaceModalOpen, setIsReplaceModalOpen] = useState(false);
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);

  // Manual Add account form states
  const [name, setName] = useState('');
  const [emailLabel, setEmailLabel] = useState('');
  const [cookie, setCookie] = useState('');
  const [proxyUrl, setProxyUrl] = useState('');
  const [authUser, setAuthUser] = useState('0');
  const [priority, setPriority] = useState(10);
  const [weight, setWeight] = useState(1);
  const [actionFeedback, setActionFeedback] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [keepaliveRunningId, setKeepaliveRunningId] = useState<string | null>(null);

  // Edit account modal form states
  const [editingAccount, setEditingAccount] = useState<SafeAccount | null>(null);
  const [editName, setEditName] = useState('');
  const [editEmail, setEditEmail] = useState('');
  const [editProxy, setEditProxy] = useState('');
  const [editPriority, setEditPriority] = useState(10);
  const [editWeight, setEditWeight] = useState(1);
  const [editProxyTesting, setEditProxyTesting] = useState(false);
  const [editProxyResult, setEditProxyResult] = useState<{ success: boolean; ip?: string; latencyMs?: number; error?: string } | null>(null);

  // Browser Onboarding form and session states
  const [onboardAccountId, setOnboardAccountId] = useState<string | null>(null);
  const [onboardName, setOnboardName] = useState('');
  const [onboardEmail, setOnboardEmail] = useState('');
  const [onboardProxy, setOnboardProxy] = useState('');
  const [onboardPriority, setOnboardPriority] = useState(10);
  const [onboardWeight, setOnboardWeight] = useState(1);
  const [onboardTestingProxy, setOnboardTestingProxy] = useState(false);
  const [onboardProxyResult, setOnboardProxyResult] = useState<{ success: boolean; ip?: string; latencyMs?: number; error?: string } | null>(null);
  const [onboardSession, setOnboardSession] = useState<OnboardingSessionState | null>(null);
  const [onboardError, setOnboardError] = useState<string | null>(null);
  const [onboardStarting, setOnboardStarting] = useState(false);
  const pollerRef = useRef<NodeJS.Timeout | null>(null);

  // Inline proxy test state for table rows: accountId -> result
  const [rowProxyTestingId, setRowProxyTestingId] = useState<string | null>(null);
  const [rowProxyResults, setRowProxyResults] = useState<Record<string, { success: boolean; ip?: string; latencyMs?: number; error?: string }>>({});

  // Replace cookie form
  const [newCookie, setNewCookie] = useState('');

  // Fetch accounts query
  const {
    data: accounts = [],
    isLoading,
    isError,
    error,
    refetch,
    isFetching,
  } = useQuery({
    queryKey: ['accounts'],
    queryFn: fetchAccounts,
  });

  // Fetch Keep-Alive worker telemetry query
  const { data: keepaliveReport, refetch: refetchKeepalive } = useQuery({
    queryKey: ['keepalive-status'],
    queryFn: fetchKeepAliveStatus,
    refetchInterval: 8000,
  });

  // Polling for active onboarding session
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
          queryClient.invalidateQueries({ queryKey: ['accounts'] });
          queryClient.invalidateQueries({ queryKey: ['analytics'] });
          setActionFeedback(`Đăng nhập qua trình duyệt thành công! Tài khoản "${updated.name}" đã được đưa vào pool.`);
        }
      } catch (err: any) {
        console.warn('Error polling onboarding session:', err);
      }
    }, 1800);

    return () => {
      if (pollerRef.current) {
        clearInterval(pollerRef.current);
        pollerRef.current = null;
      }
    };
  }, [onboardSession, queryClient]);

  // Mutations
  const addMutation = useMutation({
    mutationFn: createAccount,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
      queryClient.invalidateQueries({ queryKey: ['analytics'] });
      setIsAddManualModalOpen(false);
      setName('');
      setEmailLabel('');
      setCookie('');
      setProxyUrl('');
      setActionFeedback('Tài khoản đã được mã hóa AES-256-GCM và kích hoạt thành công!');
    },
    onError: (err: any) => {
      alert(`Thêm tài khoản thất bại: ${err.message}`);
    },
  });

  const editMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<SafeAccount> }) => updateAccount(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
      setIsEditModalOpen(false);
      setEditingAccount(null);
      setActionFeedback('Cập nhật cấu hình và Proxy tài khoản thành công.');
    },
    onError: (err: any) => {
      alert(`Lỗi cập nhật tài khoản: ${err.message}`);
    },
  });

  const replaceCookieMutation = useMutation({
    mutationFn: ({ id, cookie }: { id: string; cookie: string }) => replaceAccountCookie(id, cookie),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
      setIsReplaceModalOpen(false);
      setNewCookie('');
      setSelectedAccountId(null);
      setActionFeedback('Session cookie đã được mã hóa lại thành công.');
    },
    onError: (err: any) => {
      alert(`Lỗi cập nhật cookie: ${err.message}`);
    },
  });

  const toggleMutation = useMutation({
    mutationFn: ({ id, nextStatus }: { id: string; nextStatus: AccountStatus }) =>
      toggleAccountStatus(id, nextStatus),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteAccount(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
      queryClient.invalidateQueries({ queryKey: ['analytics'] });
      setActionFeedback('Đã xóa tài khoản và dọn dẹp thư mục profile Chromium tương ứng.');
    },
  });

  const handleAddManualAccount = (e: React.FormEvent) => {
    e.preventDefault();
    addMutation.mutate({
      name,
      email_label: emailLabel,
      cookie,
      proxy_url: proxyUrl.trim() || undefined,
      auth_user: authUser,
      priority: Number(priority),
      weight: Number(weight),
      supported_models: [],
    });
  };

  const handleOpenEdit = (acc: SafeAccount) => {
    setEditingAccount(acc);
    setEditName(acc.name);
    setEditEmail(acc.email_label);
    setEditProxy(acc.proxy_url || '');
    setEditPriority(acc.priority);
    setEditWeight(acc.weight);
    setEditProxyResult(null);
    setIsEditModalOpen(true);
  };

  const handleSaveEdit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingAccount) return;
    editMutation.mutate({
      id: editingAccount.id,
      data: {
        name: editName.trim(),
        email_label: editEmail.trim(),
        proxy_url: editProxy.trim() || null,
        priority: Number(editPriority),
        weight: Number(editWeight),
      },
    });
  };

  const handleStartBrowserOnboard = async (e: React.FormEvent) => {
    e.preventDefault();
    setOnboardStarting(true);
    setOnboardError(null);
    try {
      const session = await startBrowserOnboarding({
        accountId: onboardAccountId || undefined,
        name: onboardName.trim() || undefined,
        emailLabel: onboardEmail.trim() || undefined,
        proxyUrl: onboardProxy.trim() || undefined,
        priority: Number(onboardPriority),
        weight: Number(onboardWeight),
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

  const handleOpenBrowserOnboardNew = () => {
    setOnboardAccountId(null);
    setOnboardName(`Gemini Acc ${accounts.length + 1}`);
    setOnboardEmail('');
    setOnboardProxy('');
    setOnboardPriority(10);
    setOnboardWeight(1);
    setOnboardSession(null);
    setOnboardProxyResult(null);
    setOnboardError(null);
    setIsBrowserModalOpen(true);
  };

  const handleOpenBrowserReLogin = (acc: SafeAccount) => {
    setOnboardAccountId(acc.id);
    setOnboardName(acc.name);
    setOnboardEmail(acc.email_label);
    setOnboardProxy(acc.proxy_url || '');
    setOnboardPriority(acc.priority);
    setOnboardWeight(acc.weight);
    setOnboardSession(null);
    setOnboardProxyResult(null);
    setOnboardError(null);
    setIsBrowserModalOpen(true);
  };

  const handleTestProxyInOnboard = async () => {
    if (!onboardProxy.trim()) return;
    setOnboardTestingProxy(true);
    setOnboardProxyResult(null);
    try {
      const res = await testProxy(onboardProxy.trim());
      setOnboardProxyResult(res);
    } catch (err: any) {
      setOnboardProxyResult({ success: false, error: err.message });
    } finally {
      setOnboardTestingProxy(false);
    }
  };

  const handleTestProxyInEdit = async () => {
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

  const handleTestProxyRow = async (accId: string, pUrl: string) => {
    setRowProxyTestingId(accId);
    try {
      const res = await testProxy(pUrl);
      setRowProxyResults((prev) => ({ ...prev, [accId]: res }));
    } catch (err: any) {
      setRowProxyResults((prev) => ({ ...prev, [accId]: { success: false, error: err.message } }));
    } finally {
      setRowProxyTestingId(null);
    }
  };

  const handleTriggerKeepAliveNow = async (id: string) => {
    setKeepaliveRunningId(id);
    setActionFeedback(null);
    try {
      const res = await triggerKeepAlive(id);
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
      queryClient.invalidateQueries({ queryKey: ['keepalive-status'] });
      setActionFeedback(res.message);
    } catch (err: any) {
      setActionFeedback(`Lỗi Keep-Alive: ${err.message}`);
    } finally {
      setKeepaliveRunningId(null);
    }
  };

  const handleReplaceCookie = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedAccountId || !newCookie) return;
    replaceCookieMutation.mutate({ id: selectedAccountId, cookie: newCookie });
  };

  const handleTestSession = async (id: string) => {
    setTestingId(id);
    setActionFeedback(null);
    try {
      const res = await testAccountSession(id);
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
      if (res.valid) {
        setActionFeedback(`Phiên hoạt động tốt! Trạng thái xác nhận: ${res.status}`);
      } else {
        setActionFeedback(`Cảnh báo kiểm tra phiên: ${res.error}`);
      }
    } catch (err: any) {
      setActionFeedback(`Lỗi kiểm tra phiên: ${err.message}`);
    } finally {
      setTestingId(null);
    }
  };

  const handleToggleStatus = (account: SafeAccount) => {
    const nextStatus: AccountStatus = account.status === 'DISABLED' ? 'ACTIVE' : 'DISABLED';
    toggleMutation.mutate({ id: account.id, nextStatus });
  };

  const handleDelete = (id: string) => {
    if (!confirm('Bạn có chắc chắn muốn xóa tài khoản này khỏi gateway pool? Toàn bộ profile Chromium cô lập cũng sẽ được dọn dẹp sạch sẽ.')) return;
    deleteMutation.mutate(id);
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

  // Filtered accounts
  const filteredAccounts = useMemo(() => {
    return accounts.filter((acc) => {
      const matchesStatus = statusFilter === 'ALL' || acc.status === statusFilter;
      const matchesSearch =
        !searchQuery ||
        acc.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        acc.email_label.toLowerCase().includes(searchQuery.toLowerCase()) ||
        acc.id.toLowerCase().includes(searchQuery.toLowerCase()) ||
        (acc.proxy_url && acc.proxy_url.toLowerCase().includes(searchQuery.toLowerCase()));
      return matchesStatus && matchesSearch;
    });
  }, [accounts, statusFilter, searchQuery]);

  const getStatusBadge = (status: AccountStatus) => {
    switch (status) {
      case 'ACTIVE':
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200">
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" /> Active
          </span>
        );
      case 'COOLDOWN':
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-amber-50 text-amber-700 border border-amber-200">
            <Clock className="w-3.5 h-3.5" /> Cooldown
          </span>
        );
      case 'QUOTA_EXHAUSTED':
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-orange-50 text-orange-700 border border-orange-200">
            <AlertTriangle className="w-3.5 h-3.5" /> Quota Exhausted
          </span>
        );
      case 'SESSION_EXPIRED':
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-rose-50 text-rose-700 border border-rose-200 animate-pulse">
            <XCircle className="w-3.5 h-3.5 text-rose-600" /> Session Expired
          </span>
        );
      case 'DISABLED':
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-zinc-100 text-zinc-600 border border-zinc-200">
            Disabled
          </span>
        );
      default:
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-red-50 text-red-700 border border-red-200">
            <AlertTriangle className="w-3.5 h-3.5" /> Error
          </span>
        );
    }
  };

  const getKeepaliveBadge = (status?: string | null, lastAt?: string | null, accId?: string) => {
    const isThisRefreshing = keepaliveRunningId === accId || status === 'REFRESHING';

    if (isThisRefreshing) {
      return (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-medium bg-blue-50 text-blue-700 border border-blue-200">
          <RotateCw className="w-3 h-3 animate-spin text-blue-600" />
          <span>Đang làm mới...</span>
        </span>
      );
    }

    switch (status) {
      case 'SUCCESS':
        return (
          <div className="flex flex-col gap-0.5">
            <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[11px] font-medium bg-emerald-50 text-emerald-700 border border-emerald-200 w-fit">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
              Khỏe mạnh
            </span>
            <span className="text-[10px] text-zinc-400">
              {lastAt ? new Date(lastAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Vừa xong'}
            </span>
          </div>
        );
      case 'FAILED':
        return (
          <div className="flex flex-col gap-0.5">
            <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[11px] font-medium bg-rose-50 text-rose-700 border border-rose-200 w-fit">
              <XCircle className="w-3 h-3 text-rose-600" /> Lỗi làm mới
            </span>
            <span className="text-[10px] text-rose-500">Cần đăng nhập lại</span>
          </div>
        );
      default:
        return (
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[11px] font-medium bg-zinc-100 text-zinc-600 border border-zinc-200">
            <Clock className="w-3 h-3 text-zinc-400" /> Chờ lịch
          </span>
        );
    }
  };

  const formatProxyDisplay = (url?: string | null) => {
    if (!url || !url.trim()) {
      return <span className="text-zinc-400 italic text-[11px]">Direct (Không Proxy)</span>;
    }
    try {
      const u = new URL(url.trim());
      const hasAuth = Boolean(u.username);
      return (
        <span className="font-mono text-[11px] text-indigo-700 bg-indigo-50 border border-indigo-200 px-2 py-0.5 rounded-md flex items-center gap-1 max-w-[180px] truncate" title={url}>
          <Globe className="w-3 h-3 shrink-0 text-indigo-600" />
          <span className="truncate">{u.hostname}:{u.port || (u.protocol === 'https:' ? '443' : '80')}</span>
          {hasAuth && <span className="text-[9px] bg-indigo-200 text-indigo-800 px-1 rounded">Auth</span>}
        </span>
      );
    } catch {
      return (
        <span className="font-mono text-[11px] text-zinc-700 bg-zinc-100 px-2 py-0.5 rounded-md truncate max-w-[180px] block" title={url}>
          {url}
        </span>
      );
    }
  };

  return (
    <div className="space-y-6">
      {/* Header Controls */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-xl font-bold text-zinc-900 tracking-tight">Gemini Upstream Accounts</h2>
            <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-indigo-100 text-indigo-800 border border-indigo-200 flex items-center gap-1">
              <ShieldCheck className="w-3.5 h-3.5 text-indigo-600" /> Stealth Anti-Ban
            </span>
          </div>
          <p className="text-sm text-zinc-500 mt-1">
            Quản lý cụm 10 - 100 tài khoản Gemini Web. Tự động giữ phiên 24/7 và cô lập Profile + Proxy triệt tiêu khóa tài khoản.
          </p>
        </div>

        <div className="flex items-center gap-2.5 flex-wrap">
          <button
            onClick={() => refetch()}
            disabled={isFetching}
            className="inline-flex items-center gap-2 px-3 py-2 text-xs font-medium text-zinc-700 bg-white border border-zinc-200 rounded-xl hover:bg-zinc-50 transition-colors disabled:opacity-50 shadow-2xs"
            title="Làm mới danh sách"
          >
            <RefreshCw className={`w-3.5 h-3.5 text-zinc-500 ${isFetching ? 'animate-spin' : ''}`} />
            <span>Làm mới</span>
          </button>

          <button
            onClick={() => setIsAddManualModalOpen(true)}
            className="inline-flex items-center gap-2 px-3.5 py-2 text-xs font-medium text-zinc-700 bg-white border border-zinc-300 rounded-xl hover:bg-zinc-50 transition-colors shadow-2xs"
          >
            <KeyRound className="w-3.5 h-3.5 text-zinc-500" />
            <span>Thêm bằng Cookie</span>
          </button>

          <button
            onClick={handleOpenBrowserOnboardNew}
            className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-700 rounded-xl transition-all shadow-sm hover:shadow-md"
          >
            <Sparkles className="w-4 h-4 text-amber-300" />
            <span>Browser Login (Tự Động)</span>
          </button>
        </div>
      </div>

      {/* Action feedback toast */}
      {actionFeedback && (
        <div className="p-3.5 rounded-xl bg-zinc-900 text-zinc-100 text-xs flex items-center justify-between shadow-md transition-all">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
            <span>{actionFeedback}</span>
          </div>
          <button onClick={() => setActionFeedback(null)} className="text-zinc-400 hover:text-white text-xs underline ml-4">
            Đóng
          </button>
        </div>
      )}

      {/* KEEP-ALIVE WORKER STATUS DASHBOARD BANNER */}
      <div className="bg-gradient-to-r from-zinc-900 via-zinc-800 to-indigo-950 text-white rounded-2xl p-5 border border-zinc-700/60 shadow-md">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="flex items-start gap-3.5">
            <div className="w-10 h-10 rounded-xl bg-indigo-500/20 border border-indigo-500/30 flex items-center justify-center shrink-0 text-indigo-300">
              <Bot className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-semibold text-sm text-zinc-100">Hệ Thống Keep-Alive 24/7 (Headless Bot)</span>
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" /> Đang giám sát ngầm
                </span>
                <span className="text-[10px] text-zinc-400 font-mono bg-white/5 px-2 py-0.5 rounded-md border border-white/10">
                  Sequential Queue • Tiết kiệm RAM
                </span>
              </div>
              <p className="text-xs text-zinc-300 mt-1 max-w-2xl">
                {keepaliveReport?.lastSummary || 'Tự động kiểm tra và làm mới __Secure-1PSIDTS cho từng tài khoản theo hàng đợi tuần tự.'}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            <div className="grid grid-cols-2 gap-3 text-right">
              <div className="bg-white/5 border border-white/10 rounded-xl px-3 py-1.5">
                <div className="text-[10px] text-zinc-400 uppercase font-semibold">Đã làm mới</div>
                <div className="text-base font-mono font-bold text-emerald-400">
                  {keepaliveReport?.totalRefreshedSuccess || 0}
                </div>
              </div>
              <div className="bg-white/5 border border-white/10 rounded-xl px-3 py-1.5">
                <div className="text-[10px] text-zinc-400 uppercase font-semibold">Lỗi phiên</div>
                <div className="text-base font-mono font-bold text-rose-400">
                  {keepaliveReport?.totalRefreshedFailed || 0}
                </div>
              </div>
            </div>

            <button
              onClick={() => refetchKeepalive()}
              className="p-2.5 rounded-xl bg-white/10 hover:bg-white/15 border border-white/10 text-zinc-300 hover:text-white transition-colors"
              title="Cập nhật trạng thái Worker"
            >
              <RefreshCw className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>

      {/* Filters & Search Toolbar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-white p-3 rounded-2xl border border-zinc-200 shadow-2xs">
        <div className="flex flex-wrap items-center gap-1.5">
          {['ALL', 'ACTIVE', 'COOLDOWN', 'SESSION_EXPIRED', 'DISABLED'].map((st) => (
            <button
              key={st}
              onClick={() => updateFilters(st)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                statusFilter === st
                  ? 'bg-zinc-900 text-white shadow-2xs'
                  : 'text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900'
              }`}
            >
              {st === 'ALL' ? 'Tất cả tài khoản' : st}
            </button>
          ))}
        </div>

        <div className="relative w-full sm:w-72">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
          <input
            type="text"
            placeholder="Tìm theo tên, email, ID hoặc Proxy..."
            value={searchQuery}
            onChange={(e) => updateFilters(undefined, e.target.value)}
            className="w-full pl-9 pr-3 py-1.5 bg-zinc-50 border border-zinc-200 rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-indigo-600 focus:bg-white transition-all"
          />
        </div>
      </div>

      {/* Main Table or State */}
      {isLoading ? (
        <div className="bg-white border border-zinc-200 rounded-2xl p-12 text-center text-zinc-400">
          <RefreshCw className="w-6 h-6 animate-spin mx-auto mb-2 text-indigo-600" />
          <p className="text-sm">Đang tải danh sách tài khoản Gemini từ Database...</p>
        </div>
      ) : isError ? (
        <ErrorState
          title="Lỗi tải danh sách tài khoản"
          message={(error as any)?.message || 'Không thể truy xuất dữ liệu từ server.'}
          onRetry={() => refetch()}
        />
      ) : filteredAccounts.length === 0 ? (
        <EmptyState
          icon={Server}
          title={accounts.length === 0 ? 'Chưa có tài khoản Gemini nào trong Pool' : 'Không tìm thấy tài khoản phù hợp'}
          description={
            accounts.length === 0
              ? 'Bấm "Browser Login" để đăng nhập Chromium một lần duy nhất mà không cần tự sao chép cookie thủ công.'
              : 'Hãy thử xóa bộ lọc hoặc tìm kiếm từ khóa khác.'
          }
          actionLabel={accounts.length === 0 ? 'Đăng Nhập Browser Đầu Tiên' : 'Xóa bộ lọc'}
          onAction={accounts.length === 0 ? handleOpenBrowserOnboardNew : () => updateFilters('ALL', '')}
        />
      ) : (
        <div className="bg-white border border-zinc-200 rounded-2xl overflow-hidden shadow-2xs">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm text-zinc-600">
              <thead className="bg-zinc-50/75 border-b border-zinc-200 text-[11px] uppercase font-semibold text-zinc-500">
                <tr>
                  <th className="px-4 py-3.5">Tài khoản & Email</th>
                  <th className="px-4 py-3.5">Trạng thái</th>
                  <th className="px-4 py-3.5">Proxy & Cô Lập</th>
                  <th className="px-4 py-3.5">Keep-Alive 24/7</th>
                  <th className="px-4 py-3.5">Độ Ưu Tiên</th>
                  <th className="px-4 py-3.5">Hạn mức (Quota)</th>
                  <th className="px-4 py-3.5">Lượt gọi</th>
                  <th className="px-4 py-3.5 text-right">Thao tác</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-200/75">
                {filteredAccounts.map((acc) => {
                  const rowResult = rowProxyResults[acc.id];
                  const isTestingThisProxy = rowProxyTestingId === acc.id;

                  return (
                    <tr key={acc.id} className="hover:bg-zinc-50/70 transition-colors group">
                      <td className="px-4 py-4">
                        <Link
                          to={`/accounts/${acc.id}`}
                          className="flex items-center gap-3 group-hover:text-zinc-900"
                        >
                          <div className="w-9 h-9 rounded-xl bg-zinc-100 flex items-center justify-center text-zinc-700 font-semibold text-xs border border-zinc-200">
                            {acc.name.slice(0, 2).toUpperCase()}
                          </div>
                          <div>
                            <div className="font-semibold text-zinc-900 flex items-center gap-1.5">
                              <span>{acc.name}</span>
                              <ArrowUpRight className="w-3.5 h-3.5 text-zinc-400 group-hover:text-indigo-600 transition-colors" />
                            </div>
                            <div className="text-xs text-zinc-500 font-mono">{acc.email_label || acc.id}</div>
                          </div>
                        </Link>
                      </td>

                      <td className="px-4 py-4">{getStatusBadge(acc.status)}</td>

                      <td className="px-4 py-4">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          {formatProxyDisplay(acc.proxy_url)}
                          {acc.proxy_url && (
                            <button
                              onClick={() => handleTestProxyRow(acc.id, acc.proxy_url!)}
                              disabled={isTestingThisProxy}
                              title="Kiểm tra kết nối Proxy"
                              className="p-1 rounded text-zinc-400 hover:text-indigo-600 hover:bg-zinc-100 transition-colors disabled:opacity-50"
                            >
                              <Wifi className={`w-3.5 h-3.5 ${isTestingThisProxy ? 'animate-pulse text-indigo-600' : ''}`} />
                            </button>
                          )}
                        </div>
                        {rowResult && (
                          <div className="text-[10px] mt-1 font-mono">
                            {rowResult.success ? (
                              <span className="text-emerald-600 flex items-center gap-1">
                                <Check className="w-3 h-3" /> {rowResult.ip} ({rowResult.latencyMs}ms)
                              </span>
                            ) : (
                              <span className="text-rose-600 truncate max-w-xs block" title={rowResult.error}>
                                ✕ {rowResult.error}
                              </span>
                            )}
                          </div>
                        )}
                      </td>

                      <td className="px-4 py-4">
                        <div className="flex items-center gap-2">
                          {getKeepaliveBadge(acc.keepalive_status, acc.last_keepalive_at, acc.id)}
                          <button
                            onClick={() => handleTriggerKeepAliveNow(acc.id)}
                            disabled={keepaliveRunningId === acc.id}
                            title="Làm mới Cookie ngay bây giờ"
                            className="p-1 rounded-md text-zinc-400 hover:text-indigo-600 hover:bg-zinc-100 transition-colors disabled:opacity-50"
                          >
                            <RefreshCw className={`w-3.5 h-3.5 ${keepaliveRunningId === acc.id ? 'animate-spin text-indigo-600' : ''}`} />
                          </button>
                        </div>
                      </td>

                      <td className="px-4 py-4 text-xs font-mono">
                        P: {acc.priority} / W: {acc.weight}
                      </td>

                      <td className="px-4 py-4">
                        <AccountQuotaCard accountId={acc.id} compact />
                      </td>

                      <td className="px-4 py-4 font-mono text-xs text-zinc-900">{acc.request_count}</td>

                      <td className="px-4 py-4 text-right">
                        <div className="flex items-center justify-end gap-1.5">
                          {acc.status === 'SESSION_EXPIRED' ? (
                            <button
                              onClick={() => handleOpenBrowserReLogin(acc)}
                              className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-semibold bg-rose-50 text-rose-700 border border-rose-200 hover:bg-rose-100 transition-colors"
                              title="Phiên đã hết hạn! Bấm để mở trình duyệt đăng nhập lại"
                            >
                              <Sparkles className="w-3 h-3 text-rose-600" />
                              <span>Đăng nhập lại</span>
                            </button>
                          ) : (
                            <button
                              onClick={() => handleOpenBrowserReLogin(acc)}
                              className="p-1.5 rounded-lg hover:bg-zinc-100 text-zinc-500 hover:text-indigo-600 transition-colors"
                              title="Đăng nhập lại qua Trình duyệt (Re-login)"
                            >
                              <ExternalLink className="w-4 h-4" />
                            </button>
                          )}

                          <button
                            title="Kiểm tra phiên (Validate Upstream)"
                            disabled={testingId === acc.id}
                            onClick={() => handleTestSession(acc.id)}
                            className="p-1.5 rounded-lg hover:bg-zinc-100 text-zinc-500 hover:text-zinc-900 transition-colors disabled:opacity-50"
                          >
                            <CheckCircle2
                              className={`w-4 h-4 ${testingId === acc.id ? 'animate-spin text-zinc-900' : ''}`}
                            />
                          </button>

                          <button
                            title="Chỉnh sửa Cấu hình & Proxy"
                            onClick={() => handleOpenEdit(acc)}
                            className="p-1.5 rounded-lg hover:bg-zinc-100 text-zinc-500 hover:text-zinc-900 transition-colors"
                          >
                            <Edit3 className="w-4 h-4" />
                          </button>

                          <button
                            title="Thay Cookie thủ công"
                            onClick={() => {
                              setSelectedAccountId(acc.id);
                              setIsReplaceModalOpen(true);
                            }}
                            className="p-1.5 rounded-lg hover:bg-zinc-100 text-zinc-500 hover:text-zinc-900 transition-colors"
                          >
                            <KeyRound className="w-4 h-4" />
                          </button>

                          <button
                            title={acc.status === 'DISABLED' ? 'Kích hoạt' : 'Tạm dừng'}
                            onClick={() => handleToggleStatus(acc)}
                            className="text-xs px-2 py-1 rounded-lg border border-zinc-200 hover:bg-zinc-100 text-zinc-700 font-medium"
                          >
                            {acc.status === 'DISABLED' ? 'Bật' : 'Tắt'}
                          </button>

                          <button
                            title="Xóa tài khoản"
                            onClick={() => handleDelete(acc.id)}
                            className="p-1.5 rounded-lg hover:bg-rose-50 text-zinc-400 hover:text-rose-600 transition-colors"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* BROWSER ONBOARDING MODAL (Zero-Ban Headed Onboarding) */}
      {isBrowserModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4 overflow-y-auto">
          <div className="bg-white rounded-2xl max-w-xl w-full p-6 shadow-2xl border border-zinc-200 my-8">
            <div className="flex items-center justify-between pb-4 border-b border-zinc-100">
              <div className="flex items-center gap-2.5">
                <div className="w-9 h-9 rounded-xl bg-indigo-50 border border-indigo-200 flex items-center justify-center text-indigo-600">
                  <Sparkles className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-zinc-900">
                    {onboardAccountId ? 'Đăng Nhập Lại Qua Trình Duyệt' : 'Đăng Nhập Google Gemini Qua Trình Duyệt'}
                  </h3>
                  <span className="text-xs text-zinc-500">Headed Chromium Onboarding • Không lo bị khóa tài khoản</span>
                </div>
              </div>
              <button
                onClick={() => {
                  if (onboardSession && !['COMPLETED', 'CANCELLED', 'TIMED_OUT', 'ERROR'].includes(onboardSession.step)) {
                    handleCancelBrowserOnboard();
                  }
                  setIsBrowserModalOpen(false);
                }}
                className="text-zinc-400 hover:text-zinc-600 text-xl font-semibold"
              >
                ✕
              </button>
            </div>

            {!onboardSession ? (
              <form onSubmit={handleStartBrowserOnboard} className="space-y-4 pt-4">
                <div className="bg-indigo-50/60 border border-indigo-100 rounded-xl p-3.5 text-xs text-indigo-900 leading-relaxed space-y-1">
                  <p className="font-semibold flex items-center gap-1.5">
                    <ShieldCheck className="w-4 h-4 text-indigo-600 shrink-0" /> Cơ chế tự động hóa an toàn:
                  </p>
                  <p className="text-indigo-800">
                    Hệ thống sẽ mở một cửa sổ Chromium có giao diện thật với profile độc lập. Bạn tự tay nhập Email, Mật khẩu và xác thực OTP/2FA chính chủ trên điện thoại. Bot sẽ tự động trích xuất cookie và đóng cửa sổ.
                  </p>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-zinc-700 uppercase tracking-wider mb-1">
                    Tên gợi nhớ tài khoản
                  </label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. Gemini Pro Work #1"
                    value={onboardName}
                    onChange={(e) => setOnboardName(e.target.value)}
                    className="w-full px-3 py-2 rounded-xl border border-zinc-200 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-600"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-zinc-700 uppercase tracking-wider mb-1">
                    Email Google (Tùy chọn ghi chú)
                  </label>
                  <input
                    type="email"
                    placeholder="user@gmail.com (Hệ thống sẽ tự động cập nhật nếu để trống)"
                    value={onboardEmail}
                    onChange={(e) => setOnboardEmail(e.target.value)}
                    className="w-full px-3 py-2 rounded-xl border border-zinc-200 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-600"
                  />
                </div>

                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="block text-xs font-semibold text-zinc-700 uppercase tracking-wider">
                      Proxy Cố Định Cho Tài Khoản (Khuyến nghị)
                    </label>
                    <button
                      type="button"
                      disabled={!onboardProxy.trim() || onboardTestingProxy}
                      onClick={handleTestProxyInOnboard}
                      className="text-[11px] font-medium text-indigo-600 hover:text-indigo-800 disabled:opacity-40 flex items-center gap-1"
                    >
                      <Wifi className="w-3 h-3" />
                      {onboardTestingProxy ? 'Đang kiểm tra...' : 'Kiểm tra Proxy'}
                    </button>
                  </div>
                  <input
                    type="text"
                    placeholder="http://user:pass@ip:port hoặc socks5://..."
                    value={onboardProxy}
                    onChange={(e) => {
                      setOnboardProxy(e.target.value);
                      setOnboardProxyResult(null);
                    }}
                    className="w-full px-3 py-2 rounded-xl border border-zinc-200 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-indigo-600"
                  />
                  {onboardProxyResult && (
                    <div className="mt-1.5 text-xs font-mono">
                      {onboardProxyResult.success ? (
                        <span className="text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-1 rounded-md inline-flex items-center gap-1">
                          <Check className="w-3.5 h-3.5 text-emerald-600" /> Kết nối tốt! IP Proxy: {onboardProxyResult.ip} ({onboardProxyResult.latencyMs}ms)
                        </span>
                      ) : (
                        <span className="text-rose-700 bg-rose-50 border border-rose-200 px-2 py-1 rounded-md inline-block">
                          ✕ Lỗi: {onboardProxyResult.error}
                        </span>
                      )}
                    </div>
                  )}
                  <p className="text-[11px] text-zinc-500 mt-1">
                    Nếu để trống, hệ thống sẽ sử dụng trực tiếp kết nối mạng máy chủ nội bộ.
                  </p>
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
                      value={onboardPriority}
                      onChange={(e) => setOnboardPriority(Number(e.target.value))}
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
                      max="100"
                      value={onboardWeight}
                      onChange={(e) => setOnboardWeight(Number(e.target.value))}
                      className="w-full px-3 py-2 rounded-xl border border-zinc-200 text-sm"
                    />
                  </div>
                </div>

                {onboardError && (
                  <div className="p-3 bg-rose-50 border border-rose-200 rounded-xl text-xs text-rose-700">
                    {onboardError}
                  </div>
                )}

                <div className="flex justify-end gap-3 pt-4 border-t border-zinc-100">
                  <button
                    type="button"
                    onClick={() => setIsBrowserModalOpen(false)}
                    className="px-4 py-2 text-sm text-zinc-600 hover:text-zinc-900"
                  >
                    Hủy
                  </button>
                  <button
                    type="submit"
                    disabled={onboardStarting}
                    className="px-5 py-2.5 text-sm font-semibold text-white bg-indigo-600 rounded-xl hover:bg-indigo-700 disabled:opacity-50 flex items-center gap-2 shadow-sm"
                  >
                    {onboardStarting ? (
                      <>
                        <RefreshCw className="w-4 h-4 animate-spin" />
                        <span>Đang khởi tạo...</span>
                      </>
                    ) : (
                      <>
                        <Sparkles className="w-4 h-4 text-amber-300" />
                        <span>Mở Cửa Sổ Đăng Nhập</span>
                      </>
                    )}
                  </button>
                </div>
              </form>
            ) : (
              /* LIVE ONBOARDING PROGRESS */
              <div className="space-y-6 pt-4">
                <div className="space-y-3">
                  {/* Step 1 */}
                  <div className="flex items-center gap-3 p-3 rounded-xl border border-zinc-200 bg-zinc-50">
                    <div className="w-6 h-6 rounded-full bg-emerald-100 text-emerald-700 flex items-center justify-center shrink-0">
                      <Check className="w-3.5 h-3.5" />
                    </div>
                    <div className="text-xs">
                      <span className="font-semibold text-zinc-900 block">1. Khởi động Chromium Stealth</span>
                      <span className="text-zinc-500">Loại bỏ cờ navigator.webdriver và cấu hình Proxy độc lập</span>
                    </div>
                  </div>

                  {/* Step 2 */}
                  <div className={`flex items-center gap-3 p-3 rounded-xl border ${
                    onboardSession.step === 'WAITING_LOGIN'
                      ? 'border-indigo-300 bg-indigo-50/50 shadow-xs'
                      : ['EXTRACTING', 'COMPLETED'].includes(onboardSession.step)
                      ? 'border-zinc-200 bg-zinc-50'
                      : 'border-zinc-200 bg-zinc-50 opacity-60'
                  }`}>
                    <div className={`w-6 h-6 rounded-full flex items-center justify-center shrink-0 ${
                      ['EXTRACTING', 'COMPLETED'].includes(onboardSession.step)
                        ? 'bg-emerald-100 text-emerald-700'
                        : 'bg-indigo-100 text-indigo-700 animate-pulse'
                    }`}>
                      {['EXTRACTING', 'COMPLETED'].includes(onboardSession.step) ? (
                        <Check className="w-3.5 h-3.5" />
                      ) : (
                        <span className="w-2 h-2 rounded-full bg-indigo-600" />
                      )}
                    </div>
                    <div className="text-xs">
                      <span className="font-semibold text-zinc-900 block">2. Đăng nhập Google & Xác thực 2FA</span>
                      <span className="text-zinc-600">
                        {onboardSession.step === 'WAITING_LOGIN'
                          ? '👉 Cửa sổ trình duyệt đang mở trên màn hình máy tính. Vui lòng đăng nhập Google!'
                          : 'Đã hoàn tất xác thực đăng nhập Google'}
                      </span>
                    </div>
                  </div>

                  {/* Step 3 */}
                  <div className={`flex items-center gap-3 p-3 rounded-xl border ${
                    onboardSession.step === 'EXTRACTING'
                      ? 'border-indigo-300 bg-indigo-50/50'
                      : onboardSession.step === 'COMPLETED'
                      ? 'border-zinc-200 bg-zinc-50'
                      : 'border-zinc-200 bg-zinc-50 opacity-60'
                  }`}>
                    <div className={`w-6 h-6 rounded-full flex items-center justify-center shrink-0 ${
                      onboardSession.step === 'COMPLETED'
                        ? 'bg-emerald-100 text-emerald-700'
                        : onboardSession.step === 'EXTRACTING'
                        ? 'bg-indigo-100 text-indigo-700'
                        : 'bg-zinc-200 text-zinc-400'
                    }`}>
                      {onboardSession.step === 'COMPLETED' ? (
                        <Check className="w-3.5 h-3.5" />
                      ) : (
                        <span className="text-[10px] font-bold">3</span>
                      )}
                    </div>
                    <div className="text-xs">
                      <span className="font-semibold text-zinc-900 block">3. Bắt & Mã Hóa Session Cookies</span>
                      <span className="text-zinc-500">Mã hóa AES-256-GCM với Master Key và lưu vào Database</span>
                    </div>
                  </div>
                </div>

                {/* Status Announcement Banner */}
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
                  <div className="leading-relaxed">{onboardSession.message}</div>
                </div>

                <div className="flex justify-end gap-3 pt-2">
                  {onboardSession.step === 'COMPLETED' ? (
                    <button
                      type="button"
                      onClick={() => {
                        setIsBrowserModalOpen(false);
                        setOnboardSession(null);
                      }}
                      className="px-5 py-2 text-sm font-semibold text-white bg-zinc-900 rounded-xl hover:bg-zinc-800 shadow-sm"
                    >
                      Hoàn Tất & Đóng
                    </button>
                  ) : ['CANCELLED', 'TIMED_OUT', 'ERROR'].includes(onboardSession.step) ? (
                    <button
                      type="button"
                      onClick={() => setOnboardSession(null)}
                      className="px-5 py-2 text-sm font-semibold text-white bg-indigo-600 rounded-xl hover:bg-indigo-700 shadow-sm"
                    >
                      Thử Lại
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={handleCancelBrowserOnboard}
                      className="px-4 py-2 text-xs font-medium text-rose-600 bg-rose-50 border border-rose-200 rounded-xl hover:bg-rose-100"
                    >
                      Hủy Phiên & Đóng Trình Duyệt
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* EDIT ACCOUNT CONFIG & PROXY MODAL */}
      {isEditModalOpen && editingAccount && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-lg w-full p-6 shadow-2xl border border-zinc-200">
            <div className="flex items-center justify-between pb-4 border-b border-zinc-100">
              <h3 className="text-base font-bold text-zinc-900">Chỉnh Sửa Cấu Hình & Proxy</h3>
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
                    onClick={handleTestProxyInEdit}
                    className="text-[11px] font-medium text-indigo-600 hover:text-indigo-800 disabled:opacity-40 flex items-center gap-1"
                  >
                    <Wifi className="w-3 h-3" />
                    {editProxyTesting ? 'Đang kiểm tra...' : 'Kiểm tra Proxy'}
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

      {/* MANUAL ADD ACCOUNT MODAL */}
      {isAddManualModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-lg w-full p-6 shadow-xl border border-zinc-200">
            <div className="flex items-center justify-between pb-4 border-b border-zinc-100">
              <h3 className="text-base font-bold text-zinc-900">Thêm Bằng Cookie Thủ Công</h3>
              <button
                onClick={() => setIsAddManualModalOpen(false)}
                className="text-zinc-400 hover:text-zinc-600 text-lg"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleAddManualAccount} className="space-y-4 pt-4">
              <div>
                <label className="block text-xs font-semibold text-zinc-700 uppercase tracking-wider mb-1">
                  Tên tài khoản
                </label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Primary Work Account"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl border border-zinc-200 text-sm focus:outline-none focus:ring-2 focus:ring-zinc-900"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-zinc-700 uppercase tracking-wider mb-1">
                  Email
                </label>
                <input
                  type="email"
                  required
                  placeholder="user@gmail.com"
                  value={emailLabel}
                  onChange={(e) => setEmailLabel(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl border border-zinc-200 text-sm focus:outline-none focus:ring-2 focus:ring-zinc-900"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-zinc-700 uppercase tracking-wider mb-1">
                  Proxy URL (Tùy chọn)
                </label>
                <input
                  type="text"
                  placeholder="http://user:pass@ip:port hoặc để trống"
                  value={proxyUrl}
                  onChange={(e) => setProxyUrl(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl border border-zinc-200 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-zinc-900"
                />
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="block text-xs font-semibold text-zinc-700 uppercase tracking-wider">
                    Chuỗi Cookie Gemini
                  </label>
                  <span className="text-[11px] text-zinc-500 flex items-center gap-1 font-mono">
                    <Shield className="w-3 h-3 text-emerald-600" /> AES-256-GCM
                  </span>
                </div>
                <textarea
                  required
                  rows={4}
                  placeholder="__Secure-1PSID=...; __Secure-1PSIDTS=...; __Secure-1PSIDCC=..."
                  value={cookie}
                  onChange={(e) => setCookie(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl border border-zinc-200 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-zinc-900"
                />
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
                    value={priority}
                    onChange={(e) => setPriority(Number(e.target.value))}
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
                    value={weight}
                    onChange={(e) => setWeight(Number(e.target.value))}
                    className="w-full px-3 py-2 rounded-xl border border-zinc-200 text-sm"
                  />
                </div>
              </div>

              <div className="flex justify-end gap-3 pt-3 border-t border-zinc-100">
                <button
                  type="button"
                  onClick={() => setIsAddManualModalOpen(false)}
                  className="px-4 py-2 text-sm text-zinc-600 hover:text-zinc-900"
                >
                  Hủy
                </button>
                <button
                  type="submit"
                  disabled={addMutation.isPending}
                  className="px-4 py-2 text-sm font-semibold text-white bg-zinc-900 rounded-xl hover:bg-zinc-800 disabled:opacity-50"
                >
                  {addMutation.isPending ? 'Đang mã hóa...' : 'Lưu & Mã Hóa'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* REPLACE COOKIE MODAL */}
      {isReplaceModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-xl border border-zinc-200">
            <h3 className="text-base font-bold text-zinc-900 mb-1">Cập Nhật Chuỗi Cookie</h3>
            <p className="text-xs text-zinc-500 mb-4">
              Dán chuỗi cookie mới khi phiên đăng nhập hết hạn hoặc vừa được làm mới thủ công.
            </p>
            <form onSubmit={handleReplaceCookie} className="space-y-4">
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
