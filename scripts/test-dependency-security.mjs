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
 * Advisories with no released fix anywhere in the dependency chain can be excused by a
 * time-bounded allowlist entry. Excusal is deliberately narrow: it covers exactly one
 * advisory id on exactly one package, expires after its review date, keeps the raw
 * severity counts in the machine output and never excuses a finding that carries any
 * other advisory. The evidence for every active entry lives next to it in
 * ALLOWLISTED_ADVISORIES.
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

/**
 * Time-bounded advisory exceptions.
 *
 * An entry excuses a blocking finding only while all of these hold:
 *   - every advisory object the finding carries is covered by an active entry for that
 *     package, matched by the GHSA id extracted from the advisory URL (cascade entries
 *     carry no advisory object of their own and are excused through their references);
 *   - every package the finding references through `via` strings is itself excused;
 *   - the current date has not passed the review date.
 *
 * Entries exist only for advisories whose entire dependency chain has no released fix,
 * and only for dev toolchains with no exposure in the shipped runtime. They are not
 * severity waivers: a non-listed advisory keeps failing the gate closed.
 */
const ALLOWLISTED_ADVISORIES = [
  {
    id: 'ghsa-vfj7-8cjw-p6xm',
    cve: 'CVE-2026-93687',
    package: 'braces',
    reviewBy: '2026-12-31',
    justification:
      'braces <= 3.0.3 is the latest release and the advisory has no patched version; ' +
      'reachable only from the dev-only eslint-config-next lint toolchain ' +
      '(eslint-config-next -> @next/eslint-plugin-next -> fast-glob -> micromatch), ' +
      'never from the shipped UI runtime',
  },
];

/** GHSA id from an advisory URL, lowercased, or null when the URL carries none. */
export function advisoryGhsaId(advisory) {
  const url = advisory && typeof advisory.url === 'string' ? advisory.url : '';
  const match = /GHSA-[a-z0-9-]+/i.exec(url);
  return match ? match[0].toLowerCase() : null;
}

/** Entries that remain active at the given instant; entries past their review date are inert. */
export function activeAdvisoryAllowlist(allowlist, now) {
  const today = (now instanceof Date ? now : new Date(now)).toISOString().slice(0, 10);
  return new Map(
    allowlist
      .filter((entry) => typeof entry.reviewBy === 'string' && today <= entry.reviewBy)
      .map((entry) => [entry.id.toLowerCase(), entry]),
  );
}

/**
 * Partition blocking findings into excused and blocking names.
 *
 * A finding is excused when every advisory object it carries is covered by an active
 * entry for that package and every package reference in `via` is excused as well. A
 * missing `via`, an unknown advisory, an expired entry and a circular chain all fail
 * closed: the finding stays blocking.
 */
export function partitionBlockingFindings(vulnerabilities, allowlist, now) {
  const active = activeAdvisoryAllowlist(allowlist, now);
  const entries = vulnerabilities && typeof vulnerabilities === 'object' ? vulnerabilities : {};
  const memo = new Map();
  const visiting = new Set();

  const excused = (name) => {
    if (memo.has(name)) return memo.get(name);
    if (visiting.has(name)) return false;
    visiting.add(name);
    const entry = entries[name];
    let result = false;
    if (entry && BLOCKING.includes(entry.severity)) {
      const via = Array.isArray(entry.via) ? entry.via : [];
      const advisories = via.filter((ref) => ref && typeof ref === 'object');
      const references = via.filter((ref) => typeof ref === 'string');
      result =
        via.length > 0 &&
        advisories.every((advisory) => {
          const id = advisoryGhsaId(advisory);
          const allowed = id ? active.get(id) : null;
          return Boolean(allowed) && allowed.package === name;
        }) &&
        references.every((reference) => excused(reference));
    }
    visiting.delete(name);
    memo.set(name, result);
    return result;
  };

  const excusedNames = [];
  const blockingNames = [];
  for (const [name, entry] of Object.entries(entries)) {
    if (!entry || !BLOCKING.includes(entry.severity)) continue;
    if (excused(name)) excusedNames.push(name);
    else blockingNames.push(name);
  }
  return { excused: excusedNames, blocking: blockingNames };
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
  const partition = partitionBlockingFindings(parsed.vulnerabilities, ALLOWLISTED_ADVISORIES, new Date());
  return { ok: true, counts, findings, partition, reason: null };
}

