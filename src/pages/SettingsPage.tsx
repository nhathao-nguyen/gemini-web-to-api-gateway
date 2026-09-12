import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Settings,
  Server,
  Database,
  Shield,
  Clock,
  Code2,
  Terminal,
  Copy,
  Check,
  Cpu,
  RefreshCw,
} from 'lucide-react';
import { fetchSettings } from '../lib/api-client.js';
import { useDocumentTitle } from '../hooks/useDocumentTitle.js';
import { ErrorState } from '../components/ErrorState.js';

export const SettingsPage: React.FC = () => {
  useDocumentTitle('Settings & Guide');
  const [copiedSection, setCopiedSection] = useState<string | null>(null);

  const {
    data: settings,
    isLoading,
    isError,
    error,
    refetch,
    isFetching,
  } = useQuery({
    queryKey: ['settings'],
    queryFn: fetchSettings,
  });

  const copy = (key: string, text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedSection(key);
    setTimeout(() => setCopiedSection(null), 2000);
  };

  const currentOrigin =
    typeof window !== 'undefined' && window.location.origin
      ? window.location.origin
      : 'http://localhost:3000';
  const apiBaseUrl = `${currentOrigin}/v1`;

  const nodeSnippet = `import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: process.env.GEMINI_GATEWAY_API_KEY || 'sk-gmgw-your_key',
  baseURL: '${apiBaseUrl}',
});

async function main() {
  const stream = await client.chat.completions.create({
    model: 'gemini-2.5-flash',
    messages: [{ role: 'user', content: 'Hello Gemini Web!' }],
    stream: true,
  });

  for await (const chunk of stream) {
    process.stdout.write(chunk.choices[0]?.delta?.content || '');
  }
}

main();`;

  const pythonSnippet = `import os
from openai import OpenAI

client = OpenAI(
    api_key=os.environ.get("GEMINI_GATEWAY_API_KEY", "sk-gmgw-your_key"),
    base_url="${apiBaseUrl}"
)

response = client.chat.completions.create(
    model="gemini-2.5-flash",
    messages=[{"role": "user", "content": "Explain relativity briefly"}],
    stream=True
)

for chunk in response:
    print(chunk.choices[0].delta.content or "", end="", flush=True)
`;

  const curlSnippet = `curl ${apiBaseUrl}/chat/completions \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer $GEMINI_GATEWAY_API_KEY" \\
  -d '{
    "model": "gemini-2.5-flash",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true
  }'`;

  return (
    <div className="space-y-8 max-w-5xl">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-zinc-900 tracking-tight">Gateway Settings & SDK Guide</h2>
          <p className="text-sm text-zinc-500">
            Runtime configurations, encryption parameters, and client integration instructions.
          </p>
        </div>
        <button
          onClick={() => refetch()}
          disabled={isFetching}
          className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-zinc-700 bg-white border border-zinc-200 rounded-xl hover:bg-zinc-50 transition-colors disabled:opacity-50 self-start sm:self-auto"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isFetching ? 'animate-spin' : ''}`} />
          <span>Refresh System</span>
        </button>
      </div>

      {/* System Runtime Configuration Grid */}
      {isLoading ? (
        <div className="bg-white border border-zinc-200 rounded-2xl p-12 text-center text-zinc-400">
          <RefreshCw className="w-6 h-6 animate-spin mx-auto mb-2 text-zinc-500" />
          <p className="text-sm">Loading system settings...</p>
        </div>
      ) : isError ? (
        <ErrorState
          title="Error loading settings"
          message={(error as any)?.message || 'Failed to retrieve system settings.'}
          onRetry={() => refetch()}
        />
      ) : settings ? (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
          {/* Card 1: Server Runtime */}
          <div className="bg-white border border-zinc-200 rounded-2xl p-5 shadow-2xs space-y-3">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-zinc-500 pb-2 border-b border-zinc-100">
              <Server className="w-4 h-4 text-zinc-600" />
              <span>Server Environment</span>
            </div>
            <div className="space-y-2 text-xs">
              <div className="flex justify-between py-1 border-b border-zinc-50">
                <span className="text-zinc-500">Listening Port:</span>
                <span className="font-mono text-zinc-900 font-semibold">{settings.port}</span>
              </div>
              <div className="flex justify-between py-1 border-b border-zinc-50">
                <span className="text-zinc-500">Binding Host:</span>
                <span className="font-mono text-zinc-900">{settings.host}</span>
              </div>
              <div className="flex justify-between py-1 border-b border-zinc-50">
                <span className="text-zinc-500">Environment:</span>
                <span className="font-mono text-zinc-900">
                  {settings.isProduction ? 'production' : 'development'}
                </span>
              </div>
              <div className="flex justify-between py-1 border-b border-zinc-50">
                <span className="text-zinc-500">Node & OS:</span>
                <span className="font-mono text-zinc-900">{settings.nodeVersion} ({settings.platform})</span>
              </div>
              <div className="flex justify-between py-1">
                <span className="text-zinc-500">Uptime:</span>
                <span className="font-mono text-zinc-900">
                  {Math.floor(settings.uptimeSeconds / 60)} mins
                </span>
              </div>
            </div>
          </div>

          {/* Card 2: Persistence & Cache */}
          <div className="bg-white border border-zinc-200 rounded-2xl p-5 shadow-2xs space-y-3">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-zinc-500 pb-2 border-b border-zinc-100">
              <Database className="w-4 h-4 text-zinc-600" />
              <span>Database & Engine</span>
            </div>
            <div className="space-y-2 text-xs">
              <div className="flex justify-between py-1 border-b border-zinc-50">
                <span className="text-zinc-500">Primary Database:</span>
                <span className="font-mono font-semibold text-zinc-900">{settings.databaseEngine}</span>
              </div>
              <div className="flex justify-between py-1 border-b border-zinc-50">
                <span className="text-zinc-500">Database Status:</span>
                {settings.isDatabaseConnected ? (
                  <span className="text-emerald-700 font-medium inline-flex items-center gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
                    Connected & Healthy
                  </span>
                ) : (
                  <span className="text-rose-700 font-medium inline-flex items-center gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-rose-500"></span>
                    Disconnected
                  </span>
                )}
              </div>
              <div className="flex justify-between py-1 border-b border-zinc-50">
                <span className="text-zinc-500">Redis Distributed Store:</span>
                <span className="font-mono text-zinc-900">
                  {settings.hasRedis ? 'Enabled' : 'Disabled (Local Memory)'}
                </span>
              </div>
              <div className="flex justify-between py-1">
                <span className="text-zinc-500">Log Level:</span>
                <span className="font-mono text-zinc-900 uppercase">{settings.logLevel}</span>
              </div>
            </div>
          </div>

          {/* Card 3: Security & Upstream */}
          <div className="bg-white border border-zinc-200 rounded-2xl p-5 shadow-2xs space-y-3">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-zinc-500 pb-2 border-b border-zinc-100">
              <Shield className="w-4 h-4 text-zinc-600" />
              <span>Security & Policies</span>
            </div>
            <div className="space-y-2 text-xs">
              <div className="flex justify-between py-1 border-b border-zinc-50">
                <span className="text-zinc-500">Cookie Encryption:</span>
                <span className="text-emerald-700 font-mono font-medium">AES-256-GCM</span>
              </div>
              <div className="flex justify-between py-1 border-b border-zinc-50">
                <span className="text-zinc-500">Admin Auth:</span>
                <span className="font-mono text-zinc-900">
                  {settings.requiresAuth ? 'Enforced' : 'Unlocked'}
                </span>
              </div>
              <div className="flex justify-between py-1 border-b border-zinc-50">
                <span className="text-zinc-500">Request Timeout:</span>
                <span className="font-mono text-zinc-900">{settings.requestTimeout}ms</span>
              </div>
              <div className="flex justify-between py-1">
                <span className="text-zinc-500">Max Failover Attempts:</span>
                <span className="font-mono text-zinc-900">{settings.maxUpstreamAttempts}</span>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {/* Integration Guide Section */}
      <div className="space-y-6 pt-4 border-t border-zinc-200">
        <div>
          <h3 className="text-lg font-bold text-zinc-900 tracking-tight">OpenAI Client Integration Guide</h3>
          <p className="text-xs text-zinc-500">
            Configure standard OpenAI clients to use this gateway by redirecting baseURL and providing an API key.
          </p>
        </div>

        {/* Configuration banner */}
        <div className="p-4 rounded-2xl bg-zinc-900 text-white shadow-xs space-y-2">
          <div className="text-[11px] uppercase tracking-wider text-emerald-400 font-semibold font-mono">
            Gateway Endpoint Parameters
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1 text-xs">
            <div>
              <span className="text-zinc-400 block mb-0.5">OPENAI_BASE_URL:</span>
              <code className="bg-zinc-800 px-2 py-1 rounded-lg text-zinc-100 font-mono block select-all">
                {apiBaseUrl}
              </code>
            </div>
            <div>
              <span className="text-zinc-400 block mb-0.5">OPENAI_API_KEY:</span>
              <code className="bg-zinc-800 px-2 py-1 rounded-lg text-zinc-100 font-mono block">
                sk-gmgw-... (Generate in API Keys tab)
              </code>
            </div>
          </div>
        </div>

        {/* Node.js snippet */}
        <div className="bg-white border border-zinc-200 rounded-2xl overflow-hidden shadow-2xs">
          <div className="flex items-center justify-between px-4 py-3 bg-zinc-50 border-b border-zinc-200">
            <div className="flex items-center gap-2 text-xs font-semibold text-zinc-800">
              <Code2 className="w-4 h-4 text-emerald-600" />
              <span>Node.js / TypeScript (Official openai npm)</span>
            </div>
            <button
              onClick={() => copy('node', nodeSnippet)}
              className="flex items-center gap-1 text-xs text-zinc-600 hover:text-zinc-900"
            >
              {copiedSection === 'node' ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5 text-zinc-500" />}
              <span>{copiedSection === 'node' ? 'Copied' : 'Copy'}</span>
            </button>
          </div>
          <pre className="p-4 text-xs font-mono bg-zinc-950 text-zinc-200 overflow-x-auto leading-relaxed">
            {nodeSnippet}
          </pre>
        </div>

        {/* Python snippet */}
        <div className="bg-white border border-zinc-200 rounded-2xl overflow-hidden shadow-2xs">
          <div className="flex items-center justify-between px-4 py-3 bg-zinc-50 border-b border-zinc-200">
            <div className="flex items-center gap-2 text-xs font-semibold text-zinc-800">
              <Terminal className="w-4 h-4 text-blue-600" />
              <span>Python (openai SDK)</span>
            </div>
            <button
              onClick={() => copy('python', pythonSnippet)}
              className="flex items-center gap-1 text-xs text-zinc-600 hover:text-zinc-900"
            >
              {copiedSection === 'python' ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5 text-zinc-500" />}
              <span>{copiedSection === 'python' ? 'Copied' : 'Copy'}</span>
            </button>
          </div>
          <pre className="p-4 text-xs font-mono bg-zinc-950 text-zinc-200 overflow-x-auto leading-relaxed">
            {pythonSnippet}
          </pre>
        </div>

        {/* cURL snippet */}
        <div className="bg-white border border-zinc-200 rounded-2xl overflow-hidden shadow-2xs">
          <div className="flex items-center justify-between px-4 py-3 bg-zinc-50 border-b border-zinc-200">
            <div className="flex items-center gap-2 text-xs font-semibold text-zinc-800">
              <Terminal className="w-4 h-4 text-zinc-600" />
              <span>cURL Command Line</span>
            </div>
            <button
              onClick={() => copy('curl', curlSnippet)}
              className="flex items-center gap-1 text-xs text-zinc-600 hover:text-zinc-900"
            >
              {copiedSection === 'curl' ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5 text-zinc-500" />}
              <span>{copiedSection === 'curl' ? 'Copied' : 'Copy'}</span>
            </button>
          </div>
          <pre className="p-4 text-xs font-mono bg-zinc-950 text-zinc-200 overflow-x-auto leading-relaxed">
            {curlSnippet}
          </pre>
        </div>
      </div>
    </div>
  );
};
