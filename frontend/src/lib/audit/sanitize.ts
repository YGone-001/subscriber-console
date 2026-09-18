export type AuditValue = null | boolean | number | string | AuditValue[] | { [key: string]: AuditValue };

export const REDACTED = '[REDACTED]';
const MAX_DEPTH = 12;
const MAX_ITEMS = 200;
const MAX_NODES = 3000;
const MAX_TEXT = 64000;
const MAX_STRING = 4000;
const SECRET_KEYS = new Set([
  'password', 'passwordhash', 'passwd', 'pwd', 'token', 'accesstoken', 'refreshtoken',
  'idtoken', 'jwt', 'authorization', 'proxyauthorization', 'secret', 'privatekey',
  'apikey', 'cookie', 'setcookie', 'sessionid', 'sessiontoken',
  // Subscriber authentication material must never enter governance evidence.
  'k', 'ki', 'op', 'opc', 'kasme', 'kamf', 'xres', 'ck', 'ik',
]);

function sensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return SECRET_KEYS.has(normalized)
    || /(?:password|passwordhash|passwd|secret|privatekey|apikey|accesstoken|refreshtoken)$/.test(normalized)
    || key.split(/[.\[\]]/).some((part) => SECRET_KEYS.has(part.toLowerCase()));
}

/** Scrub recognizable credentials in free text; arbitrary prose is not a secret detector. */
export function sanitizeAuditText(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.slice(0, MAX_STRING * 2)
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, REDACTED)
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, REDACTED)
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, REDACTED)
    .replace(/(mongodb(?:\+srv)?:\/\/)[^\s/@]+:[^\s/@]+@/gi, `$1${REDACTED}@`)
    .replace(/\b(password|passwordHash|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|token|authorization|cookie)["']?\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi, `$1=${REDACTED}`)
    .slice(0, MAX_STRING);
}

/** Non-mutating, bounded JSON snapshot. No getters or user-defined toJSON are invoked. */
export function sanitizeAuditPayload(value: unknown): AuditValue {
  const ancestors = new WeakSet<object>();
  let nodes = 0;
  let textBudget = MAX_TEXT;

  function visit(current: unknown, depth: number): AuditValue {
    nodes += 1;
    if (nodes > MAX_NODES || textBudget <= 0 || depth > MAX_DEPTH) return '[TRUNCATED]';
    if (current === null || current === undefined) return null;
    if (typeof current === 'boolean') return current;
    if (typeof current === 'number') return Number.isFinite(current) ? current : null;
    if (typeof current === 'bigint') return visit(current.toString(), depth + 1);
    if (typeof current === 'string') {
      // Some legacy payloads embed JSON in strings. Scrub those recursively too.
      if (/^\s*[\[{]/.test(current)) {
        if (current.length > MAX_STRING) return '[TRUNCATED]';
        try { return JSON.stringify(visit(JSON.parse(current) as unknown, depth + 1)); } catch { /* free text */ }
      }
      const safe = sanitizeAuditText(current).slice(0, textBudget);
      textBudget -= safe.length;
      return safe;
    }
    if (typeof current !== 'object') return '[UNSUPPORTED]';
    if (current instanceof Date) return Number.isNaN(current.getTime()) ? null : current.toISOString();
    if (ArrayBuffer.isView(current) || current instanceof ArrayBuffer) return '[BINARY OMITTED]';
    if (ancestors.has(current)) return '[CIRCULAR]';
    ancestors.add(current);
    try {
      if (Array.isArray(current)) {
        const result: AuditValue[] = [];
        for (let index = 0; index < Math.min(current.length, MAX_ITEMS); index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
          result.push(descriptor && 'value' in descriptor ? visit(descriptor.value, depth + 1) : '[OMITTED]');
          if (nodes > MAX_NODES || textBudget <= 0) break;
        }
        if (result.length < current.length) result.push('[TRUNCATED]');
        return result;
      }
      const result: { [key: string]: AuditValue } = {};
      const keys = Object.keys(current);
      for (const key of keys.slice(0, MAX_ITEMS)) {
        nodes += 1;
        if (nodes > MAX_NODES || textBudget <= 0) break;
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        const safeKey = sanitizeAuditText(key).slice(0, 200);
        textBudget -= safeKey.length;
        result[safeKey] = sensitiveKey(key) ? REDACTED
          : descriptor && 'value' in descriptor ? visit(descriptor.value, depth + 1) : '[OMITTED]';
        if (nodes > MAX_NODES || textBudget <= 0) break;
      }
      if (keys.length > MAX_ITEMS || nodes > MAX_NODES || textBudget <= 0) result._truncated = true;
      return result;
    } finally {
      ancestors.delete(current);
    }
  }

  try { return visit(value, 0); } catch { return '[UNSERIALIZABLE]'; }
}