function reportTreeFindings(label, tree) {
  const excused = new Set(tree.partition ? tree.partition.excused : []);
  for (const finding of tree.findings) {
    console.log(
      `  ${label} ${finding.severity}: ${finding.name} installed range ${finding.range}` +
        ` direct=${finding.direct} fixAvailable=${finding.fixAvailable}` +
        `${excused.has(finding.name) ? ' allowlisted=true' : ''}`,
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

  const listed = ALLOWLISTED_ADVISORIES[0];
  const listedAdvisory = { url: `https://github.com/advisories/${listed.id}`, title: 'synthetic' };
  const listedChain = {
    braces: { severity: 'high', via: [listedAdvisory] },
    micromatch: { severity: 'high', via: ['braces'] },
  };
  const excusedChain = partitionBlockingFindings(listedChain, ALLOWLISTED_ADVISORIES, '2026-10-03T00:00:00Z');
  check(
    'sentinel-listed-advisory-excused',
    excusedChain.blocking.length === 0 && excusedChain.excused.length === 2,
    `blocking=${excusedChain.blocking.length} excused=${excusedChain.excused.length}`,
  );

  const unlistedChain = {
    braces: { severity: 'high', via: [{ url: 'https://github.com/advisories/GHSA-0000-0000-0000' }] },
    micromatch: { severity: 'high', via: ['braces'] },
  };
  const unlisted = partitionBlockingFindings(unlistedChain, ALLOWLISTED_ADVISORIES, '2026-10-03T00:00:00Z');
  check(
    'sentinel-unlisted-advisory-blocks',
    unlisted.blocking.includes('braces') && unlisted.blocking.includes('micromatch'),
    `blocking=${unlisted.blocking.length}`,
  );

  const expired = partitionBlockingFindings(listedChain, ALLOWLISTED_ADVISORIES, '2027-01-01T00:00:00Z');
  check('sentinel-expired-listing-blocks', expired.blocking.length === 2, `blocking=${expired.blocking.length}`);
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

  const blockingCount = (tree, severity) =>
    tree.ok
      ? tree.findings.filter((f) => f.severity === severity && tree.partition.blocking.includes(f.name)).length
      : null;
  const allowlistedCount = (tree, severity) =>
    tree.ok
      ? tree.findings.filter((f) => f.severity === severity && tree.partition.excused.includes(f.name)).length
      : null;

  for (const severity of BLOCKING) {
    const rootRaw = rootTree.ok ? rootTree.counts[severity] : null;
    const frontendRaw = frontendTree.ok ? frontendTree.counts[severity] : null;
    const rootDetail = rootTree.ok
      ? `count=${rootRaw} blocking=${blockingCount(rootTree, severity)} allowlisted=${allowlistedCount(rootTree, severity)}`
      : 'audit unavailable';
    const frontendDetail = frontendTree.ok
      ? `count=${frontendRaw} blocking=${blockingCount(frontendTree, severity)} allowlisted=${allowlistedCount(frontendTree, severity)}`
      : 'audit unavailable';
    check(`root-no-${severity}`, rootTree.ok && blockingCount(rootTree, severity) === 0, rootDetail);
    check(`frontend-no-${severity}`, frontendTree.ok && blockingCount(frontendTree, severity) === 0, frontendDetail);
  }

  const failures = checks.filter((entry) => !entry.ok);
  const value = (tree, severity) => {
    if (!tree.ok) return 'UNKNOWN';
    return String(tree.counts[severity]);
  };

  const blockingValue = (tree, severity) => (tree.ok ? String(blockingCount(tree, severity)) : 'UNKNOWN');
  const allowlistedValue = (tree, severity) => (tree.ok ? String(allowlistedCount(tree, severity)) : 'UNKNOWN');
  const activeList = activeAdvisoryAllowlist(ALLOWLISTED_ADVISORIES, new Date());

  console.log('');
  console.log('==================================================');
  for (const severity of SEVERITIES) {
    console.log(`dependency_security_root_${severity}=${value(rootTree, severity)}`);
  }
  for (const severity of SEVERITIES) {
    console.log(`dependency_security_frontend_${severity}=${value(frontendTree, severity)}`);
  }
  console.log('');
  for (const severity of BLOCKING) {
    console.log(`dependency_security_root_${severity}_blocking=${blockingValue(rootTree, severity)}`);
    console.log(`dependency_security_root_${severity}_allowlisted=${allowlistedValue(rootTree, severity)}`);
    console.log(`dependency_security_frontend_${severity}_blocking=${blockingValue(frontendTree, severity)}`);
    console.log(`dependency_security_frontend_${severity}_allowlisted=${allowlistedValue(frontendTree, severity)}`);
  }
  console.log('');
  console.log(
    `dependency_security_allowlist_active=${
      activeList.size === 0
        ? 'none'
        : [...activeList.values()].map((entry) => `${entry.id}:${entry.package}:${entry.reviewBy}`).join(',')
    }`,
  );
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
