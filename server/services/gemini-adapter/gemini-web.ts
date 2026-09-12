import crypto from 'crypto';
import { setGlobalDispatcher, Agent, ProxyAgent, Dispatcher } from 'undici';
import {
  AIProvider,
  AIProviderResult,
  AIStreamChunk,
  GeminiAccount,
  ChatCompletionRequest,
  HealthResult,
  GeneratedMedia,
  ModelCapabilities,
  AccountQuotaInfo,
  UpstreamConversation,
  UpstreamChatTurn,
} from '../../types.js';
import { decryptCookie } from '../../utils/crypto.js';
import { redactString } from '../../utils/redact.js';
import { config } from '../../config.js';
import { deduplicateCookieString } from '../../utils/cookie.js';

// Configure Undici global dispatcher with generous header buffer for Gemini Web large cookie payloads
const defaultDispatcher = new Agent({
  maxHeaderSize: 262144, // 256 KB
  headersTimeout: 60000,
});

setGlobalDispatcher(defaultDispatcher);

const proxyAgents = new Map<string, ProxyAgent>();

export function getDispatcherForProxy(proxyUrl?: string | null): Dispatcher | undefined {
  // Let Node's native fetch use its own dispatcher when no proxy is configured.
  // Passing an Agent created by the standalone undici package into Node's
  // built-in fetch can fail with UND_ERR_INVALID_ARG on newer Node versions.
  if (!proxyUrl || !proxyUrl.trim()) return undefined;
  let normalized = proxyUrl.trim();
  if (!normalized.includes('://')) {
    normalized = `http://${normalized}`;
  }
  let agent = proxyAgents.get(normalized);
  if (!agent) {
    agent = new ProxyAgent({
      uri: normalized,
      maxHeaderSize: 262144,
      headersTimeout: 60000,
    });
    proxyAgents.set(normalized, agent);
  }
  return agent;
}

/**
 * Calculate remaining milliseconds for an operation deadline and throw UPSTREAM_TIMEOUT if expired.
 */
export function getRemainingTimeout(deadline: number, phaseName = 'Operation'): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw new Error(`UPSTREAM_TIMEOUT: ${phaseName} deadline exceeded`);
  }
  return remaining;
}

