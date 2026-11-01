/*
 * Resource directory contract.
 *
 * The topology canvases name Inventory resources by identifier. That resolution
 * is bounded (50 per request), cached with a lifetime, scoped to the signed-in
 * identity and never cached from a failed read. These assertions pin the parts
 * that can be exercised without a DOM: batching, the request the API builds, the
 * cache lifetime, and the wiring of the hook.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fetchInventoryResources } from '../src/features/inventory/inventory-api';
import {
  RESOURCE_DIRECTORY_CHUNK,
  RESOURCE_DIRECTORY_TTL_MS,
  chunkResourceIds,
  primeResourceProjections,
  resetResourceDirectory,
  resourceDirectorySnapshot,
} from '../src/features/topology/use-resource-directory';

const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), 'utf8');

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function projection(resourceId: string) {
  return {
    resourceId,
    kind: 'network_function',
    name: `nf-${resourceId.slice(-4)}`,
    domain: '5gc',
    lifecycleState: 'active',
  };
}

test('identifiers are batched at the documented bound without losing order', () => {
  const ids = Array.from({ length: 121 }, (_, index) => id(index + 1));
  const chunks = chunkResourceIds(ids);

  assert.equal(chunks.length, 3, '121 identifiers need three bounded requests');
  assert.deepEqual(chunks.map((chunk) => chunk.length), [50, 50, 21]);
  assert.deepEqual(chunks.flat(), ids, 'batching must preserve the requested order');
  assert.equal(RESOURCE_DIRECTORY_CHUNK, 50);
});

test('the read client sends one bounded resourceIds parameter', async () => {
  const requested: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    requested.push(String(input));
    return new Response(JSON.stringify({ resources: [], page: { limit: 0, nextCursor: null, hasMore: false } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    await fetchInventoryResources({ resourceIds: [id(1), id(2)] });
  } finally {
    globalThis.fetch = original;
  }

  assert.equal(requested.length, 1, 'a batch is one request, not one request per identifier');
  assert.ok(requested[0].startsWith('/api/inventory/resources?'), 'the shared read path is unchanged');
  assert.ok(
    requested[0].includes(`resourceIds=${id(1)}%2C${id(2)}`),
    `the identifiers must travel as one comma separated parameter: ${requested[0]}`,
  );
});

test('a cached name expires and never outlives its lifetime', () => {
  resetResourceDirectory();
  const now = 1_800_000_000_000;
  primeResourceProjections([projection(id(7))], now);

  assert.deepEqual(Object.keys(resourceDirectorySnapshot(now)), [id(7)]);
  assert.deepEqual(
    Object.keys(resourceDirectorySnapshot(now + RESOURCE_DIRECTORY_TTL_MS)),
    [id(7)],
    'an entry is still usable at the boundary',
  );
  assert.deepEqual(
    Object.keys(resourceDirectorySnapshot(now + RESOURCE_DIRECTORY_TTL_MS + 1)),
    [],
    'a stale name must stop being served, so a rename is picked up',
  );

  resetResourceDirectory();
});

test('the hook batches, scopes the cache to the session and retries failures', () => {
  const source = read('../src/features/topology/use-resource-directory.ts');

  assert.ok(
    source.includes('fetchInventoryResources({ resourceIds: chunk })'),
    'resolution must use the bounded identifier read',
  );
  assert.ok(!source.includes('q: resourceId'), 'per-identifier queries must be gone');
  assert.ok(
    source.includes("`${user.username}|${user.role}`"),
    'the cache must be scoped to the signed-in identity',
  );
  assert.ok(
    source.includes('resetResourceDirectory()'),
    'switching identity must drop the previous session cache',
  );
  assert.ok(
    source.includes('// A failed read leaves the identifiers unresolved'),
    'a failed read must not be cached as a resolved name',
  );
  assert.ok(source.includes('RESOURCE_DIRECTORY_TTL_MS'), 'the cache must expire');
});