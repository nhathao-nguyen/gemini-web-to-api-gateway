import React, { useState } from 'react';
import { BookOpen, Copy, Check, Terminal, Code2, ShieldAlert } from 'lucide-react';

export const DocsView: React.FC = () => {
  const [copiedSection, setCopiedSection] = useState<string | null>(null);

  const copy = (key: string, text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedSection(key);
    setTimeout(() => setCopiedSection(null), 2000);
  };

  const currentOrigin = typeof window !== 'undefined' && window.location.origin
    ? window.location.origin
    : 'http://SERVER_LAN_IP:3000';
  const apiBaseUrl = `${currentOrigin}/v1`;

  const nodeSnippet = `import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: process.env.GEMINI_GATEWAY_API_KEY || 'sk-gmgw-your_generated_key',
  baseURL: '${apiBaseUrl}',
});

async function main() {
  const stream = await client.chat.completions.create({
    model: 'gemini-2.5-flash',
    messages: [
      { role: 'system', content: 'You are an AI assistant.' },
      { role: 'user', content: 'Hello!' },
    ],
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
    api_key=os.environ.get("GEMINI_GATEWAY_API_KEY", "sk-gmgw-your_generated_key"),
    base_url="${apiBaseUrl}"
)

response = client.chat.completions.create(
    model="gemini-2.5-flash",
    messages=[
        {"role": "user", "content": "What is the theory of relativity?"}
    ],
    stream=True
)

for chunk in response:
    content = chunk.choices[0].delta.content or ""
    print(content, end="", flush=True)
`;

  const curlSnippet = `curl ${apiBaseUrl}/chat/completions \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer $GEMINI_GATEWAY_API_KEY" \\
  -d '{
    "model": "gemini-2.5-flash",
    "messages": [
      {"role": "user", "content": "Hello world!"}
    ],
    "stream": true
  }'`;

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h2 className="text-xl font-semibold text-zinc-900 tracking-tight">OpenAI Client Integration Guide</h2>
        <p className="text-sm text-zinc-500">
          Connect your existing OpenAI-compatible apps, agents, and frameworks by simply redirecting the API key and Base URL.
        </p>
      </div>

      <div className="p-4 rounded-xl bg-zinc-900 text-white shadow-sm space-y-2">
        <div className="text-xs uppercase tracking-wider text-emerald-400 font-semibold font-mono">
          Endpoint Configuration
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-1 text-xs">
          <div>
            <span className="text-zinc-400 block mb-0.5">OPENAI_BASE_URL:</span>
            <code className="bg-zinc-800 px-2 py-1 rounded text-zinc-100 font-mono block">
              {window.location.origin}/v1
            </code>
          </div>
          <div>
            <span className="text-zinc-400 block mb-0.5">OPENAI_API_KEY:</span>
            <code className="bg-zinc-800 px-2 py-1 rounded text-zinc-100 font-mono block">
              sk-gmgw-... (Generate from API Keys tab)
            </code>
          </div>
        </div>
      </div>

      {/* Node.js snippet */}
      <div className="bg-white border border-zinc-200 rounded-xl overflow-hidden shadow-xs">
        <div className="flex items-center justify-between px-4 py-3 bg-zinc-50 border-b border-zinc-200">
          <div className="flex items-center gap-2 text-xs font-semibold text-zinc-800">
            <Code2 className="w-4 h-4 text-emerald-600" />
            <span>Node.js / TypeScript (Official OpenAI SDK)</span>
          </div>
          <button
            onClick={() => copy('node', nodeSnippet)}
            className="flex items-center gap-1 text-xs text-zinc-600 hover:text-zinc-900"
          >
            {copiedSection === 'node' ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
            <span>{copiedSection === 'node' ? 'Copied' : 'Copy'}</span>
          </button>
        </div>
        <pre className="p-4 text-xs font-mono bg-zinc-950 text-zinc-200 overflow-x-auto leading-relaxed">
          {nodeSnippet}
        </pre>
      </div>

      {/* Python snippet */}
      <div className="bg-white border border-zinc-200 rounded-xl overflow-hidden shadow-xs">
        <div className="flex items-center justify-between px-4 py-3 bg-zinc-50 border-b border-zinc-200">
          <div className="flex items-center gap-2 text-xs font-semibold text-zinc-800">
            <Terminal className="w-4 h-4 text-blue-600" />
            <span>Python (openai SDK)</span>
          </div>
          <button
            onClick={() => copy('python', pythonSnippet)}
            className="flex items-center gap-1 text-xs text-zinc-600 hover:text-zinc-900"
          >
            {copiedSection === 'python' ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
            <span>{copiedSection === 'python' ? 'Copied' : 'Copy'}</span>
          </button>
        </div>
        <pre className="p-4 text-xs font-mono bg-zinc-950 text-zinc-200 overflow-x-auto leading-relaxed">
          {pythonSnippet}
        </pre>
      </div>

      {/* cURL snippet */}
      <div className="bg-white border border-zinc-200 rounded-xl overflow-hidden shadow-xs">
        <div className="flex items-center justify-between px-4 py-3 bg-zinc-50 border-b border-zinc-200">
          <div className="flex items-center gap-2 text-xs font-semibold text-zinc-800">
            <Terminal className="w-4 h-4 text-zinc-600" />
            <span>cURL Command Line</span>
          </div>
          <button
            onClick={() => copy('curl', curlSnippet)}
            className="flex items-center gap-1 text-xs text-zinc-600 hover:text-zinc-900"
          >
            {copiedSection === 'curl' ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
            <span>{copiedSection === 'curl' ? 'Copied' : 'Copy'}</span>
          </button>
        </div>
        <pre className="p-4 text-xs font-mono bg-zinc-950 text-zinc-200 overflow-x-auto leading-relaxed">
          {curlSnippet}
        </pre>
      </div>
    </div>
  );
};
