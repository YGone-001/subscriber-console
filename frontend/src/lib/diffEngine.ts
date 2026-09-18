function formatBytesInternal(bytes: number): string {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  if (i === 0) return bytes + ' B';
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

export type DiffType = 'added' | 'removed' | 'modified' | 'unchanged';

export interface FieldDiff {
  path: string;
  key: string;
  label: string;
  type: DiffType;
  oldValue: unknown;
  newValue: unknown;
  formattedOld: string;
  formattedNew: string;
  category?: 'basic' | 'ambr' | 'slice' | 'pcc' | 'security' | 'billing' | 'other';
}

export interface DiffSummary {
  total: number;
  added: number;
  removed: number;
  modified: number;
  unchanged: number;
  hasChanges: boolean;
}

export interface LineDiff {
  type: 'add' | 'del' | 'normal';
  oldLineNumber?: number;
  newLineNumber?: number;
  content: string;
}

export interface ObjectDiffResult {
  fields: FieldDiff[];
  summary: DiffSummary;
}

/**
 * Checks if a value is a plain object or record
 */
function isObject(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}

// Same unit encoding as the existing Subscriber AMBR editor (0..4).
const BANDWIDTH_UNITS = ['bps', 'Kbps', 'Mbps', 'Gbps', 'Tbps'] as const;

function isBandwidthValue(value: unknown): value is { value: number; unit: number } {
  return isObject(value) && Object.keys(value).length === 2
    && typeof value.value === 'number' && Number.isFinite(value.value)
    && typeof value.unit === 'number' && Number.isInteger(value.unit)
    && value.unit >= 0 && value.unit < BANDWIDTH_UNITS.length;
}

function isAmbrDirection(path: string): boolean {
  return /(?:^|\.)ambr\.(?:downlink|uplink)$/i.test(path);
}

/**
 * Format individual values for telecom and general display
 */
export function formatDiffValue(val: unknown, keyHint?: string): string {
  if (val === undefined || val === null) {
    return '—';
  }

  if (typeof val === 'boolean') {
    return val ? 'true' : 'false';
  }

  if (isAmbrDirection(keyHint || '') && isBandwidthValue(val)) {
    return `${val.value} ${BANDWIDTH_UNITS[val.unit]}`;
  }

  if (typeof val === 'number') {
    const lowerKey = (keyHint || '').toLowerCase();
    // Incomplete legacy snapshots may contain only value/unit. Never label a
    // unit code or a quantity with unknown units as a bitrate in bps.
    if (/ambr\.(?:downlink|uplink)\.(?:value|unit)$/.test(lowerKey)) {
      return String(val);
    }
    if (lowerKey.includes('bytes') || lowerKey.includes('traffic') || lowerKey.includes('balance') || lowerKey.includes('quota')) {
      try {
        return `${val} (${formatBytesInternal(val)})`;
      } catch {
        return String(val);
      }
    }
    if (lowerKey.includes('bitrate') || lowerKey.includes('rate') || lowerKey.includes('ambr')) {
      if (val >= 1_000_000_000) return `${(val / 1_000_000_000).toFixed(1)} Gbps`;
      if (val >= 1_000_000) return `${(val / 1_000_000).toFixed(1)} Mbps`;
      if (val >= 1_000) return `${(val / 1_000).toFixed(1)} Kbps`;
      return `${val} bps`;
    }
    return String(val);
  }

  if (typeof val === 'string') {
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(val)) {
      const parsed = Date.parse(val);
      if (!Number.isNaN(parsed)) {
        return new Date(parsed).toLocaleString();
      }
    }
    return val;
  }

  if (Array.isArray(val)) {
    if (val.length === 0) return '[]';
    if (val.every((item) => typeof item === 'string' || typeof item === 'number')) {
      return `[${val.join(', ')}]`;
    }
    try {
      return JSON.stringify(val);
    } catch {
      return `[Array (${val.length})]`;
    }
  }

  try {
    return JSON.stringify(val);
  } catch {
    return String(val);
  }
}

/**
 * Categorize telecom schema property
 */
