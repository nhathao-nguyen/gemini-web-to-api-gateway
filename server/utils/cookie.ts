/**
 * Utilities for normalizing and validating Gemini browser session cookies.
 * Supports:
 * 1. Raw header strings (__Secure-1PSID=...; __Secure-1PSIDTS=...; ...)
 * 2. JSON array exports from EditThisCookie, Cookie-Editor
 * 3. JSON key-value dictionary exports
 */

export function normalizeCookieString(raw: string): string {
  if (!raw || typeof raw !== 'string') return '';
  let trimmed = raw.trim();

  // Case 1: Array of cookie objects (Cookie-Editor, EditThisCookie JSON export)
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    try {
      const arr = JSON.parse(trimmed);
      if (Array.isArray(arr)) {
        const parts: string[] = [];
        for (const item of arr) {
          if (!item) continue;
          const name = item.name || item.key;
          const value = item.value;
          if (name && value !== undefined) {
            parts.push(`${name}=${value}`);
          }
        }
        if (parts.length > 0) {
          return parts.join('; ');
        }
      }
    } catch {
      // Fall through if not valid JSON
    }
  }

  // Case 2: Key-value dictionary { "__Secure-1PSID": "...", ... }
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj === 'object') {
        const parts = Object.entries(obj).map(([k, v]) => `${k}=${v}`);
        if (parts.length > 0) {
          return parts.join('; ');
        }
      }
    } catch {
      // Fall through
    }
  }

  // Case 3: Raw string with "Cookie: " prefix
  if (trimmed.toLowerCase().startsWith('cookie:')) {
    trimmed = trimmed.slice(7).trim();
  }

  // Normalize multiple lines or semicolons
  return trimmed
    .split(/[\r\n]+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join('; ')
    .replace(/;\s*;/g, ';');
}

export function validateGeminiCookie(rawCookie: string): {
  valid: boolean;
  normalized: string;
  missing: string[];
  warnings: string[];
} {
  const normalized = normalizeCookieString(rawCookie);
  const missing: string[] = [];
  const warnings: string[] = [];

  if (!normalized) {
    return {
      valid: false,
      normalized: '',
      missing: ['Cookie content is empty'],
      warnings: [],
    };
  }

  // Ensure normalized string has at least one valid key=value pair
  if (!normalized.includes('=')) {
    return {
      valid: false,
      normalized,
      missing: ['Cookie does not contain valid key=value pairs'],
      warnings: [],
    };
  }

  const hasPsid = normalized.includes('__Secure-1PSID=') || normalized.includes('SID=');
  if (!hasPsid) {
    warnings.push('Standard Google session cookie (__Secure-1PSID or SID) not detected; session validity will be verified by upstream handshake');
  }

  if (!normalized.includes('__Secure-1PSIDTS=')) {
    warnings.push('__Secure-1PSIDTS is missing: session may expire quickly without timestamp token');
  }

  return {
    valid: missing.length === 0,
    normalized,
    missing,
    warnings,
  };
}
