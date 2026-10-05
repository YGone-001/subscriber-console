import type { ManagementEndpoint } from './inventory-types';

export const MACHINE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
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

export const FORBIDDEN_SERVER_FIELDS = [
  'resourceId',
  'schemaVersion',
  'source',
  'revision',
  'createdAt',
  'createdBy',
  'updatedAt',
  'updatedBy',
  'retiredAt',
  'retiredBy',
  'retireReason',
];

export function validateMachineName(name: string): string | null {
  if (!name || !name.trim()) {
    return 'Name is required.';
  }
  if (!MACHINE_NAME_PATTERN.test(name.trim())) {
    return 'Name must start with an alphanumeric character and contain only alphanumeric characters, dots, underscores, colons, or hyphens (up to 128 characters).';
  }
  return null;
}

export function validateLabelKey(key: string): string | null {
  if (!key) {
    return 'Label key cannot be empty.';
  }
  if (!LABEL_KEY_PATTERN.test(key)) {
    return 'Label key must start with a lowercase alphanumeric character and contain only lowercase alphanumerics, underscores, slashes, or hyphens (up to 63 characters).';
  }
  return null;
}

export function validateLabelValue(value: string): string | null {
  if (new TextEncoder().encode(value).length > 128) {
    return 'Label value cannot exceed 128 characters.';
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
    return `Attributes must not contain sensitive key (${sensitive}).`;
  }

  const keyCount = Object.keys(attrs as Record<string, unknown>).length;
  if (keyCount > 128) {
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
      for (const item of val) {
        const err = checkKeys(item, depth + 1);
        if (err) return err;
      }
      return null;
    }
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      if (k.includes('.') || k.startsWith('$')) {
        return `Attribute key "${k}" cannot contain dots or start with $.`;
      }
      const err = checkKeys(v, depth + 1);
      if (err) return err;
    }
    return null;
  }

  return checkKeys(attrs, 1);
}

export function validateManagementEndpoints(endpoints: ManagementEndpoint[]): string | null {
  if (!endpoints || endpoints.length === 0) {
    return null;
  }

  const seen = new Set<string>();
  for (const ep of endpoints) {
    if (!ep.name || !ep.name.trim()) {
      return 'Management endpoint name is required.';
    }
    if (!ep.protocol || !ep.protocol.trim()) {
      return 'Management endpoint protocol is required.';
    }
    if (!ep.addressType || !ep.addressType.trim()) {
      return 'Management endpoint addressType is required.';
    }
    if (!ep.address || !ep.address.trim()) {
      return 'Management endpoint address is required.';
    }
    const addr = ep.address.trim();
    if (addr.includes('://') || addr.includes('@')) {
      return 'Management endpoint address must not include URL schemes or user credentials.';
    }
    if (ep.port < 1 || ep.port > 65535) {
      return 'Management endpoint port must be between 1 and 65535.';
    }

    const tuple = `${ep.protocol.toLowerCase()}:${addr.toLowerCase()}:${ep.port}`;
    if (seen.has(tuple)) {
      return `Duplicate management endpoint tuple: (${ep.protocol}, ${ep.address}, ${ep.port}).`;
    }
    seen.add(tuple);
  }
  return null;
}
