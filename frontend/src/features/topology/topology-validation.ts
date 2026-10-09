/*
 * Topology metadata validation.
 *
 * Mirrors the accepted Inventory metadata policy wherever it is semantically
 * applicable. The backend remains the final authority: these checks only give
 * the operator immediate feedback and keep obviously invalid payloads off the
 * wire.
 */

/** Label grammar: lowercase alphanumerics with underscores, slashes, hyphens. */
export const LABEL_KEY_PATTERN = /^[a-z0-9][a-z0-9_/-]{0,62}$/;

export const SENSITIVE_KEY_SUBSTRINGS = [
  'password',
  'passwd',
  'secret',
  'token',
  'apikey',
  'privatekey',
  'credential',
];

/**
 * Fields owned by the server. Topology is not a secret store and identity is
 * never client-supplied.
 */
export const FORBIDDEN_SERVER_FIELDS = [
  'edgeId',
  'schemaVersion',
  'source',
  'revision',
  'lifecycleState',
  'createdAt',
  'createdBy',
  'updatedAt',
  'updatedBy',
  'retiredAt',
  'retiredBy',
  'retireReason',
];

export function validateDescription(description: string): string | null {
  if (description.length > 1024) {
    return 'Description cannot exceed 1024 characters.';
  }
  return null;
}

export function validateLabelKey(key: string): string | null {
  if (!key) {
    return 'Label key cannot be empty.';
  }
  if (key.includes('.')) {
    return 'Label key cannot contain a dot.';
  }
  if (key.startsWith('$')) {
    return 'Label key cannot start with $.';
  }
  if (!LABEL_KEY_PATTERN.test(key)) {
    return 'Label key must start with a lowercase alphanumeric character and contain only lowercase alphanumerics, underscores, slashes, or hyphens (up to 63 characters).';
  }
  return null;
}

export function validateLabelValue(value: string): string | null {
  if (new TextEncoder().encode(value).length > 128) {
    return 'Label value cannot exceed 128 UTF-8 bytes.';
  }
  return null;
}

export function validateLabels(labels: Record<string, string>): string | null {
  const entries = Object.entries(labels);
  if (entries.length > 32) {
    return 'Labels cannot have more than 32 entries.';
  }
  for (const [key, value] of entries) {
    const keyError = validateLabelKey(key);
    if (keyError) {
      return keyError;
    }
    const valueError = validateLabelValue(value);
    if (valueError) {
      return valueError;
    }
  }
  return null;
}

export function findSensitiveAttributeKey(obj: unknown, prefix = ''): string | null {
  if (!obj || typeof obj !== 'object') {
    return null;
  }
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      const match = findSensitiveAttributeKey(obj[i], `${prefix}[${i}]`);
      if (match) return match;
    }
    return null;
  }

  const record = obj as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    const normalizedKey = key.toLowerCase().replaceAll('_', '').replaceAll('-', '');
    for (const forbidden of SENSITIVE_KEY_SUBSTRINGS) {
      if (normalizedKey.includes(forbidden)) {
        return prefix ? `${prefix}.${key}` : key;
      }
    }
    const nested = findSensitiveAttributeKey(value, prefix ? `${prefix}.${key}` : key);
    if (nested) return nested;
  }
  return null;
}

export function validateAttributes(attrs: unknown): string | null {
  if (attrs === undefined || attrs === null) {
    return null;
  }
  if (typeof attrs !== 'object' || Array.isArray(attrs)) {
    return 'Attributes must be a JSON object.';
  }

  let serialized: string;
  try {
    serialized = JSON.stringify(attrs);
  } catch {
    return 'Attributes cannot be serialized to JSON.';
  }

  if (new TextEncoder().encode(serialized).length > 32768) {
    return 'Attributes payload exceeds maximum allowed size of 32 KiB.';
  }

  const sensitive = findSensitiveAttributeKey(attrs);
  if (sensitive) {
    return `Attributes must not contain a sensitive key (${sensitive}).`;
  }

  if (Object.keys(attrs as Record<string, unknown>).length > 128) {
    return 'Attributes cannot have more than 128 top-level keys.';
  }

  function checkKeys(val: unknown, depth: number): string | null {
    if (depth > 6) {
      return 'Attributes exceed maximum nesting depth of 6.';
    }
    if (!val || typeof val !== 'object') {
      return null;
    }
    if (Array.isArray(val)) {
      if (val.length > 128) {
        return 'Attribute arrays cannot exceed 128 items.';
      }
      for (const item of val) {
        const err = checkKeys(item, depth + 1);
        if (err) return err;
      }
      return null;
    }
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      if (k.includes('.')) {
        return `Attribute key "${k}" cannot contain dots.`;
      }
      if (k.startsWith('$')) {
        return `Attribute key "${k}" cannot start with $.`;
      }
      if (typeof v === 'string' && v.length > 2048) {
        return `Attribute string value for "${k}" cannot exceed 2048 characters.`;
      }
      const err = checkKeys(v, depth + 1);
      if (err) return err;
    }
    return null;
  }

  return checkKeys(attrs, 1);
}

/** Reject any server-owned field present in a client-supplied object. */
export function assertNoServerOwnedFields(input: Record<string, unknown>): void {
  for (const field of FORBIDDEN_SERVER_FIELDS) {
    if (field in input && input[field] !== undefined) {
      throw new Error(`Field "${field}" is server-owned and cannot be provided in a topology request.`);
    }
  }
}
