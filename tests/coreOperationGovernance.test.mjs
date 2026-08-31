import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import * as coreOperations from '../src/server/coreOperationRegistry.ts';

const root = new URL('..', import.meta.url).pathname.replace(/^\//, '').replaceAll('/', '\\');
const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(file);
    return /\.(?:ts|tsx|js|mjs)$/.test(entry.name) ? [file] : [];
  });
}

test('core operation registry is fail-closed until real managed targets and executors exist', () => {
  assert.deepEqual(coreOperations.coreManagedTargetRegistry, []);
  assert.deepEqual(coreOperations.coreOperationRegistry, []);
  assert.deepEqual(coreOperations.automaticCoreOperationExecutorIds, []);
  assert.equal(coreOperations.getManagedCoreTarget('amf-primary'), undefined);
  assert.equal(coreOperations.getCoreOperationDefinition('NF_RESTART'), undefined);
  assert.doesNotThrow(() => coreOperations.assertCoreOperationExecutorCoverage());
  assert.throws(
    () => coreOperations.assertCoreOperationCoverage([], [{
      operation: 'TEST_RESTART',
      targetType: 'test_nf',
      governanceMode: 'APPROVAL_GOVERNED',
      executionMode: 'automatic',
      riskLevel: 'high',
      permission: 'core.operate',
      requiresIndependentReviewer: true,
      requiresMaintenanceWindow: true,
      executorId: 'TEST_RESTART_EXECUTOR',
    }]),
    /CORE_OPERATION_EXECUTOR_MISSING:TEST_RESTART/,
  );
});

test('approval execution loads the core executor coverage invariant', () => {
  const approvalExecution = read('../src/server/approvalExecution.ts');
  assert.match(approvalExecution, /assertCoreOperationExecutorCoverage/);
});

test('Phase 8 surface inventory classifies every existing system operation route', () => {
  const inventory = read('../docs/phase-8-operational-surface-inventory.md');
  for (const route of [
    'GET /api/system/health',
    'GET /api/system/mongo/health',
    'POST /api/system/audit/scan',
    'POST /api/system/audit/heal',
    'POST /api/system/audit/batch-heal',
  ]) {
    assert.match(inventory, new RegExp(route.replaceAll('/', '\\/')));
  }
  assert.match(inventory, /No Core \/ NF operational HTTP write routes exist/);
  assert.match(inventory, /No managed\s+core-network targets are registered/);
});

test('core operation source has no arbitrary command or remote execution surface', () => {
  const forbidden = /(?:from\s+['"]node:child_process|require\(\s*['"]node:child_process|(?:execFile|spawn)\s*\(|\b(?:systemctl|kubectl|supervisorctl|pm2)\s+[A-Za-z]|docker(?:\s+compose)?\s+(?:restart|reload|start|stop)|ssh\s+[A-Za-z0-9_.@-]+@)/i;
  const roots = ['src/app/api', 'src/server', 'src/lib'].map((path) => join(root, path));
  const matches = roots
    .flatMap(sourceFiles)
    .filter((file) => forbidden.test(readFileSync(file, 'utf8')))
    .map((file) => relative(root, file));
  assert.deepEqual(matches, []);
});
