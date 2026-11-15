export type DiffLineType = 'same' | 'added' | 'removed';

export type DiffLine = {
  type: DiffLineType;
  text: string;
};

export type TextDiff = {
  lines: DiffLine[];
  added: number;
  removed: number;
  truncated: boolean;
};

const MAX_DIFF_LINES = 400;

/** A bounded positional line comparison. It is intentionally simple: the
 *  operator needs to see what changed, not an optimal edit script over a 200KB
 *  Markdown body. Identical lines stay neutral; a changed position emits the
 *  previous line as removed and the current line as added. */
export function diffLines(current: string, previous: string): TextDiff {
  if (current === previous) return { lines: [], added: 0, removed: 0, truncated: false };
  const currentLines = current.split('\n');
  const previousLines = previous.split('\n');
  const total = Math.max(currentLines.length, previousLines.length);
  const lines: DiffLine[] = [];
  let added = 0;
  let removed = 0;

  for (let index = 0; index < total && lines.length < MAX_DIFF_LINES; index += 1) {
    const next = currentLines[index];
    const before = previousLines[index];
    if (next === before) {
      if (next !== undefined) lines.push({ type: 'same', text: next });
      continue;
    }
    if (before !== undefined) {
      lines.push({ type: 'removed', text: before });
      removed += 1;
    }
    if (next !== undefined) {
      lines.push({ type: 'added', text: next });
      added += 1;
    }
  }

  return { lines, added, removed, truncated: total > MAX_DIFF_LINES };
}