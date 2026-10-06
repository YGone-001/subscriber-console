/*
 * Bulk user-action contract.
 *
 * The historical UI offers multi-selection, but there is no bulk API and the
 * frontend must not invent one: every bulk action is a sequential series of the
 * existing single-user endpoints. These tests pin the guarantees that makes
 * necessary — one request per user, no concurrency, no automatic retry, a
 * per-user outcome, and cancellation that stops the run without losing the work
 * already done.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { bulkPayload, runBulkAction, type BulkItemStatus } from '../src/features/users/bulk-action';
import { MutationApiError } from '../src/lib/api/mutation-client';

const translate = (key: string) => key;

type Recorded = { username: string; payload: unknown };

/** Build a runner whose `apply` is scripted per user. */
function harness(
  usernames: string[],
  script: (username: string, call: number) => Promise<unknown> | unknown,
  options: {
    action?: 'enable' | 'disable' | 'assignRole';
    role?: 'admin' | 'operator' | 'viewer';
    reason?: string;
    cancelAfter?: number;
    /** Set the cancellation flag before the run is created. */
    cancelBeforeStart?: boolean;
  } = {},
) {
  const calls: Recorded[] = [];
  const transitions: Array<{ username: string; status: BulkItemStatus; reason?: string }> = [];
  let cancelled = Boolean(options.cancelBeforeStart);
  const cancelAfter = options.cancelAfter;

  const run = runBulkAction({
    usernames,
    action: options.action ?? 'disable',
    role: options.role,
    reason: options.reason,
    translate,
    isCancelRequested: () => cancelled,
    apply: async (username, payload) => {
      calls.push({ username, payload });
      if (cancelAfter !== undefined && calls.length >= cancelAfter) cancelled = true;
      return script(username, calls.length);
    },
    onItemStatus: (username, status, reason) => { transitions.push({ username, status, reason }); },
  });

  return { run, calls, transitions, cancel: () => { cancelled = true; } };
}

/* ------------------------------------------------------------ payloads -- */

test('each bulk action maps onto the existing single-user request body', () => {
  assert.deepEqual(bulkPayload('disable', undefined, 'cleanup'), { status: 'disabled', reason: 'cleanup' });
  assert.deepEqual(bulkPayload('enable', undefined, undefined), { status: 'active', reason: undefined });
  assert.deepEqual(bulkPayload('assignRole', 'viewer', 'rotation'), { role: 'viewer', reason: 'rotation' });
});

/* --------------------------------------------------------- happy path -- */

test('a fully successful run reports every user as succeeded', async () => {
  const { run, calls, transitions } = harness(['a', 'b', 'c'], () => undefined);
  const result = await run;

  assert.equal(result.succeeded, 3);
  assert.equal(result.failed, 0);
  assert.equal(result.cancelled, 0);
  assert.equal(result.cancelledEarly, false);
  assert.deepEqual(calls.map((call) => call.username), ['a', 'b', 'c']);
  assert.deepEqual(transitions.filter((entry) => entry.status === 'running').map((entry) => entry.username), ['a', 'b', 'c']);
});

test('requests are issued strictly one at a time, in selection order', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const order: string[] = [];
  const result = await runBulkAction({
    usernames: ['first', 'second', 'third'],
    action: 'disable',
    translate,
    isCancelRequested: () => false,
    apply: async (username) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      order.push(`start:${username}`);
      await new Promise((done) => setTimeout(done, 1));
      order.push(`end:${username}`);
      inFlight -= 1;
    },
    onItemStatus: () => undefined,
  });

  assert.equal(maxInFlight, 1, 'a bulk run must never issue concurrent requests');
  assert.deepEqual(order, ['start:first', 'end:first', 'start:second', 'end:second', 'start:third', 'end:third']);
  assert.equal(result.succeeded, 3);
});

/* ------------------------------------------------------ partial failure -- */

test('a partial failure reports the failed user and keeps the successful ones', async () => {
  const { run } = harness(['a', 'b', 'c'], (username) => {
    if (username === 'b') throw new MutationApiError(409, 'Conflict or concurrent modification detected.', undefined, 'PRECONDITION_FAILED');
    return undefined;
  });
  const result = await run;

  assert.equal(result.succeeded, 2);
  assert.equal(result.failed, 1);
  assert.equal(result.items.find((item) => item.username === 'b')?.status, 'failed');
  assert.match(result.items.find((item) => item.username === 'b')?.reason ?? '', /conflict/i);
  assert.equal(result.items.find((item) => item.username === 'a')?.status, 'success');
  assert.equal(result.items.find((item) => item.username === 'c')?.status, 'success');
});

