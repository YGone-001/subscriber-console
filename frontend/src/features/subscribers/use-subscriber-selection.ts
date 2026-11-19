/*
 * Subscribers selection ownership.
 *
 * A selection belongs to one query identity: filters, sort, page size, profile
 * drill-down and the raw search draft. Pagination is the only query dimension
 * that preserves it, matching the established list behavior. A query change
 * makes the old selection invisible immediately, before any effect runs, and
 * clears the stored array in the same commit so a later navigation cannot
 * resurrect it.
 *
 * Selection is memory-only; it is never serialized into the URL.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

type StoredSelection = {
  scope: string;
  imsis: string[];
};

function sameSelection(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

export type SubscriberSelection = {
  selectedImsis: string[];
  setSelectedImsis: React.Dispatch<React.SetStateAction<string[]>>;
  clearSelection: () => void;
};

const EMPTY_SELECTION: string[] = [];

export function useSubscriberSelection(scope: string): SubscriberSelection {
  const [stored, setStored] = useState<StoredSelection>({ scope, imsis: EMPTY_SELECTION });
  /* The table is memoized. A scope change must not change the identity of its
   * setter or hand it a fresh empty array on every keystroke. */
  const scopeRef = useRef(scope);
  scopeRef.current = scope;

  useEffect(() => {
    setStored((previous) => (previous.scope === scope ? previous : { scope, imsis: EMPTY_SELECTION }));
  }, [scope]);

  const selectedImsis = stored.scope === scope ? stored.imsis : EMPTY_SELECTION;

  const setSelectedImsis = useCallback<React.Dispatch<React.SetStateAction<string[]>>>((value) => {
    const activeScope = scopeRef.current;
    setStored((previous) => {
      const base = previous.scope === activeScope ? previous.imsis : EMPTY_SELECTION;
      const resolved = typeof value === 'function' ? value(base) : value;
      const unique = Array.from(new Set(resolved));
      if (previous.scope === activeScope && sameSelection(previous.imsis, unique)) return previous;
      return { scope: activeScope, imsis: unique };
    });
  }, []);

  const clearSelection = useCallback(() => {
    const activeScope = scopeRef.current;
    setStored((previous) => (previous.imsis.length === 0 ? previous : { scope: activeScope, imsis: EMPTY_SELECTION }));
  }, []);

  return { selectedImsis, setSelectedImsis, clearSelection };
}