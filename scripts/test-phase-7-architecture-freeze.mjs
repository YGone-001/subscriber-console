#!/usr/bin/env node

/**
 * Phase 7.0 - Platform Services Architecture Freeze Test Suite
 *
 * Verifies:
 * 1. Authoritative 11 candidate endpoints exist in Next.js / Node.
 * 2. Strict freeze invariants: CUTOVER_TABLE = 36, ACTUALLY_ROUTED = 36.
 * 3. None of the 11 Phase 7 candidate endpoints are in CUTOVER_TABLE or routed to Go.
 * 4. Go backend cmd/server/main.go contains zero Phase 7 endpoint registrations.
 * 5. POST /api/system/audit/scan is verified to be read-only (zero DB mutations).
 * 6. Architecture freeze document (docs/architecture/phase-7-platform-services-architecture.md)
 *    contains all 20 required sections and contract declarations.
 * 7. Documentation reconciliation across AGENTS.md, todo.md, dev-log.md, and migration-routing-matrix.md.
 * 8. Pure ASCII compliance across modified files.
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
// 4. POST /api/system/audit/scan Read-Only Verification
// ---------------------------------------------------------------------------
console.log('\n4. Scan Route Read-Only Semantics Verification');

const repoPath = path.join(ROOT, 'frontend/src/server/repositories/systemAuditRepository.ts');
assert.ok(fs.existsSync(repoPath), 'systemAuditRepository.ts must exist');
const repoContent = fs.readFileSync(repoPath, 'utf8');

// Extract the scanSubscriberDocuments function body
const scanFnMatch = repoContent.match(/export async function scanSubscriberDocuments[\s\S]*?(?=export async function healSubscriberDocument|$)/);
assert.ok(scanFnMatch, 'scanSubscriberDocuments function must exist in systemAuditRepository.ts');
const scanFnBody = scanFnMatch[0];

const writeMethods = [
  'insertOne',
  'insertMany',
  'updateOne',
  'updateMany',
  'deleteOne',
  'deleteMany',
  'replaceOne',
  'findOneAndUpdate',
  'findOneAndDelete',
  'findOneAndReplace',
  'drop',
];

for (const writeMethod of writeMethods) {
  assert.ok(
    !scanFnBody.includes(`.${writeMethod}(`),
    `scanSubscriberDocuments must NOT call ${writeMethod} (must be strictly read-only)`
  );
}
console.log('  [PASS] scanSubscriberDocuments confirmed strictly read-only (zero mutation calls)');

// ---------------------------------------------------------------------------
// 5. Architecture Freeze Document Complete 20 Sections
// ---------------------------------------------------------------------------
console.log('\n5. Architecture Freeze Document Structure Verification');

const archDocPath = path.join(ROOT, 'docs/architecture/phase-7-platform-services-architecture.md');
assert.ok(fs.existsSync(archDocPath), 'Phase 7 architecture document must exist');
const archDoc = fs.readFileSync(archDocPath, 'utf8');

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

// Check key freeze declarations in arch doc
const keyDeclarations = [
  'CUTOVER_TABLE',
  'ACTUALLY_ROUTED',
  'Exactly 36 routes',
  '11 candidate endpoints',
  'app_alerts',
  'text/event-stream',
  'X-Accel-Buffering: no',
  'system_heal',
  'Phase 7.1',
  'Phase 7.2',
  'Phase 7.3',
  'Phase 7.4',
  'Phase 7.5',
];

for (const decl of keyDeclarations) {
  assert.ok(archDoc.includes(decl), `Architecture doc must contain declaration: "${decl}"`);
}
console.log('  [PASS] All critical contract declarations present in architecture doc');

// ---------------------------------------------------------------------------
// 6. Documentation Reconciliation Verification
// ---------------------------------------------------------------------------
console.log('\n6. Documentation Reconciliation Verification');

// 6a. AGENTS.md
const agentsPath = path.join(ROOT, 'AGENTS.md');
assert.ok(fs.existsSync(agentsPath), 'AGENTS.md must exist');
const agentsContent = fs.readFileSync(agentsPath, 'utf8');

assert.ok(agentsContent.includes('Phase 7.0'), 'AGENTS.md must document Phase 7.0');
assert.ok(!agentsContent.includes('Login/logout = Node owner.'), 'AGENTS.md must not contain stale "Login/logout = Node owner."');
assert.ok(agentsContent.includes('CUTOVER_TABLE = 36'), 'AGENTS.md must document CUTOVER_TABLE = 36');
assert.ok(agentsContent.includes('ACTUALLY_ROUTED = 36'), 'AGENTS.md must document ACTUALLY_ROUTED = 36');
console.log('  [PASS] AGENTS.md reconciled');

// 6b. docs/operations/todo.md
const todoPath = path.join(ROOT, 'docs/operations/todo.md');
assert.ok(fs.existsSync(todoPath), 'todo.md must exist');
const todoContent = fs.readFileSync(todoPath, 'utf8');

assert.ok(todoContent.includes('Phase 7.0'), 'todo.md must mention Phase 7.0');
assert.ok(!todoContent.includes('Phase 5.7-C push requires user credentials'), 'todo.md must not contain stale Phase 5.7-C push blocker');
console.log('  [PASS] todo.md reconciled');

// 6c. docs/operations/dev-log.md
const devLogPath = path.join(ROOT, 'docs/operations/dev-log.md');
assert.ok(fs.existsSync(devLogPath), 'dev-log.md must exist');
const devLogContent = fs.readFileSync(devLogPath, 'utf8');

assert.ok(devLogContent.includes('Phase 7.0'), 'dev-log.md must document Phase 7.0');
console.log('  [PASS] dev-log.md reconciled');

// 6d. docs/backend-migration/migration-routing-matrix.md
const matrixPath = path.join(ROOT, 'docs/backend-migration/migration-routing-matrix.md');
assert.ok(fs.existsSync(matrixPath), 'migration-routing-matrix.md must exist');
const matrixContent = fs.readFileSync(matrixPath, 'utf8');

assert.ok(matrixContent.includes('### Phase 7'), 'matrix must include Phase 7 section');
console.log('  [PASS] migration-routing-matrix.md reconciled');

// ---------------------------------------------------------------------------
// 7. Pure ASCII Check on New/Modified Script & Architecture Files
// ---------------------------------------------------------------------------
console.log('\n7. Pure ASCII Compliance Check');

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
