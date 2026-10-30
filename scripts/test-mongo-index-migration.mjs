#!/usr/bin/env node
/**
 * Deterministic contract for the business index specification and the
 * index-only migration tool. It never connects to MongoDB.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUSINESS_INDEX_SPECS } from './lib/mongo-business-indexes.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const migration = readFileSync(resolve(root, 'scripts/migrate-mongo-indexes.mjs'), 'utf8');
const initializer = readFileSync(resolve(root, 'scripts/init-mongo-indexes.mjs'), 'utf8');

assert.equal(BUSINESS_INDEX_SPECS.length, 4, 'the business index spec must cover four collections');
const targets = new Set(BUSINESS_INDEX_SPECS.map((spec) => `${spec.database}.${spec.collection}`));
assert.deepEqual(
  [...targets].sort(),
  ['xcloud.ocs_balances', 'xcloud.ocs_subscribers', 'xcloud.subscribers', 'xcloud_ops.app_profiles'],
);

const expected = {
  'xcloud.subscribers': ['subscriber_msisdn', 'uniq_imsi'],
  'xcloud.ocs_subscribers': ['ocs_subscriber_msisdn', 'ocs_subscriber_plan_id', 'uniq_ocs_subscriber_imsi'],
  'xcloud.ocs_balances': ['ocs_balance_updated_at_desc', 'uniq_ocs_balance_imsi'],
  'xcloud_ops.app_profiles': ['profile_updated_at_desc', 'uniq_profile_name'],
};
for (const spec of BUSINESS_INDEX_SPECS) {
  const names = spec.indexes.map((index) => index.name).sort();
  assert.deepEqual(names, expected[`${spec.database}.${spec.collection}`]);
  assert.equal(new Set(names).size, names.length, 'index names must be unique within a collection');
  const keys = spec.indexes.map((index) => JSON.stringify(index.key));
  assert.equal(new Set(keys).size, keys.length, 'one spec entry per key pattern');
  for (const index of spec.indexes) {
    assert.ok(Object.keys(index.key).length > 0, `${index.name} must have a key`);
  }
}

assert.match(initializer, /from '\.\/lib\/mongo-business-indexes\.mjs'/);
assert.match(initializer, /for \(const spec of BUSINESS_INDEX_SPECS\)/);
assert.match(migration, /const apply = args\.has\('--apply'\)/);
assert.match(migration, /const replaceConflicting = args\.has\('--replace-conflicting'\)/);
assert.match(migration, /duplicateSample/);
assert.match(migration, /createIndexes\(\[entry\.desired\]\)/);
for (const forbidden of ['insertOne', 'insertMany', 'updateOne', 'updateMany', 'deleteOne', 'deleteMany', 'bulkWrite']) {
  assert.ok(
    !migration.toLowerCase().includes(forbidden.toLowerCase()),
    `index migration must not perform business writes (${forbidden})`,
  );
}
assert.ok(!/provisionOcs|provision_missing/i.test(migration), 'index migration must not provision OCS rows');

console.log('mongo_index_spec_collections=4');
console.log('mongo_index_spec_indexes=' + BUSINESS_INDEX_SPECS.reduce((count, spec) => count + spec.indexes.length, 0));
console.log('mongo_index_migration_contract=PASS');
