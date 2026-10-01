#!/usr/bin/env node
/**
 * CI runtime contract.
 *
 * Permanent, phase-neutral gate proving every first-party GitHub JavaScript action
 * reference in `.github/workflows/**` uses a Node-24-capable release line.
 *
 * GitHub-hosted runners no longer provide Node 20 for JavaScript actions, so a
 * Node-20-based action major is a broken runtime reference rather than a cosmetic warning.
 * Only first-party (`actions/*`) JavaScript actions are asserted; third-party actions are
 * never rejected by version number alone.
 *
 * Assertions:
 *   - every workflow file is scanned
 *   - no obsolete Node-20 first-party action major remains
 *   - each first-party action is referenced through a single major (no mixed majors)
 *   - workflow permissions remain least-privilege (read-only, no `: write`)
 *
 * Usage:
 *   node scripts/test-ci-runtime-contract.mjs
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const WORKFLOW_DIR = join(ROOT, '.github', 'workflows');

/**
 * First-party JavaScript actions whose obsolete (Node 20) majors must be gone.
 * The value is the current supported Node-24-capable release line.
 */
const FIRST_PARTY_ACTIONS = Object.freeze({
  'actions/checkout': { supported: 'v7', obsolete: ['v1', 'v2', 'v3', 'v4'] },
  'actions/setup-node': { supported: 'v7', obsolete: ['v1', 'v2', 'v3', 'v4'] },
  'actions/setup-go': { supported: 'v7', obsolete: ['v1', 'v2', 'v3', 'v4', 'v5'] },
});

