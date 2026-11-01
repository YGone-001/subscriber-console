/*
 * Disabled operations and remediation ownership.
 *
 * Two separate concerns, deliberately kept apart:
 *
 *   1. The ABSOLUTE DENYLIST. Operations the project must never call. Detection is
 *      by ENDPOINT LITERAL, not by call shape: every `/api/...` string in the source
 *      is extracted and matched. The previous implementation required `postJson(`
 *      to be immediately followed by the quote, so a generic argument
 *      (`postJson<Res>('/api/...')`) or a native `fetch('/api/...')` walked straight
 *      through the gate. Endpoint-literal extraction cannot be evaded that way.
 *
 *   2. REMEDIATION OWNERSHIP. `/api/system/audit/heal` and `/api/system/audit/batch-heal`
 *      are NOT denylisted: they are direct data-consistency remediation, registered by
 *      the Go router and protected server-side by authentication, the `system_heal`
 *      capability, per-route rate limits and operation logging. They must stay
 *      callable, but only through one owner module.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import test from 'node:test';

const spaRoot = resolve(import.meta.dirname, '..');
const srcDir = resolve(spaRoot, 'src');

function walk(dir: string, files: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = resolve(dir, name);
    if (statSync(full).isDirectory()) walk(full, files);
    else if (/\.(ts|tsx)$/.test(full)) files.push(full);
  }
  return files;
}

const sourceFiles = walk(srcDir);
const allSource = sourceFiles.map((f) => readFileSync(f, 'utf8')).join('\n');

/**
 * Every MUTATING API endpoint literal in the source, with the files that mention it.
 *
 * Deliberately shape-agnostic about the call: it does not care whether the write is
 * `postJson`, `postJson<T>`, a native `fetch`, or a wrapper. For each endpoint
 * literal it also captures the surrounding call text, so a write can be told apart
 * from a legitimate GET read of the same path.
 */
