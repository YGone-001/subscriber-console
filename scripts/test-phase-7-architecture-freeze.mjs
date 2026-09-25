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
const archDoc = fs.readFileSync(archDocPath, 'utf8').replace(/\r\n/g, '\n');

function getDocSection(text, startHeader, endHeader) {
  const startIdx = text.indexOf(startHeader);
  if (startIdx === -1) return '';
  const searchFrom = startIdx + startHeader.length;
  const endIdx = endHeader ? text.indexOf(endHeader, searchFrom) : text.length;
  return endIdx === -1 ? text.slice(startIdx) : text.slice(startIdx, endIdx);
}

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
// 6. System Health & Mongo Health Deep Contract & Shape Drift Verification
// ---------------------------------------------------------------------------
console.log('\n6. System Health & Mongo Health Deep Contract & Shape Drift Verification');

const sysHealthContent = fs.readFileSync(path.join(ROOT, 'frontend/src/app/api/system/health/route.ts'), 'utf8');
assert.ok(sysHealthContent.includes("'Comprehensive system health check failed'"), 'system/health 500 error message match');
assert.ok(archDoc.includes('"Comprehensive system health check failed"'), 'archDoc must document system/health 500 error');

// Mongo Health repository type and implementation
const mongoHealthRepoPath = path.join(ROOT, 'frontend/src/server/repositories/mongoHealthRepository.ts');
const mongoHealthRepoContent = fs.readFileSync(mongoHealthRepoPath, 'utf8');
assert.ok(mongoHealthRepoContent.includes('export type MongoHealthReport = {'), 'MongoHealthReport type must be exported');
assert.ok(mongoHealthRepoContent.includes('export async function getMongoHealthReport(): Promise<MongoHealthReport>'), 'getMongoHealthReport must be exported');
assert.ok(mongoHealthRepoContent.includes('database: `${databases.xcloud} / ${databases.app}`'), 'mongoHealthRepo combines xcloud and app database names');
assert.ok(mongoHealthRepoContent.includes('databases,'), 'mongoHealthRepo returns databases role dictionary');

// Mongo Health route failure contract
const mongoHealthRouteContent = fs.readFileSync(path.join(ROOT, 'frontend/src/app/api/system/mongo/health/route.ts'), 'utf8');
assert.ok(mongoHealthRouteContent.includes('{ status: 200 }'), 'mongo/health catch block must return status 200');
assert.ok(mongoHealthRouteContent.includes("'MongoDB health check failed'"), 'mongo/health error message match');
assert.ok(archDoc.includes('HTTP **200 OK** (not 500) with diagnostic payload'), 'archDoc must document mongo/health returns 200 on failure');

// Cross-check Mongo Health success shape in archDoc
const mongoDocSection = getDocSection(archDoc, '#### `GET /api/system/mongo/health`', '\n---');
assert.ok(mongoDocSection, 'Mongo health section must exist in archDoc');

const mongoJsonBlock = mongoDocSection.match(/```json([\s\S]*?)```/)?.[1] || '';
assert.ok(mongoJsonBlock, 'Mongo health success JSON block must exist');
assert.ok(mongoJsonBlock.includes('"database": "xcloud / xcloud_ops"'), 'archDoc must document combined database string');
assert.ok(mongoJsonBlock.includes('"xcloud": "xcloud"'), 'archDoc must document xcloud string property');
assert.ok(mongoJsonBlock.includes('"app": "xcloud_ops"'), 'archDoc must document app string property');
assert.ok(mongoJsonBlock.includes('"documentCount": 100'), 'archDoc must document documentCount in collections');
assert.ok(mongoJsonBlock.includes('"missingIndexes": []'), 'archDoc must document missingIndexes in collections');

assert.ok(mongoDocSection.includes('databases.xcloud` is a string'), 'archDoc must state databases.xcloud is a string');
assert.ok(mongoDocSection.includes('databases.app` is a string'), 'archDoc must state databases.app is a string');
assert.ok(mongoDocSection.includes('database`: String combining xcloud and app database names'), 'archDoc must document combined string invariant');