const checks = [];
function check(id, ok, detail = '') {
  checks.push({ id, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}${detail ? `  ${detail}` : ''}`);
}

/** Every `uses:` reference in a workflow text, in source order. */
export function scanUsesReferences(text) {
  const refs = [];
  const pattern = /^[ \t]*(?:-[ \t]+)?uses:[ \t]*([^\s#]+)/gm;
  let match;
  while ((match = pattern.exec(text)) !== null) refs.push(match[1].trim());
  return refs;
}

/** Split `owner/action@ref` into its parts; returns null for local (`./`) actions. */
export function parseActionReference(reference) {
  if (reference.startsWith('./') || reference.startsWith('.\\')) return null;
  const at = reference.lastIndexOf('@');
  if (at <= 0) return null;
  return { action: reference.slice(0, at), ref: reference.slice(at + 1) };
}

/** Major component of a version reference (`v7`, `v7.0.1` -> `v7`; `main` -> null). */
export function actionMajor(ref) {
  const match = /^v(\d+)(?:\.|$)/.exec(String(ref || ''));
  return match ? `v${match[1]}` : null;
}

/** Obsolete first-party references found in a workflow text. */
export function findObsoleteReferences(text) {
  const obsolete = [];
  for (const reference of scanUsesReferences(text)) {
    const parsed = parseActionReference(reference);
    if (!parsed) continue;
    const rule = FIRST_PARTY_ACTIONS[parsed.action];
    if (!rule) continue;
    const major = actionMajor(parsed.ref);
    if (major && rule.obsolete.includes(major)) obsolete.push(reference);
  }
  return obsolete;
}

function listWorkflowFiles(dir) {
  if (!existsSync(dir)) return [];
  const files = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isFile() && /\.ya?ml$/i.test(entry)) files.push(full);
  }
  return files;
}

function testNegativeSentinels() {
  const syntheticObsolete = [
    'jobs:',
    '  build:',
    '    steps:',
    '      - uses: actions/checkout@v4',
    '      - uses: actions/setup-go@v5',
    '',
  ].join('\n');
  const obsolete = findObsoleteReferences(syntheticObsolete);
  check(
    'sentinel-obsolete-action-detected',
    obsolete.length === 2,
    `detected=${JSON.stringify(obsolete)} result=${obsolete.length > 0 ? 'FAIL' : 'PASS'}`,
  );

  const syntheticCurrent = ['jobs:', '  build:', '    steps:', '      - uses: actions/checkout@v7', ''].join('\n');
  check('sentinel-current-action-accepted', findObsoleteReferences(syntheticCurrent).length === 0);
}

function main() {
  console.log('-- CI runtime contract --');
  console.log('');

  testNegativeSentinels();
  console.log('');

  const workflowFiles = listWorkflowFiles(WORKFLOW_DIR);
  check('workflow-files-found', workflowFiles.length > 0, `files=${workflowFiles.length}`);

  const references = [];
  let workflowText = '';
  for (const file of workflowFiles) {
    const text = readFileSync(file, 'utf8');
    workflowText += `\n${text}`;
    for (const reference of scanUsesReferences(text)) references.push({ file, reference });
  }
  check('workflow-uses-references-parsed', references.length > 0, `references=${references.length}`);

  const obsoleteAll = [];
  const majorsByAction = new Map();
  for (const entry of references) {
    const parsed = parseActionReference(entry.reference);
    if (!parsed) continue;
    const rule = FIRST_PARTY_ACTIONS[parsed.action];
    if (!rule) continue;
    const major = actionMajor(parsed.ref);
    if (major && rule.obsolete.includes(major)) {
      obsoleteAll.push(`${parsed.action}@${parsed.ref} (${entry.file.replace(ROOT + '\\', '').replace(ROOT + '/', '')})`);
    }
    if (!majorsByAction.has(parsed.action)) majorsByAction.set(parsed.action, new Set());
    if (major) majorsByAction.get(parsed.action).add(major);
  }

  for (const [action, rule] of Object.entries(FIRST_PARTY_ACTIONS)) {
    const key = action.replace('actions/', '').replace(/-/g, '_');
    const majors = majorsByAction.get(action) || new Set();
    const obsolete = [...majors].filter((major) => rule.obsolete.includes(major));
    const referenced = majors.size > 0;
    check(
      `ci-runtime-${key}-supported`,
      referenced && obsolete.length === 0 && majors.size === 1 && majors.has(rule.supported),
      `majors=${[...majors].join(',') || 'none'} expected=${rule.supported}`,
    );
  }

  check('ci-runtime-no-obsolete-first-party-references', obsoleteAll.length === 0, `obsolete=${JSON.stringify(obsoleteAll)}`);

  const hasReadOnlyPermissions = /^permissions:\s*$\n(?:[ \t]+[^\n]*\n)*?[ \t]+contents:[ \t]*read/m.test(workflowText);
  const writePermissionHits = (workflowText.match(/^[ \t]*[a-z-]+:[ \t]*write(?:-all)?[ \t]*$/gm) || []).length;
  check('ci-runtime-permissions-least-privilege', hasReadOnlyPermissions, `contents_read=${hasReadOnlyPermissions}`);
  check('ci-runtime-no-write-permissions', writePermissionHits === 0, `write_hits=${writePermissionHits}`);

  const failures = checks.filter((entry) => !entry.ok);
  const supported = (name) => {
    const rule = FIRST_PARTY_ACTIONS[name];
    const majors = majorsByAction.get(name) || new Set();
    return majors.size === 1 && majors.has(rule.supported) && [...majors].every((major) => !rule.obsolete.includes(major));
  };
  const obsoleteCount = obsoleteAll.length;

  console.log('');
  console.log('==================================================');
  console.log(`ci_runtime_checkout_supported=${supported('actions/checkout')}`);
  console.log(`ci_runtime_setup_node_supported=${supported('actions/setup-node')}`);
  console.log(`ci_runtime_setup_go_supported=${supported('actions/setup-go')}`);
  console.log(`ci_runtime_workflow_files=${workflowFiles.length}`);
  console.log(`ci_runtime_node20_first_party_actions=${obsoleteCount}`);
  console.log(`ci_runtime_permissions_least_privilege=${hasReadOnlyPermissions && writePermissionHits === 0}`);
  console.log(`ci_runtime_failures=${failures.length}`);
  console.log(`ci_runtime_result=${failures.length === 0 ? 'PASS' : 'FAIL'}`);
  console.log('==================================================');

  if (failures.length > 0) {
    for (const failure of failures) console.log(`  ${failure.id}${failure.detail ? `  ${failure.detail}` : ''}`);
    process.exitCode = 1;
  }
}

main();
