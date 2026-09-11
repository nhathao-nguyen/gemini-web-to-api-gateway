import crypto from 'crypto';
import {
  AIProvider,
  AIProviderResult,
  AIStreamChunk,
  GeminiAccount,
  ChatCompletionRequest,
  HealthResult,
} from '../../types.js';
import { decryptCookie } from '../../utils/crypto.js';
import { redactString } from '../../utils/redact.js';
import { config } from '../../config.js';

const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export const GEMINI_MODEL_HEADER_KEY = 'x-goog-ext-525001261-jspb';
export const GEMINI_USER_STATUS_RPC = 'otAQ7b';

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

export function resolveGeminiModel(requested: string, models: DiscoveredModel[]): DiscoveredModel {
  if (!models || models.length === 0) {
    throw new Error('no Gemini models available; refresh the authenticated session');
  }

  const req = requested.toLowerCase().trim();
  if (!req) {
    return models[0];
  }

  let lookup = req;
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
  generationId: string
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
  header[15 + offset] = 1;
  header[16 + offset] = generationId;

  const requestHeader = [requestId, 1];

  return {
    [GEMINI_MODEL_HEADER_KEY]: JSON.stringify(header),
    'x-goog-ext-525005358-jspb': JSON.stringify(requestHeader),
    'x-goog-ext-73010989-jspb': '[0]',
    'x-goog-ext-73010990-jspb': '[0,0,0]',
  };
}

export function buildGenerateInner(
  prompt: string,
  modelNumber: number,
  language: string,
  requestId: string,
  isTemporary = false,
  metadata?: { cid?: string; rid?: string; rcid?: string }
): any[] {
  const messageContent = [prompt];
  const defaultMetadata = [
    metadata?.cid || '',
    metadata?.rid || '',
    metadata?.rcid || '',
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
  inner[80] = 1;

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
    if (codes.length > 0) {
      return `Google Gemini Web returned an error (BardErrorInfo code ${codes.join(' ')}). This usually indicates session expiration, rate limits, context window limits, or bot protection/CAPTCHA block.`;
    }
    return 'Google Gemini Web returned a BardErrorInfo block.';
  }
  return null;
}

export function parseGoogleWireResponse(rawBody: string): {
  text: string;
  thinking?: string;
  conversation_id?: string;
  response_id?: string;
  choice_id?: string;
} {
  const cleaned = rawBody.replace(/^\)]\}'\s*/, '');
  const lines = cleaned.split('\n');

  let finalResText = '';
  let cid = '';
  let rid = '';
  let rcid = '';
  let found = false;

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
                    if (typeof payload[1] === 'string') {
                      cid = payload[1];
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
    const sample = rawBody.slice(0, 500);
    throw new Error(`UPSTREAM_ERROR: Failed to parse response candidates from Gemini Web RPC. Sample: ${sample}`);
  }

  const { thinking, text: cleanText } = extractThinkingAndText(finalResText);

  return {
    text: cleanText,
    thinking,
    conversation_id: cid || undefined,
    response_id: rid || undefined,
    choice_id: rcid || undefined,
  };
}

// --------------------------------------------------------------------------
// GeminiWebProvider Implementation
// --------------------------------------------------------------------------

export class GeminiWebProvider implements AIProvider {
  private sessionCache = new Map<string, GeminiWebSession>();

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
    return cookieHeader;
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
    const res = await fetch(targetUrl, {
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
    });

    console.log(`[Upstream Gemini Web Handshake] account_id=${account.id} upstream_hostname=gemini.google.com upstream_path=/app upstream_status=${res.status} duration_ms=${Date.now() - fetchStart}`);