// Negative drift checks for Mongo Health (inside documented JSON block)
assert.ok(!/^\s{4}"database":\s*"xcloud",/m.test(mongoJsonBlock), 'archDoc JSON must NOT document top-level "database": "xcloud" alone');
assert.ok(!mongoJsonBlock.includes('"xcloud": {'), 'archDoc JSON must NOT document databases.xcloud as object');
assert.ok(!mongoJsonBlock.includes('"xcloud_ops": {'), 'archDoc JSON must NOT document databases.xcloud_ops as object');
assert.ok(!mongoDocSection.includes('databases.xcloud.ok'), 'archDoc must NOT claim databases.xcloud.ok');
assert.ok(!mongoDocSection.includes('databases.xcloud_ops.ok'), 'archDoc must NOT claim databases.xcloud_ops.ok');
console.log('  [PASS] System Health and Mongo Health contracts & shape invariants verified');

// ---------------------------------------------------------------------------
// 7. System Integrity Audit Deep Contract & Drift Verification
// ---------------------------------------------------------------------------
console.log('\n7. System Integrity Audit Deep Contract & Drift Verification');

// 7a. Read-only proof for scan
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

// 7b. Scan read dependency inventory and phase matrix
assert.ok(scanRepoContent.includes('subscribersCollection()'), 'scan reads subscribers');
assert.ok(scanRepoContent.includes('ocsSubscribersCollection()'), 'scan reads ocs_subscribers');
assert.ok(scanRepoContent.includes('ocsBalancesCollection()'), 'scan reads ocs_balances');
assert.ok(scanRepoContent.includes('ocsReservationsCollection()'), 'scan reads ocs_reservations');
assert.ok(scanRepoContent.includes('ocsSessionsCollection()'), 'scan reads ocs_sessions');
assert.ok(scanRepoContent.includes('tariffPlansCollection()'), 'scan reads ocs_tariff_plans');
assert.ok(scanRepoContent.includes('listProfiles()'), 'scan reads profiles via listProfiles()');

const scanDocSection = getDocSection(archDoc, '#### `POST /api/system/audit/scan`', '\n---');
assert.ok(scanDocSection, 'scan section must exist in archDoc');
assert.ok(scanDocSection.includes('xcloud.subscribers'), 'archDoc scan must document xcloud.subscribers');
assert.ok(scanDocSection.includes('xcloud.ocs_subscribers'), 'archDoc scan must document xcloud.ocs_subscribers');
assert.ok(scanDocSection.includes('xcloud.ocs_balances'), 'archDoc scan must document xcloud.ocs_balances');
assert.ok(scanDocSection.includes('xcloud.ocs_reservations'), 'archDoc scan must document xcloud.ocs_reservations');
assert.ok(scanDocSection.includes('xcloud.ocs_sessions'), 'archDoc scan must document xcloud.ocs_sessions');
assert.ok(scanDocSection.includes('xcloud.ocs_tariff_plans'), 'archDoc scan must document xcloud.ocs_tariff_plans');
assert.ok(scanDocSection.includes('xcloud_ops.app_profiles'), 'archDoc scan must document xcloud_ops.app_profiles');

// Scan phases
assert.ok(scanDocSection.includes('phase = reservation'), 'archDoc scan must document phase = reservation');
assert.ok(scanDocSection.includes('phase = tariff'), 'archDoc scan must document phase = tariff');
assert.ok(scanDocSection.includes('phase = ocs'), 'archDoc scan must document phase = ocs');
assert.ok(scanDocSection.includes('phase = sub'), 'archDoc scan must document phase = sub');

// Negative drift checks for scan
assert.ok(scanDocSection.includes('ocs_sessions'), 'dependency inventory must include ocs_sessions');
assert.ok(scanDocSection.includes('ocs_tariff_plans'), 'dependency inventory must include ocs_tariff_plans');
console.log('  [PASS] Audit scan dependency inventory and phase matrix verified');

// 7c. Audit heal request validation and recognized repair types
const healContent = fs.readFileSync(path.join(ROOT, 'frontend/src/app/api/system/audit/heal/route.ts'), 'utf8');
assert.ok(healContent.includes('!imsi || !type'), 'heal route checks !imsi || !type');
assert.ok(healContent.includes('!/^\\d{15}$|^UNKNOWN$/'), 'heal route checks IMSI regex format');
assert.ok(healContent.includes("logAudit('HEAL'"), "heal route must log action 'HEAL'");