test('permission, conflict and rate-limit failures each surface their own reason', async () => {
  const failures: Record<string, MutationApiError> = {
    forbidden: new MutationApiError(403, 'Permission denied.'),
    conflict: new MutationApiError(409, 'Conflict or concurrent modification detected.', undefined, 'PRECONDITION_FAILED'),
    throttled: new MutationApiError(429, 'Rate limit exceeded. Please try again later.', undefined, 'RATE_LIMITED', 30),
  };
  const { run } = harness(['forbidden', 'conflict', 'throttled'], (username) => { throw failures[username]; });
  const result = await run;

  assert.equal(result.failed, 3);
  assert.equal(result.items[0].reason, 'Permission denied.');
  assert.match(result.items[1].reason ?? '', /conflict/i);
  assert.match(result.items[2].reason ?? '', /rate limit/i);
});

test('a failure with no message falls back to the dictionary rather than rendering blank', async () => {
  const { run } = harness(['a'], () => { throw new Error(''); });
  const result = await run;
  assert.equal(result.items[0].reason, 'users_bulk_default_failure');
});

/* ------------------------------------------------------- no auto-retry -- */

test('a failed request is never retried automatically', async () => {
  const attempts: string[] = [];
  const { run } = harness(['a', 'b'], (username) => {
    attempts.push(username);
    throw new MutationApiError(429, 'Rate limit exceeded. Please try again later.');
  });
  const result = await run;

  assert.deepEqual(attempts, ['a', 'b'], 'each user must be attempted exactly once');
  assert.equal(result.failed, 2);
});

/* ------------------------------------------------------- cancellation -- */

test('cancelling before the first request issues nothing and cancels everyone', async () => {
  const { run, calls } = harness(['a', 'b', 'c'], () => undefined, { cancelBeforeStart: true });
  const result = await run;

  assert.deepEqual(calls, [], 'a cancellation before submit must not touch the API');
  assert.equal(result.cancelled, 3);
  assert.equal(result.succeeded, 0);
  assert.equal(result.cancelledEarly, true);
  assert.deepEqual(result.items.map((item) => item.status), ['cancelled', 'cancelled', 'cancelled']);
});

test('cancelling mid-run keeps the completed work and cancels the remainder', async () => {
  const { run, calls } = harness(['a', 'b', 'c', 'd'], () => undefined, { cancelAfter: 2 });
  const result = await run;

  assert.deepEqual(calls.map((call) => call.username), ['a', 'b'], 'the in-flight user finishes, the rest are skipped');
  assert.equal(result.succeeded, 2);
  assert.equal(result.cancelled, 2);
  assert.equal(result.cancelledEarly, true);
  assert.deepEqual(result.items.map((item) => `${item.username}:${item.status}`), [
    'a:success', 'b:success', 'c:cancelled', 'd:cancelled',
  ]);
});

test('a failure does not stop the run, so the operator sees every outcome', async () => {
  const { run, calls } = harness(['a', 'b', 'c'], (username) => {
    if (username === 'b') throw new MutationApiError(403, 'Permission denied.');
    return undefined;
  });
  const result = await run;

  assert.deepEqual(calls.map((call) => call.username), ['a', 'b', 'c']);
  assert.equal(result.failed, 1);
  assert.equal(result.succeeded, 2);
  assert.equal(result.cancelledEarly, false);
});

/* -------------------------------------------------- boundary contracts -- */

test('the run reports progress transitions so the modal can render live', async () => {
  const { run, transitions } = harness(['a', 'b'], () => undefined);
  await run;
  assert.deepEqual(transitions, [
    { username: 'a', status: 'running', reason: undefined },
    { username: 'a', status: 'success', reason: undefined },
    { username: 'b', status: 'running', reason: undefined },
    { username: 'b', status: 'success', reason: undefined },
  ]);
});

test('the bulk path uses only the single-user endpoint and never a bulk route', () => {
  const root = resolve(import.meta.dirname, '..', 'src');
  const runner = readFileSync(resolve(root, 'features', 'users', 'bulk-action.ts'), 'utf8');
  assert.doesNotMatch(runner, /\/api\//, 'the orchestration module must not own any endpoint');

  const hook = readFileSync(resolve(root, 'features', 'users', 'hooks', 'useUserCrud.ts'), 'utf8');
  assert.match(hook, /usersApi\.update\(username, payload\)/, 'each user must go through the single-user update');
  assert.doesNotMatch(hook, /bulk-delete|batch-update|\/api\/users\/bulk/, 'no bulk endpoint may be introduced');
  assert.match(hook, /runBulkAction\(/, 'the run must go through the tested orchestrator');
});

test('the bulk path never retries by wrapping the request in a loop of its own', () => {
  const root = resolve(import.meta.dirname, '..', 'src');
  const runner = readFileSync(resolve(root, 'features', 'users', 'bulk-action.ts'), 'utf8');
  /* Exactly one `apply(` call site: the retry would have to appear as a second. */
  assert.equal((runner.match(/await apply\(/g) ?? []).length, 1, 'exactly one apply call site');
});
