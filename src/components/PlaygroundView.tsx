import React, { useState, useEffect } from 'react';
import { Send, Terminal, Loader2, Sliders, AlertCircle, Code, Key } from 'lucide-react';
import { ApiKeyItem } from '../types/client.js';
import { getApiUrl } from '../utils/api.js';

interface PlaygroundViewProps {
  apiKeys: ApiKeyItem[];
}

export const PlaygroundView: React.FC<PlaygroundViewProps> = ({ apiKeys }) => {
  const [manualKey, setManualKey] = useState<string>(() => {
    try {
      return localStorage.getItem('gateway_client_active_key') || '';
    } catch {
      return '';
    }
  });

  const [models, setModels] = useState<string[]>([]);
  const [selectedModel, setSelectedModel] = useState('');
  const [prompt, setPrompt] = useState('Explain the concept of quantum entanglement in three simple bullet points.');
  const [stream, setStream] = useState(true);
  const [temperature, setTemperature] = useState(0.7);
  const [maxTokens, setMaxTokens] = useState(1024);
  const [loadingModels, setLoadingModels] = useState(false);

  // Output states
  const [responseOutput, setResponseOutput] = useState('');
  const [rawResponse, setRawResponse] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [showRaw, setShowRaw] = useState(false);

  // Save key to local storage
  const handleKeyChange = (newKey: string) => {
    setManualKey(newKey);
    try {
      localStorage.setItem('gateway_client_active_key', newKey);
    } catch {}
  };

  // Fetch available models whenever a key is provided
  useEffect(() => {
    async function fetchModels() {
      if (!manualKey.trim()) {
        setModels([]);
        return;
      }
      setLoadingModels(true);
      try {
        const res = await fetch(getApiUrl('/v1/models'), {
          headers: { Authorization: `Bearer ${manualKey.trim()}` },
        });
        if (res.ok) {
          const data = await res.json();
          if (data.data && Array.isArray(data.data)) {
            const list = data.data.map((m: any) => m.id);
            setModels(list);
            if (list.length > 0 && !list.includes(selectedModel)) {
              setSelectedModel(list[0]);
            }
          } else {
            setModels([]);
          }
        } else {
          setModels([]);
        }
      } catch {
        setModels([]);
      } finally {
        setLoadingModels(false);
      }
    }
    fetchModels();
  }, [manualKey]);

  const handleSendRequest = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!prompt.trim() || isLoading) return;

    if (!manualKey.trim()) {
      setErrorText('Please create an API key in the API Keys tab and enter it above to authenticate requests.');
      return;
    }

    if (!selectedModel) {
      setErrorText('No model selected. Please ensure a Gemini account is configured and active in the Accounts tab.');
      return;
    }

    setIsLoading(true);
    setResponseOutput('');
    setRawResponse(null);
    setErrorText(null);
    setLatencyMs(null);
    const startTime = Date.now();

    try {
      const payload = {
        model: selectedModel,
        messages: [
          { role: 'system', content: 'You are a helpful, accurate AI assistant running through Gemini Web Gateway.' },
          { role: 'user', content: prompt },
        ],
        temperature,
        max_tokens: maxTokens,
        stream,
      };

      const res = await fetch(getApiUrl('/v1/chat/completions'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${manualKey.trim()}`,
        },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const errJson = await res.json();
        throw new Error(errJson?.error?.message || `HTTP ${res.status}`);
      }

      if (stream) {
        if (!res.body) throw new Error('No stream body returned');
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let accumulated = '';

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
                const delta = parsed.choices?.[0]?.delta?.content || '';
                accumulated += delta;
                setResponseOutput(accumulated);
                setRawResponse(parsed);
              } catch {
                // Ignore parse errors on partial chunks
              }
            }
          }
        }
        setLatencyMs(Date.now() - startTime);
      } else {
        const data = await res.json();
        setLatencyMs(Date.now() - startTime);
        setRawResponse(data);
        const text = data.choices?.[0]?.message?.content || '';
        setResponseOutput(text);
      }
    } catch (err: any) {
      setErrorText(err.message || 'An error occurred while executing the chat completion');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-zinc-900 tracking-tight">Interactive Gateway Playground</h2>
        <p className="text-sm text-zinc-500">
          Execute real OpenAI-compatible completions against <code className="text-xs bg-zinc-100 px-1 py-0.5 rounded">/v1/chat/completions</code> with full SSE streaming.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left Column: Request Form & Controls */}
        <div className="lg:col-span-5 bg-white border border-zinc-200 rounded-xl p-5 shadow-xs space-y-4">
          <div className="flex items-center gap-2 pb-3 border-b border-zinc-100 font-medium text-sm text-zinc-900">
            <Sliders className="w-4 h-4 text-zinc-500" />
            <span>Request Parameters</span>
          </div>

          <form onSubmit={handleSendRequest} className="space-y-4">
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="block text-xs font-medium text-zinc-700">Gateway API Key</label>
                {apiKeys.length === 0 && (
                  <span className="text-[11px] text-amber-600 font-medium">0 keys created</span>
                )}
              </div>
              <div className="relative">
                <input
                  type="text"
                  value={manualKey}
                  onChange={(e) => handleKeyChange(e.target.value)}
                  placeholder="sk-gmgw-..."
                  className="w-full px-3 py-2 border border-zinc-200 rounded-lg text-xs font-mono text-zinc-800 focus:ring-2 focus:ring-zinc-900 focus:outline-none"
                />
              </div>
              <p className="text-[11px] text-zinc-400 mt-1">
                Bearer token for authentication. Create keys under the "API Keys" tab.
              </p>
            </div>

            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="block text-xs font-medium text-zinc-700">Model Selection</label>
                {loadingModels && <span className="text-[11px] text-zinc-400">Discovering...</span>}
              </div>
              {models.length > 0 ? (
                <select
                  value={selectedModel}
                  onChange={(e) => setSelectedModel(e.target.value)}
                  className="w-full px-3 py-2 border border-zinc-200 rounded-lg text-sm bg-white text-zinc-800 focus:ring-2 focus:ring-zinc-900 focus:outline-none font-mono"
                >
                  {models.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              ) : (
                <div className="p-3 bg-amber-50 rounded-lg border border-amber-200 text-xs text-amber-800 leading-relaxed">
                  No models available in pool. Either enter a valid API key above or add an active Gemini account session in the Accounts tab.
                </div>
              )}
            </div>

            <div className="flex items-center justify-between p-3 bg-zinc-50 rounded-lg border border-zinc-200">
              <div>
                <span className="text-xs font-medium text-zinc-800 block">Stream Tokens (SSE)</span>
                <span className="text-[11px] text-zinc-500">Real-time OpenAI chunk stream</span>
              </div>
              <input
                type="checkbox"
                checked={stream}
                onChange={(e) => setStream(e.target.checked)}
                className="w-4 h-4 rounded text-zinc-900"
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

            <div>
              <label className="block text-xs font-medium text-zinc-700 mb-1">User Prompt</label>
              <textarea
                rows={4}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="Enter prompt..."
                className="w-full px-3 py-2 border border-zinc-200 rounded-lg text-sm focus:ring-2 focus:ring-zinc-900 focus:outline-none"
              />
            </div>

            <button
              type="submit"
              disabled={isLoading || !prompt.trim() || models.length === 0}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-zinc-900 text-white rounded-lg text-sm font-medium hover:bg-zinc-800 transition-colors shadow-sm disabled:opacity-50"
            >
              {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              <span>{isLoading ? 'Streaming from upstream...' : 'Run Completion'}</span>
            </button>
          </form>
        </div>

        {/* Right Column: Live Output Console */}
        <div className="lg:col-span-7 bg-white border border-zinc-200 rounded-xl p-5 shadow-xs space-y-4">
          <div className="flex items-center justify-between pb-3 border-b border-zinc-100">
            <div className="flex items-center gap-2 font-medium text-sm text-zinc-900">
              <Terminal className="w-4 h-4 text-zinc-500" />
              <span>Response Window</span>
            </div>
            <div className="flex items-center gap-2">
              {latencyMs !== null && (
                <span className="text-xs px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200 font-mono">
                  {latencyMs}ms
                </span>
              )}
              <button
                onClick={() => setShowRaw(!showRaw)}
                className={`text-xs px-2.5 py-1 rounded border transition-colors ${
                  showRaw
                    ? 'bg-zinc-900 text-white border-zinc-900'
                    : 'bg-white text-zinc-600 border-zinc-200 hover:bg-zinc-50'
                }`}
              >
                <Code className="w-3.5 h-3.5 inline mr-1" />
                {showRaw ? 'Rendered' : 'JSON'}
              </button>
            </div>
          </div>

          {/* Error display */}
          {errorText && (
            <div className="p-3.5 rounded-lg bg-rose-50 border border-rose-200 text-rose-800 text-xs flex items-start gap-2">
              <AlertCircle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
              <div>
                <strong>Error:</strong> {errorText}
              </div>
            </div>
          )}

          {/* Response Container */}
          <div className="min-h-[360px] max-h-[500px] overflow-y-auto p-4 rounded-lg bg-zinc-50 border border-zinc-200 font-mono text-xs leading-relaxed text-zinc-800">
            {isLoading && !responseOutput ? (
              <div className="flex items-center justify-center h-48 text-zinc-400 space-x-2">
                <Loader2 className="w-5 h-5 animate-spin" />
                <span>Connecting to Gemini Web session and scheduler...</span>
              </div>
            ) : showRaw ? (
              <pre className="whitespace-pre-wrap">{JSON.stringify(rawResponse || { text: responseOutput }, null, 2)}</pre>
            ) : responseOutput ? (
              <div className="whitespace-pre-wrap font-sans text-sm leading-relaxed text-zinc-900">
                {responseOutput}
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center h-48 text-zinc-400 space-y-2">
                <Terminal className="w-8 h-8 text-zinc-300" />
                <span>Click "Run Completion" to test this model with the gateway pool</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
