/**
 * unitParser.ts
 * Utility functions for parsing human-readable units.
 * Provides conversions between strings like "10G" and Bytes, or "60m" and Seconds.
 *
 * Offset mapping (Strictly base-2 for data):
 * 1 KB = 1024 Bytes
 * 1 MB = 1024 * 1024 = 1048576 Bytes
 * 1 GB = 1024 * 1024 * 1024 = 1073741824 Bytes
 * 1 TB = 1024 * 1024 * 1024 * 1024 = 1099511627776 Bytes
 */

const BYTE_UNITS: Record<string, number> = {
  "": 1,
  B: 1,
  BYTE: 1,
  BYTES: 1,
  K: 1024,
  KB: 1024,
  KIB: 1024,
  M: 1024 ** 2,
  MB: 1024 ** 2,
  MIB: 1024 ** 2,
  G: 1024 ** 3,
  GB: 1024 ** 3,
  GIB: 1024 ** 3,
  T: 1024 ** 4,
  TB: 1024 ** 4,
  TIB: 1024 ** 4,
};

export const BYTE_INPUT_UNITS = [
  { label: 'B', value: 'B' },
  { label: 'KB', value: 'KB' },
  { label: 'MB', value: 'MB' },
  { label: 'GB', value: 'GB' },
  { label: 'TB', value: 'TB' },
] as const;

export const TIME_INPUT_UNITS = [
  { label: 'sec', value: 's' },
  { label: 'min', value: 'm' },
  { label: 'hour', value: 'h' },
  { label: 'day', value: 'd' },
] as const;

const BYTE_UNIT_PATTERN = Object.keys(BYTE_UNITS)
  .filter(Boolean)
  .sort((a, b) => b.length - a.length)
  .join("|");

export function parseBytes(input: string | number): number {
  if (typeof input === 'number') return Number.isFinite(input) ? Math.floor(input) : 0;
  const str = String(input).trim().replace(/,/g, '').toUpperCase();
  if (!str) return 0;

  const match = str.match(new RegExp(`^(\\d+(?:\\.\\d+)?|\\.\\d+)\\s*(${BYTE_UNIT_PATTERN})?$`));
  if (!match) return 0;

  const val = parseFloat(match[1]);
  if (!Number.isFinite(val)) return 0;

  const unit = match[2] || "";
  return Math.floor(val * BYTE_UNITS[unit]);
}

export function composeByteInput(value: string | number, unit: string): string {
  const normalizedValue = String(value).trim();
  const normalizedUnit = String(unit || 'GB').trim().toUpperCase();
  if (!normalizedValue) return `0 ${normalizedUnit}`;
  return `${normalizedValue} ${BYTE_UNITS[normalizedUnit] ? normalizedUnit : 'GB'}`;
}

export function splitByteInput(input: string | number, fallbackUnit = 'GB'): { value: string; unit: string } {
  if (typeof input === 'number') {
    const formatted = formatBytes(input);
    return splitByteInput(formatted, fallbackUnit);
  }

  const str = String(input).trim().replace(/,/g, '').toUpperCase();
  const match = str.match(new RegExp(`^(\\d+(?:\\.\\d+)?|\\.\\d+)\\s*(${BYTE_UNIT_PATTERN})?$`));
  if (!match) return { value: '0', unit: fallbackUnit };

  const unit = match[2] || fallbackUnit;
  return {
    value: match[1],
    unit: BYTE_UNITS[unit] ? unit : fallbackUnit,
  };
}

export function formatBytes(bytes: number): string {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  if (i === 0) return bytes + ' B';
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

export function formatBytesAligned(b1: number, b2: number): [string, string] {
  const maxBytes = Math.max(b1, b2);
  if (!maxBytes || maxBytes === 0) return [b1 + ' B', b2 + ' B'];
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(maxBytes) / Math.log(k));

  const formatSingle = (bytes: number) => {
    if (i === 0) return bytes + ' B';
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  return [formatSingle(b1), formatSingle(b2)];
}


export function parseSeconds(input: string | number): number {
  if (typeof input === 'number') return Number.isFinite(input) ? Math.floor(input) : 0;
  const str = String(input).trim().toLowerCase();
  // match number and optional time suffix (e.g. 60m, 1h, 2d)
  const match = str.match(/^([\d.]+)\s*([smhd]?)$/);
  if (!match) return Number(str) || 0;

  const val = parseFloat(match[1]);
  if (isNaN(val)) return 0;

  const unit = match[2];

  if (unit === 'm') return Math.floor(val * 60);
  if (unit === 'h') return Math.floor(val * 3600);
  if (unit === 'd') return Math.floor(val * 86400);
  return Math.floor(val);
}

export function composeSecondsInput(value: string | number, unit: string): string {
  const normalizedValue = String(value).trim();
  const normalizedUnit = TIME_INPUT_UNITS.some((item) => item.value === unit) ? unit : 'h';
  if (!normalizedValue) return `0${normalizedUnit}`;
  return `${normalizedValue}${normalizedUnit}`;
}

export function splitSecondsInput(input: string | number, fallbackUnit = 'h'): { value: string; unit: string } {
  if (typeof input === 'number') {
    const formatted = formatSeconds(input);
    return splitSecondsInput(formatted, fallbackUnit);
  }

  const str = String(input).trim().toLowerCase();
  const match = str.match(/^(\d+(?:\.\d+)?|\.\d+)\s*([smhd]?)$/);
  if (!match) return { value: '0', unit: fallbackUnit };

  const unit = match[2] || fallbackUnit;
  return {
    value: match[1],
    unit: TIME_INPUT_UNITS.some((item) => item.value === unit) ? unit : fallbackUnit,
  };
}

export function formatSeconds(seconds: number): string {
  if (!seconds || seconds === 0) return '0s';
  if (seconds % 86400 === 0) return `${seconds / 86400}d`;
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

export function parseEvents(input: string | number): number {
  if (typeof input === 'number') return Number.isFinite(input) ? Math.floor(Math.max(0, input)) : 0;
  const parsed = Number(String(input).trim().replace(/,/g, ''));
  return Number.isFinite(parsed) ? Math.floor(Math.max(0, parsed)) : 0;
}

export function formatEvents(events: number): string {
  const safeEvents = Number.isFinite(events) ? Math.max(0, Math.floor(events)) : 0;
  return `${safeEvents}`;
}
