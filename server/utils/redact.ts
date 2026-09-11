/**
 * Redact sensitive credentials such as cookies, Google session tokens,
 * passwords, and secret keys from logs, error messages, and telemetry.
 */

const SENSITIVE_PATTERNS = [
  /Cookie:\s*[^\r\n]+/gi,
  /__Secure-[a-zA-Z0-9_-]+(=|:\s*)[^;\s&"']+/gi,
  /\bSID(=|:\s*)[^;\s&"']+/gi,
  /\bHSID(=|:\s*)[^;\s&"']+/gi,
  /\bSSID(=|:\s*)[^;\s&"']+/gi,
  /SNlM0e(=|:\s*"?|":")[^"';\s&]+/gi,
  /Bearer\s+[a-zA-Z0-9_\-\.]+/gi,
  /sk-gmgw-[a-zA-Z0-9_-]{10,}/gi,
  /"encrypted_cookie":"[^"]+"/gi,
  /password=[^&\s]+/gi,
];

export function redactString(text: string): string {
  if (!text || typeof text !== 'string') return text;
  let sanitized = text;
  for (const pattern of SENSITIVE_PATTERNS) {
    sanitized = sanitized.replace(pattern, '[REDACTED]');
  }
  return sanitized;
}

export function redactObject<T>(obj: T): T {
  if (!obj) return obj;
  if (typeof obj === 'string') {
    return redactString(obj) as unknown as T;
  }
  if (Array.isArray(obj)) {
    return obj.map((item) => redactObject(item)) as unknown as T;
  }
  if (typeof obj === 'object') {
    const copy: Record<string, any> = {};
    for (const [key, value] of Object.entries(obj)) {
      const lower = key.toLowerCase();
      if (
        lower.includes('cookie') ||
        lower.includes('secret') ||
        lower.includes('password') ||
        lower.includes('token') ||
        lower.includes('authorization') ||
        lower.includes('apikey') ||
        lower.includes('api_key')
      ) {
        if (key === 'key_prefix') {
          copy[key] = value;
        } else {
          copy[key] = '[REDACTED]';
        }
      } else {
        copy[key] = redactObject(value);
      }
    }
    return copy as T;
  }
  return obj;
}
