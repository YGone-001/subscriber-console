import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { NF_HEALTH_READ_INDEX_SPECS } from './lib/nf-health-read-indexes.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
assert.deepEqual(NF_HEALTH_READ_INDEX_SPECS.map(spec => spec.collection), ['app_nf_health_samples', 'app_nf_health_runs']);
assert.deepEqual(NF_HEALTH_READ_INDEX_SPECS.map(spec => Object.entries(spec.indexes[0].key)), [
  [['targetId', 1], ['collectedAt', -1], ['_id', -1]],
  [['targetId', 1], ['startedAt', -1], ['_id', -1]],
]);
for (const spec of NF_HEALTH_READ_INDEX_SPECS) for (const index of spec.indexes) {
  assert.equal(index.unique, undefined);
  assert.equal(index.expireAfterSeconds, undefined);
}
const tool = readFileSync(resolve(root, 'scripts/migrate-nf-health-read-indexes.mjs'), 'utf8');
assert.doesNotMatch(tool, /\.(?:insertOne|insertMany|updateOne|updateMany|deleteOne|deleteMany|dropIndex|dropIndexes)\(/);
const dry = spawnSync(process.execPath, ['scripts/migrate-nf-health-read-indexes.mjs'], { cwd: root, encoding: 'utf8', env: { ...process.env, MONGODB_URI: 'mongodb://127.0.0.1:1' } });
assert.equal(dry.status, 0);
assert.match(dry.stdout, /DRY_RUN: no database connection made/);
assert.match(readFileSync(resolve(root, 'scripts/init-mongo-indexes.mjs'), 'utf8'), /NF_HEALTH_READ_INDEX_SPECS/);
console.log('PASS NF Health deterministic latest-evidence sort indexes and index-only dry-run contract');
