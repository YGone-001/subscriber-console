/*
 * Bounded cursor paging for the discovery candidate queue.
 *
 * The URL carries only the cursor of the page being displayed, so the component
 * needs one place that knows how a cursor scroll is derived from the current
 * page envelope. Keeping it pure means the request sequence can be asserted
 * without a DOM: the helpers return the exact cursor the loader will send.
 *
 * A cursor is only meaningful for the filter set that produced it, so the
 * caller resets the scroll whenever the filters change.
 */
import type { PageInfo } from './discovery-types';

export type DiscoveryCursorScroll = {
  /* Cursors already traversed, oldest first. Its length is the zero-based page. */
  history: string[];
  /* Cursor to request next; undefined requests the first page. */
  cursor: string | undefined;
};

/** 1-based page number derived from the traversed cursors. */
export function pageIndexFor(history: readonly string[]): number {
  return history.length + 1;
}

/** A next page exists only when the server says more rows exist behind a cursor. */
export function canAdvance(page: PageInfo | null): boolean {
  return Boolean(page?.hasMore && page?.nextCursor);
}

/** Returns the next scroll, or null when the current page is the last one. */
export function nextScroll(
  history: readonly string[],
  page: PageInfo | null,
): DiscoveryCursorScroll | null {
  if (!page?.hasMore || !page.nextCursor) return null;
  const next = [...history, page.nextCursor];
  return { history: next, cursor: page.nextCursor };
}

/** Returns the previous scroll; the first page requests no cursor. */
export function previousScroll(history: readonly string[]): DiscoveryCursorScroll {
  if (history.length === 0) return { history: [], cursor: undefined };
  const next = history.slice(0, -1);
  return { history: next, cursor: next.length > 0 ? next[next.length - 1] : undefined };
}

/** Resets the scroll to the first page. */
export function firstScroll(): DiscoveryCursorScroll {
  return { history: [], cursor: undefined };
}