export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs: number = config.requestTimeout || 60000,
  externalSignal?: AbortSignal
): Promise<Response> {
  if (externalSignal?.aborted) {
    throw externalSignal.reason || new Error('CLIENT_ABORT: Request cancelled by client');
  }
  if (timeoutMs <= 0) {
    throw new Error('UPSTREAM_TIMEOUT: Upstream request deadline already exceeded');
  }

  const timeoutController = new AbortController();
  const timer = setTimeout(() => {
    timeoutController.abort(new Error(`UPSTREAM_TIMEOUT: Upstream request timed out after ${timeoutMs}ms`));
  }, timeoutMs);

  let onExternalAbort: (() => void) | undefined;
  if (externalSignal) {
    onExternalAbort = () => {
      timeoutController.abort(externalSignal.reason || new Error('CLIENT_ABORT: Request cancelled by client'));
    };
    externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  }

  try {
    const res = await fetch(url, {
      ...init,
      signal: timeoutController.signal,
    });
    return res;
  } catch (err: any) {
    if (externalSignal?.aborted) {
      throw new Error(`CLIENT_ABORT: Request cancelled by client`);
    }
    if (timeoutController.signal.aborted) {
      throw new Error(`UPSTREAM_TIMEOUT: Upstream request timed out after ${timeoutMs}ms (${err.message})`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
    if (externalSignal && onExternalAbort) {
      externalSignal.removeEventListener('abort', onExternalAbort);
    }
  }
}

/**
 * Check if request has sufficient native Gemini conversation state (c_ CID, RID, and RCID)
 * to continue the conversation thread without replaying previous history turns.
 */
export function hasUsableNativeConversationState(request: ChatCompletionRequest): boolean {
  const cid = (request.upstream_cid || request.conversation_id || '').trim();
  const rid = (request.upstream_rid || '').trim();
  const rcid = (request.upstream_rcid || '').trim();
  return Boolean(cid.startsWith('c_') && rid && rcid);
}

/**
 * Read response body as text with timeout and external client abort support
 */
export async function readBodyWithTimeout(
  res: Response,
  timeoutMs: number = config.requestTimeout || 60000,
  signal?: AbortSignal
): Promise<string> {
  if (signal?.aborted) {
    throw new Error('CLIENT_ABORT: Request cancelled by client');
  }
  if (timeoutMs <= 0) {
    throw new Error('UPSTREAM_TIMEOUT: Response body read deadline already exceeded');
  }

  let timer: NodeJS.Timeout | null = null;
  let onAbort: (() => void) | null = null;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`UPSTREAM_TIMEOUT: Response body read timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  const abortPromise = new Promise<never>((_, reject) => {
    if (signal) {
      onAbort = () => {
        reject(new Error('CLIENT_ABORT: Request cancelled by client'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });

  try {
    return await Promise.race([res.text(), timeoutPromise, abortPromise]);
  } catch (err: any) {
    if (signal?.aborted) {
      throw new Error('CLIENT_ABORT: Request cancelled by client');
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && onAbort) {
      signal.removeEventListener('abort', onAbort);
    }
  }
}

/**
 * Read response body as arrayBuffer with timeout and external client abort support
 */
export async function readBufferWithTimeout(
  res: Response,
  timeoutMs: number = config.requestTimeout || 60000,
  signal?: AbortSignal
): Promise<ArrayBuffer> {
  if (signal?.aborted) {
    throw new Error('CLIENT_ABORT: Request cancelled by client');
  }
  if (timeoutMs <= 0) {
    throw new Error('UPSTREAM_TIMEOUT: Response buffer read deadline already exceeded');
  }

  let timer: NodeJS.Timeout | null = null;
  let onAbort: (() => void) | null = null;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`UPSTREAM_TIMEOUT: Response buffer read timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  const abortPromise = new Promise<never>((_, reject) => {
    if (signal) {
      onAbort = () => {
        reject(new Error('CLIENT_ABORT: Request cancelled by client'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });

  try {
    return await Promise.race([res.arrayBuffer(), timeoutPromise, abortPromise]);
  } catch (err: any) {
    if (signal?.aborted) {
      throw new Error('CLIENT_ABORT: Request cancelled by client');
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && onAbort) {
      signal.removeEventListener('abort', onAbort);
    }
  }
}

const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export const GEMINI_MODEL_HEADER_KEY = 'x-goog-ext-525001261-jspb';
export const GEMINI_USER_STATUS_RPC = 'otAQ7b';
export const GEMINI_USAGE_INFO_RPC = 'jSf9Qc';

export interface DiscoveredModel {
  id: string; // canonical slug, e.g. "gemini-3.8-flash", "gemini-3.1-pro"
  displayName: string;
  modelId: string; // internal Google model ID, e.g. "g-xxxx"
  capacity: number;
  capacityField: number; // 12 or 13
  modelNumber: number; // 1, 2, 3...
  aliases: string[];
}

export interface GeminiWebSession {
  snlm0e: string;
  pushId: string;
  buildLabel: string;
  sessionId: string;
  language: string;
  generationId: string;
  cookieHeader: string;
  discoveredModels: DiscoveredModel[];
  fetchedAt: number;
}

// --------------------------------------------------------------------------
// Protocol helper functions
// --------------------------------------------------------------------------

export function geminiAccountUrl(endpoint: string, authUser?: string): string {
  if (!authUser || authUser === '0' || authUser === '') {
    return endpoint;
  }
  return endpoint.replace('https://gemini.google.com/', `https://gemini.google.com/u/${authUser}/`);
}

export function geminiSourcePath(authUser?: string): string {
  if (!authUser || authUser === '0' || authUser === '') {
    return '/app';
  }
  return `/u/${authUser}/app`;
}

export function cleanCookie(v: string): string {
  let val = v.trim();
  val = val.replace(/^["']|["']$/g, '');
  return val.replace(/;$/, '');
}

export function mergeCookieHeaders(...headers: string[]): string {
  const values = new Map<string, string>();
  const order: string[] = [];

  for (const header of headers) {
    if (!header) continue;
    for (const pair of header.split(';')) {
      const idx = pair.indexOf('=');
      if (idx === -1) continue;
      const name = pair.slice(0, idx).trim();
      const val = pair.slice(idx + 1).trim();
      if (!name) continue;
      if (!values.has(name)) {
        order.push(name);
      }
      values.set(name, val);
    }
  }

  return order.map((name) => `${name}=${values.get(name)}`).join('; ');
}

export function extractThinkingAndText(raw: string): { thinking: string; text: string } {
  if (!raw) return { thinking: '', text: '' };

  let startIdx = -1;
  let startLen = 0;
  const markers = ['<ctrl94>thought', '<ctrl94>'];
  for (const marker of markers) {
    const idx = raw.indexOf(marker);
    if (idx !== -1) {
      startIdx = idx;
      startLen = marker.length;
      break;
    }
  }

  if (startIdx === -1) {
    return { thinking: '', text: raw };
  }

  let endIdx = -1;
  let endLen = 0;
  const endMarkers = ['<ctrl95>'];
  for (const marker of endMarkers) {
    const idx = raw.indexOf(marker, startIdx + startLen);
    if (idx !== -1) {
      endIdx = idx;
      endLen = marker.length;
      break;
    }
  }

  if (endIdx === -1) {
    const thinking = raw.slice(startIdx + startLen).trim();
    const textBefore = raw.slice(0, startIdx).trim();
    return { thinking, text: textBefore };
  }

  const thinking = raw.slice(startIdx + startLen, endIdx).trim();
  const textBefore = raw.slice(0, startIdx);
  const textAfter = raw.slice(endIdx + endLen);
  const text = (textBefore + textAfter).trim();

  return { thinking, text };
}

export function geminiAccountCapacity(tierValue: any, capabilityValue: any): { capacity: number; capacityField: number } {
  const tiers = Array.isArray(tierValue) ? tierValue : [];
  const capabilities = Array.isArray(capabilityValue) ? capabilityValue : [];

  const has = (flags: any[], want: number): boolean => {
    return flags.some((f) => (typeof f === 'number' ? f : parseInt(String(f), 10)) === want);
  };

  if (has(tiers, 21)) {
    return { capacity: 1, capacityField: 13 };
  } else if (has(tiers, 22)) {
    return { capacity: 2, capacityField: 13 };
  } else if (has(capabilities, 115)) {
    return { capacity: 4, capacityField: 12 };
  } else if (has(tiers, 16) || has(capabilities, 106)) {
    return { capacity: 3, capacityField: 12 };
  } else if (has(tiers, 8) || has(capabilities, 19)) {
    return { capacity: 2, capacityField: 12 };
  } else {
    return { capacity: 1, capacityField: 12 };
  }
}

export function geminiModelNames(modelId: string, category: string, display: string): { name: string; aliases: string[] } {
  const aliases = new Set<string>();
  const add = (v: string) => {
    const val = v.toLowerCase().trim();
    if (val) aliases.add(val);
  };

  const slug = (v: string) => {
    return v.toLowerCase().trim().replace(/[^a-z0-9.]+/g, '-').replace(/^-+|-+$/g, '');
  };

  const prefix = (v: string) => {
    return v.startsWith('gemini-') ? v : `gemini-${v}`;
  };

  add(modelId);

  for (const val of [category, display]) {
    if (!val) continue;
    add(val);
    add(slug(val));
    add(prefix(slug(val).replace(/^gemini-/, '')));
  }

  if (category) {
    const versionMatch = display.match(/\b(\d+)(?:\.\d+)?\b/);
    if (versionMatch) {
      add(`gemini-${versionMatch[0]}-${slug(category)}`);
      add(`gemini-${versionMatch[1]}-${slug(category)}`);
    }
  }

  const nameSource = display || category;
  const name = nameSource ? prefix(slug(nameSource).replace(/^gemini-/, '')) : prefix(modelId.toLowerCase());
  add(name);

  return {
    name,
    aliases: Array.from(aliases).sort(),
  };
}

function collectGeminiModelRecords(value: any, records: any[][]): void {
  if (!Array.isArray(value)) return;
  if (value.length >= 2) {
    const marker = value[0];
    const rpcId = value[1];
    if ((marker === 'wrb.fr' || marker === 'er') && rpcId === GEMINI_USER_STATUS_RPC) {
      records.push(value);
      return;
    }
  }
  for (const item of value) {
    collectGeminiModelRecords(item, records);
  }
}

export function parseGeminiModels(bodyText: string): DiscoveredModel[] {
  let cleaned = bodyText.trim();
  if (cleaned.startsWith(")]}'")) {
    cleaned = cleaned.slice(4).trim();
  }

  const records: any[][] = [];
  const lines = cleaned.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || /^\d+$/.test(trimmed)) continue;
    try {
      const parsed = JSON.parse(trimmed.replace(/^\)]\}'\s*/, ''));
      collectGeminiModelRecords(parsed, records);
    } catch {
      // ignore frame fragments
    }
  }

  if (records.length === 0) {
    try {
      const parsed = JSON.parse(cleaned);
      collectGeminiModelRecords(parsed, records);
    } catch {
      // ignore
    }
  }

  const models: DiscoveredModel[] = [];
  const seen = new Set<string>();
  const publicNames = new Set<string>();

  for (const record of records) {
    if (Array.isArray(record[5])) {
      const code = typeof record[5][0] === 'number' ? record[5][0] : parseInt(String(record[5][0]), 10);
      if (!isNaN(code) && code !== 0) {
        throw new Error(`Gemini model discovery RPC rejected the session (code ${code})`);
      }
    }

    let status: any = null;
    const rawStatusVal = record[2];
    if (typeof rawStatusVal === 'string') {
      try {
        status = JSON.parse(rawStatusVal);
      } catch {
        throw new Error('invalid Gemini user status response');
      }
    } else if (Array.isArray(rawStatusVal)) {
      status = rawStatusVal;
    } else {
      throw new Error('Gemini model discovery returned no user status');
    }

    if (!Array.isArray(status)) {
      throw new Error('invalid Gemini user status response');
    }

    const rawStatusCode = status[14];
    if (rawStatusCode !== undefined && rawStatusCode !== null) {
      const code = typeof rawStatusCode === 'number' ? rawStatusCode : parseInt(String(rawStatusCode), 10);
      if (isNaN(code)) {
        throw new Error('invalid Gemini account status');
      }
      if (code !== 1000) {
        throw new Error(`Gemini account cannot select models (status ${code}); verify access and cookies on Gemini Web`);
      }
    }

    const { capacity, capacityField } = geminiAccountCapacity(status[16], status[17]);
    const entries = Array.isArray(status[15]) ? status[15] : [];

    for (const entry of entries) {
      if (!Array.isArray(entry)) continue;
      const modelId = typeof entry[0] === 'string' ? entry[0].trim() : '';
      if (!modelId || seen.has(modelId)) continue;

      const category = (typeof entry[1] === 'string' ? entry[1] : (typeof entry[10] === 'string' ? entry[10] : '')).trim();
      const display = (typeof entry[11] === 'string' ? entry[11] : (Array.isArray(entry[19]) && typeof entry[19][1] === 'string' ? entry[19][1] : '')).trim();

      const { name, aliases } = geminiModelNames(modelId, category, display);
      let canonicalName = name;
      if (publicNames.has(canonicalName)) {
        const suffix = modelId.slice(0, 8).toLowerCase();
        canonicalName = `${canonicalName}-${suffix}`;
      }

      let rawNumber = entry[17];
      if (rawNumber === undefined || rawNumber === null) {
        rawNumber = entry[9];
      }
      let modelNumber = 1;
      if (rawNumber !== undefined && rawNumber !== null) {
        const num = typeof rawNumber === 'number' ? rawNumber : parseInt(String(rawNumber), 10);
        if (isNaN(num) || num <= 0) continue;
        modelNumber = num;
      }

      models.push({
        id: canonicalName,
        displayName: display || canonicalName,
        modelId,
        capacity,
        capacityField,
        modelNumber,
        aliases,
      });

      seen.add(modelId);
      publicNames.add(canonicalName);
    }
  }

  if (models.length === 0) {
    throw new Error('Gemini model discovery returned no available models');
  }

  return models;
}

export function parseGeminiQuotaResponse(rawBody: string): AccountQuotaInfo {
  let cleaned = rawBody.trim();
  if (cleaned.startsWith(")]}'")) {
    cleaned = cleaned.slice(4).trim();
  }

  let rawPayload: any = null;
  const lines = cleaned.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || /^\d+$/.test(trimmed)) continue;
    try {
      const parsed = JSON.parse(trimmed.replace(/^\)]\}'\s*/, ''));
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (Array.isArray(item) && item[1] === GEMINI_USAGE_INFO_RPC && item[2]) {
            rawPayload = typeof item[2] === 'string' ? JSON.parse(item[2]) : item[2];
            break;
          }
        }
      }
    } catch {
      // ignore frame fragments
    }
    if (rawPayload) break;
  }

  if (!rawPayload && cleaned) {
    try {
      const parsed = JSON.parse(cleaned);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (Array.isArray(item) && item[1] === GEMINI_USAGE_INFO_RPC && item[2]) {
            rawPayload = typeof item[2] === 'string' ? JSON.parse(item[2]) : item[2];
            break;
          }
        }
      }
    } catch {
      // ignore
    }
  }

  if (!rawPayload || !Array.isArray(rawPayload) || rawPayload.length < 2) {
    throw new Error('Invalid or missing quota data in Gemini usage response');
  }

  const limitsArray = Array.isArray(rawPayload[1]) ? rawPayload[1] : [];
  let currentUsage = 0;
  let currentResetSeconds = 0;
  let weeklyUsage = 0;
  let weeklyResetSeconds = 0;

  for (const limit of limitsArray) {
    if (!Array.isArray(limit)) continue;
    const ratio = typeof limit[1] === 'number' ? limit[1] : parseFloat(String(limit[1] || '0'));
    const percent = Math.min(100, Math.max(0, Math.round(ratio * 100)));
    const level = limit[2];
    const resetTimeSec = limit[3]?.[0]?.[0] ? Number(limit[3][0][0]) : 0;

    if (level === 1) {
      currentUsage = percent;
      currentResetSeconds = resetTimeSec;
    } else if (level === 2) {
      weeklyUsage = percent;
      weeklyResetSeconds = resetTimeSec;
    }
  }

  const formatResetTime = (sec: number, isWeekly: boolean): { iso: string; label: string } => {
    if (!sec || isNaN(sec)) {
      return { iso: '', label: 'Chưa xác định' };
    }
    const date = new Date(sec * 1000);
    const iso = date.toISOString();
    const hh = String(date.getUTCHours()).padStart(2, '0');
    const mm = String(date.getUTCMinutes()).padStart(2, '0');

    if (isWeekly) {
      const dd = date.getUTCDate();
      const month = date.getUTCMonth() + 1;
      return { iso, label: `Đặt lại vào ${dd} thg ${month} lúc ${hh}:${mm} UTC` };
    }
    return { iso, label: `Đặt lại lúc ${hh}:${mm} UTC` };
  };

  const currentFormatted = formatResetTime(currentResetSeconds, false);
  const weeklyFormatted = formatResetTime(weeklyResetSeconds, true);

  return {
    tier: 'PRO',
    current_usage_percent: currentUsage,
    current_reset_at: currentFormatted.iso,
    current_reset_label: currentFormatted.label,
    weekly_usage_percent: weeklyUsage,
    weekly_reset_at: weeklyFormatted.iso,
    weekly_reset_label: weeklyFormatted.label,
    fetched_at: new Date().toISOString(),
  };
}

