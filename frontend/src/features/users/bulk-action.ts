/*
 * Bulk user-action orchestration.
 *
 * The historical UI offers multi-selection with a per-user progress list, but
 * there is no bulk API and there must not be one: every bulk action is a
 * SEQUENTIAL series of the existing single-user endpoints, each of which
 * re-validates the actor and enforces its own rate limit on the server.
 *
 * This module owns that sequence so the guarantees are testable without a DOM:
 *
 *   - one request per user, in order, never concurrent;
 *   - never retried automatically (a failure is reported, not repeated);
 *   - a cancellation requested before a user's turn stops the run and marks the
 *     remaining users cancelled;
 *   - a cancellation requested while a user is in flight lets that request
 *     finish and is then honoured;
 *   - every failure is reported per user, so a partial success is visible.
 */
import type { BulkAction, RoleKey, UserStatus } from './types';

export type BulkItemStatus = 'pending' | 'running' | 'success' | 'failed' | 'cancelled';

export type BulkItemResult = {
  username: string;
  status: BulkItemStatus;
  reason?: string;
};

export type BulkActionPayload = {
  role?: RoleKey;
  status?: UserStatus;
  reason?: string;
};

export type BulkRunOptions = {
  usernames: string[];
  action: BulkAction;
  /** Target role, required by the `assignRole` action. */
  role?: RoleKey;
  /** Operator-supplied justification, forwarded to the single-user endpoint. */
  reason?: string;
  /** Applies one user's change through the existing single-user endpoint. */
  apply: (username: string, payload: BulkActionPayload) => Promise<unknown>;
  /** Polled before each user; a `true` answer stops the run. */
  isCancelRequested: () => boolean;
  /** Reports each transition so the progress list can render it live. */
  onItemStatus: (username: string, status: BulkItemStatus, reason?: string) => void;
  /** Dictionary access for the two generated failure reasons. */
  translate: (key: string) => string;
};

export type BulkRunResult = {
  items: BulkItemResult[];
  succeeded: number;
  failed: number;
  cancelled: number;
  /** True when the run stopped early because a cancellation was requested. */
  cancelledEarly: boolean;
};

/** The request body for one user, derived from the bulk action. */
export function bulkPayload(action: BulkAction, role: RoleKey | undefined, reason: string | undefined): BulkActionPayload {
  if (action === 'assignRole') return { role, reason };
  return { status: action === 'enable' ? 'active' : 'disabled', reason };
}

export async function runBulkAction(options: BulkRunOptions): Promise<BulkRunResult> {
  const { usernames, action, role, reason, apply, isCancelRequested, onItemStatus, translate } = options;
  const items: BulkItemResult[] = usernames.map((username) => ({ username, status: 'pending' as BulkItemStatus }));
  let cancelledEarly = false;

  for (const item of items) {
    if (isCancelRequested()) {
      cancelledEarly = true;
      break;
    }

    item.status = 'running';
    item.reason = undefined;
    onItemStatus(item.username, 'running');

    try {
      await apply(item.username, bulkPayload(action, role, reason));
      item.status = 'success';
      onItemStatus(item.username, 'success');
    } catch (failure) {
      item.status = 'failed';
      item.reason = failure instanceof Error && failure.message
        ? failure.message
        : translate('users_bulk_default_failure');
      onItemStatus(item.username, 'failed', item.reason);
    }
  }

  /* A cancellation stops the run; everything still pending is reported cancelled. */
  for (const item of items) {
    if (item.status !== 'pending') continue;
    item.status = 'cancelled';
    onItemStatus(item.username, 'cancelled');
  }

  return {
    items,
    succeeded: items.filter((item) => item.status === 'success').length,
    failed: items.filter((item) => item.status === 'failed').length,
    cancelled: items.filter((item) => item.status === 'cancelled').length,
    cancelledEarly,
  };
}