function categorizePath(path: string): FieldDiff['category'] {
  const p = path.toLowerCase();
  if (p.includes('ambr') || p.includes('bitrate') || p.includes('rate')) return 'ambr';
  if (p.includes('slice') || p.includes('sst') || p.includes('sd') || p.includes('session') || p.includes('dnn')) return 'slice';
  if (p.includes('pcc') || p.includes('flow') || p.includes('qci') || p.includes('5qi') || p.includes('arp')) return 'pcc';
  if (p.includes('auth') || p.includes('security') || p.includes('opc') || p.includes('key') || p.includes('k') || p.includes('sqn')) return 'security';
  if (p.includes('balance') || p.includes('rating') || p.includes('tariff') || p.includes('plan') || p.includes('ocs')) return 'billing';
  if (p.includes('imsi') || p.includes('msisdn') || p.includes('name') || p.includes('title') || p.includes('status')) return 'basic';
  return 'other';
}

/**
 * Convert property path to human-readable label
 */
export function humanizePath(path: string): string {
  const segments = path.split('.');
  const last = segments[segments.length - 1] || path;
  return last
    .replace(/([A-Z])/g, ' $1')
    .replace(/_/g, ' ')
    .replace(/\[\d+\]/g, (match) => ` ${match} `)
    .trim()
    .replace(/^\w/, (c) => c.toUpperCase());
}

export interface DiffOptions {
  ignoreKeys?: string[];
  includeUnchanged?: boolean;
}

/**
 * Deep recursive object diff computation
 */
export function computeObjectDiff(
  oldObj: unknown,
  newObj: unknown,
  options: DiffOptions = {}
): ObjectDiffResult {
  const fields: FieldDiff[] = [];
  const ignoreSet = new Set(options.ignoreKeys || ['_id', '__v']);

  function traverse(oldVal: unknown, newVal: unknown, currentPath: string) {
    if (ignoreSet.has(currentPath)) return;

    if (isAmbrDirection(currentPath) && isBandwidthValue(oldVal) && isBandwidthValue(newVal)) {
      const unchanged = oldVal.value === newVal.value && oldVal.unit === newVal.unit;
      if (!unchanged || options.includeUnchanged) fields.push({
        path: currentPath, key: currentPath, label: humanizePath(currentPath),
        type: unchanged ? 'unchanged' : 'modified', oldValue: oldVal, newValue: newVal,
        formattedOld: formatDiffValue(oldVal, currentPath), formattedNew: formatDiffValue(newVal, currentPath),
        category: 'ambr',
      });
      return;
    }

    // Case 1: Both are identical primitives
    if (oldVal === newVal) {
      if (options.includeUnchanged && oldVal !== undefined) {
        fields.push({
          path: currentPath,
          key: currentPath,
          label: humanizePath(currentPath),
          type: 'unchanged',
          oldValue: oldVal,
          newValue: newVal,
          formattedOld: formatDiffValue(oldVal, currentPath),
          formattedNew: formatDiffValue(newVal, currentPath),
          category: categorizePath(currentPath),
        });
      }
      return;
    }

    // Case 2: One is added (old was undefined/null and new is defined)
    if ((oldVal === undefined || oldVal === null) && newVal !== undefined && newVal !== null) {
      if (isObject(newVal) || Array.isArray(newVal)) {
        fields.push({
          path: currentPath,
          key: currentPath,
          label: humanizePath(currentPath),
          type: 'added',
          oldValue: oldVal,
          newValue: newVal,
          formattedOld: '—',
          formattedNew: formatDiffValue(newVal, currentPath),
          category: categorizePath(currentPath),
        });
      } else {
        fields.push({
          path: currentPath,
          key: currentPath,
          label: humanizePath(currentPath),
          type: 'added',
          oldValue: oldVal,
          newValue: newVal,
          formattedOld: '—',
          formattedNew: formatDiffValue(newVal, currentPath),
          category: categorizePath(currentPath),
        });
      }
      return;
    }

    // Case 3: One is removed (old was defined and new is undefined/null)
    if (oldVal !== undefined && oldVal !== null && (newVal === undefined || newVal === null)) {
      fields.push({
        path: currentPath,
        key: currentPath,
        label: humanizePath(currentPath),
        type: 'removed',
        oldValue: oldVal,
        newValue: newVal,
        formattedOld: formatDiffValue(oldVal, currentPath),
        formattedNew: '—',
        category: categorizePath(currentPath),
      });
      return;
    }

    // Case 4: Both are objects
    if (isObject(oldVal) && isObject(newVal)) {
      const allKeys = Array.from(new Set([...Object.keys(oldVal), ...Object.keys(newVal)]));
      for (const k of allKeys) {
        const nextPath = currentPath ? `${currentPath}.${k}` : k;
        traverse(oldVal[k], newVal[k], nextPath);
      }
      return;
    }

    // Case 5: Both are arrays
    if (Array.isArray(oldVal) && Array.isArray(newVal)) {
      const maxLen = Math.max(oldVal.length, newVal.length);
      for (let i = 0; i < maxLen; i++) {
        const nextPath = `${currentPath}[${i}]`;
        traverse(oldVal[i], newVal[i], nextPath);
      }
      return;
    }

    // Case 6: Different types or modified primitive values
    fields.push({
      path: currentPath,
      key: currentPath,
      label: humanizePath(currentPath),
      type: 'modified',
      oldValue: oldVal,
      newValue: newVal,
      formattedOld: formatDiffValue(oldVal, currentPath),
      formattedNew: formatDiffValue(newVal, currentPath),
      category: categorizePath(currentPath),
    });
  }

  traverse(oldObj, newObj, '');

  let added = 0;
  let removed = 0;
  let modified = 0;
  let unchanged = 0;

  for (const f of fields) {
    if (f.type === 'added') added++;
    else if (f.type === 'removed') removed++;
    else if (f.type === 'modified') modified++;
    else if (f.type === 'unchanged') unchanged++;
  }

  const summary: DiffSummary = {
    total: fields.length,
    added,
    removed,
    modified,
    unchanged,
    hasChanges: added + removed + modified > 0,
  };

  return { fields, summary };
}