export function resolveGeminiModel(requested: string, models: DiscoveredModel[]): DiscoveredModel {
  if (!models || models.length === 0) {
    throw new Error('no Gemini models available; refresh the authenticated session');
  }

  const req = requested.toLowerCase().trim();
  if (!req) {
    return models[0];
  }

  let lookup = req;
  if (lookup.endsWith('-thinking')) {
    lookup = lookup.replace(/-thinking$/, '');
  } else if (lookup.endsWith(':thinking')) {
    lookup = lookup.replace(/:thinking$/, '');
  }

  if (lookup === 'gemini-advanced') {
    lookup = 'gemini-pro';
  }

  // 1. Exact canonical name or internal modelId
  const exactMatches = models.filter(
    (m) => m.id.toLowerCase() === lookup || m.modelId.toLowerCase() === lookup
  );
  if (exactMatches.length === 1) {
    return exactMatches[0];
  }

  // 2. Alias matching
  const aliasMatches = models.filter((m) =>
    m.aliases.some((a) => a.toLowerCase() === lookup)
  );

  const combined = exactMatches.length > 0 ? exactMatches : aliasMatches;
  if (combined.length === 1) {
    return combined[0];
  }

  const available = models.map((m) => m.id).join(', ');
  if (combined.length > 1) {
    throw new Error(`ambiguous Gemini model "${requested}"; available models: ${available}`);
  }

  throw new Error(`unsupported Gemini model "${requested}"; available models: ${available}`);
}

export function buildGeminiModelHeaders(
  model: DiscoveredModel,
  requestId: string,
  generationId: string,
  thinkingMode = 1
): Record<string, string> {
  if (
    !model.modelId ||
    model.modelNumber <= 0 ||
    model.capacity <= 0 ||
    (model.capacityField !== 12 && model.capacityField !== 13)
  ) {
    throw new Error(`model '${model.id}' has incomplete Gemini routing information`);
  }

  const offset = model.capacityField - 12;
  const header: any[] = new Array(17 + offset).fill(null);
  header[0] = 1;
  header[4] = model.modelId;
  header[7] = 0;
  header[8] = [4, 5, 6, 8];
  header[model.capacityField - 1] = model.capacity;
  header[14 + offset] = model.modelNumber;
  header[15 + offset] = thinkingMode;
  header[16 + offset] = generationId;

  const requestHeader = [requestId, 1];

  return {
    [GEMINI_MODEL_HEADER_KEY]: JSON.stringify(header),
    'x-goog-ext-525005358-jspb': JSON.stringify(requestHeader),
    'x-goog-ext-73010989-jspb': '[0]',
    'x-goog-ext-73010990-jspb': '[0,0,0]',
  };
}

export interface UploadedFileRef {
  id: string; // e.g. "/contrib_service/files/..."
  name: string;
}

export function buildGenerateInner(
  prompt: string,
  modelNumber: number,
  language: string,
  requestId: string,
  isTemporary = false,
  metadata?: { cid?: string; rid?: string; rcid?: string },
  files?: UploadedFileRef[],
  thinkingMode = 1
): any[] {
  let messageContent: any[];
  if (!files || files.length === 0) {
    messageContent = [prompt];
  } else {
    const fileData = files.map((f) => [[f.id], f.name]);
    messageContent = [prompt, 0, null, fileData, null, null, 0];
  }

  const hasCid = Boolean(metadata?.cid && metadata.cid.trim());
  const defaultMetadata = [
    hasCid ? metadata!.cid!.trim() : '',
    hasCid ? (metadata?.rid || '') : '',
    hasCid ? (metadata?.rcid || '') : '',
    null,
    null,
    null,
    null,
    null,
    null,
    '',
  ];

  const inner: any[] = new Array(81).fill(null);
  inner[0] = messageContent;
  inner[1] = [language || 'en'];
  inner[2] = defaultMetadata;
  inner[6] = [1];
  inner[7] = 1;
  inner[10] = 1;
  inner[11] = 0;
  inner[17] = [[0]];
  inner[18] = 0;
  inner[27] = 1;
  inner[30] = [4];
  inner[41] = [1];
  inner[53] = 0;
  inner[59] = requestId;
  inner[61] = [];
  inner[68] = 1;
  inner[79] = modelNumber;
  inner[80] = thinkingMode;

  if (isTemporary) {
    inner[45] = 1;
  }

  return inner;
}

export function extractBardError(item: any): string | null {
  const codes: number[] = [];
  let foundError = false;

  const walk = (v: any): boolean => {
    if (Array.isArray(v)) {
      let hasErr = false;
      for (const child of v) {
        if (walk(child)) {
          hasErr = true;
        }
      }
      return hasErr;
    } else if (typeof v === 'string') {
      return v.includes('BardErrorInfo');
    } else if (typeof v === 'number') {
      codes.push(v);
      return false;
    }
    return false;
  };

  if (Array.isArray(item)) {
    for (const el of item) {
      if (walk(el)) {
        foundError = true;
        break;
      }
    }
  }

  if (foundError) {
    if (codes.includes(1003)) {
      return `Google Gemini Web returned an error (BardErrorInfo code 3 1003): Invalid or non-existent conversation ID. Upstream conversation thread was not found on Google servers. Please clear the Conversation ID or start a new chat.`;
    }
    if (codes.length > 0) {
      return `Google Gemini Web returned an error (BardErrorInfo code ${codes.join(' ')}). This usually indicates session expiration, rate limits, context window limits, or bot protection/CAPTCHA block.`;
    }
    return 'Google Gemini Web returned a BardErrorInfo block.';
  }
  return null;
}

export function extractGeneratedImages(candidate: any[]): GeneratedMedia[] {
  const images: GeneratedMedia[] = [];
  if (!Array.isArray(candidate)) return images;

  // 1. Dedicated Gemini Web generated-media candidate slot at candidate[12][7][0]
  if (candidate.length > 12 && Array.isArray(candidate[12])) {
    const candidateMedia = candidate[12];
    if (candidateMedia.length > 7 && Array.isArray(candidateMedia[7])) {
      const mediaGroups = candidateMedia[7];
      if (mediaGroups.length > 0 && Array.isArray(mediaGroups[0])) {
        const generated = mediaGroups[0];
        for (const rawImage of generated) {
          if (!Array.isArray(rawImage) || rawImage.length === 0) continue;
          const imageNode = rawImage[0];
          if (!Array.isArray(imageNode) || imageNode.length <= 3) continue;
          const metadata = imageNode[3];
          if (!Array.isArray(metadata) || metadata.length <= 3) continue;
          const imageURL = metadata[3];
          if (typeof imageURL === 'string' && imageURL.trim()) {
            const filename = typeof metadata[2] === 'string' ? metadata[2] : 'generated_image.png';
            let mimeType = 'image/png';
            let width: number | undefined;
            let height: number | undefined;
            for (const field of metadata) {
              if (typeof field === 'string' && field.startsWith('image/')) {
                mimeType = field;
              } else if (Array.isArray(field) && field.length >= 2) {
                if (typeof field[0] === 'number') width = field[0];
                if (typeof field[1] === 'number') height = field[1];
              }
            }
            images.push({
              url: imageURL.trim(),
              title: filename,
              mime_type: mimeType,
              width,
              height,
            });
          }
        }
      }
    }
  }

  // 2. Scan candidate structure for googleusercontent image URLs
  const candidateStr = JSON.stringify(candidate);
  const urlRegex = /https:\/\/[a-zA-Z0-9.\-]+\.googleusercontent\.com\/[^\s"',\])}]+/g;
  const matches = candidateStr.match(urlRegex);
  if (matches) {
    for (const match of matches) {
      const cleanUrl = match.replace(/\\u003d/g, '=').replace(/\\/g, '');
      if (!images.some((img) => img.url === cleanUrl)) {
        images.push({
          url: cleanUrl,
          title: 'generated_image.png',
          mime_type: 'image/png',
        });
      }
    }
  }

  return images;
}

export function parseGoogleWireResponse(rawBody: string): {
  text: string;
  thinking?: string;
  conversation_id?: string;
  response_id?: string;
  choice_id?: string;
  images?: GeneratedMedia[];
} {
  const cleaned = rawBody.replace(/^\)]\}'\s*/, '');
  const lines = cleaned.split('\n');

  let finalResText = '';
  let cid = '';
  let rid = '';
  let rcid = '';
  let found = false;
  let images: GeneratedMedia[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || /^\d+$/.test(trimmed)) continue;

    try {
      const root = JSON.parse(trimmed.replace(/^\)]\}'\s*/, ''));
      if (Array.isArray(root)) {
        for (const item of root) {
          if (!Array.isArray(item) || item.length < 1) continue;

          // Check for BardErrorInfo
          const errStr = extractBardError(item);
          if (errStr) {
            throw new Error(errStr);
          }

          if (item.length < 3) continue;
          const payloadStr = item[2];
          if (typeof payloadStr !== 'string') continue;

          let payload: any;
          try {
            payload = JSON.parse(payloadStr);
          } catch {
            continue;
          }

          if (Array.isArray(payload) && payload.length > 4) {
            const candidates = payload[4];
            if (Array.isArray(candidates) && candidates.length > 0) {
              const firstCandidate = candidates[0];
              if (Array.isArray(firstCandidate) && firstCandidate.length >= 2) {
                const contentParts = firstCandidate[1];
                if (Array.isArray(contentParts) && contentParts.length > 0) {
                  const resText = contentParts[0];
                  if (typeof resText === 'string') {
                    if (typeof firstCandidate[0] === 'string') {
                      rcid = firstCandidate[0];
                    }
                    if (Array.isArray(payload[1])) {
                      if (payload[1][0]) cid = payload[1][0];
                      if (payload[1][1]) rid = payload[1][1];
                    } else if (typeof payload[1] === 'string') {
                      cid = payload[1];
                    }
                    if (!rid && typeof payload[2]?.[18] === 'string') {
                      rid = payload[2][18];
                    }

                    // Extract structured generated images
                    const extracted = extractGeneratedImages(firstCandidate);
                    if (extracted.length > 0) {
                      images = extracted;
                    }

                    finalResText = resText;
                    found = true;
                  }
                }
              }
            }
          }
        }
      }
    } catch (e: any) {
      if (e.message && e.message.includes('BardErrorInfo')) {
        throw e;
      }
      // Continue parsing next line
    }
  }

  if (!found) {
    throw new Error('UPSTREAM_ERROR: Failed to parse response candidates from Gemini Web RPC (protocol envelope mismatch)');
  }

  const { thinking, text: cleanText } = extractThinkingAndText(finalResText);

  return {
    text: cleanText,
    thinking,
    conversation_id: cid || undefined,
    response_id: rid || undefined,
    choice_id: rcid || undefined,
    images: images.length > 0 ? images : undefined,
  };
}


