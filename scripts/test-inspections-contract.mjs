import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveGoRegistrations, SEMANTIC_READ_POST } from './lib/go-registrations.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const contract = JSON.parse(readFileSync(resolve(root, 'frontend/inspections-contract.json'), 'utf8'));
const registered = deriveGoRegistrations(root).keys.filter(key => / \/api\/(?:inspections|inspection-plans|inspection-runs)(?:[/{]|$)/.test(key));
assert.equal(contract.routes.length, 11);
assert.deepEqual(registered.sort(), contract.routes.map(route => `${route.method} ${route.path}`).sort());
assert.deepEqual(contract.domainWriteCollections, ['xcloud_ops.app_inspection_plans', 'xcloud_ops.app_inspection_runs']);
assert.equal(contract.sourceCollectionWrites, false);
assert.equal(contract.collectionMode, 'existing_evidence_only');
assert.ok(SEMANTIC_READ_POST.has('POST /api/inspection-plans/preview'));
for (const route of contract.routes) {
  assert.equal(route.permission, route.method === 'GET' ? 'core.read' : 'core.configure');
  if (route.method !== 'GET' && !route.path.endsWith('/preview')) assert.equal(route.freshActor, true);
}
const routes = JSON.parse(readFileSync(resolve(root, 'frontend/route-contract.json'), 'utf8'));
for (const route of contract.spaRoutes) assert.ok(routes.some(value => value.route === route));
const source = readFileSync(resolve(root, 'backend/internal/inspections/evidence.go'), 'utf8');
assert.ok(!/\.(?:InsertOne|InsertMany|UpdateOne|UpdateMany|ReplaceOne|DeleteOne|DeleteMany)\(/.test(source));
assert.ok(!source.includes('os/exec'));
for (const path of ['backend/cmd/inspections-init/main.go', 'docs/architecture/scheduled-inspections.md', 'docs/operations/scheduled-inspections.md']) assert.ok(existsSync(resolve(root, path)), path);
console.log('PASS scheduled inspection API, scope, permissions, source-read boundary and route contracts');