    if (res.status === 302 || res.status === 301) {
      const location = res.headers.get('location') || '';
      if (location.includes('accounts.google.com')) {
        throw new Error('SESSION_EXPIRED: Cookie redirect to accounts.google.com login');
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
    let discoveredModels: DiscoveredModel[] = [];
    try {
      discoveredModels = await this.fetchGeminiModels(
        account,
        snlm0e,
        cookie,
        buildLabel,
        sessionId,
        language,
        generationId
      );
    } catch (discoveryErr: any) {
      console.warn(`[GeminiWebProvider] Model discovery warning for account ${account.id}: ${discoveryErr.message}`);
      // If live discovery failed, fall back to account.supported_models or default models
      const fallbackList = account.supported_models && account.supported_models.length > 0
        ? account.supported_models
        : ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-advanced'];
      discoveredModels = fallbackList.map((m) => {
        const { name, aliases } = geminiModelNames(m, m.includes('pro') ? 'Pro' : 'Fast', m);
        return {
          id: name,
          displayName: m,
          modelId: `fallback-${m}`,
          capacity: 1,
          capacityField: 12,
          modelNumber: 1,
          aliases,
        };
      });
    }

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
    const res = await fetch(targetUrl, {
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
    });

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

  private buildPromptFromMessages(messages: ChatCompletionRequest['messages']): { prompt: string; systemPrompt?: string } {
    let systemPrompt = '';
    const promptParts: string[] = [];

    for (const msg of messages) {
      const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      if (msg.role === 'system') {
        systemPrompt += (systemPrompt ? '\n' : '') + content;
      } else if (msg.role === 'user') {
        promptParts.push(`User: ${content}`);
      } else if (msg.role === 'assistant') {
        promptParts.push(`Assistant: ${content}`);
      }
    }

    let finalPrompt = promptParts.join('\n\n');
    if (systemPrompt) {
      finalPrompt = `[System Instructions]\n${systemPrompt}\n\n${finalPrompt}`;
    }

    return { prompt: finalPrompt, systemPrompt };
  }

  private async executeRpc(
    account: GeminiAccount,
    request: ChatCompletionRequest,
    signal?: AbortSignal
  ): Promise<{ res: Response; model: DiscoveredModel }> {
    const session = await this.getOrFetchSession(account);
    const resolvedModel = resolveGeminiModel(request.model, session.discoveredModels);

    const { prompt } = this.buildPromptFromMessages(request.messages);
    const requestId = crypto.randomUUID().toUpperCase();
    const isTemporary = false;

    const innerReq = buildGenerateInner(
      prompt,
      resolvedModel.modelNumber,
      session.language || 'en',
      requestId,
      isTemporary,
      { cid: request.conversation_id }
    );

    const fReq = JSON.stringify([null, JSON.stringify(innerReq)]);
    const modelHeaders = buildGeminiModelHeaders(resolvedModel, requestId, session.generationId);

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
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers,
      body: bodyParams.toString(),
      signal,
    });

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
    signal?: AbortSignal
  ): Promise<AIProviderResult> {
    const { res } = await this.executeRpc(account, request, signal);
    const textBody = await res.text();
    const parsed = parseGoogleWireResponse(textBody);

    const promptText = request.messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join(' ');
    const promptTokens = Math.max(1, Math.round(promptText.length / 4));
    const completionTokens = Math.max(1, Math.round(parsed.text.length / 4));

    return {
      text: parsed.text,
      reasoning_content: parsed.thinking,
      conversation_id: parsed.conversation_id,
      response_id: parsed.response_id,
      choice_id: parsed.choice_id,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
    };
  }

  public async *ChatCompletionStream(
    account: GeminiAccount,
    request: ChatCompletionRequest,
    signal?: AbortSignal
  ): AsyncIterable<AIStreamChunk> {
    const streamStart = performance.now();
    const { res } = await this.executeRpc(account, request, signal);

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
    let upstreamFirstChunkTs: number | null = null;
    let downstreamFirstChunkTs: number | null = null;

    try {
      while (true) {
        if (signal?.aborted) {
          await reader.cancel();
          break;
        }

        const { done, value } = await reader.read();

        if (value) {
          if (upstreamFirstChunkTs === null) {
            upstreamFirstChunkTs = performance.now();
            console.log(`[Stream Timing] Upstream first chunk received at ${(upstreamFirstChunkTs - streamStart).toFixed(2)}ms`);
          }

          lineBuffer += decoder.decode(value, { stream: true });
          const lines = lineBuffer.split('\n');
          lineBuffer = lines.pop() || ''; // Keep incomplete trailing fragment

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || /^\d+$/.test(trimmed)) continue;

            try {
              const root = JSON.parse(trimmed.replace(/^\)]\}'\s*/, ''));
              if (Array.isArray(root)) {
                for (const item of root) {
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
                            if (typeof payload[1] === 'string') convId = payload[1];
                            if (typeof firstCandidate[0] === 'string') respId = firstCandidate[0];

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
                              };
                            }

                            // Yield text delta if any
                            if (text && text.length > emittedText.length) {
                              const delta = text.slice(emittedText.length);
                              emittedText = text;

                              if (downstreamFirstChunkTs === null) {
                                downstreamFirstChunkTs = performance.now();
                                console.log(`[Stream Timing] Downstream first SSE write at ${(downstreamFirstChunkTs - streamStart).toFixed(2)}ms`);
                              }

                              yield {
                                text_delta: delta,
                                is_done: false,
                                conversation_id: convId,
                                response_id: respId,
                              };
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

        if (done) {
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
    };
  }
}