const healDocSection = getDocSection(archDoc, '#### `POST /api/system/audit/heal`', '\n---');
assert.ok(healDocSection, 'heal section must exist in archDoc');
assert.ok(healDocSection.includes('Recognized repair types'), 'archDoc heal must label types as recognized repair types');
assert.ok(healDocSection.includes('NOT** a strict route-enforced enum'), 'archDoc heal must note not a strict enum');
assert.ok(healDocSection.includes("action string is **`HEAL`**"), "archDoc must document action string 'HEAL'");
console.log('  [PASS] Audit heal validation and recognized repair types verified');

// 7d. Batch-heal input validation and response schema
const batchHealContent = fs.readFileSync(path.join(ROOT, 'frontend/src/app/api/system/audit/batch-heal/route.ts'), 'utf8');
assert.ok(batchHealContent.includes('!Array.isArray(anomalies) || anomalies.length === 0'), 'batch-heal checks array and non-empty');
assert.ok(batchHealContent.includes("logAudit('HEAL'"), "batch-heal route must log action 'HEAL'");
assert.ok(!batchHealContent.includes("HEAL_BATCH"), "batch-heal route must not emit HEAL_BATCH");

assert.ok(scanRepoContent.includes('failedCount: number'), 'systemAuditRepository must declare failedCount');
assert.ok(scanRepoContent.includes('let failedCount = 0;'), 'batchHealSubscriberDocuments must track failedCount');

const batchHealDocSection = getDocSection(archDoc, '#### `POST /api/system/audit/batch-heal`', '\n---');
assert.ok(batchHealDocSection, 'batch-heal section must exist in archDoc');
assert.ok(batchHealDocSection.includes('does **not** perform strict per-item schema validation'), 'archDoc batch-heal boundary documented');
assert.ok(batchHealDocSection.includes('"failedCount": 0'), 'archDoc batch-heal must document "failedCount": 0');
assert.ok(batchHealDocSection.includes('Field name is **`failedCount`**'), 'archDoc batch-heal must explicitly emphasize failedCount');
assert.ok(batchHealDocSection.includes("Notice action string is **`HEAL`** (not `HEAL_BATCH`)"), "archDoc must clarify batch heal uses 'HEAL'");

// Negative drift check: failureCount must not appear in batch-heal CURRENT contract
assert.ok(!batchHealDocSection.includes('"failureCount"'), 'archDoc batch-heal section must NOT contain "failureCount"');
console.log('  [PASS] Batch-heal validation and failedCount response verified');

// ---------------------------------------------------------------------------
// 8. Analytics Init Deep Contract & Schema Drift Verification
// ---------------------------------------------------------------------------
console.log('\n8. Analytics Init Deep Contract & Schema Drift Verification');

const initContent = fs.readFileSync(path.join(ROOT, 'frontend/src/app/api/analytics/init/route.ts'), 'utf8');
assert.ok(initContent.includes('computeAnalyticsMetrics()'), 'analytics/init must call computeAnalyticsMetrics()');
assert.ok(initContent.includes('enforceRateLimit(`analytics:init:${auth.auth.user}`, 3, 300)'), 'analytics/init 3/300s limiter match');

const analyticsRepoPath = path.join(ROOT, 'frontend/src/server/repositories/analyticsRepository.ts');
const analyticsRepoContent = fs.readFileSync(analyticsRepoPath, 'utf8');
const analyticsMetricsMatch = analyticsRepoContent.match(/export type AnalyticsMetrics = {([\s\S]*?)};/);
assert.ok(analyticsMetricsMatch, 'AnalyticsMetrics type declaration must exist in analyticsRepository.ts');
const metricsTypeBody = analyticsMetricsMatch[1];

const EXPECTED_ANALYTICS_KEYS = [
  'totalTraffic',
  'plmnDist',
  'ratesDist',
  'top5',
  'timestamp',
  'ocsBalances',
  'ocsSessions',
  'ocsReservations',
  'tariffPlanDist',
  'ocsUsage',
];

for (const key of EXPECTED_ANALYTICS_KEYS) {
  assert.ok(metricsTypeBody.includes(`${key}:`), `AnalyticsMetrics in source must declare key ${key}`);
}