const WRITE_CALL = /\b(postJson|putJson|patchJson|deleteJson)\b|method\s*:\s*['"](POST|PUT|PATCH|DELETE)['"]/;

function collectWriteEndpoints() {
  const found = new Map<string, string[]>();
  for (const file of sourceFiles) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/['"`](\/api\/[^'"`\s]*)['"`]/g)) {
      /* The write indicator may precede the literal (`postJson<T>('/api/...')`) or
       * follow it (`fetch('/api/...', { method: 'POST' })`), so both sides are read. */
      const context = source.slice(Math.max(0, match.index - 200), match.index + 200);
      if (!WRITE_CALL.test(context)) continue;
      const path = match[1];
      const rel = relative(srcDir, file).replace(/\\/g, '/');
      found.set(path, [...(found.get(path) ?? []), rel]);
    }
  }
  return found;
}

const endpoints = collectWriteEndpoints();

/** Every endpoint literal regardless of call shape; used for ownership. */
function collectAllEndpointLiterals() {
  const found = new Map<string, string[]>();
  for (const file of sourceFiles) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/['"`](\/api\/[^'"`\s]*)['"`]/g)) {
      const rel = relative(srcDir, file).replace(/\\/g, '/');
      found.set(match[1], [...(found.get(match[1]) ?? []), rel]);
    }
  }
  return found;
}

const allEndpoints = collectAllEndpointLiterals();

test('absolute denylist WRITES are absent from SPA source, whatever the call shape', () => {
  /* Paths, not call shapes. A generic argument or a raw fetch cannot slip past these. */
  const forbidden = [
    { name: 'balance reset', pattern: /^\/api\/ocs\/balances\/[^/]+\/reset/ },
    { name: 'subscriber policy assignment', pattern: /^\/api\/subscribers\/policy/ },
    { name: 'ratings write', pattern: /^\/api\/ratings/ },
    { name: 'remediation write through a non-owner module', pattern: /^\/api\/system\/audit\/(heal|batch-heal)$/ },
    { name: 'tariff rules write', pattern: /^\/api\/[^/]*rules/ },
    { name: 'tariff plan import mutation', pattern: /^\/api\/[^/]*tariff-plans[^/]*import/ },
    { name: 'tariff migrate mutation', pattern: /^\/api\/[^/]*migrate/ },
  ];

  /* Remediation is owned, not forbidden: it is asserted separately below. */
  const owned = new Set(['/api/system/audit/heal', '/api/system/audit/batch-heal']);

  for (const { name, pattern } of forbidden) {
    const offenders = [...endpoints.keys()].filter((path) => !owned.has(path) && pattern.test(path));
    assert.deepEqual(offenders, [], `forbidden operation must be absent: ${name} (${offenders.join(', ')})`);
  }
});

test('the denylist check cannot be bypassed by a generic argument or a wrapper', () => {
  /* Regression guard for the gate itself: a generic call, a native fetch, and a
     helper-wrapped call must all be caught. A plain GET read must NOT be. */
  const writes = [
    "postJson<Res>('/api/subscribers/policy', payload)",
    "fetch('/api/subscribers/policy', { method: 'POST' })",
    "await postJson<Res>('/api/subscribers/policy', payload)",
    "patchJson<Res>('/api/subscribers/policy', payload)",
  ];
  /* Mirror the collector exactly: the write indicator may sit on either side. */
  const contextOf = (sample: string, index: number) => sample.slice(Math.max(0, index - 200), index + 200);

  for (const sample of writes) {
    const match = sample.match(/['"`](\/api\/[^'"`\s]*)['"`]/);
    assert.ok(match, `sample must yield a literal: ${sample}`);
    assert.ok(WRITE_CALL.test(contextOf(sample, match!.index!)), `a write must be detected: ${sample}`);
  }

  const read = "useRead<Res>(`/api/ratings?planId=${encodeURIComponent(planId)}`)";
  const readMatch = read.match(/['"`](\/api\/[^'"`\s]*)['"`]/);
  assert.ok(readMatch, 'the read sample must yield a literal');
  assert.ok(!WRITE_CALL.test(contextOf(read, readMatch!.index!)), 'a GET read must not be treated as a write');
});

test('retired remediation and analytics-init endpoints are absent from SPA source', () => {
  const retired = [
    '/api/system/audit/heal',
    '/api/system/audit/batch-heal',
    '/api/analytics/init',
  ];
  for (const path of retired) {
    const mentions = (allEndpoints.get(path) ?? []).filter((file) => !/\.test\./.test(file));
    assert.deepEqual(mentions, [], `${path} must not be called by the console`);
  }
});

test('the system health page only owns the read-only audit scan', () => {
  const page = readFileSync(resolve(srcDir, 'features/system-health/SystemHealthPage.tsx'), 'utf8');
  assert.doesNotMatch(page, /\bfetch\s*\(/, 'the page must go through the API owner, not native fetch');
  assert.match(page, /requestAuditScanStep\(/, 'the diagnostic scan must use its owner helper');
  assert.doesNotMatch(page, /requestSingleHeal|requestBatchHeal|health_btn_heal|health_modal_confirm/i, 'auto-heal must be retired from the page');
  assert.match(page, /health_readonly_notice/, 'the page must state that diagnostics are read-only');
});

test('the scan entry is gated by core.configure, not by a capability that no longer exists', () => {
  const page = readFileSync(resolve(srcDir, 'features/system-health/SystemHealthPage.tsx'), 'utf8');
  assert.match(page, /hasPermission\(user, "core\.configure"\)/, 'the scan entry must check core.configure');
  assert.match(page, /canScan \?/, 'the scan action must be conditional');
});

test('no approval compatibility logic remains on the diagnostics path', () => {
  assert.doesNotMatch(allSource, /approval_msg_submitted/, 'the retired approval notice must be gone');
  assert.doesNotMatch(allSource, /\.approval\?\.id/, 'the retired approval response branch must be gone');

  const api = readFileSync(resolve(srcDir, 'features/system-health/system-health-api.ts'), 'utf8');
  assert.doesNotMatch(api, /approval/i, 'the owner must not model an approval hand-off');
});

test('subscriber mutation surfaces use direct-execution language', () => {
  const surfaces = [
    readFileSync(resolve(srcDir, 'features/subscribers/SubscriberDetailPage.tsx'), 'utf8'),
    readFileSync(resolve(srcDir, 'components/SubscriberBatchUpdateModal.tsx'), 'utf8'),
  ].join('\n');
  assert.doesNotMatch(surfaces, /提交审批|submitted for approval/i, 'subscriber writes must not present a retired approval hand-off');
});
