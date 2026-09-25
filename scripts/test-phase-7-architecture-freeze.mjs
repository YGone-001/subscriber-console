#!/usr/bin/env node

/**
 * Phase 7.0 - Platform Services Architecture Freeze Test Suite
 *
 * Strengthened Source-Derived Contract Validator:
 * 1. Authoritative 11 candidate endpoints exist in Next.js / Node.
 * 2. Strict freeze invariants: CUTOVER_TABLE = 36, ACTUALLY_ROUTED = 36.
 * 3. None of the 11 Phase 7 candidate endpoints are in CUTOVER_TABLE or routed to Go.
 * 4. Go backend cmd/server/main.go contains zero Phase 7 endpoint registrations.
 * 5. POST /api/system/audit/scan is verified to be read-only (zero DB mutations).
 * 6. Source-derived rate limit extraction and cross-check across all 11 endpoints.
 * 7. Alert Domain source vs architecture doc contract verification:
 *    - GET /api/alerts: rate limit 120/60s, listAlerts(101), no query params, response fields.
 *    - POST /api/alerts/acknowledge: rate limit 60/60s, MAX_ACK_IDS=200, id/ids parsing, response fields, no extra writes.
 *    - POST /api/alerts/workflow: rate limit 120/60s, allowed statuses, id field, cleanText max 80, matched/modified response, no CAS.
 *    - Alert repository: actual AlertDocument fields, retention limit 10000, expected mongo indexes.
 * 8. System Health, Mongo Health (HTTP 200 failure), System Audit (heal action 'HEAL'), Analytics Init contracts.
 * 9. Architecture freeze document contains all 20 required sections with clear CURRENT vs TARGET separation.
 * 10. Documentation reconciliation across AGENTS.md, todo.md, dev-log.md, and migration-routing-matrix.md.
 * 11. Pure ASCII compliance across modified files.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

console.log('Running Phase 7.0 Platform Services Architecture Freeze Suite...\n');

// ---------------------------------------------------------------------------
// 1. Authoritative Phase 7 Candidate Endpoint Inventory
// ---------------------------------------------------------------------------
console.log('1. Candidate Endpoint Inventory Verification');

const PHASE_7_CANDIDATES = [
  { method: 'GET', path: '/api/alerts', file: 'frontend/src/app/api/alerts/route.ts', domain: 'alerts' },
  { method: 'POST', path: '/api/alerts/acknowledge', file: 'frontend/src/app/api/alerts/acknowledge/route.ts', domain: 'alerts' },
  { method: 'POST', path: '/api/alerts/workflow', file: 'frontend/src/app/api/alerts/workflow/route.ts', domain: 'alerts' },
  { method: 'GET', path: '/api/notifications/stream', file: 'frontend/src/app/api/notifications/stream/route.ts', domain: 'notifications' },
  { method: 'GET', path: '/api/system/health', file: 'frontend/src/app/api/system/health/route.ts', domain: 'system' },
  { method: 'GET', path: '/api/system/mongo/health', file: 'frontend/src/app/api/system/mongo/health/route.ts', domain: 'system' },
  { method: 'GET', path: '/api/system/audit/status', file: 'frontend/src/app/api/system/audit/status/route.ts', domain: 'system' },
  { method: 'POST', path: '/api/system/audit/scan', file: 'frontend/src/app/api/system/audit/scan/route.ts', domain: 'system' },
  { method: 'POST', path: '/api/system/audit/heal', file: 'frontend/src/app/api/system/audit/heal/route.ts', domain: 'system' },
  { method: 'POST', path: '/api/system/audit/batch-heal', file: 'frontend/src/app/api/system/audit/batch-heal/route.ts', domain: 'system' },
  { method: 'POST', path: '/api/analytics/init', file: 'frontend/src/app/api/analytics/init/route.ts', domain: 'analytics' },
];

assert.equal(PHASE_7_CANDIDATES.length, 11, 'Phase 7 candidate inventory must be exactly 11 endpoints');

for (const candidate of PHASE_7_CANDIDATES) {
  const fullPath = path.join(ROOT, candidate.file);
  assert.ok(fs.existsSync(fullPath), `Candidate route file missing: ${candidate.file}`);
  const content = fs.readFileSync(fullPath, 'utf8');
  assert.ok(
    content.includes(`export async function ${candidate.method}`) ||
    content.includes(`export function ${candidate.method}`),
    `Candidate ${candidate.file} must export ${candidate.method} handler`
  );
  console.log(`  [PASS] ${candidate.method} ${candidate.path} -> ${candidate.file} exists`);
}

// ---------------------------------------------------------------------------
// 2. Strict Freeze Invariants in CUTOVER_TABLE
// ---------------------------------------------------------------------------
console.log('\n2. Strict Routing Invariants Verification');

const jiti = createJiti(import.meta.url);
const cutoverModule = jiti(path.join(ROOT, 'frontend/src/lib/cutover-routing.ts'));
const CUTOVER_TABLE = cutoverModule.CUTOVER_TABLE;

assert.ok(Array.isArray(CUTOVER_TABLE), 'CUTOVER_TABLE must be an array');
assert.equal(CUTOVER_TABLE.length, 36, `CUTOVER_TABLE must be exactly 36 (found ${CUTOVER_TABLE.length})`);

const actuallyRoutedGo = CUTOVER_TABLE.filter((r) => r.owner === 'go');
assert.equal(actuallyRoutedGo.length, 36, `ACTUALLY_ROUTED must be exactly 36 (found ${actuallyRoutedGo.length})`);

// Ensure none of the 11 Phase 7 candidate endpoints are in CUTOVER_TABLE
for (const candidate of PHASE_7_CANDIDATES) {
  const match = CUTOVER_TABLE.find((r) => r.method === candidate.method && r.path === candidate.path);
  assert.ok(
    !match,
    `Phase 7 candidate ${candidate.method} ${candidate.path} must NOT be in CUTOVER_TABLE during Phase 7.0 freeze`
  );
}
console.log('  [PASS] CUTOVER_TABLE length is exactly 36');
console.log('  [PASS] ACTUALLY_ROUTED count is exactly 36');
console.log('  [PASS] Zero Phase 7 candidates exist in CUTOVER_TABLE');

// ---------------------------------------------------------------------------
// 3. Go Backend Zero Leakage / No Premature Migration
// ---------------------------------------------------------------------------
console.log('\n3. Go Backend Route Isolation Verification');

const mainGoPath = path.join(ROOT, 'backend/cmd/server/main.go');
assert.ok(fs.existsSync(mainGoPath), 'backend/cmd/server/main.go must exist');
const mainGoContent = fs.readFileSync(mainGoPath, 'utf8');

const forbiddenGoRoutes = [
  '/api/alerts',
  '/api/notifications',
  '/api/system/health',
  '/api/system/mongo/health',
  '/api/system/audit',
  '/api/analytics/init',
];

for (const routePrefix of forbiddenGoRoutes) {
  assert.ok(
    !mainGoContent.includes(`"${routePrefix}"`) &&
    !mainGoContent.includes(`"${routePrefix}/`),
    `Go backend must not register route ${routePrefix} before Phase 7.1+`
  );
  console.log(`  [PASS] Go router does not contain ${routePrefix}`);
}

// ---------------------------------------------------------------------------
// 4. Source-Derived Rate-Limit Matrix Verification
// ---------------------------------------------------------------------------
console.log('\n4. Source-Derived Rate-Limit Matrix Verification');

const EXPECTED_RATE_LIMITS = [
  { file: 'frontend/src/app/api/alerts/route.ts', keyPrefix: 'alerts:list:', count: 120, window: 60 },
  { file: 'frontend/src/app/api/alerts/acknowledge/route.ts', keyPrefix: 'alerts:acknowledge:', count: 60, window: 60 },
  { file: 'frontend/src/app/api/alerts/workflow/route.ts', keyPrefix: 'alerts:workflow:', count: 120, window: 60 },
  { file: 'frontend/src/app/api/system/health/route.ts', keyPrefix: 'system:health:', count: 30, window: 60 },
  { file: 'frontend/src/app/api/system/mongo/health/route.ts', keyPrefix: 'system:mongo-health:', count: 30, window: 60 },
  { file: 'frontend/src/app/api/system/audit/status/route.ts', keyPrefix: 'system:audit-status:', count: 60, window: 60 },
  { file: 'frontend/src/app/api/system/audit/scan/route.ts', keyPrefix: 'system:audit-scan:', count: 30, window: 60 },
  { file: 'frontend/src/app/api/system/audit/heal/route.ts', keyPrefix: 'system:audit-heal:', count: 20, window: 60 },
  { file: 'frontend/src/app/api/system/audit/batch-heal/route.ts', keyPrefix: 'system:audit-batch-heal:', count: 10, window: 60 },
  { file: 'frontend/src/app/api/analytics/init/route.ts', keyPrefix: 'analytics:init:', count: 3, window: 300 },
];

for (const rl of EXPECTED_RATE_LIMITS) {
  const content = fs.readFileSync(path.join(ROOT, rl.file), 'utf8');
  const rlRegex = /enforceRateLimit\(`([^`]+)`,\s*(\d+),\s*(\d+)\)/;
  const match = content.match(rlRegex);
  assert.ok(match, `enforceRateLimit call missing in ${rl.file}`);
  const [_, keyPattern, countStr, windowStr] = match;
  assert.ok(keyPattern.startsWith(rl.keyPrefix), `${rl.file} key prefix mismatch: expected ${rl.keyPrefix}, got ${keyPattern}`);
  assert.equal(Number(countStr), rl.count, `${rl.file} rate limit count mismatch: expected ${rl.count}, got ${countStr}`);
  assert.equal(Number(windowStr), rl.window, `${rl.file} rate limit window mismatch: expected ${rl.window}, got ${windowStr}`);
  console.log(`  [PASS] ${rl.file} enforceRateLimit(${keyPattern}, ${rl.count}, ${rl.window}) verified`);
}

// Verify SSE has no route-level rate limiter
const sseContent = fs.readFileSync(path.join(ROOT, 'frontend/src/app/api/notifications/stream/route.ts'), 'utf8');
assert.ok(!sseContent.includes('enforceRateLimit'), 'notifications/stream must not contain fixed-window rate limiter');
console.log('  [PASS] notifications/stream confirmed to have no fixed-window rate limiter');

// ---------------------------------------------------------------------------
// 5. Alert Domain Detailed Source & Document Verification
// ---------------------------------------------------------------------------
console.log('\n5. Alert Domain Source vs Architecture Document Verification');

const archDocPath = path.join(ROOT, 'docs/architecture/phase-7-platform-services-architecture.md');
assert.ok(fs.existsSync(archDocPath), 'Phase 7 architecture document must exist');
const archDoc = fs.readFileSync(archDocPath, 'utf8');

// 5a. GET /api/alerts
const alertRouteContent = fs.readFileSync(path.join(ROOT, 'frontend/src/app/api/alerts/route.ts'), 'utf8');
assert.ok(alertRouteContent.includes('listAlerts(101)'), 'GET /api/alerts must call listAlerts(101)');
assert.ok(!alertRouteContent.includes('searchParams.get'), 'GET /api/alerts must not parse query params');

// Cross-check with archDoc
assert.ok(archDoc.includes('120 requests / 60 seconds'), 'archDoc must specify 120 requests / 60 seconds for GET /api/alerts');
assert.ok(archDoc.includes('listAlerts(101)'), 'archDoc must document listAlerts(101)');
assert.ok(archDoc.includes('Query Parameters**: **NONE**'), 'archDoc must state query parameters are NONE');
assert.ok(!archDoc.includes('"totalCount"'), 'archDoc must not include totalCount in GET /api/alerts response');
console.log('  [PASS] GET /api/alerts contract verified in source and archDoc');

// 5b. POST /api/alerts/acknowledge
const ackRouteContent = fs.readFileSync(path.join(ROOT, 'frontend/src/app/api/alerts/acknowledge/route.ts'), 'utf8');
assert.ok(ackRouteContent.includes('const MAX_ACK_IDS = 200;'), 'acknowledge route must define MAX_ACK_IDS = 200');
assert.ok(ackRouteContent.includes('body.ids : [body.id]'), 'acknowledge route must support ids and id');
assert.ok(ackRouteContent.includes("'Alert ID(s) required'"), 'acknowledge route must have exact error "Alert ID(s) required"');
assert.ok(ackRouteContent.includes('At most ${MAX_ACK_IDS} alerts can be acknowledged at once'), 'acknowledge route error message match');

// Cross-check with archDoc
assert.ok(archDoc.includes('MAX_ACK_IDS = 200'), 'archDoc must document MAX_ACK_IDS = 200');
assert.ok(archDoc.includes('"Alert ID(s) required"'), 'archDoc must document error "Alert ID(s) required"');
assert.ok(archDoc.includes('"At most 200 alerts can be acknowledged at once"'), 'archDoc must document 200 alert limit error');
assert.ok(archDoc.includes('"acknowledged": 2'), 'archDoc must document acknowledged count response field');
assert.ok(archDoc.includes('"requested": 2'), 'archDoc must document requested count response field');
assert.ok(archDoc.includes('"skipped": 0'), 'archDoc must document skipped count response field');
assert.ok(!archDoc.includes('"acknowledgedCount"'), 'archDoc must not contain fictional acknowledgedCount field');
console.log('  [PASS] POST /api/alerts/acknowledge contract verified in source and archDoc');

// 5c. POST /api/alerts/workflow
const wfRouteContent = fs.readFileSync(path.join(ROOT, 'frontend/src/app/api/alerts/workflow/route.ts'), 'utf8');
assert.ok(wfRouteContent.includes("'acknowledged', 'assigned', 'recovering', 'resolved'"), 'workflow route status set match');
assert.ok(!wfRouteContent.includes("'active'"), 'workflow route must NOT accept active status');
assert.ok(wfRouteContent.includes('const MAX_TEXT_LENGTH = 80;'), 'workflow route text clamp match (80)');
assert.ok(wfRouteContent.includes("'Alert ID required'"), 'workflow route exact error "Alert ID required"');
assert.ok(wfRouteContent.includes("'Invalid alert workflow status'"), 'workflow route exact error "Invalid alert workflow status"');
assert.ok(wfRouteContent.includes("'Alert not found'"), 'workflow route exact error "Alert not found"');

// Cross-check with archDoc
assert.ok(archDoc.includes("Primary identifier field is **`id`**"), 'archDoc must specify id as primary identifier');
assert.ok(archDoc.includes("`active` is **not** an accepted workflow status"), 'archDoc must note active is not accepted');
assert.ok(archDoc.includes("80 characters via `slice(0, 80)`"), 'archDoc must note 80 char text clamping');
assert.ok(archDoc.includes('"Alert ID required"'), 'archDoc must document exact error "Alert ID required"');
assert.ok(archDoc.includes('"Invalid alert workflow status"'), 'archDoc must document exact error "Invalid alert workflow status"');
assert.ok(archDoc.includes('"Alert not found"'), 'archDoc must document exact error "Alert not found"');
assert.ok(archDoc.includes('"matched": 1'), 'archDoc must document matched field in response');
assert.ok(archDoc.includes('"modified": 1'), 'archDoc must document modified field in response');
assert.ok(archDoc.includes('No optimistic version/CAS matching on `updatedAt`, `status`, or `_id`'), 'archDoc must truthfully describe no CAS');
console.log('  [PASS] POST /api/alerts/workflow contract verified in source and archDoc');

// 5d. Alert Repository & Document Schema
const alertRepoContent = fs.readFileSync(path.join(ROOT, 'frontend/src/server/repositories/alertRepository.ts'), 'utf8');
assert.ok(alertRepoContent.includes('const ALERT_LIMIT = 10000;'), 'alertRepository must have ALERT_LIMIT = 10000');
assert.ok(alertRepoContent.includes('is_acknowledged: boolean;'), 'AlertDocument must have is_acknowledged');
assert.ok(alertRepoContent.includes('workflow_status?: AlertWorkflowStatus;'), 'AlertDocument must have workflow_status');
assert.ok(alertRepoContent.includes('assigned_to?: string;'), 'AlertDocument must have assigned_to');
assert.ok(alertRepoContent.includes('handling_note?: string;'), 'AlertDocument must have handling_note');
assert.ok(alertRepoContent.includes('workflow_updated_at?: string;'), 'AlertDocument must have workflow_updated_at');

// Cross-check with archDoc
assert.ok(archDoc.includes('ALERT_LIMIT = 10000'), 'archDoc must document ALERT_LIMIT = 10000');
assert.ok(archDoc.includes('`is_acknowledged`'), 'archDoc must document is_acknowledged field');
assert.ok(archDoc.includes('`workflow_status`'), 'archDoc must document workflow_status field');
assert.ok(archDoc.includes('`assigned_to`'), 'archDoc must document assigned_to field');
assert.ok(archDoc.includes('`handling_note`'), 'archDoc must document handling_note field');
assert.ok(archDoc.includes('`workflow_updated_at`'), 'archDoc must document workflow_updated_at field');
assert.ok(archDoc.includes('Nonexistent fields such as `alertId`, `severity`'), 'archDoc must explicitly disclaim nonexistent fields');
console.log('  [PASS] Alert repository schema and retention contract verified');

// 5e. Alert Indexes in mongoHealthRepository.ts
const mongoHealthContent = fs.readFileSync(path.join(ROOT, 'frontend/src/server/repositories/mongoHealthRepository.ts'), 'utf8');
assert.ok(mongoHealthContent.includes("name: 'alerts_timestamp_desc', key: { timestamp: -1 }"), 'mongoHealth alerts_timestamp_desc index match');
assert.ok(mongoHealthContent.includes("name: 'alerts_active_by_level', key: { is_acknowledged: 1, level: 1, timestamp: -1 }"), 'mongoHealth alerts_active_by_level index match');
assert.ok(mongoHealthContent.includes("name: 'alerts_imsi_timestamp', key: { imsi: 1, timestamp: -1 }"), 'mongoHealth alerts_imsi_timestamp index match');

// Cross-check with archDoc
assert.ok(archDoc.includes('alerts_timestamp_desc`: `{ timestamp: -1 }`'), 'archDoc must document alerts_timestamp_desc');
assert.ok(archDoc.includes('alerts_active_by_level`: `{ is_acknowledged: 1, level: 1, timestamp: -1 }`'), 'archDoc must document alerts_active_by_level');
assert.ok(archDoc.includes('alerts_imsi_timestamp`: `{ imsi: 1, timestamp: -1 }`'), 'archDoc must document alerts_imsi_timestamp');
console.log('  [PASS] Alert collection expected indexes verified');

// ---------------------------------------------------------------------------
// 6. System Health & Mongo Health Deep Contract Verification
// ---------------------------------------------------------------------------
console.log('\n6. System Health & Mongo Health Deep Contract Verification');

const sysHealthContent = fs.readFileSync(path.join(ROOT, 'frontend/src/app/api/system/health/route.ts'), 'utf8');
assert.ok(sysHealthContent.includes("'Comprehensive system health check failed'"), 'system/health 500 error message match');
assert.ok(archDoc.includes('"Comprehensive system health check failed"'), 'archDoc must document system/health 500 error');

const mongoHealthRouteContent = fs.readFileSync(path.join(ROOT, 'frontend/src/app/api/system/mongo/health/route.ts'), 'utf8');
assert.ok(mongoHealthRouteContent.includes('{ status: 200 }'), 'mongo/health catch block must return status 200');
assert.ok(mongoHealthRouteContent.includes("'MongoDB health check failed'"), 'mongo/health error message match');
assert.ok(archDoc.includes('HTTP **200 OK** (not 500) with diagnostic payload'), 'archDoc must document mongo/health returns 200 on failure');
console.log('  [PASS] System Health and Mongo Health contracts verified');

// ---------------------------------------------------------------------------
// 7. System Integrity Audit Deep Contract Verification
// ---------------------------------------------------------------------------
console.log('\n7. System Integrity Audit Deep Contract Verification');

// Read-only proof for scan
const scanRepoPath = path.join(ROOT, 'frontend/src/server/repositories/systemAuditRepository.ts');
const scanRepoContent = fs.readFileSync(scanRepoPath, 'utf8');
const scanFnMatch = scanRepoContent.match(/export async function scanSubscriberDocuments[\s\S]*?(?=export async function healSubscriberDocument|$)/);
assert.ok(scanFnMatch, 'scanSubscriberDocuments function must exist');
const scanFnBody = scanFnMatch[0];

const writeMethods = [
  'insertOne', 'insertMany', 'updateOne', 'updateMany',
  'deleteOne', 'deleteMany', 'replaceOne', 'findOneAndUpdate',
  'findOneAndDelete', 'findOneAndReplace', 'drop',
];
for (const writeMethod of writeMethods) {
  assert.ok(!scanFnBody.includes(`.${writeMethod}(`), `scanSubscriberDocuments must NOT call ${writeMethod}`);
}
console.log('  [PASS] scanSubscriberDocuments confirmed strictly read-only');

// Audit heal and batch-heal action logging
const healContent = fs.readFileSync(path.join(ROOT, 'frontend/src/app/api/system/audit/heal/route.ts'), 'utf8');
assert.ok(healContent.includes("logAudit('HEAL'"), "heal route must log action 'HEAL'");

const batchHealContent = fs.readFileSync(path.join(ROOT, 'frontend/src/app/api/system/audit/batch-heal/route.ts'), 'utf8');
assert.ok(batchHealContent.includes("logAudit('HEAL'"), "batch-heal route must log action 'HEAL'");
assert.ok(!batchHealContent.includes("HEAL_BATCH"), "batch-heal route must not emit HEAL_BATCH in current source");

// Cross-check with archDoc
assert.ok(archDoc.includes("action string is **`HEAL`**"), "archDoc must document action string 'HEAL'");
assert.ok(archDoc.includes("Notice action string is **`HEAL`** (not `HEAL_BATCH`)"), "archDoc must clarify batch heal uses 'HEAL'");
console.log('  [PASS] System Audit heal and batch-heal contracts verified');

// ---------------------------------------------------------------------------
// 8. Analytics Init Platform Action Verification
// ---------------------------------------------------------------------------
console.log('\n8. Analytics Init Platform Action Verification');

const initContent = fs.readFileSync(path.join(ROOT, 'frontend/src/app/api/analytics/init/route.ts'), 'utf8');
assert.ok(initContent.includes('computeAnalyticsMetrics()'), 'analytics/init must call computeAnalyticsMetrics()');
assert.ok(initContent.includes('enforceRateLimit(`analytics:init:${auth.auth.user}`, 3, 300)'), 'analytics/init 3/300s limiter match');
assert.ok(archDoc.includes('"MongoDB analytics are computed from subscriber documents on demand."'), 'archDoc message match');
console.log('  [PASS] Analytics Init contract verified');

// ---------------------------------------------------------------------------
// 9. Architecture Freeze Document Structure & Separation Verification
// ---------------------------------------------------------------------------
console.log('\n9. Architecture Freeze Document Structure & Separation Verification');

const requiredSections = [
  '## 1. Executive Summary & Phase 7 Scope Definition',
  '## 2. Authoritative Baseline & Status',
  '## 3. Phase 7 Candidate Endpoint Inventory',
  '## 4. Routing Architecture & Invariants',
  '## 5. Alert Domain Architecture & Contract',
  '## 6. Notification Streaming Architecture & Contract',
  '## 7. System Health Architecture & Contract',
  '## 8. System Audit & Self-Healing Architecture & Contract',
  '## 9. Analytics Init Platform Action Architecture & Contract',
  '## 10. Background Processing & Scheduler Audit',
  '## 11. Security, Authorization & RBAC Canonical Alignment',
  '## 12. Audit Logging & Evidence Contract',
  '## 13. Concurrency Control & State Management',
  '## 14. Error Code & Contract Canonical Catalog',
  '## 15. Backward Compatibility & Migration Strategy',
  '## 16. Phase 7 Subphase Execution Roadmap',
  '## 17. Testing & Verification Framework',
  '## 18. Quality Gates & Acceptance Criteria',
  '## 19. Frozen Boundary Declarations & Exclusions',
  '## 20. Sign-off & Architecture Freeze Commitment',
];

for (const sec of requiredSections) {
  assert.ok(archDoc.includes(sec), `Architecture document missing section: ${sec}`);
  console.log(`  [PASS] Section verified: ${sec.replace('## ', '')}`);
}

// Verify strict CURRENT vs TARGET separation
assert.ok(archDoc.includes('CURRENT FROZEN CONTRACT'), 'archDoc must have CURRENT FROZEN CONTRACT headers');
assert.ok(archDoc.includes('TARGET GO MIGRATION REQUIREMENTS'), 'archDoc must have TARGET GO MIGRATION REQUIREMENTS headers');
console.log('  [PASS] CURRENT vs TARGET separation confirmed in archDoc');

// ---------------------------------------------------------------------------
// 10. Documentation Reconciliation Verification
// ---------------------------------------------------------------------------
console.log('\n10. Documentation Reconciliation Verification');

// 10a. AGENTS.md
const agentsPath = path.join(ROOT, 'AGENTS.md');
assert.ok(fs.existsSync(agentsPath), 'AGENTS.md must exist');
const agentsContent = fs.readFileSync(agentsPath, 'utf8');

assert.ok(agentsContent.includes('Phase 7.0'), 'AGENTS.md must document Phase 7.0');
assert.ok(!agentsContent.includes('Login/logout = Node owner.'), 'AGENTS.md must not contain stale "Login/logout = Node owner."');
assert.ok(agentsContent.includes('CUTOVER_TABLE = 36'), 'AGENTS.md must document CUTOVER_TABLE = 36');
assert.ok(agentsContent.includes('ACTUALLY_ROUTED = 36'), 'AGENTS.md must document ACTUALLY_ROUTED = 36');
console.log('  [PASS] AGENTS.md reconciled');

// 10b. docs/operations/todo.md
const todoPath = path.join(ROOT, 'docs/operations/todo.md');
assert.ok(fs.existsSync(todoPath), 'todo.md must exist');
const todoContent = fs.readFileSync(todoPath, 'utf8');

assert.ok(todoContent.includes('Phase 7.0'), 'todo.md must mention Phase 7.0');
assert.ok(!todoContent.includes('Phase 5.7-C push requires user credentials'), 'todo.md must not contain stale Phase 5.7-C push blocker');
console.log('  [PASS] todo.md reconciled');

// 10c. docs/operations/dev-log.md
const devLogPath = path.join(ROOT, 'docs/operations/dev-log.md');
assert.ok(fs.existsSync(devLogPath), 'dev-log.md must exist');
const devLogContent = fs.readFileSync(devLogPath, 'utf8');

assert.ok(devLogContent.includes('Phase 7.0'), 'dev-log.md must document Phase 7.0');
console.log('  [PASS] dev-log.md reconciled');

// 10d. docs/backend-migration/migration-routing-matrix.md
const matrixPath = path.join(ROOT, 'docs/backend-migration/migration-routing-matrix.md');
assert.ok(fs.existsSync(matrixPath), 'migration-routing-matrix.md must exist');
const matrixContent = fs.readFileSync(matrixPath, 'utf8');

assert.ok(matrixContent.includes('### Phase 7'), 'matrix must include Phase 7 section');
console.log('  [PASS] migration-routing-matrix.md reconciled');

// ---------------------------------------------------------------------------
// 11. Pure ASCII Compliance Check
// ---------------------------------------------------------------------------
console.log('\n11. Pure ASCII Compliance Check');

const filesToCheckAscii = [
  'scripts/test-phase-7-architecture-freeze.mjs',
  'docs/architecture/phase-7-platform-services-architecture.md',
];

for (const relFile of filesToCheckAscii) {
  const full = path.join(ROOT, relFile);
  const buf = fs.readFileSync(full);
  for (let i = 0; i < buf.length; i++) {
    const byte = buf[i];
    if (byte > 127) {
      assert.fail(`Non-ASCII byte (0x${byte.toString(16)}) at byte ${i} in ${relFile}`);
    }
  }
  console.log(`  [PASS] ${relFile} is 100% pure ASCII`);
}

console.log('\n==================================================');
console.log('Phase 7.0 Platform Services Architecture Freeze Suite: PASSED');
console.log('==================================================\n');
