import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createJiti } from 'jiti';

const root = resolve(import.meta.dirname, '..');
const frontend = join(root, 'frontend', 'src');
const jiti = createJiti(import.meta.url);

const removedPaths = [
  'frontend/src/app/api/approvals',
  'frontend/src/app/api/audit',
  'frontend/src/app/(dashboard)/approvals',
  'frontend/src/app/(dashboard)/audit-logs',
  'frontend/src/app/(dashboard)/ocs/approvals',
  'frontend/src/app/(dashboard)/ocs/audit',
  'frontend/src/server/approvalCreator.ts',
  'frontend/src/server/approvalExecution.ts',
  'frontend/src/server/approvalExecutors.ts',
  'frontend/src/server/approvalWorkflow.ts',
  'frontend/src/server/repositories/approvalRepository.ts',
  'backend/internal/approval',
];

function containsFiles(directory) {
  return readdirSync(directory).some((name) => {
    const path = join(directory, name);
    return statSync(path).isFile() || containsFiles(path);
  });
}

for (const path of removedPaths) {
  const absolute = join(root, path);
  const hasFiles = existsSync(absolute) && (statSync(absolute).isFile() || containsFiles(absolute));
  assert.equal(hasFiles, false, `${path} must remain removed`);
}

function sourceFiles(directory) {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory()
      ? sourceFiles(path)
      : /\.(?:ts|tsx)$/.test(name) ? [path] : [];
  });
}

const productionSource = sourceFiles(frontend)
  .map((path) => readFileSync(path, 'utf8'))
  .join('\n');

for (const forbidden of ['app_approvals', 'approval_required', 'AUDIT_UNAVAILABLE', 'APPROVAL_GOVERNED']) {
  assert.doesNotMatch(productionSource, new RegExp(forbidden), `frontend production source contains ${forbidden}`);
}

const { CUTOVER_TABLE } = jiti(join(root, 'frontend/src/lib/cutover-routing.ts'));
assert.equal(CUTOVER_TABLE.length, 36, 'CUTOVER_TABLE must be exactly 36');
assert.equal(CUTOVER_TABLE.filter((route) => route.owner === 'go').length, 36, 'ACTUALLY_ROUTED must be exactly 36');

console.log('Direct operations contract passed: governance surfaces removed; CUTOVER_TABLE=36; ACTUALLY_ROUTED=36.');