/**
 * Line-by-line unified diff calculation
 */
export function computeLineDiff(oldText: string, newText: string): LineDiff[] {
  const oldLines = (oldText || '').split(/\r?\n/);
  const newLines = (newText || '').split(/\r?\n/);

  const result: LineDiff[] = [];
  let oldIdx = 0;
  let newIdx = 0;

  while (oldIdx < oldLines.length || newIdx < newLines.length) {
    const oldLine = oldLines[oldIdx];
    const newLine = newLines[newIdx];

    if (oldIdx < oldLines.length && newIdx < newLines.length) {
      if (oldLine === newLine) {
        result.push({
          type: 'normal',
          oldLineNumber: oldIdx + 1,
          newLineNumber: newIdx + 1,
          content: oldLine,
        });
        oldIdx++;
        newIdx++;
      } else {
        // Look ahead in newLines for oldLine
        const foundInNew = newLines.indexOf(oldLine, newIdx);
        // Look ahead in oldLines for newLine
        const foundInOld = oldLines.indexOf(newLine, oldIdx);

        if (foundInNew !== -1 && (foundInOld === -1 || foundInNew - newIdx <= foundInOld - oldIdx)) {
          // Lines were added
          while (newIdx < foundInNew) {
            result.push({
              type: 'add',
              newLineNumber: newIdx + 1,
              content: newLines[newIdx],
            });
            newIdx++;
          }
        } else if (foundInOld !== -1) {
          // Lines were deleted
          while (oldIdx < foundInOld) {
            result.push({
              type: 'del',
              oldLineNumber: oldIdx + 1,
              content: oldLines[oldIdx],
            });
            oldIdx++;
          }
        } else {
          // Changed line
          result.push({
            type: 'del',
            oldLineNumber: oldIdx + 1,
            content: oldLine,
          });
          result.push({
            type: 'add',
            newLineNumber: newIdx + 1,
            content: newLine,
          });
          oldIdx++;
          newIdx++;
        }
      }
    } else if (oldIdx < oldLines.length) {
      result.push({
        type: 'del',
        oldLineNumber: oldIdx + 1,
        content: oldLines[oldIdx],
      });
      oldIdx++;
    } else if (newIdx < newLines.length) {
      result.push({
        type: 'add',
        newLineNumber: newIdx + 1,
        content: newLines[newIdx],
      });
      newIdx++;
    }
  }

  return result;
}

/**
 * Generate standard Git Unified Patch string
 */
export function generateUnifiedPatch(oldObj: unknown, newObj: unknown, headerTitle = 'Target'): string {
  const oldJson = oldObj !== undefined && oldObj !== null ? JSON.stringify(oldObj, null, 2) : '';
  const newJson = newObj !== undefined && newObj !== null ? JSON.stringify(newObj, null, 2) : '';

  const lines = computeLineDiff(oldJson, newJson);
  const header = [
    `--- ${headerTitle} (Previous)`,
    `+++ ${headerTitle} (Current)`,
    `@@ -1,${oldJson.split('\n').length} +1,${newJson.split('\n').length} @@`,
  ];

  const body = lines.map((l) => {
    if (l.type === 'add') return `+ ${l.content}`;
    if (l.type === 'del') return `- ${l.content}`;
    return `  ${l.content}`;
  });

  return [...header, ...body].join('\n');
}