// --------------------------------------------------------------------------
// GeminiWebProvider Implementation
// --------------------------------------------------------------------------

export class GeminiWebProvider implements AIProvider {
  private sessionCache = new Map<string, GeminiWebSession>();

  public invalidateSession(accountId: string): boolean {
    const deleted = this.sessionCache.delete(accountId);
    if (deleted) {
      console.log(`[GeminiWeb] Invalidated cached session for account ${accountId}`);
    }
    return deleted;
  }

  private getFormattedCookie(account: GeminiAccount): string {
    const raw = decryptCookie(account.encrypted_cookie, config.masterEncryptionKey);
    let cookieHeader = cleanCookie(raw);

    if (cookieHeader.startsWith('{') && cookieHeader.endsWith('}')) {
      try {
        const parsed = JSON.parse(cookieHeader);
        cookieHeader = Object.entries(parsed)
          .map(([k, v]) => `${k}=${v}`)
          .join('; ');
      } catch {
        // fallback
      }
    }
    return deduplicateCookieString(cookieHeader);
  }

  public async getOrFetchSession(account: GeminiAccount, forceRefresh = false): Promise<GeminiWebSession> {
    const cached = this.sessionCache.get(account.id);
    const now = Date.now();
    if (!forceRefresh && cached && now - cached.fetchedAt < 30 * 60 * 1000) {
      return cached;
    }

    const cookie = this.getFormattedCookie(account);
    const targetUrl = geminiAccountUrl('https://gemini.google.com/app', account.auth_user) + '?hl=en';

    const fetchStart = Date.now();
    const dispatcher = getDispatcherForProxy(account.proxy_url);
    let res = await fetchWithTimeout(targetUrl, {
      headers: {
        'User-Agent': BROWSER_USER_AGENT,
        'Cookie': cookie,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Sec-Ch-Ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Platform': '"Windows"',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1',
        'X-Same-Domain': '1',
      },
      redirect: 'manual',
      dispatcher,
    } as any);

    console.log(`[Upstream Gemini Web Handshake] account_id=${account.id} upstream_hostname=gemini.google.com upstream_path=/app upstream_status=${res.status} duration_ms=${Date.now() - fetchStart}`);

    if (res.status === 302 || res.status === 301) {
      const location = res.headers.get('location') || '';
      if (location.includes('accounts.google.com')) {
        throw new Error('SESSION_EXPIRED: Cookie redirect to accounts.google.com login');
      }
      // Follow redirect if redirected to a multi-login slot like /u/1/app
      const slotMatch = location.match(/gemini\.google\.com\/u\/(\d+)\//);
      if (slotMatch) {
        account.auth_user = slotMatch[1];
        console.log(`[Upstream Gemini Web Handshake] Following account slot redirect to /u/${account.auth_user}/...`);
        const redirectUrl = location.includes('?hl=') ? location : `${location}?hl=en`;
        res = await fetchWithTimeout(redirectUrl, {
          headers: {
            'User-Agent': BROWSER_USER_AGENT,
            'Cookie': cookie,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            'Sec-Ch-Ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
            'Sec-Ch-Ua-Mobile': '?0',
            'Sec-Ch-Ua-Platform': '"Windows"',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none',
            'Sec-Fetch-User': '?1',
            'Upgrade-Insecure-Requests': '1',
            'X-Same-Domain': '1',
          },
          redirect: 'manual',
          dispatcher,
        } as any);
      }
    }

    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        throw new Error(`SESSION_EXPIRED: Upstream returned HTTP ${res.status}`);
      }
      if (res.status === 429) {
        throw new Error(`QUOTA_EXHAUSTED: Rate limited by Google (HTTP 429)`);
      }
      throw new Error(`UPSTREAM_ERROR: Failed to load gemini.google.com with status ${res.status}`);
    }

