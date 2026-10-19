/*
 * Operations URL state.
 *
 * One query-string contract shared by the five operations surfaces, so a
 * filtered workspace survives reload, browser back/forward and a copied link.
 *
 * The contract is deliberately narrow:
 *   - only allow-listed keys are ever read or written; a hand-edited URL cannot
 *     inject unknown query state into a page;
 *   - empty, over-long and control-character values are dropped instead of
 *     being forwarded to the API;
 *   - any change to a key other than `cursor` resets `cursor`, because a cursor
 *     is only meaningful for the exact filter set that produced it.
 *
 * The pure helpers below are exported so the contract can be tested without a
 * DOM or a router.
 */

export const OPERATIONS_VIEW_PARAM = 'view';
export const OPERATIONS_CURSOR_PARAM = 'cursor';
export const OPERATIONS_RESOURCE_PARAM = 'resourceId';

/* A filter value longer than this is a paste accident, not a query. */
const MAX_VALUE_LENGTH = 256;

export type OperationsPatch = Record<string, string | null | undefined>;

export type OperationsSearchResult = {
  /* Serialized query string, including the leading `?` when non-empty. */
  search: string;
  /* True when a non-cursor key changed and the cursor was therefore dropped. */
  cursorReset: boolean;
  /* False when the patch is a no-op, so callers can skip a history entry. */
  changed: boolean;
};

/* Control characters never belong in a filter; they are rejected rather than
 * stripped so a malformed link degrades to the unfiltered view. */
function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

export function sanitizeOperationsValue(value: string | null | undefined): string {
  if (value == null) return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (trimmed.length > MAX_VALUE_LENGTH) return '';
  if (hasControlCharacter(trimmed)) return '';
  return trimmed;
}

function toSearch(params: URLSearchParams): string {
  const query = params.toString();
  return query ? `?${query}` : '';
}

/**
 * Read the allow-listed keys out of a query string.
 *
 * Unknown keys are ignored rather than reported: the URL is operator-editable
 * and a stale bookmark must degrade to the default view, not break the page.
 */
export function readOperationsParams(
  search: string,
  keys: readonly string[],
): Record<string, string> {
  const params = new URLSearchParams(search);
  const result: Record<string, string> = {};
  for (const key of keys) {
    const value = sanitizeOperationsValue(params.get(key));
    if (value) result[key] = value;
  }
  return result;
}

/**
 * Apply a patch to the current query string.
 *
 * Foreign parameters are dropped, empty patch values remove their key, and a
 * non-cursor change invalidates the cursor in the same write so a page never
 * loads page N of a filter set it no longer displays.
 */
export function applyOperationsPatch(
  current: URLSearchParams | string,
  patch: OperationsPatch,
  keys: readonly string[],
): OperationsSearchResult {
  const currentParams = typeof current === 'string' ? new URLSearchParams(current) : current;
  const next = new URLSearchParams();
  let cursorReset = false;

  for (const key of keys) {
    const rawValue = currentParams.get(key);
    const value = sanitizeOperationsValue(rawValue);
    if (value) next.set(key, value);
    if (key !== OPERATIONS_CURSOR_PARAM && rawValue !== null && value !== rawValue) {
      cursorReset = true;
    }
  }

  let changed = toSearch(currentParams) !== toSearch(next);

  for (const [key, raw] of Object.entries(patch)) {
    if (!keys.includes(key)) continue;
    const value = sanitizeOperationsValue(raw);
    const previous = next.get(key) ?? '';
    if (value === previous) continue;
    changed = true;
    if (value) next.set(key, value);
    else next.delete(key);
    if (key !== OPERATIONS_CURSOR_PARAM) cursorReset = true;
  }

  if (cursorReset) next.delete(OPERATIONS_CURSOR_PARAM);

  const search = toSearch(next);
  changed ||= toSearch(currentParams) !== search;
  return { search, cursorReset, changed };
}

/** Parse a serialized query string back into a params object. */
export function operationsSearchToParams(search: string): URLSearchParams {
  return new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
}

/** Resolve a `view` value against the views a page actually implements. */
export function resolveOperationsView(
  requested: string | null | undefined,
  views: readonly string[] | undefined,
  fallback: string,
): string {
  if (!views || views.length === 0) return fallback;
  const candidate = sanitizeOperationsValue(requested);
  return candidate && views.includes(candidate) ? candidate : fallback;
}
