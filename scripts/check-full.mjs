#!/usr/bin/env node
/**
 * Local mirror of the CI gates that run on every push to main/develop.
 *
 * CI remains the authority; this command exists so a development session can
 * finish with one local pass instead of discovering drift after a push. Keep
 * the step list aligned with `.github/workflows/ci.yml` when the workflow gains
 * or drops a push-triggered step.
 *
 * Service-backed integration jobs (MongoDB, nginx, browser screenshots) are
 * dispatch-only in CI and are intentionally not part of this local gate.
 *
 * Two Go test packages assert Linux runtime behaviour (symlink privileges and
 * /proc + journald); on Windows only internal/nfhealth is skipped locally with
 * an explicit note. Linux CI still runs every package.
 *
 * Usage: npm run check:full
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FRONTEND = resolve(ROOT, 'frontend');
const BACKEND = resolve(ROOT, 'backend');
const IS_WINDOWS = process.platform === 'win32';
const WINDOWS_ONLY_GO_PACKAGES = ['/internal/nfhealth'];

const REPOSITORY_GATES = [
  'scripts/test-dependency-security.mjs',
  'scripts/test-ci-runtime-contract.mjs',
  'scripts/test-frontend-runtime-contract.mjs',
  'scripts/test-frontend-shell-contract.mjs',
  'scripts/test-frontend-read-contract.mjs',
  'scripts/test-frontend-mutation-contract.mjs',
  'scripts/test-frontend-operational-contract.mjs',
  'scripts/test-inventory-contract.mjs',
  'scripts/test-runtime-discovery-contract.mjs',
  'scripts/test-api-ownership-invariants.mjs',
  'scripts/test-frontend-runtime-boundary.mjs',
  'scripts/test-frontend-runtime-dependencies.mjs',
  'scripts/test-mongo-index-migration.mjs',
  'scripts/test-ui-restoration-contract.mjs',
  'scripts/test-local-operations-contract.mjs',
  'scripts/test-current-architecture-docs.mjs',
  'scripts/test-documentation-integrity.mjs',
  'scripts/test-local-development-contract.mjs',
  'scripts/test-repository-normalization.mjs',
  'scripts/test-production-architecture.mjs',
  'scripts/test-agent-docs-parity.mjs',
];

const failures = [];

function run(label, command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? ROOT,
    encoding: 'utf8',
    shell: IS_WINDOWS,
    maxBuffer: 64 * 1024 * 1024,
    env: process.env,
  });
  if (result.status === 0) {
    console.log(`PASS ${label}`);
    return result;
  }
  failures.push(label);
  console.log(`FAIL(${result.status ?? 'spawn-error'}) ${label}`);
  const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
  if (output) {
    const tail = output.split('\n').slice(-30).join('\n');
    console.log(tail);
  }
  if (result.error) console.log(`spawn error: ${result.error.message}`);
  return result;
}

function gofmtGate() {
  const result = spawnSync('gofmt', ['-l', '.'], { cwd: BACKEND, encoding: 'utf8', shell: IS_WINDOWS });
  const files = (result.stdout || '').trim();
  if (result.status !== 0 || files) {
    failures.push('gofmt');
    console.log('FAIL gofmt -l .');
    if (files) console.log(files);
    if (result.stderr) console.log(result.stderr.trim());
    return;
  }
  console.log('PASS gofmt -l .');
}

function goTestGate() {
  let packages = ['-race', '-count=1', './...'];
  if (IS_WINDOWS) {
    const list = spawnSync('go', ['list', './...'], { cwd: BACKEND, encoding: 'utf8', shell: true });
    if (list.status !== 0) {
      failures.push('go test (package listing)');
      console.log('FAIL go list ./...');
      console.log((list.stderr || '').trim());
      return;
    }
    const all = (list.stdout || '').trim().split('\n').filter(Boolean);
    const skipped = all.filter((pkg) => WINDOWS_ONLY_GO_PACKAGES.some((suffix) => pkg.endsWith(suffix)));
    const selected = all.filter((pkg) => !skipped.includes(pkg));
    console.log(
      `NOTE go test skipped on Windows: ${skipped.map((p) => p.split('/internal/')[1]).join(', ')} (Linux-only assertions; Linux CI covers them)`,
    );
    packages = ['-race', '-count=1', ...selected];
  }
  run('go test -race ./...', 'go', ['test', ...packages], { cwd: BACKEND });
}

console.log('-- Local CI gate mirror (push-triggered jobs) --\n');

for (const script of REPOSITORY_GATES) {
  run(script, 'node', [script]);
}

run('frontend npm run check', 'npm', ['run', 'check'], { cwd: FRONTEND });
run('stage SPA for Go', 'node', ['scripts/stage-spa-for-go.mjs']);
run('go bundled build', 'go', ['build', '-o', 'bin/server', './cmd/server'], { cwd: BACKEND });
run('go test ./internal/spa/...', 'go', ['test', '-count=1', './internal/spa/...'], { cwd: BACKEND });
gofmtGate();
run('go vet ./...', 'go', ['vet', './...'], { cwd: BACKEND });
run('go build ./...', 'go', ['build', './...'], { cwd: BACKEND });
goTestGate();

console.log('');
if (failures.length > 0) {
  console.log(`check_full_result=FAIL failures=${failures.length}`);
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exit(1);
}
console.log('check_full_result=PASS');
