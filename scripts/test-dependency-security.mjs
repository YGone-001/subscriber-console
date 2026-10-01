#!/usr/bin/env node
/**
 * Dependency security gate.
 *
 * Permanent, phase-neutral gate proving the repository's two declared dependency trees
 * carry no critical and no high severity advisories:
 *
 *   root      repository-root operational script dependencies
 *   frontend  the Next.js UI runtime
 *
 * Evaluation is driven exclusively by `npm audit --json` machine output. Human-formatted
 * npm output is never parsed.
 *
 * The gate fails closed. An audit that cannot execute, a registry that is unavailable, a
 * malformed audit response and a surprised npm exit are all FAIL, never "zero
 * vulnerabilities": an unavailable audit is never interpreted as a clean audit.
 *
 * Usage:
 *   node scripts/test-dependency-security.mjs
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const IS_WINDOWS = process.platform === 'win32';

const NPM = IS_WINDOWS ? 'npm.cmd' : 'npm';
const SEVERITIES = ['critical', 'high', 'moderate', 'low'];
/** Severities that are never acceptable in this repository. */
const BLOCKING = ['critical', 'high'];

const checks = [];
function check(id, ok, detail = '') {
  checks.push({ id, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}${detail ? `  ${detail}` : ''}`);
}

function runAudit(cwd) {
  return spawnSync(NPM, ['audit', '--json'], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    shell: IS_WINDOWS,
    maxBuffer: 64 * 1024 * 1024,
  });
}

/**
 * Extract severity counts from a parsed `npm audit --json` document.
 *
 * Returns null when the document is not a usable audit report. Callers must treat null as
 * FAIL so that a missing or unreadable audit can never be mistaken for a clean one.
 */
export function summarizeAudit(audit) {
  const vulnerabilities =
    audit && typeof audit === 'object' && audit.metadata && typeof audit.metadata === 'object'
      ? audit.metadata.vulnerabilities
      : null;
  if (!vulnerabilities || typeof vulnerabilities !== 'object') return null;
  const counts = {};
  for (const severity of SEVERITIES) {
    const value = Number(vulnerabilities[severity]);
    if (!Number.isFinite(value)) return null;
    counts[severity] = value;
  }
  return counts;
}

/** Severity names that block acceptance for the given counts. */
export function blockingSeverities(counts) {
  if (!counts) return [...BLOCKING, '<audit-unavailable>'];
  return BLOCKING.filter((severity) => counts[severity] > 0);
}

/** Audit one dependency tree and classify the outcome. */
function auditTree(cwd) {
  const result = runAudit(cwd);
  const stdout = String(result.stdout || '');
  if (!stdout.trim()) {
    const cause = result.error ? result.error.message : `exit ${result.status}`;
    return { ok: false, counts: null, findings: [], reason: `audit produced no output (${cause})` };
  }
  let parsed;
  try {
    parsed = JSON.parse(stdout.replace(/^\uFEFF/, ''));
  } catch (error) {
    return { ok: false, counts: null, findings: [], reason: `malformed audit JSON: ${error.message}` };
  }
  if (parsed && typeof parsed === 'object' && parsed.error) {
    const detail = parsed.error.summary || parsed.error.code || 'unknown audit failure';
    return { ok: false, counts: null, findings: [], reason: `audit reported an error: ${detail}` };
  }
  const counts = summarizeAudit(parsed);
  if (!counts) {
    return { ok: false, counts: null, findings: [], reason: 'audit response missing metadata.vulnerabilities' };
  }
  const findings = Object.entries(parsed.vulnerabilities || {})
    .filter(([, entry]) => entry && BLOCKING.includes(entry.severity))
    .map(([name, entry]) => ({
      name,
      severity: entry.severity,
      range: entry.range || 'unknown',
      direct: Boolean(entry.isDirect),
      fixAvailable: entry.fixAvailable ? JSON.stringify(entry.fixAvailable) : 'none',
      advisories: (entry.via || [])
        .filter((via) => via && typeof via === 'object')
        .map((via) => `${via.title || via.name || 'advisory'} (${via.url || 'no-url'})`),
    }));
  return { ok: true, counts, findings, reason: null };
}

function reportTreeFindings(label, tree) {
  for (const finding of tree.findings) {
    console.log(
      `  ${label} ${finding.severity}: ${finding.name} installed range ${finding.range}` +
        ` direct=${finding.direct} fixAvailable=${finding.fixAvailable}`,
    );
    for (const advisory of finding.advisories) console.log(`    advisory: ${advisory}`);
  }
}

/**
 * Negative sentinels: prove the evaluator is non-tautological.
 *
 * A synthetic audit report carrying one critical finding must be detected, and an
 * unusable audit document must be classified as unavailable rather than clean.
 */
function testNegativeSentinels() {
  const syntheticCritical = {
    metadata: { vulnerabilities: { critical: 1, high: 0, moderate: 0, low: 0 } },
  };
  const syntheticCounts = summarizeAudit(syntheticCritical);
  const detected = syntheticCounts !== null && blockingSeverities(syntheticCounts).includes('critical');
  check('sentinel-critical-finding-detected', detected, `detected=${detected} result=${detected ? 'FAIL' : 'PASS'}`);

  const syntheticHigh = { metadata: { vulnerabilities: { critical: 0, high: 1, moderate: 0, low: 0 } } };
  const highCounts = summarizeAudit(syntheticHigh);
  const highDetected = highCounts !== null && blockingSeverities(highCounts).includes('high');
  check('sentinel-high-finding-detected', highDetected, `detected=${highDetected}`);

  const unavailable = summarizeAudit({ auditReportVersion: 2 });
  check('sentinel-unavailable-audit-fails-closed', unavailable === null, `summarized=${JSON.stringify(unavailable)}`);
}

function main() {
  console.log('-- Dependency security gate --');
  console.log('');

  testNegativeSentinels();
  console.log('');

  const rootTree = auditTree(ROOT);
  const frontendTree = auditTree(resolve(ROOT, 'frontend'));

  check('root-audit-available', rootTree.ok, rootTree.reason || 'audit executed');
  check('frontend-audit-available', frontendTree.ok, frontendTree.reason || 'audit executed');
  if (!rootTree.ok) console.log(`  root audit diagnostic: ${rootTree.reason}`);
  if (!frontendTree.ok) console.log(`  frontend audit diagnostic: ${frontendTree.reason}`);

  reportTreeFindings('root', rootTree);
  reportTreeFindings('frontend', frontendTree);

  for (const severity of BLOCKING) {
    const rootCount = rootTree.ok ? rootTree.counts[severity] : null;
    const frontendCount = frontendTree.ok ? frontendTree.counts[severity] : null;
    check(`root-no-${severity}`, rootCount === 0, rootTree.ok ? `count=${rootCount}` : 'audit unavailable');
    check(
      `frontend-no-${severity}`,
      frontendCount === 0,
      frontendTree.ok ? `count=${frontendCount}` : 'audit unavailable',
    );
  }

  const failures = checks.filter((entry) => !entry.ok);
  const value = (tree, severity) => {
    if (!tree.ok) return 'UNKNOWN';
    return String(tree.counts[severity]);
  };

  console.log('');
  console.log('==================================================');
  for (const severity of SEVERITIES) {
    console.log(`dependency_security_root_${severity}=${value(rootTree, severity)}`);
  }
  for (const severity of SEVERITIES) {
    console.log(`dependency_security_frontend_${severity}=${value(frontendTree, severity)}`);
  }
  console.log('');
  console.log(`dependency_security_failures=${failures.length}`);
  console.log(`dependency_security_result=${failures.length === 0 ? 'PASS' : 'FAIL'}`);
  console.log('==================================================');

  if (failures.length > 0) {
    for (const failure of failures) console.log(`  ${failure.id}${failure.detail ? `  ${failure.detail}` : ''}`);
    process.exitCode = 1;
  }
}

main();
