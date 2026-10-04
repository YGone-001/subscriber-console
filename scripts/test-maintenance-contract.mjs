#!/usr/bin/env node
/**
 * Maintenance contract.
 *
 * Permanent, phase-neutral composition of the maintenance gates introduced for the
 * repository maintenance baseline. It does not re-derive any invariant itself: it runs
 * the authoritative checks and composes their machine-readable output into a single
 * maintenance summary, so CI exposes one auditable contract instead of scattered keys.
 *
 * Composed checks:
 *   scripts/test-dependency-security.mjs       root + frontend advisory counts
 *   scripts/test-ci-runtime-contract.mjs       first-party action runtime majors
 *   scripts/test-current-architecture-docs.mjs documented vs declared Next.js version
 *   scripts/test-production-architecture.mjs   API ownership / fallback invariants
 *   scripts/test-local-development-contract.mjs Next.js API rewrites
 *
 * Usage:
 *   node scripts/test-maintenance-contract.mjs
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const CHECKS = [
  { id: 'dependency-security', script: 'scripts/test-dependency-security.mjs' },
  { id: 'ci-runtime-contract', script: 'scripts/test-ci-runtime-contract.mjs' },
  { id: 'current-architecture-docs', script: 'scripts/test-current-architecture-docs.mjs' },
  { id: 'production-architecture', script: 'scripts/test-production-architecture.mjs' },
  { id: 'local-access-contract', script: 'scripts/test-local-development-contract.mjs' },
];

/** `key=value` machine contract lines, in source order. */
export function parseMachineKeys(text) {
  const keys = {};
  for (const line of String(text || '').split('\n')) {
    const match = /^([a-z0-9_]+)=(.*)$/.exec(line.trim());
    if (match) keys[match[1]] = match[2].trim();
  }
  return keys;
}

function runCheck(entry) {
  const result = spawnSync(process.execPath, [entry.script], {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  const stdout = String(result.stdout || '');
  const stderr = String(result.stderr || '');
  return {
    ...entry,
    status: result.status,
    keys: parseMachineKeys(stdout),
    tail: stderr.trim().split('\n').filter(Boolean).slice(-3).join(' | '),
  };
}

function main() {
  console.log('-- Maintenance contract --');
  console.log('');

  const failures = [];
  const results = {};

  for (const entry of CHECKS) {
    const outcome = runCheck(entry);
    results[entry.id] = outcome;
    const ok = outcome.status === 0;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${entry.id}${ok ? '' : `  exit=${outcome.status}${outcome.tail ? `  ${outcome.tail}` : ''}`}`);
    if (!ok) failures.push(`${entry.id} (exit=${outcome.status})`);
  }

  const keysOf = (id) => (results[id] && results[id].keys) || {};
  const read = (id, key) => {
    const value = keysOf(id)[key];
    if (value === undefined) {
      failures.push(`${id}:${key} missing from machine output`);
      return 'MISSING';
    }
    return value;
  };

  const rootCritical = read('dependency-security', 'dependency_security_root_critical');
  const rootHigh = read('dependency-security', 'dependency_security_root_high');
  const frontendCritical = read('dependency-security', 'dependency_security_frontend_critical');
  const frontendHigh = read('dependency-security', 'dependency_security_frontend_high');

  const declaredNext = read('current-architecture-docs', 'declared_next_version');
  const documentedNext = read('current-architecture-docs', 'documented_next_version');
  const versionMatch = read('current-architecture-docs', 'next_documentation_version_match');

  const checkoutSupported = read('ci-runtime-contract', 'ci_runtime_checkout_supported');
  const setupNodeSupported = read('ci-runtime-contract', 'ci_runtime_setup_node_supported');
  const setupGoSupported = read('ci-runtime-contract', 'ci_runtime_setup_go_supported');
  const node20Actions = read('ci-runtime-contract', 'ci_runtime_node20_first_party_actions');

  const goRoutes = read('production-architecture', 'production_architecture_go_registrations_actual');
  const nextApiRoutes = read('production-architecture', 'production_architecture_next_api_route_files');
  const nextApiReverseProxy = read('production-architecture', 'production_architecture_next_api_reverse_proxy_functions');
  const nodeApiFallback = read('production-architecture', 'production_architecture_node_api_fallback');
  const nextApiRewrites = read('local-access-contract', 'local_access_next_api_rewrites');

  console.log('');
  console.log('==================================================');
  console.log(`maintenance_root_audit_critical=${rootCritical}`);
  console.log(`maintenance_root_audit_high=${rootHigh}`);
  console.log('');
  console.log(`maintenance_frontend_audit_critical=${frontendCritical}`);
  console.log(`maintenance_frontend_audit_high=${frontendHigh}`);
  console.log('');
  console.log(`maintenance_next_declared_version=${declaredNext}`);
  console.log(`maintenance_next_documented_version=${documentedNext}`);
  console.log(`maintenance_next_version_match=${versionMatch}`);
  console.log('');
  console.log(`maintenance_checkout_supported=${checkoutSupported}`);
  console.log(`maintenance_setup_node_supported=${setupNodeSupported}`);
  console.log(`maintenance_setup_go_supported=${setupGoSupported}`);
  console.log(`maintenance_node20_first_party_actions=${node20Actions}`);
  console.log('');
  console.log(`maintenance_go_routes=${goRoutes}`);
  console.log(`maintenance_next_api_routes=${nextApiRoutes}`);
  console.log(`maintenance_next_api_rewrites=${nextApiRewrites}`);
  console.log(`maintenance_next_api_reverse_proxy=${nextApiReverseProxy}`);
  console.log(`maintenance_node_api_fallback=${nodeApiFallback}`);
  console.log('');
  console.log(`maintenance_failures=${failures.length}`);
  console.log(`maintenance_result=${failures.length === 0 ? 'PASS' : 'FAIL'}`);
  console.log('==================================================');

  if (failures.length > 0) {
    for (const failure of failures) console.log(`  ${failure}`);
    process.exitCode = 1;
  }
}

main();