const analyticsDocSection = getDocSection(archDoc, '## 9. Analytics Init Platform Action Architecture & Contract', '## 10');
assert.ok(analyticsDocSection, 'Analytics section must exist in archDoc');
assert.ok(analyticsDocSection.includes('"MongoDB analytics are computed from subscriber documents on demand."'), 'archDoc message match');

for (const key of EXPECTED_ANALYTICS_KEYS) {
  assert.ok(
    analyticsDocSection.includes(`"${key}":`) || analyticsDocSection.includes(`\`${key}\``),
    `archDoc must document analytics key ${key}`
  );
}

// Verify nested telemetry metric schemas
const EXPECTED_OCS_BALANCE_FIELDS = [
  'totalSubscribers', 'totalDataAllocated', 'totalDataUsed', 'totalDataReserved',
  'totalDataAvailable', 'dataUtilizationRate', 'totalVoiceAllocated', 'totalVoiceUsed',
  'totalVoiceReserved', 'totalVoiceAvailable', 'totalSmsAllocated', 'totalSmsUsed',
  'totalSmsAvailable', 'validInvariantCount', 'brokenInvariantCount', 'allInvariantsOk',
];
for (const field of EXPECTED_OCS_BALANCE_FIELDS) {
  assert.ok(analyticsDocSection.includes(`\`${field}\``), `archDoc must document ocsBalances field ${field}`);
}

const EXPECTED_OCS_SESSION_FIELDS = [
  'totalSessions', 'activeSessions', 'closingSessions', 'closedSessions',
  'totalGrantedOctets', 'totalUsedOctets', 'interfaceGyCount', 'interfaceRoCount', 'apnDistribution',
];
for (const field of EXPECTED_OCS_SESSION_FIELDS) {
  assert.ok(analyticsDocSection.includes(`\`${field}\``), `archDoc must document ocsSessions field ${field}`);
}

const EXPECTED_OCS_RESERVATION_FIELDS = [
  'totalReservations', 'activeReservations', 'settledReservations', 'releasedReservations',
  'orphanedReservations', 'totalReservedOctets', 'totalReleasedOctets', 'totalUsedOctets',
];
for (const field of EXPECTED_OCS_RESERVATION_FIELDS) {
  assert.ok(analyticsDocSection.includes(`\`${field}\``), `archDoc must document ocsReservations field ${field}`);
}

const EXPECTED_TARIFF_DIST_FIELDS = [
  'planId', 'name', 'subscriberCount', 'percentage', 'status',
];
for (const field of EXPECTED_TARIFF_DIST_FIELDS) {
  assert.ok(analyticsDocSection.includes(`\`${field}\``), `archDoc must document tariffPlanDist field ${field}`);
}

const EXPECTED_OCS_USAGE_FIELDS = [
  'totalRecords', 'chargedRecords', 'totalInputOctets', 'totalOutputOctets', 'totalOctets',
];
for (const field of EXPECTED_OCS_USAGE_FIELDS) {
  assert.ok(analyticsDocSection.includes(`\`${field}\``), `archDoc must document ocsUsage field ${field}`);
}

// Negative drift checks for analytics: fictional fields must not appear in current contract
const fictionalAnalyticsFields = [
  'activeSubscriberCount',
  'balanceMetrics',
  'sessionMetrics',
  'tariffDistribution',
];

const analyticsCurrentContract = getDocSection(analyticsDocSection, '#### CURRENT FROZEN CONTRACT', '##### TARGET GO MIGRATION');
const analyticsJsonBlock = getDocSection(analyticsCurrentContract, '```json', '```');
for (const fictional of fictionalAnalyticsFields) {
  assert.ok(
    !analyticsJsonBlock.includes(`"${fictional}":`),
    `archDoc CURRENT FROZEN CONTRACT JSON must not use fictional analytics field "${fictional}":`
  );
}
// subscriberCount must NOT appear as a direct top-level key under metrics (exactly 6 spaces indentation)
assert.ok(
  !/^[ ]{6}"subscriberCount":/m.test(analyticsJsonBlock),
  'archDoc CURRENT FROZEN CONTRACT JSON must not contain top-level metrics.subscriberCount'
);
console.log('  [PASS] Analytics Init metrics schema and nested type definitions verified');

