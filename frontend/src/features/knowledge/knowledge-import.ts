import type { KnowledgeEntryInput } from './types';

export type KnowledgeImportEntry = KnowledgeEntryInput & { title: string };

/** Parses a single exported entry, an array, or an export envelope
 *  (`{ entries: [...] }`). Attachments are intentionally ignored: exports carry
 *  attachment metadata but not bytes, so importing them would create broken
 *  links. Invalid rows without a usable title are skipped. */
export function parseKnowledgeImport(raw: string): KnowledgeImportEntry[] {
  const parsed = JSON.parse(raw) as unknown;
  const rows = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { entries?: unknown }).entries)
      ? (parsed as { entries: unknown[] }).entries
      : [parsed];

  const out: KnowledgeImportEntry[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const record = row as Record<string, unknown>;
    const title = typeof record.title === 'string' ? record.title.trim() : '';
    if (!title) continue;
    const tags = Array.isArray(record.tags)
      ? record.tags.filter((value): value is string => typeof value === 'string')
      : [];
    out.push({
      title,
      protocol: typeof record.protocol === 'string' && record.protocol.trim() ? record.protocol.trim() : undefined,
      phenomenon: typeof record.phenomenon === 'string' ? record.phenomenon : '',
      rootCause: typeof record.rootCause === 'string' ? record.rootCause : '',
      solution: typeof record.solution === 'string' ? record.solution : '',
      tags,
      applicableScope: typeof record.applicableScope === 'string' ? record.applicableScope : '',
    });
  }
  return out;
}