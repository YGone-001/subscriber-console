/*
 * Latest-request guard for imperative reads.
 *
 * Several topology surfaces load data through imperative callbacks rather than
 * SWR, so a slow earlier response can land after a newer one and overwrite the
 * filtered result the operator is now looking at. The guard gives every load a
 * monotonically increasing token and lets the caller drop any result that is no
 * longer the newest request. Stale results are discarded silently: they are not
 * an error and must never be reported as one.
 *
 * The guard carries no state of its own about data, so it stays a pure helper
 * that can be unit-tested without a DOM.
 */

export type LatestRequestGuard = {
  /** Claims the next token; only the newest claim stays current. */
  begin(): number;
  /** True only for the most recently claimed token. */
  isCurrent(token: number): boolean;
};

export function createLatestRequestGuard(): LatestRequestGuard {
  let current = 0;
  return {
    begin: () => {
      current += 1;
      return current;
    },
    isCurrent: (token: number) => token === current,
  };
}