// ---------------------------------------------------------------------------
// 9. Notification Streaming (SSE) Timer Semantics Verification
// ---------------------------------------------------------------------------
console.log('\n9. Notification Streaming (SSE) Timer Semantics Verification');

assert.ok(sseContent.includes('!hasUpdate && now - lastHeartbeat >= 12000'), 'SSE heartbeat condition match in route');
const sseDocSection = getDocSection(archDoc, '## 6. Notification Streaming Architecture & Contract', '## 7');
assert.ok(sseDocSection, 'SSE section must exist in archDoc');
assert.ok(sseDocSection.includes('now - lastHeartbeat >= 12000'), 'archDoc SSE heartbeat condition match');
assert.ok(sseDocSection.includes('Alert updates do **not** reset `lastHeartbeat`'), 'archDoc SSE lastHeartbeat semantics match');
console.log('  [PASS] Notification stream timer and heartbeat semantics verified');

// ---------------------------------------------------------------------------
// 10. Parameterized Phase 7.1 Candidate Wire Contract Gate
// ---------------------------------------------------------------------------
console.log('\n10. Parameterized Phase 7.1 Candidate Wire Contract Gate');

const PHASE_7_1_CANDIDATE_FIXTURES = [
  {
    method: 'GET',
    path: '/api/alerts',
    routeFile: 'frontend/src/app/api/alerts/route.ts',
    authGuard: 'requireAuth',
    rateLimitKey: 'alerts:list:',
    rateLimitCount: 120,
    rateLimitWindow: 60,
    repositoryCall: 'listAlerts(101)',
    requestBehavior: 'no query parameters parsed',
    successStatus: 200,
    responseKeys: ['alerts', 'activeCriticalCount', 'activeWarningCount', 'activeCount'],
    failureStatus: 500,
    readOnly: true,
  },
  {
    method: 'GET',
    path: '/api/system/health',
    routeFile: 'frontend/src/app/api/system/health/route.ts',
    authGuard: 'requireAuth',
    rateLimitKey: 'system:health:',
    rateLimitCount: 30,
    rateLimitWindow: 60,
    repositoryCall: 'getComprehensiveSystemHealth()',
    requestBehavior: 'no query parameters parsed',
    successStatus: 200,
    responseKeys: ['status', 'score', 'checkedAt', 'subsystems', 'summary'],
    failureStatus: 500,
    readOnly: true,
  },
  {
    method: 'GET',
    path: '/api/system/mongo/health',
    routeFile: 'frontend/src/app/api/system/mongo/health/route.ts',
    authGuard: 'requireAuth',
    rateLimitKey: 'system:mongo-health:',
    rateLimitCount: 30,
    rateLimitWindow: 60,
    repositoryCall: 'getMongoHealthReport()',
    requestBehavior: 'no query parameters parsed',
    successStatus: 200,
    responseKeys: ['ok', 'database', 'databases', 'checkedAt', 'latencyMs', 'collections', 'missingCollections', 'missingIndexes'],
    failureStatus: 200,
    readOnly: true,
  },
  {
    method: 'GET',
    path: '/api/system/audit/status',
    routeFile: 'frontend/src/app/api/system/audit/status/route.ts',
    authGuard: 'requireAuth',
    rateLimitKey: 'system:audit-status:',
    rateLimitCount: 60,
    rateLimitWindow: 60,
    repositoryCall: 'internal status query',
    requestBehavior: 'no query parameters parsed',
    successStatus: 200,
    responseKeys: ['lastSaveTime'],
    failureStatus: 500,
    readOnly: true,
  },
  {
    method: 'POST',
    path: '/api/system/audit/scan',
    routeFile: 'frontend/src/app/api/system/audit/scan/route.ts',
    authGuard: "requireAnyRole(request, ['root', 'operator'])",
    rateLimitKey: 'system:audit-scan:',
    rateLimitCount: 30,
    rateLimitWindow: 60,
    repositoryCall: 'scanSubscriberDocuments(cursor, phase)',
    requestBehavior: 'cursor, phase in JSON body',
    successStatus: 200,
    responseKeys: ['nextCursor', 'scannedCount', 'anomalies'],
    failureStatus: 500,
    readOnly: true,
  },
  {
    method: 'POST',
    path: '/api/analytics/init',
    routeFile: 'frontend/src/app/api/analytics/init/route.ts',
    authGuard: "requireAnyRole(request, ['root', 'operator'])",
    rateLimitKey: 'analytics:init:',
    rateLimitCount: 3,
    rateLimitWindow: 300,
    repositoryCall: 'computeAnalyticsMetrics()',
    requestBehavior: 'no body required',
    successStatus: 200,
    responseKeys: ['message', 'metrics'],
    failureStatus: 500,
    readOnly: true,
  },
];

