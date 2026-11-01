/*
 * Latest-request contract for imperative topology reads.
 *
 * The ledger and the one-hop neighbourhood are both loaded through imperative
 * callbacks, so a slow earlier response can land after a newer one. These
 * assertions pin the guard that decides which response may write state, and the
 * wiring that makes both surfaces use it.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createLatestRequestGuard } from '../src/lib/api/latest-request';

const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), 'utf8');

test('only the newest guard token stays current', () => {
  const guard = createLatestRequestGuard();
  const first = guard.begin();
  assert.equal(guard.isCurrent(first), true, 'the first claim is current while nothing superseded it');

  const second = guard.begin();
  assert.equal(guard.isCurrent(first), false, 'a superseded claim is never current');
  assert.equal(guard.isCurrent(second), true, 'the newest claim wins');
});

test('out-of-order completion keeps the newest result and drops the stale one', async () => {
  const guard = createLatestRequestGuard();
  let committed = '';

  const load = async (label: string, resolveAfter: () => Promise<void>) => {
    const token = guard.begin();
    await resolveAfter();
    if (!guard.isCurrent(token)) return;
    committed = label;
  };

  let releaseSlow: () => void = () => {};
  const slow = new Promise<void>((resolve) => {
    releaseSlow = resolve;
  });
  const slowRun = load('slow-first-request', () => slow);
  const fastRun = load('fast-second-request', async () => {});

  await fastRun;
  releaseSlow();
  await slowRun;

  assert.equal(committed, 'fast-second-request', 'the stale response must not overwrite the newer one');
});

test('a superseded token never reports an error either', async () => {
  const guard = createLatestRequestGuard();
  const events: string[] = [];

  const load = async (label: string, settle: () => Promise<void>, shouldFail = false) => {
    const token = guard.begin();
    try {
      await settle();
      if (shouldFail) throw new Error('stale read failed');
      if (!guard.isCurrent(token)) return;
      events.push(`data:${label}`);
    } catch {
      if (!guard.isCurrent(token)) return;
      events.push(`error:${label}`);
    }
  };

  let releaseSlow: () => void = () => {};
  const slow = new Promise<void>((resolve) => {
    releaseSlow = resolve;
  });
  const slowRun = load('stale', () => slow, true);
  const fastRun = load('fresh', async () => {});

  await fastRun;
  releaseSlow();
  await slowRun;

  assert.deepEqual(events, ['data:fresh'], 'a stale failure is dropped silently instead of surfacing an error');
});

test('the read clients accept an abort signal without changing the default call path', () => {
  const api = read('../src/features/topology/topology-api.ts');
  assert.ok(api.includes('getJsonWithSignal'), 'the signal path must use the shared signal-aware reader');
  assert.ok(
    api.includes('signal?: AbortSignal'),
    'the signal must be an optional parameter so existing callers keep working',
  );
  assert.ok(
    api.includes(': getJson<ListEdgesResponse>(url)') && api.includes(': getJson<NeighborsResponse>(url)'),
    'a call without a signal must keep the original reader',
  );
});

test('the ledger and the one-hop page both guard their reads', () => {
  for (const relative of [
    '../src/features/topology/TopologyPage.tsx',
    '../src/features/topology/ResourceTopologyPage.tsx',
  ]) {
    const source = read(relative);
    assert.ok(
      source.includes('createLatestRequestGuard()'),
      `${relative} must own a latest-request guard`,
    );
    assert.ok(
      source.includes('readGuard.current.begin()') && source.includes('isCurrent(token)'),
      `${relative} must claim a token and drop results that are no longer current`,
    );
    assert.ok(
      /if \(!readGuard\.current\.isCurrent\(token\)\) return;/.test(source),
      `${relative} must bail out before writing stale state`,
    );
    assert.ok(
      source.includes('controller.signal'),
      `${relative} must abort the superseded socket instead of leaving it open`,
    );
  }
});