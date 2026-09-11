import React, { useState, useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Send,
  Terminal,
  Loader2,
  Sliders,
  AlertCircle,
  Code,
  RefreshCw,
  Paperclip,
  X,
  FileText,
  Image as ImageIcon,
  Brain,
  ChevronDown,
  ChevronRight,
  Download,
  Trash2,
  Sparkles,
  Copy,
  ExternalLink,
  Check,
  MessageSquare,
  History,
  Plus,
} from 'lucide-react';
import {
  fetchModels,
  fetchApiKeys,
  getApiUrl,
  fetchUpstreamRecentConversations,
  fetchUpstreamConversationTurns,
  UpstreamConversationItem,
} from '../lib/api-client.js';
import { useDocumentTitle } from '../hooks/useDocumentTitle.js';

interface AttachedFile {
  name: string;
  mimeType: string;
  size: number;
  dataUrl: string;
}

interface ChatTurn {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  reasoning?: string;
  images?: Array<{ url: string; title?: string; b64_json?: string }>;
  attachments?: AttachedFile[];
}

function formatConvTime(timestampSeconds?: number, isoDate?: string): string {
  if (!timestampSeconds && !isoDate) return '';
  const date = timestampSeconds ? new Date(timestampSeconds * 1000) : new Date(isoDate!);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMinutes = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMinutes < 1) return 'Vừa xong';
  if (diffMinutes < 60) return `${diffMinutes} phút trước`;
  if (diffHours < 24) return `${diffHours} giờ trước`;
  if (diffDays < 7) return `${diffDays} ngày trước`;
  return date.toLocaleDateString('vi-VN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export const PlaygroundPage: React.FC = () => {
  useDocumentTitle('Playground');
  const [searchParams, setSearchParams] = useSearchParams();

  // Model from URL param
  const modelParam = searchParams.get('model') || '';

  // Manual key saved in sessionStorage
  const [manualKey, setManualKey] = useState<string>(() => {
    try {
      return sessionStorage.getItem('gmgw_playground_key') || '';
    } catch {
      return '';
    }
  });

  const [prompt, setPrompt] = useState<string>('');
  const [stream, setStream] = useState(true);
  const [extendedThinking, setExtendedThinking] = useState(true);
  const [temperature, setTemperature] = useState(0.7);
  const [maxTokens, setMaxTokens] = useState(2048);
  const [conversationId, setConversationId] = useState<string>(() => {
    try {
      return sessionStorage.getItem('gmgw_playground_conv_id') || '';
    } catch {
      return '';
    }
  });
  const [activeConvTitle, setActiveConvTitle] = useState<string>(() => {
    try {
      return sessionStorage.getItem('gmgw_playground_conv_title') || '';
    } catch {
      return '';
    }
  });
  const [upstreamRid, setUpstreamRid] = useState<string>(() => {
    try {
      return sessionStorage.getItem('gmgw_playground_upstream_rid') || '';
    } catch {
      return '';
    }
  });
  const [upstreamRcid, setUpstreamRcid] = useState<string>(() => {
    try {
      return sessionStorage.getItem('gmgw_playground_upstream_rcid') || '';
    } catch {
      return '';
    }
  });
  const [loadingTurns, setLoadingTurns] = useState(false);
  const [showRecentModal, setShowRecentModal] = useState(false);

  // Attached files before sending
  const [attachments, setAttachments] = useState<AttachedFile[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Chat turns state
  const [turns, setTurns] = useState<ChatTurn[]>(() => {
    try {
      const saved = sessionStorage.getItem('gmgw_playground_turns');
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });

  const [isLoading, setIsLoading] = useState(false);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [showRaw, setShowRaw] = useState(false);
  const [rawResponse, setRawResponse] = useState<any>(null);
  const [thinkingExpanded, setThinkingExpanded] = useState<Record<string, boolean>>({});
  const [copiedConv, setCopiedConv] = useState(false);

  // Streaming temp output
  const [streamingText, setStreamingText] = useState('');
  const [streamingReasoning, setStreamingReasoning] = useState('');

  // Queries
  const { data: models = [], isLoading: loadingModels, refetch: refetchModels } = useQuery({
    queryKey: ['models'],
    queryFn: fetchModels,
  });

  const { data: apiKeys = [] } = useQuery({
    queryKey: ['api-keys'],
    queryFn: fetchApiKeys,
  });

  const {
    data: recentConvsData,
    isLoading: loadingRecentConvs,
    refetch: refetchRecentConvs,
  } = useQuery({
    queryKey: ['upstream-recent-conversations'],
    queryFn: () => fetchUpstreamRecentConversations(10),
  });

  const handleSelectRecentConversation = async (conv: UpstreamConversationItem) => {
    setConversationId(conv.id);
    setActiveConvTitle(conv.title);
    try {
      sessionStorage.setItem('gmgw_playground_conv_id', conv.id);
      sessionStorage.setItem('gmgw_playground_conv_title', conv.title);
    } catch {}

    setLoadingTurns(true);
    setErrorText(null);
    try {
      const data = await fetchUpstreamConversationTurns(conv.id);
      if (data.turns && data.turns.length > 0) {
        const mappedTurns: ChatTurn[] = data.turns.map((t, idx) => ({
          id: `loaded_${idx}_${Date.now()}`,
          role: t.role,
          content: t.content,
          reasoning: t.reasoning_content,
        }));
        setTurns(mappedTurns);
      } else {
        setTurns([]);
      }

      if (data.last_rid) {
        setUpstreamRid(data.last_rid);
        try { sessionStorage.setItem('gmgw_playground_upstream_rid', data.last_rid); } catch {}
      }
      if (data.last_rcid) {
        setUpstreamRcid(data.last_rcid);
        try { sessionStorage.setItem('gmgw_playground_upstream_rcid', data.last_rcid); } catch {}
      } else if (conv.choice_id) {
        setUpstreamRcid(conv.choice_id);
        try { sessionStorage.setItem('gmgw_playground_upstream_rcid', conv.choice_id); } catch {}
      }
    } catch (err: any) {
      setErrorText(`Không thể tải lịch sử cuộc trò chuyện: ${err.message}`);
    } finally {
      setLoadingTurns(false);
      setShowRecentModal(false);
    }
  };

  // Auto-fill first API key if none set and available
  useEffect(() => {
    if (!manualKey && apiKeys.length > 0) {
      // Don't auto-fill without prefix check
    }
  }, [apiKeys, manualKey]);

  // Persist turns
  useEffect(() => {
    try {
      sessionStorage.setItem('gmgw_playground_turns', JSON.stringify(turns));
    } catch {}
  }, [turns]);

  // Persist key
  const handleKeyChange = (val: string) => {
    setManualKey(val);
    try {
      sessionStorage.setItem('gmgw_playground_key', val);
    } catch {}
  };

  // Sync selected model with URL
  const selectedModel =
    modelParam && models.includes(modelParam)
      ? modelParam
      : models.length > 0
      ? models[0]
      : '';

  const setSelectedModel = (newModel: string) => {
    const params = new URLSearchParams(searchParams);
    params.set('model', newModel);
    setSearchParams(params);
  };

  useEffect(() => {
    if (!modelParam && models.length > 0) {
      const params = new URLSearchParams(searchParams);
      params.set('model', models[0]);
      setSearchParams(params, { replace: true });
    }
  }, [models, modelParam, searchParams, setSearchParams]);

  // Handle File Input / Drag & Drop
  const handleFileSelect = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setErrorText(null);

    Array.from(files).forEach((file) => {
      if (file.size > 20 * 1024 * 1024) {
        setErrorText(`File "${file.name}" exceeds 20MB limit`);
        return;
      }

      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        setAttachments((prev) => [
          ...prev,
          {
            name: file.name,
            mimeType: file.type || 'application/octet-stream',
            size: file.size,
            dataUrl,
          },
        ]);
      };
      reader.readAsDataURL(file);
    });

    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const removeAttachment = (index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  };

  const clearChat = () => {
    setTurns([]);
    setStreamingText('');
    setStreamingReasoning('');
    setRawResponse(null);
    setLatencyMs(null);
    setErrorText(null);
    setConversationId('');
    setActiveConvTitle('');
    setUpstreamRid('');
    setUpstreamRcid('');
    try {
      sessionStorage.removeItem('gmgw_playground_turns');
      sessionStorage.removeItem('gmgw_playground_conv_id');
      sessionStorage.removeItem('gmgw_playground_conv_title');
      sessionStorage.removeItem('gmgw_playground_upstream_rid');
      sessionStorage.removeItem('gmgw_playground_upstream_rcid');
    } catch {}
  };

  const handleSendRequest = async (e: React.FormEvent) => {
    e.preventDefault();
    if ((!prompt.trim() && attachments.length === 0) || isLoading) return;

    if (!manualKey.trim()) {
      setErrorText('Please enter a valid Gateway API key (sk-gmgw-...) to authenticate requests.');
      return;
    }

    if (!selectedModel) {
      setErrorText('No model selected. Ensure an active Gemini session exists in the Accounts tab.');
      return;
    }

    const currentPrompt = prompt.trim();
    const currentAttachments = [...attachments];
    const userTurnId = `user_${Date.now()}`;
    const assistantTurnId = `asst_${Date.now()}`;

    // Add user turn
    const userTurn: ChatTurn = {
      id: userTurnId,
      role: 'user',
      content: currentPrompt,
      attachments: currentAttachments,
    };

    setTurns((prev) => [...prev, userTurn]);
    setPrompt('');
    setAttachments([]);
    setIsLoading(true);
    setStreamingText('');
    setStreamingReasoning('');
    setErrorText(null);
    setLatencyMs(null);
    const startTime = Date.now();

    try {
      // Build message content array if attachments exist
      let userMessageContent: any = currentPrompt;
      if (currentAttachments.length > 0) {
        userMessageContent = [];
        if (currentPrompt) {
          userMessageContent.push({ type: 'text', text: currentPrompt });
        }
        for (const att of currentAttachments) {
          if (att.mimeType.startsWith('image/')) {
            userMessageContent.push({
              type: 'image_url',
              image_url: { url: att.dataUrl },
            });
          } else {
            userMessageContent.push({
              type: 'file_url',
              file_url: { url: att.dataUrl, name: att.name },
            });
          }
        }
      }

      // Build full conversation history for context
      const messagesPayload: any[] = [
        { role: 'system', content: 'You are a helpful AI assistant connected via Gemini Web Gateway.' },
      ];

      for (const t of turns) {
        messagesPayload.push({ role: t.role, content: t.content });
      }
      messagesPayload.push({ role: 'user', content: userMessageContent });

      const requestPayload: any = {
        model: selectedModel,
        messages: messagesPayload,
        temperature,
        max_tokens: maxTokens,
        stream,
        thinking: extendedThinking,
      };

      if (conversationId) {
        requestPayload.conversation_id = conversationId;
        if (conversationId.startsWith('c_')) {
          requestPayload.upstream_cid = conversationId;
        }
      }
      if (upstreamRid) {
        requestPayload.upstream_rid = upstreamRid;
      }
      if (upstreamRcid) {
        requestPayload.upstream_rcid = upstreamRcid;
      }

      const res = await fetch(getApiUrl('/v1/chat/completions'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${manualKey.trim()}`,
        },
        body: JSON.stringify(requestPayload),
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson?.error?.message || `HTTP ${res.status}`);
      }

      if (stream) {
        if (!res.body) throw new Error('No stream body returned');
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let accumulatedText = '';
        let accumulatedThinking = '';
        let capturedImages: any[] = [];

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('data: ')) {
              const dataStr = trimmed.slice(6);
              if (dataStr === '[DONE]') break;
              try {
                const parsed = JSON.parse(dataStr);
                const delta = parsed.choices?.[0]?.delta;
                if (delta?.content) {
                  accumulatedText += delta.content;
                  setStreamingText(accumulatedText);
                }
                if (delta?.reasoning_content) {
                  accumulatedThinking += delta.reasoning_content;
                  setStreamingReasoning(accumulatedThinking);
                }
                if (delta?.images && delta.images.length > 0) {
                  capturedImages = delta.images;
                }
                if (parsed.conversation_id && !conversationId) {
                  setConversationId(parsed.conversation_id);
                  try {
                    sessionStorage.setItem('gmgw_playground_conv_id', parsed.conversation_id);
                  } catch {}
                }
                if (parsed.response_id) {
                  setUpstreamRid(parsed.response_id);
                  try {
                    sessionStorage.setItem('gmgw_playground_upstream_rid', parsed.response_id);
                  } catch {}
                }
                if (parsed.choice_id) {
                  setUpstreamRcid(parsed.choice_id);
                  try {
                    sessionStorage.setItem('gmgw_playground_upstream_rcid', parsed.choice_id);
                  } catch {}
                }
                setRawResponse(parsed);
              } catch {
                // partial frame ignore
              }
            }
          }
        }

        setLatencyMs(Date.now() - startTime);

        // Add assistant turn
        setTurns((prev) => [
          ...prev,
          {
            id: assistantTurnId,
            role: 'assistant',
            content: accumulatedText,
            reasoning: accumulatedThinking || undefined,
            images: capturedImages.length > 0 ? capturedImages : undefined,
          },
        ]);
        setStreamingText('');
        setStreamingReasoning('');
      } else {
        const data = await res.json();
        setLatencyMs(Date.now() - startTime);
        setRawResponse(data);

        if (data.conversation_id && !conversationId) {
          setConversationId(data.conversation_id);
          try {
            sessionStorage.setItem('gmgw_playground_conv_id', data.conversation_id);
          } catch {}
        }
        if (data.response_id) {
          setUpstreamRid(data.response_id);
          try {
            sessionStorage.setItem('gmgw_playground_upstream_rid', data.response_id);
          } catch {}
        }
        if (data.choice_id) {
          setUpstreamRcid(data.choice_id);
          try {
            sessionStorage.setItem('gmgw_playground_upstream_rcid', data.choice_id);
          } catch {}
        }

        const choice = data.choices?.[0];
        const text = choice?.message?.content || '';
        const reasoning = choice?.message?.reasoning_content;
        const images = choice?.message?.images;

        setTurns((prev) => [
          ...prev,
          {
            id: assistantTurnId,
            role: 'assistant',
            content: text,
            reasoning: reasoning || undefined,
            images: images && images.length > 0 ? images : undefined,
          },
        ]);
      }
    } catch (err: any) {
      setErrorText(err.message || 'Error occurred while communicating with Gateway');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-xl font-semibold text-zinc-900 tracking-tight">Interactive Gemini Web Playground</h2>
            <span className="text-[11px] px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-200 font-medium">
              Native Web Protocol
            </span>
          </div>
          <p className="text-sm text-zinc-500">
            Multi-turn conversation, multimodal file upload (PDF/TXT/CSV/Images), thinking mode, and image generation.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {turns.length > 0 && (
            <button
              onClick={clearChat}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-rose-700 bg-rose-50 border border-rose-200 rounded-xl hover:bg-rose-100 transition-colors"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>Clear Chat</span>
            </button>
          )}
          <button
            onClick={() => refetchModels()}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-zinc-700 bg-white border border-zinc-200 rounded-xl hover:bg-zinc-50 transition-colors"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loadingModels ? 'animate-spin' : ''}`} />
            <span>Refresh Models</span>
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left Column: Configuration & Controls */}
        <div className="lg:col-span-4 bg-white border border-zinc-200 rounded-2xl p-5 shadow-2xs space-y-4">
          <div className="flex items-center gap-2 pb-3 border-b border-zinc-100 font-medium text-sm text-zinc-900">
            <Sliders className="w-4 h-4 text-zinc-500" />
            <span>Gateway Parameters</span>
          </div>

          <div className="space-y-4">
            <div>
              <label className="block text-xs font-semibold text-zinc-700 uppercase tracking-wider mb-1">
                Gateway API Key
              </label>
              <input
                type="text"
                value={manualKey}
                onChange={(e) => handleKeyChange(e.target.value)}
                placeholder="sk-gmgw-..."
                className="w-full px-3 py-2 border border-zinc-200 rounded-xl text-xs font-mono text-zinc-800 focus:ring-2 focus:ring-zinc-900 focus:outline-none bg-zinc-50 focus:bg-white"
              />
              <p className="text-[11px] text-zinc-400 mt-1">
                Bearer API Key created in Admin API Keys tab.
              </p>
            </div>

            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="block text-xs font-semibold text-zinc-700 uppercase tracking-wider">
                  Model Selection
                </label>
                {loadingModels && <span className="text-[11px] text-zinc-400">Discovering...</span>}
              </div>
              {models.length > 0 ? (
                <select
                  value={selectedModel}
                  onChange={(e) => setSelectedModel(e.target.value)}
                  className="w-full px-3 py-2 border border-zinc-200 rounded-xl text-sm bg-white text-zinc-800 focus:ring-2 focus:ring-zinc-900 focus:outline-none font-mono"
                >
                  {models.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              ) : (
                <div className="p-3 bg-amber-50 rounded-xl border border-amber-200 text-xs text-amber-800 leading-relaxed">
                  No models available. Please ensure an active Gemini session is enabled.
                </div>
              )}

              {/* Model Capability Badges */}
              <div className="flex flex-wrap gap-1 mt-2">
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-100 text-zinc-700 font-medium">Text</span>
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-100 text-zinc-700 font-medium">Vision</span>
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-100 text-zinc-700 font-medium">Files</span>
                {selectedModel.includes('pro') || selectedModel.includes('thinking') ? (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-50 text-purple-700 font-medium border border-purple-200 flex items-center gap-0.5">
                    <Brain className="w-2.5 h-2.5" /> Thinking
                  </span>
                ) : null}
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 font-medium border border-emerald-200 flex items-center gap-0.5">
                  <Sparkles className="w-2.5 h-2.5" /> Image Gen
                </span>
              </div>
            </div>

            <div className="flex items-center justify-between p-3 bg-zinc-50 rounded-xl border border-zinc-200">
              <div>
                <span className="text-xs font-medium text-zinc-800 block">Stream SSE Chunks</span>
                <span className="text-[11px] text-zinc-500">Incremental streaming & reasoning deltas</span>
              </div>
              <input
                type="checkbox"
                checked={stream}
                onChange={(e) => setStream(e.target.checked)}
                className="w-4 h-4 rounded text-zinc-900 accent-zinc-900"
              />
            </div>

            <div className="flex items-center justify-between p-3 bg-purple-50/60 rounded-xl border border-purple-200/80">
              <div>
                <span className="text-xs font-medium text-purple-950 flex items-center gap-1.5">
                  <Brain className="w-3.5 h-3.5 text-purple-600" />
                  <span>Tư duy mở rộng (Thinking)</span>
                </span>
                <span className="text-[11px] text-purple-700/80">Kích hoạt suy luận chuyên sâu & trích xuất suy nghĩ</span>
              </div>
              <input
                type="checkbox"
                checked={extendedThinking}
                onChange={(e) => setExtendedThinking(e.target.checked)}
                className="w-4 h-4 rounded text-purple-900 accent-purple-600"
              />
            </div>

            <div>
              <div className="flex items-center justify-between text-xs font-medium text-zinc-700 mb-1">
                <span>Temperature</span>
                <span className="font-mono text-zinc-500">{temperature}</span>
              </div>
              <input
                type="range"
                min="0"
                max="1.5"
                step="0.1"
                value={temperature}
                onChange={(e) => setTemperature(parseFloat(e.target.value))}
                className="w-full accent-zinc-900"
              />
            </div>

            {/* Conversation Management */}
            <div className="pt-2 border-t border-zinc-100 space-y-2.5">
              <div className="flex items-center justify-between">
                <label className="text-xs font-semibold text-zinc-800 uppercase tracking-wider flex items-center gap-1.5">
                  <MessageSquare className="w-3.5 h-3.5 text-zinc-500" />
                  <span>Quản lý đoạn chat</span>
                </label>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => {
                      refetchRecentConvs();
                      setShowRecentModal(true);
                    }}
                    className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium text-blue-700 bg-blue-50 border border-blue-200 rounded-lg hover:bg-blue-100 transition-colors"
                    title="Xem danh sách 10 đoạn chat gần nhất"
                  >
                    <History className="w-3 h-3" />
                    <span>10 chat gần nhất</span>
                  </button>
                  {conversationId && (
                    <button
                      type="button"
                      onClick={() => {
                        clearChat();
                      }}
                      className="inline-flex items-center gap-0.5 px-2 py-1 text-[11px] font-medium text-zinc-600 bg-zinc-100 hover:bg-zinc-200 border border-zinc-200 rounded-lg transition-colors"
                      title="Bắt đầu hội thoại mới"
                    >
                      <Plus className="w-3 h-3" />
                      <span>Mới</span>
                    </button>
                  )}
                </div>
              </div>

              {/* Quick Select Dropdown */}
              <div>
                <select
                  value={conversationId}
                  onChange={(e) => {
                    const selectedCid = e.target.value;
                    if (!selectedCid) {
                      clearChat();
                      return;
                    }
                    const found = recentConvsData?.conversations?.find((c) => c.id === selectedCid);
                    if (found) {
                      handleSelectRecentConversation(found);
                    } else {
                      setConversationId(selectedCid);
                    }
                  }}
                  className="w-full px-2.5 py-1.5 border border-zinc-200 rounded-xl text-xs text-zinc-800 bg-zinc-50 focus:bg-white focus:outline-hidden focus:ring-2 focus:ring-zinc-900/10"
                >
                  <option value="">-- Chọn 1 trong 10 chat gần nhất --</option>
                  {recentConvsData?.conversations?.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.title.length > 28 ? c.title.slice(0, 28) + '…' : c.title} ({formatConvTime(c.timestamp_seconds, c.updated_at)})
                    </option>
                  ))}
                </select>
              </div>

              {/* Active Conversation Card */}
              {conversationId ? (
                <div className="p-2.5 rounded-xl bg-blue-50/60 border border-blue-200/80 text-xs space-y-1.5">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-blue-950 truncate max-w-[170px]" title={activeConvTitle || conversationId}>
                      {activeConvTitle || 'Đoạn chat đang chọn'}
                    </span>
                    <span className="inline-flex items-center gap-1 text-[10px] font-medium text-emerald-700 bg-emerald-100/70 px-1.5 py-0.5 rounded-md">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span>
                      <span>Đang tiếp tục</span>
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-[11px] text-blue-800 font-mono">
                    <span className="truncate">{conversationId}</span>
                    <a
                      href={`https://gemini.google.com/app/${conversationId}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-0.5 text-blue-600 hover:text-blue-900 hover:underline font-sans ml-1 shrink-0"
                    >
                      <ExternalLink className="w-3 h-3" />
                    </a>
                  </div>
                  <p className="text-[10px] text-blue-700/80 leading-tight">
                    Tin nhắn tiếp theo sẽ được liên kết trên cùng đoạn chat này mà không tạo chat mới trên Google.
                  </p>
                </div>
              ) : (
                <div className="p-2.5 rounded-xl bg-zinc-50 border border-dashed border-zinc-200 text-zinc-500 text-[11px] leading-tight">
                  Chưa chọn đoạn chat. Khi gửi câu hỏi đầu tiên, hệ thống sẽ liên kết trực tiếp trên Gemini Web.
                </div>
              )}

              {/* Manual Input Fallback */}
              <div>
                <details className="text-[11px] text-zinc-500 group">
                  <summary className="cursor-pointer hover:text-zinc-800 flex items-center gap-1 py-0.5 select-none font-medium">
                    <ChevronRight className="w-3 h-3 transition-transform group-open:rotate-90" />
                    <span>Nhập mã c_... thủ công</span>
                  </summary>
                  <div className="mt-1.5 space-y-1">
                    <input
                      type="text"
                      value={conversationId}
                      onChange={(e) => {
                        setConversationId(e.target.value);
                        try {
                          sessionStorage.setItem('gmgw_playground_conv_id', e.target.value);
                        } catch {}
                      }}
                      placeholder="Mã đoạn chat (ví dụ: c_c73b1...)"
                      className="w-full px-2.5 py-1.5 border border-zinc-200 rounded-lg text-xs font-mono text-zinc-800 bg-white focus:outline-hidden focus:ring-1 focus:ring-zinc-900/20"
                    />
                  </div>
                </details>
              </div>
            </div>
          </div>
        </div>

        {/* Right Column: Chat History & Input */}
        <div className="lg:col-span-8 bg-white border border-zinc-200 rounded-2xl shadow-2xs flex flex-col min-h-[580px]">
          {/* Top Chat Bar */}
          <div className="flex items-center justify-between px-5 py-3 border-b border-zinc-100">
            <div className="flex items-center gap-2 text-sm font-medium text-zinc-900">
              <Terminal className="w-4 h-4 text-zinc-500" />
              <span>Conversation ({turns.length} messages)</span>
            </div>
            <div className="flex items-center gap-2">
              {latencyMs !== null && (
                <span className="text-xs px-2.5 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 font-mono">
                  {latencyMs}ms
                </span>
              )}
              <button
                onClick={() => setShowRaw(!showRaw)}
                className={`text-xs px-2.5 py-1 rounded-lg border transition-colors ${
                  showRaw
                    ? 'bg-zinc-900 text-white border-zinc-900'
                    : 'bg-white text-zinc-600 border-zinc-200 hover:bg-zinc-50'
                }`}
              >
                <Code className="w-3.5 h-3.5 inline mr-1" />
                {showRaw ? 'Chat UI' : 'Raw JSON'}
              </button>
            </div>
          </div>

          {/* Active Conversation Banner */}
          {conversationId && (
            <div className="flex flex-wrap items-center justify-between gap-2 px-5 py-2.5 bg-blue-50/80 border-b border-blue-100 text-xs text-blue-900">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-emerald-500 shrink-0"></span>
                <span className="font-semibold text-blue-950">
                  {activeConvTitle ? `Đoạn chat: "${activeConvTitle}"` : 'Đang chat trên cùng một đoạn chat'}
                </span>
                <code className="font-mono bg-blue-100/90 px-2 py-0.5 rounded-md text-[11px] text-blue-950 font-bold border border-blue-200">
                  {conversationId}
                </code>
                <button
                  type="button"
                  onClick={() => {
                    navigator.clipboard.writeText(conversationId);
                    setCopiedConv(true);
                    setTimeout(() => setCopiedConv(false), 2000);
                  }}
                  className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md hover:bg-blue-100 text-blue-700 font-medium transition-colors"
                  title="Sao chép mã cuộc trò chuyện"
                >
                  {copiedConv ? <Check className="w-3 h-3 text-emerald-600" /> : <Copy className="w-3 h-3" />}
                  <span className="text-[11px]">{copiedConv ? 'Đã chép' : 'Chép'}</span>
                </button>
              </div>
              <div className="flex items-center gap-3">
                <a
                  href={`https://gemini.google.com/app/${conversationId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-[11px] text-blue-700 hover:text-blue-950 hover:underline font-medium"
                >
                  <span>Mở trên gemini.google.com</span>
                  <ExternalLink className="w-3 h-3" />
                </a>
                <button
                  type="button"
                  onClick={() => {
                    refetchRecentConvs();
                    setShowRecentModal(true);
                  }}
                  className="text-[11px] text-blue-700 hover:text-blue-950 hover:underline font-medium"
                >
                  Đổi đoạn chat
                </button>
                <button
                  type="button"
                  onClick={() => clearChat()}
                  className="text-[11px] text-rose-600 hover:text-rose-800 hover:underline font-medium"
                >
                  Tạo chat mới
                </button>
              </div>
            </div>
          )}

          {/* Loading conversation turns overlay/bar */}
          {loadingTurns && (
            <div className="flex items-center justify-center gap-2 py-2 px-4 bg-amber-50 border-b border-amber-200 text-amber-900 text-xs font-medium">
              <Loader2 className="w-4 h-4 animate-spin text-amber-700" />
              <span>Đang tải lịch sử tin nhắn của đoạn chat từ Gemini Web...</span>
            </div>
          )}

          {errorText && (
            <div className="mx-5 mt-4 p-3.5 rounded-xl bg-rose-50 border border-rose-200 text-rose-800 text-xs flex items-start gap-2">
              <AlertCircle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
              <div>
                <strong>Error:</strong> {errorText}
              </div>
            </div>
          )}

          {/* Messages Container */}
          <div className="flex-1 p-5 overflow-y-auto space-y-4 max-h-[520px]">
            {showRaw ? (
              <pre className="p-4 bg-zinc-50 border border-zinc-200 rounded-xl text-xs font-mono text-zinc-800 whitespace-pre-wrap">
                {JSON.stringify(rawResponse || { turns }, null, 2)}
              </pre>
            ) : turns.length === 0 && !isLoading ? (
              <div className="flex flex-col items-center justify-center h-72 text-zinc-400 space-y-2">
                <Terminal className="w-8 h-8 text-zinc-300" />
                <p className="text-sm font-medium text-zinc-600">No messages in conversation</p>
                <p className="text-xs text-zinc-400 max-w-sm text-center">
                  Type a prompt below, attach images/PDFs/CSVs, or ask Gemini Web to generate images.
                </p>
              </div>
            ) : (
              <div className="space-y-4">
                {turns.map((turn) => (
                  <div
                    key={turn.id}
                    className={`flex flex-col ${turn.role === 'user' ? 'items-end' : 'items-start'}`}
                  >
                    <div className="flex items-center gap-1.5 mb-1 px-1">
                      <span className="text-[11px] font-semibold text-zinc-500 uppercase tracking-wider">
                        {turn.role === 'user' ? 'You' : 'Gemini Assistant'}
                      </span>
                    </div>

                    <div
                      className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm leading-relaxed shadow-2xs ${
                        turn.role === 'user'
                          ? 'bg-zinc-900 text-white rounded-br-none'
                          : 'bg-zinc-50 border border-zinc-200 text-zinc-900 rounded-bl-none'
                      }`}
                    >
                      {/* Attached user files */}
                      {turn.attachments && turn.attachments.length > 0 && (
                        <div className="flex flex-wrap gap-2 mb-2 pb-2 border-b border-zinc-700">
                          {turn.attachments.map((att, idx) => (
                            <div
                              key={idx}
                              className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-zinc-800 text-xs text-zinc-200"
                            >
                              {att.mimeType.startsWith('image/') ? (
                                <ImageIcon className="w-3.5 h-3.5 text-blue-400" />
                              ) : (
                                <FileText className="w-3.5 h-3.5 text-amber-400" />
                              )}
                              <span className="truncate max-w-[120px]">{att.name}</span>
                            </div>
                          ))}
                        </div>
                      )}

                      {/* Extended Thinking Section */}
                      {turn.reasoning && (
                        <div className="mb-3 rounded-xl bg-purple-50/80 border border-purple-200 p-2.5 text-xs text-purple-900">
                          <button
                            type="button"
                            onClick={() =>
                              setThinkingExpanded((prev) => ({
                                ...prev,
                                [turn.id]: !prev[turn.id],
                              }))
                            }
                            className="flex items-center gap-1.5 font-semibold text-purple-800 hover:text-purple-950 transition-colors w-full text-left"
                          >
                            <Brain className="w-3.5 h-3.5 text-purple-600" />
                            <span>Extended Thinking Process</span>
                            {thinkingExpanded[turn.id] ? (
                              <ChevronDown className="w-3 h-3 ml-auto" />
                            ) : (
                              <ChevronRight className="w-3 h-3 ml-auto" />
                            )}
                          </button>
                          {thinkingExpanded[turn.id] && (
                            <div className="mt-2 pt-2 border-t border-purple-200 whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-purple-950">
                              {turn.reasoning}
                            </div>
                          )}
                        </div>
                      )}

                      {/* Text content */}
                      <div className="whitespace-pre-wrap">{turn.content}</div>

                      {/* Generated Images */}
                      {turn.images && turn.images.length > 0 && (
                        <div className="mt-3 space-y-2">
                          {turn.images.map((img, idx) => (
                            <div
                              key={idx}
                              className="rounded-xl border border-zinc-200 overflow-hidden bg-white p-2 shadow-xs"
                            >
                              <img
                                src={img.b64_json ? `data:${img.title?.endsWith('.png') ? 'image/png' : 'image/jpeg'};base64,${img.b64_json}` : img.url}
                                alt={img.title || 'Generated image'}
                                className="max-h-72 w-full object-contain rounded-lg bg-zinc-100"
                              />
                              <div className="mt-2 flex items-center justify-between text-xs text-zinc-600 px-1">
                                <span className="font-medium truncate">{img.title || 'Generated Media'}</span>
                                <a
                                  href={img.b64_json ? `data:image/png;base64,${img.b64_json}` : img.url}
                                  download={img.title || 'gemini_image.png'}
                                  className="inline-flex items-center gap-1 text-blue-600 hover:text-blue-800"
                                >
                                  <Download className="w-3.5 h-3.5" />
                                  <span>Download</span>
                                </a>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                ))}

                {/* Streaming in progress */}
                {isLoading && (
                  <div className="flex flex-col items-start">
                    <div className="flex items-center gap-1.5 mb-1 px-1">
                      <span className="text-[11px] font-semibold text-zinc-500 uppercase tracking-wider">
                        Gemini Assistant
                      </span>
                    </div>
                    <div className="max-w-[85%] rounded-2xl rounded-bl-none px-4 py-3 text-sm leading-relaxed bg-zinc-50 border border-zinc-200 text-zinc-900 shadow-2xs">
                      {streamingReasoning && (
                        <div className="mb-3 rounded-xl bg-purple-50/80 border border-purple-200 p-2.5 text-xs text-purple-900">
                          <div className="flex items-center gap-1.5 font-semibold text-purple-800">
                            <Brain className="w-3.5 h-3.5 text-purple-600 animate-pulse" />
                            <span>Thinking...</span>
                          </div>
                          <div className="mt-2 pt-2 border-t border-purple-200 whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-purple-950">
                            {streamingReasoning}
                          </div>
                        </div>
                      )}
                      {streamingText ? (
                        <div className="whitespace-pre-wrap">{streamingText}</div>
                      ) : (
                        <div className="flex items-center gap-2 text-zinc-400 py-1">
                          <Loader2 className="w-4 h-4 animate-spin text-zinc-600" />
                          <span>Generating from Gemini Web session...</span>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Attachment Preview Chips */}
          {attachments.length > 0 && (
            <div className="px-5 py-2 border-t border-zinc-100 flex flex-wrap gap-2 bg-zinc-50">
              {attachments.map((att, idx) => (
                <div
                  key={idx}
                  className="flex items-center gap-2 px-2.5 py-1 bg-white border border-zinc-200 rounded-lg text-xs shadow-2xs"
                >
                  {att.mimeType.startsWith('image/') ? (
                    <img src={att.dataUrl} alt="preview" className="w-4 h-4 rounded object-cover" />
                  ) : (
                    <FileText className="w-3.5 h-3.5 text-zinc-500" />
                  )}
                  <span className="font-medium text-zinc-700 truncate max-w-[140px]">{att.name}</span>
                  <span className="text-[10px] text-zinc-400">({Math.round(att.size / 1024)} KB)</span>
                  <button
                    type="button"
                    onClick={() => removeAttachment(idx)}
                    className="text-zinc-400 hover:text-zinc-600 ml-1"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Bottom Prompt Input */}
          <div className="p-4 border-t border-zinc-100 bg-white rounded-b-2xl">
            <form onSubmit={handleSendRequest} className="space-y-3">
              <div className="relative flex items-center gap-2">
                <input
                  type="file"
                  ref={fileInputRef}
                  onChange={(e) => handleFileSelect(e.target.files)}
                  multiple
                  accept="image/png,image/jpeg,image/webp,image/gif,application/pdf,text/plain,text/csv"
                  className="hidden"
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="p-2 text-zinc-500 hover:text-zinc-800 rounded-xl hover:bg-zinc-100 transition-colors shrink-0"
                  title="Attach images or documents (PDF, TXT, CSV)"
                >
                  <Paperclip className="w-4 h-4" />
                </button>
                <textarea
                  rows={2}
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      handleSendRequest(e);
                    }
                  }}
                  placeholder="Ask a question, upload images/files, or request image generation... (Press Enter to send)"
                  className="flex-1 px-3 py-2 border border-zinc-200 rounded-xl text-sm focus:ring-2 focus:ring-zinc-900 focus:outline-none bg-zinc-50 focus:bg-white resize-none"
                />
                <button
                  type="submit"
                  disabled={isLoading || (!prompt.trim() && attachments.length === 0) || models.length === 0}
                  className="px-4 py-2 bg-zinc-900 text-white rounded-xl text-sm font-medium hover:bg-zinc-800 transition-colors shadow-xs disabled:opacity-50 shrink-0 self-end"
                >
                  {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                </button>
              </div>
            </form>
          </div>
        </div>
      </div>
      {/* 10 Recent Conversations Modal */}
      {showRecentModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-xs animate-in fade-in duration-150">
          <div className="bg-white rounded-2xl border border-zinc-200 shadow-xl max-w-xl w-full max-h-[85vh] flex flex-col overflow-hidden">
            {/* Modal Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-100">
              <div className="flex items-center gap-2.5">
                <div className="p-2 bg-blue-50 text-blue-700 rounded-xl">
                  <History className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-base font-semibold text-zinc-900">10 đoạn chat gần nhất từ Gemini Web</h3>
                  <p className="text-xs text-zinc-500">
                    Chọn một đoạn chat để tải lại lịch sử và tiếp tục đặt câu hỏi mà không tạo chat mới trên Google.
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => refetchRecentConvs()}
                  disabled={loadingRecentConvs}
                  className="p-1.5 text-zinc-500 hover:text-zinc-800 rounded-lg hover:bg-zinc-100 transition-colors disabled:opacity-50"
                  title="Làm mới danh sách"
                >
                  <RefreshCw className={`w-4 h-4 ${loadingRecentConvs ? 'animate-spin' : ''}`} />
                </button>
                <button
                  type="button"
                  onClick={() => setShowRecentModal(false)}
                  className="p-1.5 text-zinc-400 hover:text-zinc-700 rounded-lg hover:bg-zinc-100 transition-colors"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Modal Content / Conversation List */}
            <div className="flex-1 overflow-y-auto p-4 space-y-2">
              {loadingRecentConvs ? (
                <div className="py-12 flex flex-col items-center justify-center text-zinc-400 gap-2">
                  <Loader2 className="w-6 h-6 animate-spin text-blue-600" />
                  <span className="text-xs">Đang truy xuất 10 đoạn chat gần nhất từ Google Gemini...</span>
                </div>
              ) : !recentConvsData?.conversations || recentConvsData.conversations.length === 0 ? (
                <div className="py-12 text-center text-zinc-400 text-xs">
                  Chưa tìm thấy đoạn chat nào trên tài khoản Gemini Web đang kết nối.
                </div>
              ) : (
                recentConvsData.conversations.map((conv, idx) => {
                  const isSelected = conversationId === conv.id;
                  return (
                    <div
                      key={conv.id}
                      className={`p-3.5 rounded-xl border transition-all flex items-center justify-between gap-3 ${
                        isSelected
                          ? 'bg-blue-50/70 border-blue-300 ring-1 ring-blue-300/50'
                          : 'bg-white hover:bg-zinc-50 border-zinc-200'
                      }`}
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-semibold text-zinc-400 font-mono">#{idx + 1}</span>
                          <h4 className="text-sm font-medium text-zinc-900 truncate" title={conv.title}>
                            {conv.title}
                          </h4>
                          {isSelected && (
                            <span className="text-[10px] font-semibold text-blue-700 bg-blue-100 px-2 py-0.5 rounded-md shrink-0">
                              Đang chọn
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-2 mt-1 text-[11px] text-zinc-500">
                          <span className="font-mono text-zinc-400">{conv.id}</span>
                          <span>•</span>
                          <span>{formatConvTime(conv.timestamp_seconds, conv.updated_at)}</span>
                        </div>
                      </div>

                      <div className="flex items-center gap-2 shrink-0">
                        <a
                          href={`https://gemini.google.com/app/${conv.id}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="p-2 text-zinc-400 hover:text-zinc-700 hover:bg-zinc-100 rounded-lg transition-colors"
                          title="Mở trực tiếp trên web Gemini"
                        >
                          <ExternalLink className="w-4 h-4" />
                        </a>
                        <button
                          type="button"
                          onClick={() => handleSelectRecentConversation(conv)}
                          disabled={loadingTurns}
                          className={`px-3 py-1.5 text-xs font-medium rounded-xl transition-colors ${
                            isSelected
                              ? 'bg-blue-600 text-white hover:bg-blue-700'
                              : 'bg-zinc-900 text-white hover:bg-zinc-800'
                          }`}
                        >
                          {isSelected ? 'Đang chọn' : 'Mở & Chat tiếp'}
                        </button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            {/* Modal Footer */}
            <div className="px-6 py-3 border-t border-zinc-100 bg-zinc-50/70 flex items-center justify-between text-xs text-zinc-500">
              <span>Mỗi tài khoản hiển thị tối đa 10 cuộc hội thoại mới nhất từ Gemini.</span>
              <button
                type="button"
                onClick={() => setShowRecentModal(false)}
                className="px-3.5 py-1.5 bg-white border border-zinc-200 text-zinc-700 rounded-xl hover:bg-zinc-50 font-medium transition-colors"
              >
                Đóng
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