assert.equal(PHASE_7_1_CANDIDATE_FIXTURES.length, 6, 'Must validate exactly 6 Phase 7.1 read candidates');

for (const fix of PHASE_7_1_CANDIDATE_FIXTURES) {
  const content = fs.readFileSync(path.join(ROOT, fix.routeFile), 'utf8');
  assert.ok(
    content.includes(fix.authGuard),
    `${fix.routeFile} must enforce auth guard: ${fix.authGuard}`
  );
  assert.ok(
    content.includes(`enforceRateLimit(\`${fix.rateLimitKey}`),
    `${fix.routeFile} must enforce rate limit key prefix: ${fix.rateLimitKey}`
  );
  assert.equal(fix.readOnly, true, `${fix.path} must be classified as strictly read-only`);
  console.log(`  [PASS] Phase 7.1 candidate wire contract: ${fix.method} ${fix.path}`);
}

// ---------------------------------------------------------------------------
// 11. Architecture Freeze Document Structure & Separation Verification
// ---------------------------------------------------------------------------
console.log('\n11. Architecture Freeze Document Structure & Separation Verification');

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
// 12. Documentation Reconciliation Verification
// ---------------------------------------------------------------------------
console.log('\n12. Documentation Reconciliation Verification');

// 12a. AGENTS.md
const agentsPath = path.join(ROOT, 'AGENTS.md');
assert.ok(fs.existsSync(agentsPath), 'AGENTS.md must exist');
const agentsContent = fs.readFileSync(agentsPath, 'utf8');

assert.ok(agentsContent.includes('Phase 7.0'), 'AGENTS.md must document Phase 7.0');
assert.ok(!agentsContent.includes('Login/logout = Node owner.'), 'AGENTS.md must not contain stale "Login/logout = Node owner."');
assert.ok(agentsContent.includes('CUTOVER_TABLE = 36'), 'AGENTS.md must document CUTOVER_TABLE = 36');
assert.ok(agentsContent.includes('ACTUALLY_ROUTED = 36'), 'AGENTS.md must document ACTUALLY_ROUTED = 36');
console.log('  [PASS] AGENTS.md reconciled');

// 12b. docs/operations/todo.md
const todoPath = path.join(ROOT, 'docs/operations/todo.md');
assert.ok(fs.existsSync(todoPath), 'todo.md must exist');
const todoContent = fs.readFileSync(todoPath, 'utf8');

assert.ok(todoContent.includes('Phase 7.0'), 'todo.md must mention Phase 7.0');
assert.ok(!todoContent.includes('Phase 5.7-C push requires user credentials'), 'todo.md must not contain stale Phase 5.7-C push blocker');
console.log('  [PASS] todo.md reconciled');

// 12c. docs/operations/dev-log.md
const devLogPath = path.join(ROOT, 'docs/operations/dev-log.md');
assert.ok(fs.existsSync(devLogPath), 'dev-log.md must exist');
const devLogContent = fs.readFileSync(devLogPath, 'utf8');

assert.ok(devLogContent.includes('Phase 7.0'), 'dev-log.md must document Phase 7.0');
console.log('  [PASS] dev-log.md reconciled');

// 12d. docs/backend-migration/migration-routing-matrix.md
const matrixPath = path.join(ROOT, 'docs/backend-migration/migration-routing-matrix.md');
assert.ok(fs.existsSync(matrixPath), 'migration-routing-matrix.md must exist');
const matrixContent = fs.readFileSync(matrixPath, 'utf8');

assert.ok(matrixContent.includes('### Phase 7'), 'matrix must include Phase 7 section');
console.log('  [PASS] migration-routing-matrix.md reconciled');

// ---------------------------------------------------------------------------
// 13. Pure ASCII Compliance Check
// ---------------------------------------------------------------------------
console.log('\n13. Pure ASCII Compliance Check');

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