    const html = await res.text();
    const snlm0eMatch =
      html.match(/"SNlM0e":"([^"]+)"/) ||
      html.match(/\["SNlM0e","([^"]+)"\]/) ||
      html.match(/WIZ_global_data\.SNlM0e\s*=\s*"([^"]+)"/);

    if (!snlm0eMatch || !snlm0eMatch[1]) {
      if (html.includes('Sign in - Google Accounts') || html.includes('identifierId')) {
        throw new Error('SESSION_EXPIRED: Google account login prompt encountered');
      }
      throw new Error('SESSION_EXPIRED: Could not find SNlM0e token in Gemini Web page response');
    }

    const snlm0e = snlm0eMatch[1];
    const pushMatch = html.match(/"qKIAYe":"([^"]+)"/);
    const buildMatch = html.match(/"cfb2h":"([^"]+)"/);
    const sessionMatch = html.match(/"FdrFJe":"([^"]+)"/);
    const langMatch = html.match(/"TuX5cc":"([^"]+)"/);

    const pushId = pushMatch ? pushMatch[1] : 'feeds/mcudyrk2a4khkz';
    const buildLabel = buildMatch ? buildMatch[1] : '';
    const sessionId = sessionMatch ? sessionMatch[1] : '';
    const language = langMatch ? langMatch[1] : 'en';
    const generationId = crypto.randomUUID().toUpperCase();

    // Discover models via otAQ7b RPC
    const discoveredModels = await this.fetchGeminiModels(
      account,
      snlm0e,
      cookie,
      buildLabel,
      sessionId,
      language,
      generationId
    );

    const session: GeminiWebSession = {
      snlm0e,
      pushId,
      buildLabel,
      sessionId,
      language,
      generationId,
      cookieHeader: cookie,
      discoveredModels,
      fetchedAt: now,
    };

    this.sessionCache.set(account.id, session);
    return session;
  }

  public async fetchGeminiModels(
    account: GeminiAccount,
    token: string,
    cookieHeader: string,
    buildLabel: string,
    sessionId: string,
    language: string,
    generationId: string
  ): Promise<DiscoveredModel[]> {
    const query = new URLSearchParams({
      rpcids: GEMINI_USER_STATUS_RPC,
      hl: language || 'en',
      _reqid: String(Math.floor(Math.random() * 90000) + 10000),
      rt: 'c',
      'source-path': geminiSourcePath(account.auth_user),
    });

    if (buildLabel) query.set('bl', buildLabel);
    if (sessionId) query.set('f.sid', sessionId);

    const form = new URLSearchParams({
      at: token,
      'f.req': '[[["otAQ7b","[]",null,"generic"]]]',
    });

    const batchHeader = new Array(17).fill(null);
    batchHeader[0] = 1;
    batchHeader[8] = [4, 5, 6, 8];
    batchHeader[16] = generationId;

    const targetUrl = geminiAccountUrl(
      'https://gemini.google.com/_/BardChatUi/data/batchexecute',
      account.auth_user
    ) + '?' + query.toString();

    const fetchStart = Date.now();
    const dispatcher = getDispatcherForProxy(account.proxy_url);
    const res = await fetchWithTimeout(targetUrl, {
      method: 'POST',
      headers: {
        'User-Agent': BROWSER_USER_AGENT,
        'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
        'Origin': 'https://gemini.google.com',
        'Referer': 'https://gemini.google.com/',
        'X-Same-Domain': '1',
        'Cookie': cookieHeader,
        [GEMINI_MODEL_HEADER_KEY]: JSON.stringify(batchHeader),
        'x-goog-ext-73010989-jspb': '[0]',
      },
      body: form.toString(),
      dispatcher,
    } as any);

    console.log(`[Upstream Gemini Web Discovery] account_id=${account.id} upstream_hostname=gemini.google.com upstream_path=/_/BardChatUi/data/batchexecute upstream_status=${res.status} duration_ms=${Date.now() - fetchStart}`);

    if (!res.ok) {
      throw new Error(`Gemini model discovery failed with HTTP status ${res.status}`);
    }

    const text = await res.text();
    return parseGeminiModels(text);
  }

  public async ValidateSession(account: GeminiAccount): Promise<HealthResult> {
    try {
      const session = await this.getOrFetchSession(account, true);
      const modelNames = session.discoveredModels.map((m) => m.id);

      return {
        valid: true,
        models: modelNames,
        accountStatus: 'ACTIVE',
      };
    } catch (err: any) {
      const msg = redactString(err.message || String(err));
      let status: any = 'ERROR';
      if (msg.includes('SESSION_EXPIRED')) status = 'SESSION_EXPIRED';
      else if (msg.includes('QUOTA_EXHAUSTED')) status = 'QUOTA_EXHAUSTED';

      return {
        valid: false,
        error: msg,
        accountStatus: status,
      };
    }
  }

  public async fetchAccountQuota(account: GeminiAccount): Promise<AccountQuotaInfo> {
    const session = await this.getOrFetchSession(account);

    const query = new URLSearchParams({
      rpcids: GEMINI_USAGE_INFO_RPC,
      hl: session.language || 'vi',
      _reqid: String(Math.floor(Math.random() * 90000) + 10000),
      rt: 'c',
      'source-path': geminiSourcePath(account.auth_user),
    });

    if (session.buildLabel) query.set('bl', session.buildLabel);
    if (session.sessionId) query.set('f.sid', session.sessionId);

    const form = new URLSearchParams();
    form.append('at', session.snlm0e);
    form.append('f.req', `[[["${GEMINI_USAGE_INFO_RPC}","[]",null,"generic"]]]`);

    const targetUrl = geminiAccountUrl(
      'https://gemini.google.com/_/BardChatUi/data/batchexecute',
      account.auth_user
    ) + '?' + query.toString();

    const fetchStart = Date.now();
    const dispatcher = getDispatcherForProxy(account.proxy_url);
    const res = await fetchWithTimeout(targetUrl, {
      method: 'POST',
      headers: {
        'User-Agent': BROWSER_USER_AGENT,
        'Cookie': session.cookieHeader,
        'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
        'Origin': 'https://gemini.google.com',
        'Referer': 'https://gemini.google.com/',
        'X-Same-Domain': '1',
      },
      body: form.toString(),
      dispatcher,
    } as any);

    console.log(`[Upstream Gemini Web Quota] account_id=${account.id} upstream_hostname=gemini.google.com upstream_path=/_/BardChatUi/data/batchexecute upstream_status=${res.status} duration_ms=${Date.now() - fetchStart}`);

    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        this.sessionCache.delete(account.id);
        throw new Error(`SESSION_EXPIRED: Upstream returned HTTP ${res.status}`);
      }
      throw new Error(`Failed to fetch Gemini account quota with HTTP status ${res.status}`);
    }

    const text = await res.text();
    return parseGeminiQuotaResponse(text);
  }

  public async ListModels(account: GeminiAccount): Promise<string[]> {
    if (account.supported_models && account.supported_models.length > 0) {
      return account.supported_models;
    }
    const cached = this.sessionCache.get(account.id);
    if (cached && cached.discoveredModels.length > 0) {
      return cached.discoveredModels.map((m) => m.id);
    }
    return [];
  }

  public parseDataUrl(url: string, defaultName: string): { name: string; mimeType: string; data: Buffer } | null {
    if (!url.startsWith('data:')) return null;
    const match = url.match(/^data:([^;]+);base64,(.*)$/);
    if (!match) return null;
    const mimeType = match[1];
    const base64Data = match[2];
    const buffer = Buffer.from(base64Data, 'base64');
    let ext = '.bin';
    if (mimeType.includes('png')) ext = '.png';
    else if (mimeType.includes('jpeg') || mimeType.includes('jpg')) ext = '.jpg';
    else if (mimeType.includes('webp')) ext = '.webp';
    else if (mimeType.includes('gif')) ext = '.gif';
    else if (mimeType.includes('pdf')) ext = '.pdf';
    else if (mimeType.includes('csv')) ext = '.csv';
    else if (mimeType.includes('plain')) ext = '.txt';

    const filename = defaultName.includes('.') ? defaultName : `${defaultName}${ext}`;
    return { name: filename, mimeType, data: buffer };
  }

  public buildPromptAndAttachments(
    messages: ChatCompletionRequest['messages'],
    hasNativeConversation = false
  ): {
    prompt: string;
    systemPrompt?: string;
    attachments: Array<{ name: string; mimeType: string; data: Buffer }>;
  } {
    let systemPrompt = '';
    const attachments: Array<{ name: string; mimeType: string; data: Buffer }> = [];

    // Extract system instructions across messages
    for (const msg of messages) {
      if (msg.role === 'system') {
        const text = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
        systemPrompt += (systemPrompt ? '\n' : '') + text;
      }
    }

    // Determine target messages:
    // If native conversation exists (valid upstream cid/rid/rcid), ONLY send the latest user turn.
    // Otherwise, replay full conversation history to establish context.
    let targetMessages = messages;
    if (hasNativeConversation) {
      const lastUserIndex = messages.map((m) => m.role).lastIndexOf('user');
      if (lastUserIndex !== -1) {
        targetMessages = [messages[lastUserIndex]];
      } else {
        const nonSystem = messages.filter((m) => m.role !== 'system');
        targetMessages = nonSystem.slice(-1);
      }
    }

    const promptParts: string[] = [];

    for (let i = 0; i < targetMessages.length; i++) {
      const msg = targetMessages[i];
      let textContent = '';

      if (typeof msg.content === 'string') {
        textContent = msg.content;
      } else if (Array.isArray(msg.content)) {
        for (let j = 0; j < msg.content.length; j++) {
          const part: any = msg.content[j];
          if (!part) continue;
          if (part.type === 'text' && typeof part.text === 'string') {
            textContent += (textContent ? '\n' : '') + part.text;
          } else if (part.type === 'image_url' && part.image_url?.url) {
            const parsed = this.parseDataUrl(part.image_url.url, `attachment_${i}_${j}`);
            if (parsed) attachments.push(parsed);
          } else if (part.type === 'file_url' && part.file_url?.url) {
            const parsed = this.parseDataUrl(part.file_url.url, part.file_url.name || `attachment_${i}_${j}`);
            if (parsed) attachments.push(parsed);
          } else if (part.type === 'file' && part.file) {
            if (part.file.data) {
              const buffer = Buffer.from(part.file.data, 'base64');
              attachments.push({
                name: part.file.name || `attachment_${i}_${j}`,
                mimeType: part.file.mime_type || 'application/octet-stream',
                data: buffer,
              });
            }
          }
        }
      }

      if (msg.role === 'system') {
        continue;
      } else if (msg.role === 'user') {
        if (hasNativeConversation) {
          promptParts.push(textContent);
        } else {
          promptParts.push(`User: ${textContent}`);
        }
      } else if (msg.role === 'assistant') {
        promptParts.push(`Assistant: ${textContent}`);
      }
    }

    let finalPrompt = promptParts.join('\n\n');
    if (systemPrompt) {
      finalPrompt = `[System Instructions]\n${systemPrompt}\n\n${finalPrompt}`;
    }

    return { prompt: finalPrompt, systemPrompt, attachments };
  }

  public async uploadFile(
    account: GeminiAccount,
    filename: string,
    mimeType: string,
    data: Buffer,
    signal?: AbortSignal,
    deadline?: number
  ): Promise<UploadedFileRef> {
    const opDeadline = deadline ?? (Date.now() + (config.requestTimeout || 60000));
    const session = await this.getOrFetchSession(account);
    const sanitizedFilename = filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100);

    const startHeaders: Record<string, string> = {
      'Accept': '*/*',
      'Authorization': 'Basic c2F2ZXM6cyNMdGhlNmxzd2F2b0RsN3J1d1U=',
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      'Origin': 'https://gemini.google.com',
      'Referer': 'https://gemini.google.com/',
      'Push-ID': session.pushId || 'feeds/mcudyrk2a4khkz',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(data.length),
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Tenant-Id': 'bard-storage',
      'User-Agent': BROWSER_USER_AGENT,
      'Size': String(data.length),
      'Cookie': session.cookieHeader,
    };

    const uploadStart = Date.now();
    const dispatcher = getDispatcherForProxy(account.proxy_url);
    // 1. OPTIONS request
    await fetchWithTimeout('https://content-push.googleapis.com/upload', {
      method: 'OPTIONS',
      headers: startHeaders,
      dispatcher,
    } as any, getRemainingTimeout(opDeadline, 'Upload options 1'), signal).catch(() => {});

    // 2. POST start
    const startRes = await fetchWithTimeout('https://content-push.googleapis.com/upload', {
      method: 'POST',
      headers: startHeaders,
      body: 'File name: ' + sanitizedFilename,
      dispatcher,
    } as any, getRemainingTimeout(opDeadline, 'Upload start'), signal);

    if (!startRes.ok) {
      throw new Error(`Upstream upload initialization failed: HTTP ${startRes.status}`);
    }

    const uploadUrl = startRes.headers.get('x-goog-upload-url');
    if (!uploadUrl) {
      throw new Error('Upstream upload initialization failed: missing X-Goog-Upload-Url header');
    }

    // 3. OPTIONS to uploadUrl
    await fetchWithTimeout(uploadUrl, {
      method: 'OPTIONS',
      headers: startHeaders,
      dispatcher,
    } as any, getRemainingTimeout(opDeadline, 'Upload options 2'), signal).catch(() => {});

    // 4. POST file bytes & finalize
    const uploadRes = await fetchWithTimeout(uploadUrl, {
      method: 'POST',
      headers: {
        'Accept': '*/*',
        'Authorization': 'Basic c2F2ZXM6cyNMdGhlNmxzd2F2b0RsN3J1d1U=',
        'Content-Type': mimeType || 'application/octet-stream',
        'Origin': 'https://gemini.google.com',
        'Referer': 'https://gemini.google.com/',
        'Push-ID': session.pushId || 'feeds/mcudyrk2a4khkz',
        'X-Goog-Upload-Command': 'upload, finalize',
        'X-Goog-Upload-Offset': '0',
        'X-Tenant-Id': 'bard-storage',
        'User-Agent': BROWSER_USER_AGENT,
        'Cookie': session.cookieHeader,
      },
      body: new Uint8Array(data),
      dispatcher,
    } as any, getRemainingTimeout(opDeadline, 'Upload bytes'), signal);

    if (!uploadRes.ok) {
      throw new Error(`Upstream file upload failed: HTTP ${uploadRes.status}`);
    }

    const fileId = (await readBodyWithTimeout(uploadRes, getRemainingTimeout(opDeadline, 'Upload file ID read'), signal)).trim();
    if (!fileId) {
      throw new Error('Upstream file upload returned empty file ID');
    }

    console.log(`[Upstream Gemini Web Upload] account_id=${account.id} upstream_hostname=content-push.googleapis.com upstream_path=/upload file_name="${sanitizedFilename}" file_id="${fileId}" duration_ms=${Date.now() - uploadStart}`);

    return { id: fileId, name: sanitizedFilename };
  }

  public async downloadGeneratedImage(
    account: GeminiAccount,
    rawUrl: string,
    targetSize = 2048,
    signal?: AbortSignal,
    deadline?: number
  ): Promise<{ data: Buffer; mimeType: string }> {
    const opDeadline = deadline ?? (Date.now() + (config.requestTimeout || 60000));
    const session = await this.getOrFetchSession(account);
    let imageUrl = rawUrl;
    if (!imageUrl.includes('=s') && !imageUrl.includes('=w')) {
      imageUrl = imageUrl.replace(/(\?|#|$)/, `=s${targetSize}$1`);
    }

    const dispatcher = getDispatcherForProxy(account.proxy_url);
    let res = await fetchWithTimeout(imageUrl, {
      headers: {
        'User-Agent': BROWSER_USER_AGENT,
        'Referer': 'https://gemini.google.com/',
        'Cookie': session.cookieHeader,
      },
      dispatcher,
    } as any, getRemainingTimeout(opDeadline, 'Image download headers'), signal);

    if (!res.ok && (res.status === 403 || res.status === 401)) {
      // Retry without Cookie header as Google User Content CDN often rejects session cookies
      res = await fetchWithTimeout(imageUrl, {
        headers: {
          'User-Agent': BROWSER_USER_AGENT,
          'Referer': 'https://gemini.google.com/',
        },
        dispatcher,
      } as any, getRemainingTimeout(opDeadline, 'Image download retry headers'), signal);
    }

    if (!res.ok) {
      throw new Error(`Failed to download generated image: HTTP ${res.status}`);
    }

    const mimeType = res.headers.get('content-type') || 'image/png';
    const arrayBuffer = await readBufferWithTimeout(res, getRemainingTimeout(opDeadline, 'Image download read buffer'), signal);
    return { data: Buffer.from(arrayBuffer), mimeType };
  }

  public getModelCapabilities(modelId: string): ModelCapabilities {
    const id = modelId.toLowerCase();
    const isPro = id.includes('pro');
    const isFlash = id.includes('flash');
    const isThinking = id.includes('thinking') || isPro;

    return {
      text: true,
      vision: true,
      files: true,
      thinking: isThinking,
      image_generation: isPro || isFlash,
      video_generation: false, // Standard Gemini Web does not expose video generation
    };
  }

  private async executeRpc(
    account: GeminiAccount,
    request: ChatCompletionRequest,
    signal?: AbortSignal,
    deadline?: number
  ): Promise<{ res: Response; model: DiscoveredModel; images?: GeneratedMedia[] }> {
    const session = await this.getOrFetchSession(account);
    const resolvedModel = resolveGeminiModel(request.model, session.discoveredModels);

    // Pass native Gemini conversation state only when full turn metadata (cid, rid, rcid) is available
    const hasNativeConversation = hasUsableNativeConversationState(request);
    const rawCid = (request.upstream_cid || request.conversation_id || '').trim();
    const nativeCid = rawCid.startsWith('c_') ? rawCid : undefined;

    let { prompt, attachments } = this.buildPromptAndAttachments(request.messages, hasNativeConversation);

    const isTemporary = false;
    const metadata = hasNativeConversation
      ? {
          cid: nativeCid,
          rid: request.upstream_rid,
          rcid: request.upstream_rcid,
        }
      : undefined;

    // Attach uploaded files if present in request
    let uploadedFiles: UploadedFileRef[] | undefined;
    if (request.uploaded_files && request.uploaded_files.length > 0) {
      uploadedFiles = request.uploaded_files.map((f) => ({
        id: f.id,
        name: f.name || 'file',
      }));
    }

    const requestId = `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

    const wantsThinking =
      request.thinking === true ||
      request.model.toLowerCase().includes('thinking') ||
      (Boolean(request.reasoning_effort) && request.reasoning_effort !== 'none');
    const thinkingMode = wantsThinking ? 2 : 1;

    // Support OpenAI response_format json_object if requested
    if (request.response_format?.type === 'json_object') {
      prompt += '\n\nIMPORTANT: Respond ONLY with valid JSON. Do not include markdown formatting or explanations.';
    }

    const uploadedFilesList: UploadedFileRef[] = uploadedFiles ? [...uploadedFiles] : [];

    // Upload inline attachments upstream
    for (const att of attachments) {
      const uploaded = await this.uploadFile(account, att.name, att.mimeType, att.data);
      uploadedFilesList.push(uploaded);
    }

    const innerReq = buildGenerateInner(
      prompt,
      resolvedModel.modelNumber,
      session.language || 'en',
      requestId,
      isTemporary,
      metadata,
      uploadedFilesList,
      thinkingMode
    );

    const fReq = JSON.stringify([null, JSON.stringify(innerReq)]);
    const modelHeaders = buildGeminiModelHeaders(resolvedModel, requestId, session.generationId, thinkingMode);

    const query = new URLSearchParams({
      at: session.snlm0e,
      hl: session.language || 'en',
      _reqid: String(Math.floor(Math.random() * 90000) + 10000),
      rt: 'c',
    });
    if (session.buildLabel) {
      query.set('bl', session.buildLabel);
    }
    if (session.sessionId) {
      query.set('f.sid', session.sessionId);
    }

    const rpcUrl = geminiAccountUrl(
      'https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate',
      account.auth_user
    ) + '?' + query.toString();

    const bodyParams = new URLSearchParams();
    bodyParams.append('at', session.snlm0e);
    bodyParams.append('f.req', fReq);

    const headers: Record<string, string> = {
      'User-Agent': BROWSER_USER_AGENT,
      'Cookie': session.cookieHeader,
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      'Origin': 'https://gemini.google.com',
      'Referer': 'https://gemini.google.com/',
      'X-Same-Domain': '1',
      ...modelHeaders,
    };

    const fetchStart = Date.now();
    const dispatcher = getDispatcherForProxy(account.proxy_url);
    const opDeadline = deadline ?? (Date.now() + (config.requestTimeout || 60000));
    const remaining = getRemainingTimeout(opDeadline, 'RPC headers fetch');
    const res = await fetchWithTimeout(
      rpcUrl,
      {
        method: 'POST',
        headers,
        body: bodyParams.toString(),
        dispatcher,
      } as any,
      remaining,
      signal
    );

    console.log(`[Upstream Gemini Web RPC] request_id=${requestId} account_id=${account.id} upstream_hostname=gemini.google.com upstream_path=/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate upstream_status=${res.status} duration_ms=${Date.now() - fetchStart}`);

    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        this.sessionCache.delete(account.id);
        throw new Error(`SESSION_EXPIRED: Upstream RPC returned HTTP ${res.status}`);
      }
      if (res.status === 429) {
        throw new Error(`QUOTA_EXHAUSTED: Upstream rate limit reached (HTTP 429)`);
      }
      throw new Error(`UPSTREAM_ERROR: Gemini Web RPC failed with status ${res.status}`);
    }

    return { res, model: resolvedModel };
  }

  public async ChatCompletion(
    account: GeminiAccount,
    request: ChatCompletionRequest,
    signal?: AbortSignal,
    deadline?: number
  ): Promise<AIProviderResult> {
    const opDeadline = deadline ?? (Date.now() + (config.requestTimeout || 60000));
    const { res } = await this.executeRpc(account, request, signal, opDeadline);
    const remaining = getRemainingTimeout(opDeadline, 'Response body read');
    const textBody = await readBodyWithTimeout(res, remaining, signal);
    const parsed = parseGoogleWireResponse(textBody);

    let text = parsed.text;

    // Apply stop sequences
    if (request.stop) {
      const stopList = (Array.isArray(request.stop) ? request.stop : [request.stop]).filter(Boolean);
      for (const stopSeq of stopList) {
        const idx = text.indexOf(stopSeq);
        if (idx !== -1) {
          text = text.slice(0, idx);
        }
      }
    }

    // Apply max_tokens
    if (request.max_tokens && request.max_tokens > 0) {
      const maxChars = request.max_tokens * 4;
      if (text.length > maxChars) {
        text = text.slice(0, maxChars);
      }
    }

    const promptText = request.messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join(' ');
    const promptTokens = Math.max(1, Math.round(promptText.length / 4));
    const completionTokens = Math.max(1, Math.round(text.length / 4));

    return {
      text,
      reasoning_content: parsed.thinking,
      conversation_id: parsed.conversation_id,
      response_id: parsed.response_id,
      choice_id: parsed.choice_id,
      images: parsed.images,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
    };
  }

  public async *ChatCompletionStream(
    account: GeminiAccount,
    request: ChatCompletionRequest,
    signal?: AbortSignal,
    deadline?: number
  ): AsyncIterable<AIStreamChunk> {
    const streamStart = performance.now();
    const opDeadline = deadline ?? (Date.now() + (config.requestTimeout || 60000));
    const { res } = await this.executeRpc(account, request, signal, opDeadline);

    if (!res.body) {
      throw new Error('UPSTREAM_ERROR: Gemini Web response has no readable body stream');
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');

    let lineBuffer = '';
    let emittedText = '';
    let emittedThinking = '';
    let convId: string | undefined;
    let respId: string | undefined;
    let choiceId: string | undefined;
    let capturedImages: GeneratedMedia[] = [];
    let upstreamFirstChunkTs: number | null = null;
    let downstreamFirstChunkTs: number | null = null;

    let hitStop = false;
    let stopList: string[] = [];
    if (request.stop) {
      stopList = (Array.isArray(request.stop) ? request.stop : [request.stop]).filter(Boolean);
    }

    try {
      while (true) {
        if (signal?.aborted) {
          await reader.cancel().catch(() => {});
          throw new Error('CLIENT_ABORT: Request cancelled by client');
        }
        if (Date.now() >= opDeadline) {
          await reader.cancel().catch(() => {});
          throw new Error('UPSTREAM_TIMEOUT: Upstream streaming deadline exceeded');
        }
        if (hitStop) {
          await reader.cancel().catch(() => {});
          break;
        }

        const remainingMs = opDeadline - Date.now();
        if (remainingMs <= 0) {
          await reader.cancel().catch(() => {});
          throw new Error('UPSTREAM_TIMEOUT: Upstream streaming deadline exceeded');
        }

        let readTimer: NodeJS.Timeout | null = null;
        let onClientAbort: (() => void) | null = null;

        const readTimeoutPromise = new Promise<never>((_, reject) => {
          readTimer = setTimeout(() => {
            reject(new Error('UPSTREAM_TIMEOUT: Upstream streaming chunk read timed out'));
          }, remainingMs);
        });

        const abortPromise = new Promise<never>((_, reject) => {
          if (signal) {
            onClientAbort = () => {
              reject(new Error('CLIENT_ABORT: Request cancelled by client'));
            };
            signal.addEventListener('abort', onClientAbort, { once: true });
          }
        });

        let chunkRead;
        try {
          chunkRead = await Promise.race([reader.read(), readTimeoutPromise, abortPromise]);
        } catch (err: any) {
          await reader.cancel().catch(() => {});
          if (signal?.aborted) {
            throw new Error('CLIENT_ABORT: Request cancelled by client');
          }
          throw err;
        } finally {
          if (readTimer) clearTimeout(readTimer);
          if (signal && onClientAbort) {
            signal.removeEventListener('abort', onClientAbort);
          }
        }

        const { done, value } = chunkRead;

        if (value) {
          if (upstreamFirstChunkTs === null) {
            upstreamFirstChunkTs = performance.now();
            console.log(`[Stream Timing] Upstream first chunk received at ${(upstreamFirstChunkTs - streamStart).toFixed(2)}ms`);
          }

          lineBuffer += decoder.decode(value, { stream: true });
          const lines = lineBuffer.split('\n');
          lineBuffer = lines.pop() || ''; // Keep incomplete trailing fragment

          for (const line of lines) {
            if (hitStop) break;
            const trimmed = line.trim();
            if (!trimmed || /^\d+$/.test(trimmed)) continue;

            try {
              const root = JSON.parse(trimmed.replace(/^\)]\}'\s*/, ''));
              if (Array.isArray(root)) {
                for (const item of root) {
                  if (hitStop) break;
                  if (!Array.isArray(item) || item.length < 1) continue;

                  const errStr = extractBardError(item);
                  if (errStr) throw new Error(errStr);

                  if (item.length < 3) continue;
                  const payloadStr = item[2];
                  if (typeof payloadStr !== 'string') continue;

                  let payload: any;
                  try {
                    payload = JSON.parse(payloadStr);
                  } catch {
                    continue;
                  }

                  if (Array.isArray(payload) && payload.length > 4) {
                    const candidates = payload[4];
                    if (Array.isArray(candidates) && candidates.length > 0) {
                      const firstCandidate = candidates[0];
                      if (Array.isArray(firstCandidate) && firstCandidate.length >= 2) {
                        const contentParts = firstCandidate[1];
                        if (Array.isArray(contentParts) && contentParts.length > 0) {
                          const rawCandidateText = contentParts[0];
                          if (typeof rawCandidateText === 'string') {
                            if (typeof firstCandidate[0] === 'string') {
                              choiceId = firstCandidate[0];
                            }
                            if (Array.isArray(payload[1])) {
                              if (payload[1][0]) convId = payload[1][0];
                              if (payload[1][1]) respId = payload[1][1];
                            } else if (typeof payload[1] === 'string') {
                              convId = payload[1];
                            }
                            if (!respId && typeof payload[2]?.[18] === 'string') {
                              respId = payload[2][18];
                            }

                            // Extract structured generated images
                            const extracted = extractGeneratedImages(firstCandidate);
                            if (extracted.length > 0) {
                              capturedImages = extracted;
                            }

                            const { thinking, text } = extractThinkingAndText(rawCandidateText);

                            // Yield reasoning delta if any
                            if (thinking && thinking.length > emittedThinking.length) {
                              const delta = thinking.slice(emittedThinking.length);
                              emittedThinking = thinking;

                              if (downstreamFirstChunkTs === null) {
                                downstreamFirstChunkTs = performance.now();
                                console.log(`[Stream Timing] Downstream first SSE write (thought) at ${(downstreamFirstChunkTs - streamStart).toFixed(2)}ms`);
                              }

                              yield {
                                text_delta: '',
                                reasoning_delta: delta,
                                is_done: false,
                                conversation_id: convId,
                                response_id: respId,
                                choice_id: choiceId,
                              };
                            }

                            // Yield text delta if any
                            if (text && text.length > emittedText.length && !hitStop) {
                              let delta = text.slice(emittedText.length);
                              let newTotal = emittedText + delta;

                              // Check stop sequences
                              for (const stopSeq of stopList) {
                                const stopIdx = newTotal.indexOf(stopSeq);
                                if (stopIdx !== -1) {
                                  hitStop = true;
                                  const allowedLen = Math.max(0, stopIdx - emittedText.length);
                                  delta = delta.slice(0, allowedLen);
                                  newTotal = emittedText + delta;
                                  break;
                                }
                              }

                              // Check max_tokens
                              if (request.max_tokens && request.max_tokens > 0) {
                                const maxChars = request.max_tokens * 4;
                                if (newTotal.length >= maxChars) {
                                  hitStop = true;
                                  const allowedLen = Math.max(0, maxChars - emittedText.length);
                                  delta = delta.slice(0, allowedLen);
                                  newTotal = emittedText + delta;
                                }
                              }

                              emittedText = newTotal;

                              if (delta) {
                                if (downstreamFirstChunkTs === null) {
                                  downstreamFirstChunkTs = performance.now();
                                  console.log(`[Stream Timing] Downstream first SSE write at ${(downstreamFirstChunkTs - streamStart).toFixed(2)}ms`);
                                }

                                yield {
                                  text_delta: delta,
                                  is_done: false,
                                  conversation_id: convId,
                                  response_id: respId,
                                  choice_id: choiceId,
                                };
                              }

                              if (hitStop) {
                                await reader.cancel().catch(() => {});
                                break;
                              }
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            } catch (e: any) {
              if (e.message && e.message.includes('BardErrorInfo')) throw e;
              // Ignore partial frame parse errors
            }
          }
        }

        if (done || hitStop) {
          const upstreamCompletionTs = performance.now();
          console.log(`[Stream Timing] Upstream stream completed at ${(upstreamCompletionTs - streamStart).toFixed(2)}ms`);
          if (downstreamFirstChunkTs !== null) {
            console.log(`[Stream Timing Proof] downstreamFirstChunk (${(downstreamFirstChunkTs - streamStart).toFixed(2)}ms) < upstreamCompletion (${(upstreamCompletionTs - streamStart).toFixed(2)}ms): ${downstreamFirstChunkTs < upstreamCompletionTs ? 'PASS (True incremental stream)' : 'FAIL'}`);
          }
          break;
        }
      }
    } finally {
      reader.releaseLock();
    }

    // Final completion chunk
    yield {
      text_delta: '',
      is_done: true,
      conversation_id: convId,
      response_id: respId,
      choice_id: choiceId,
      images: capturedImages.length > 0 ? capturedImages : undefined,
    };
  }

  public async fetchRecentConversations(account: GeminiAccount, limit = 10, deadline?: number): Promise<UpstreamConversation[]> {
    const opDeadline = deadline ?? (Date.now() + (config.requestTimeout || 60000));
    const session = await this.getOrFetchSession(account);

    const query = new URLSearchParams({
      rpcids: 'MaZiqc',
      hl: session.language || 'vi',
      _reqid: String(Math.floor(Math.random() * 90000) + 10000),
      rt: 'c',
      'source-path': geminiSourcePath(account.auth_user),
    });

    if (session.buildLabel) query.set('bl', session.buildLabel);
    if (session.sessionId) query.set('f.sid', session.sessionId);

    const reqPayload = JSON.stringify([limit, null, [0, null, 1]]);
    const form = new URLSearchParams({
      at: session.snlm0e,
      'f.req': JSON.stringify([[["MaZiqc", reqPayload, null, "generic"]]]),
    });

    const targetUrl = geminiAccountUrl(
      'https://gemini.google.com/_/BardChatUi/data/batchexecute',
      account.auth_user
    ) + '?' + query.toString();

    const fetchStart = Date.now();
    const dispatcher = getDispatcherForProxy(account.proxy_url);
    const res = await fetchWithTimeout(targetUrl, {
      method: 'POST',
      headers: {
        'User-Agent': BROWSER_USER_AGENT,
        'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
        'Origin': 'https://gemini.google.com',
        'Referer': 'https://gemini.google.com/',
        'X-Same-Domain': '1',
        'Cookie': session.cookieHeader,
      },
      body: form.toString(),
      dispatcher,
    } as any, getRemainingTimeout(opDeadline, 'Recent conversations headers'));

    console.log(`[Upstream Gemini Web ListConversations] account_id=${account.id} upstream_hostname=gemini.google.com upstream_path=/_/BardChatUi/data/batchexecute upstream_status=${res.status} duration_ms=${Date.now() - fetchStart}`);

    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        this.sessionCache.delete(account.id);
        throw new Error(`SESSION_EXPIRED: Upstream returned HTTP ${res.status}`);
      }
      throw new Error(`Failed to fetch recent conversations: HTTP ${res.status}`);
    }

    const text = await readBodyWithTimeout(res, getRemainingTimeout(opDeadline, 'Recent conversations body'));
    return parseGeminiRecentConversations(text);
  }

  public async fetchConversationHistory(
    account: GeminiAccount,
    conversationId: string,
    deadline?: number
  ): Promise<{ turns: UpstreamChatTurn[]; lastRid?: string; lastRcid?: string }> {
    const opDeadline = deadline ?? (Date.now() + (config.requestTimeout || 60000));
    const session = await this.getOrFetchSession(account);

    const query = new URLSearchParams({
      rpcids: 'hNvQHb',
      hl: session.language || 'vi',
      _reqid: String(Math.floor(Math.random() * 90000) + 10000),
      rt: 'c',
      'source-path': geminiSourcePath(account.auth_user),
    });

    if (session.buildLabel) query.set('bl', session.buildLabel);
    if (session.sessionId) query.set('f.sid', session.sessionId);

    const reqPayload = JSON.stringify([conversationId, 25, null, 1]);
    const form = new URLSearchParams({
      at: session.snlm0e,
      'f.req': JSON.stringify([[["hNvQHb", reqPayload, null, "generic"]]]),
    });

    const targetUrl = geminiAccountUrl(
      'https://gemini.google.com/_/BardChatUi/data/batchexecute',
      account.auth_user
    ) + '?' + query.toString();

    const fetchStart = Date.now();
    const dispatcher = getDispatcherForProxy(account.proxy_url);
    const res = await fetchWithTimeout(targetUrl, {
      method: 'POST',
      headers: {
        'User-Agent': BROWSER_USER_AGENT,
        'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
        'Origin': 'https://gemini.google.com',
        'Referer': 'https://gemini.google.com/',
        'X-Same-Domain': '1',
        'Cookie': session.cookieHeader,
      },
      body: form.toString(),
      dispatcher,
    } as any, getRemainingTimeout(opDeadline, 'Conversation history headers'));

    console.log(`[Upstream Gemini Web ReadConversation] account_id=${account.id} upstream_hostname=gemini.google.com upstream_path=/_/BardChatUi/data/batchexecute upstream_status=${res.status} duration_ms=${Date.now() - fetchStart}`);

    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        this.sessionCache.delete(account.id);
        throw new Error(`SESSION_EXPIRED: Upstream returned HTTP ${res.status}`);
      }
      throw new Error(`Failed to fetch conversation history: HTTP ${res.status}`);
    }

    const text = await readBodyWithTimeout(res, getRemainingTimeout(opDeadline, 'Conversation history body'));
    return parseGeminiConversationHistory(text);
  }
}

export function parseGeminiRecentConversations(bodyText: string): UpstreamConversation[] {
  let cleaned = bodyText.trim();
  if (cleaned.startsWith(")]}'")) {
    cleaned = cleaned.slice(4).trim();
  }

  const results: UpstreamConversation[] = [];
  const lines = cleaned.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || /^\d+$/.test(trimmed)) continue;
    try {
      const parsed = JSON.parse(trimmed.replace(/^\)]\}'\s*/, ''));
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (Array.isArray(item) && item[1] === 'MaZiqc' && item[2]) {
            const data = typeof item[2] === 'string' ? JSON.parse(item[2]) : item[2];
            if (Array.isArray(data) && Array.isArray(data[2])) {
              for (const conv of data[2]) {
                if (Array.isArray(conv) && conv.length >= 2) {
                  const id = conv[0]; // e.g. "c_c73b1db28bf040bd"
                  const title = typeof conv[1] === 'string' ? conv[1] : 'Cuộc trò chuyện mới';
                  let timestampSeconds = 0;
                  if (Array.isArray(conv[5]) && typeof conv[5][0] === 'number') {
                    timestampSeconds = conv[5][0];
                  }
                  const choiceId = typeof conv[21] === 'string' ? conv[21] : undefined;
                  const updatedAt = timestampSeconds
                    ? new Date(timestampSeconds * 1000).toISOString()
                    : new Date().toISOString();

                  results.push({
                    id,
                    title,
                    updated_at: updatedAt,
                    timestamp_seconds: timestampSeconds,
                    choice_id: choiceId,
                  });
                }
              }
            }
          }
        }
      }
    } catch {}
  }

  return results;
}

export function parseGeminiConversationHistory(bodyText: string): {
  turns: UpstreamChatTurn[];
  lastRid?: string;
  lastRcid?: string;
} {
  let cleaned = bodyText.trim();
  if (cleaned.startsWith(")]}'")) {
    cleaned = cleaned.slice(4).trim();
  }

  const turns: UpstreamChatTurn[] = [];
  let lastRid: string | undefined;
  let lastRcid: string | undefined;
  const lines = cleaned.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || /^\d+$/.test(trimmed)) continue;
    try {
      const parsed = JSON.parse(trimmed.replace(/^\)]\}'\s*/, ''));
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (Array.isArray(item) && item[1] === 'hNvQHb' && item[2]) {
            const data = typeof item[2] === 'string' ? JSON.parse(item[2]) : item[2];
            if (Array.isArray(data) && Array.isArray(data[0])) {
              const rawItems = data[0]; // List of messages ordered newest to oldest
              if (rawItems.length > 0) {
                const newest = rawItems[0];
                if (Array.isArray(newest[0]) && newest[0][1]) {
                  lastRid = newest[0][1];
                }
                if (Array.isArray(newest[3]) && newest[3][0]?.[0]?.[0]) {
                  lastRcid = newest[3][0][0][0];
                } else if (typeof newest[3]?.[3] === 'string') {
                  lastRcid = newest[3][3];
                }
              }

              // Reverse to make chronological (oldest to newest)
              const chronological = [...rawItems].reverse();
              for (const turnItem of chronological) {
                if (!Array.isArray(turnItem)) continue;

                // 1. User turn
                let userText = '';
                if (Array.isArray(turnItem[2]) && Array.isArray(turnItem[2][0])) {
                  const rawUserText = turnItem[2][0][0] || '';
                  userText = typeof rawUserText === 'string' ? rawUserText.replace(/^User:\s*/i, '') : '';
                }

                if (userText) {
                  turns.push({
                    role: 'user',
                    content: userText,
                  });
                }

                // 2. Assistant turn
                let asstText = '';
                let asstReasoning = '';
                let asstChoiceId: string | undefined;
                let asstRespId: string | undefined;

                if (Array.isArray(turnItem[0]) && turnItem[0][1]) {
                  asstRespId = turnItem[0][1];
                }

                if (Array.isArray(turnItem[3]) && Array.isArray(turnItem[3][0])) {
                  const candNode = turnItem[3][0][0];
                  if (Array.isArray(candNode)) {
                    asstChoiceId = candNode[0];
                    const rawContent = candNode[1]?.[0] || '';
                    if (typeof rawContent === 'string') {
                      const extracted = extractThinkingAndText(rawContent);
                      asstText = extracted.text;
                      asstReasoning = extracted.thinking;
                    }
                  }
                }

                let timestamp: number | undefined;
                if (Array.isArray(turnItem[4]) && typeof turnItem[4][0] === 'number') {
                  timestamp = turnItem[4][0];
                }

                if (asstText || asstReasoning) {
                  turns.push({
                    role: 'assistant',
                    content: asstText,
                    reasoning_content: asstReasoning || undefined,
                    choice_id: asstChoiceId,
                    response_id: asstRespId,
                    timestamp,
                  });
                }
              }
            }
          }
        }
      }
    } catch {}
  }

  return { turns, lastRid, lastRcid };
}

