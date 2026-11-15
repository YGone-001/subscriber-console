import type { KnowledgeSummary } from './types';

export type KnowledgeMatchField = 'title' | 'phenomenon' | 'tag' | 'protocol' | 'body';

export type KnowledgeMatchContext = {
  field: KnowledgeMatchField;
  value: string;
};

/** Explains why a search result matched. Title and phenomenon are already
 *  highlighted in the row; tag/protocol/body matches get an explicit hint.
 *  Root cause and solution are not in the list projection, so a match there is
 *  reported as a body match rather than pretending the row is unrelated. */
export function matchContext(entry: KnowledgeSummary, query: string): KnowledgeMatchContext | null {
  const needle = query.trim().toLowerCase();
  if (!needle) return null;

  if (entry.title.toLowerCase().includes(needle)) {
    return { field: 'title', value: entry.title };
  }
  if (entry.phenomenon.toLowerCase().includes(needle)) {
    return { field: 'phenomenon', value: entry.phenomenon };
  }
  const tag = entry.tags.find((value) => value.toLowerCase().includes(needle));
  if (tag) return { field: 'tag', value: tag };
  if ((entry.protocol || '').toLowerCase().includes(needle)) {
    return { field: 'protocol', value: entry.protocol };
  }
  return { field: 'body', value: '' };
}