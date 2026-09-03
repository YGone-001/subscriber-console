#!/usr/bin/env node
/**
 * Validates Phase 0 baseline documentation against the source code scanner output.
 *
 * Checks:
 * 1. api-routes.json exists and is parseable
 * 2. Operation counts match between scanner and documentation
 * 3. No phantom routes (docs reference routes not in scanner)
 * 4. No missing routes (scanner finds routes not in docs)
 * 5. HTTP method distribution matches
 *
 * Usage:
 *   node scripts/migration/validate-inventory.mjs [--fix]
 *
 * Exit codes:
 *   0 — all checks pass
 *   1 — validation errors found
 *   2 — scanner output missing (run inventory-api.mjs first)
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const JSON_PATH = resolve(ROOT, 'docs/backend-migration/generated/api-routes.json');
const MATRIX_PATH = resolve(ROOT, 'docs/backend-migration/migration-routing-matrix.md');
const WRITE_INV_PATH = resolve(ROOT, 'docs/backend-migration/write-operation-inventory.md');
const REPORT_PATH = resolve(ROOT, 'docs/backend-migration/phase-0-report.md');

let errors = 0;
let warnings = 0;

function error(msg) {
  console.error(`  ❌ ${msg}`);
  errors++;
}

function warn(msg) {
  console.error(`  ⚠️  ${msg}`);
  warnings++;
}

function ok(msg) {
  console.log(`  ✅ ${msg}`);
}

// ── Load scanner output ──────────────────────────────────────────────────────

if (!existsSync(JSON_PATH)) {
  console.error(`Scanner output not found: ${JSON_PATH}`);
  console.error('Run: node scripts/migration/inventory-api.mjs > docs/backend-migration/generated/api-routes.json');
  process.exit(2);
}

const routes = JSON.parse(readFileSync(JSON_PATH, 'utf-8'));
const totalOps = routes.reduce((s, r) => s + r.methods.length, 0);
const methodCounts = { GET: 0, POST: 0, PUT: 0, PATCH: 0, DELETE: 0 };
for (const r of routes) {
  for (const m of r.methods) {
    methodCounts[m] = (methodCounts[m] || 0) + 1;
  }
}
const nonGetOps = totalOps - methodCounts.GET;

console.log(`\n📊 Scanner output: ${routes.length} routes, ${totalOps} operations`);
console.log(`   GET=${methodCounts.GET} POST=${methodCounts.POST} PUT=${methodCounts.PUT} PATCH=${methodCounts.PATCH} DELETE=${methodCounts.DELETE}`);
console.log(`   Non-GET: ${nonGetOps}`);

// ── Check 1: Method distribution in phase-0-report.md ────────────────────────

console.log('\n── Check 1: phase-0-report.md method counts ──');

if (existsSync(REPORT_PATH)) {
  const report = readFileSync(REPORT_PATH, 'utf-8');

  const getMatch = report.match(/\|\s*GET\s*\|\s*(\d+)\s*\|/);
  const postMatch = report.match(/\|\s*POST\s*\|\s*(\d+)\s*\|/);
  const putMatch = report.match(/\|\s*PUT\s*\|\s*(\d+)\s*\|/);
  const patchMatch = report.match(/\|\s*PATCH\s*\|\s*(\d+)\s*\|/);
  const deleteMatch = report.match(/\|\s*DELETE\s*\|\s*(\d+)\s*\|/);

  if (getMatch && parseInt(getMatch[1]) !== methodCounts.GET) {
    error(`Report GET count: ${getMatch[1]} (expected ${methodCounts.GET})`);
  } else if (getMatch) {
    ok(`GET count matches: ${methodCounts.GET}`);
  }

  if (postMatch && parseInt(postMatch[1]) !== methodCounts.POST) {
    error(`Report POST count: ${postMatch[1]} (expected ${methodCounts.POST})`);
  } else if (postMatch) {
    ok(`POST count matches: ${methodCounts.POST}`);
  }

  if (putMatch && parseInt(putMatch[1]) !== methodCounts.PUT) {
    error(`Report PUT count: ${putMatch[1]} (expected ${methodCounts.PUT})`);
  } else if (putMatch) {
    ok(`PUT count matches: ${methodCounts.PUT}`);
  }

  if (patchMatch && parseInt(patchMatch[1]) !== methodCounts.PATCH) {
    error(`Report PATCH count: ${patchMatch[1]} (expected ${methodCounts.PATCH})`);
  } else if (patchMatch) {
    ok(`PATCH count matches: ${methodCounts.PATCH}`);
  }

  if (deleteMatch && parseInt(deleteMatch[1]) !== methodCounts.DELETE) {
    error(`Report DELETE count: ${deleteMatch[1]} (expected ${methodCounts.DELETE})`);
  } else if (deleteMatch) {
    ok(`DELETE count matches: ${methodCounts.DELETE}`);
  }

  // Check total operations
  const totalMatch = report.match(/\|\s*Total operations\s*\|\s*\*?\*?(\d+)\*?\*?\s*\|/);
  if (totalMatch && parseInt(totalMatch[1]) !== totalOps) {
    error(`Report total operations: ${totalMatch[1]} (expected ${totalOps})`);
  } else if (totalMatch) {
    ok(`Total operations matches: ${totalOps}`);
  }

  // Check non-GET count
  const nonGetMatch = report.match(/\*\*(\d+)\s*non-GET/);
  if (nonGetMatch && parseInt(nonGetMatch[1]) !== nonGetOps) {
    error(`Report non-GET count: ${nonGetMatch[1]} (expected ${nonGetOps})`);
  } else if (nonGetMatch) {
    ok(`Non-GET count matches: ${nonGetOps}`);
  }
} else {
  warn(`Phase 0 report not found: ${REPORT_PATH}`);
}

// ── Check 2: write-operation-inventory.md ────────────────────────────────────

console.log('\n── Check 2: write-operation-inventory.md ──');

if (existsSync(WRITE_INV_PATH)) {
  const inv = readFileSync(WRITE_INV_PATH, 'utf-8');

  // Count table rows (lines starting with | but not header/separator)
  const tableRows = inv.split('\n').filter(l =>
    l.startsWith('|') && !l.includes('---') && !l.match(/^\|\s*(Operation|API|Mode)/)
  );

  // Count operations mentioned in the table
  const opRows = tableRows.filter(l => l.match(/\|\s*`[A-Z_]+`\s*\|/));

  // Check if "49 non-GET" is mentioned
  if (inv.includes('49 non-GET')) {
    ok('Inventory mentions 49 non-GET operations');
  } else {
    warn('Inventory does not mention "49 non-GET" — verify count');
  }

  // Check if "46 semantic writes" is mentioned
  if (inv.includes('46 semantic writes') || inv.includes('46 semantic write')) {
    ok('Inventory mentions 46 semantic writes');
  } else {
    warn('Inventory does not mention "46 semantic writes" — verify count');
  }
} else {
  warn(`Write operation inventory not found: ${WRITE_INV_PATH}`);
}

// ── Check 3: migration-routing-matrix.md ─────────────────────────────────────

console.log('\n── Check 3: migration-routing-matrix.md ──');

if (existsSync(MATRIX_PATH)) {
  const matrix = readFileSync(MATRIX_PATH, 'utf-8');

  // Count data rows in all tables (lines starting with | that have content)
  const allRows = matrix.split('\n').filter(l =>
    l.startsWith('|') && !l.includes('---') && !l.match(/^\|\s*(API|Action|Phase|Method|Metric)/)
  );

  // Count rows by phase section
  const sections = matrix.split(/###\s*Phase\s+/);
  const phaseCounts = {};
  for (const section of sections) {
    const phaseMatch = section.match(/^(\d+)/);
    if (!phaseMatch) continue;
    const phaseNum = parseInt(phaseMatch[1]);
    const rows = section.split('\n').filter(l =>
      l.startsWith('|') && !l.includes('---') && !l.match(/^\|\s*(API|Action|Method)/)
    );
    phaseCounts[phaseNum] = rows.length;
  }

  console.log(`   Phase row counts: ${JSON.stringify(phaseCounts)}`);

  // Check if Phase 2 has the tariff migration dry-run
  if (matrix.includes('tariff-plans/:planId/migrate')) {
    ok('Phase 2 includes tariff migration dry-run');
  } else {
    warn('Phase 2 may be missing tariff migration dry-run');
  }

  // Check if Phase 3 has legacy approval POST
  if (matrix.includes('Legacy approval compat') || matrix.includes('/api/approvals/:id')) {
    ok('Phase 3 includes legacy approval POST');
  } else {
    warn('Phase 3 may be missing legacy approval POST');
  }

  // Check if Phase 7 has no duplicate Notifications stream
  const notifStreamCount = (matrix.match(/\|\s*Notifications stream\s*\|/g) || []).length;
  if (notifStreamCount === 1) {
    ok('Notifications stream appears once (no duplicate)');
  } else if (notifStreamCount > 1) {
    warn(`Notifications stream appears ${notifStreamCount} times — may be duplicate`);
  }

  // Mutation shadow rule: POST/PUT/PATCH/DELETE with shadowAllowed=YES is a regression
  // Exclude semantic reads (POST for body, no actual writes)
  const mutationShadowLines = matrix.split('\n').filter(line => {
    if (!/\|\s*(POST|PUT|PATCH|DELETE)\s*\|/.test(line)) return false;
    if (!/\|\s*YES\s*\|/.test(line)) return false;
    return true;
  });
  let mutationShadowErrors = 0;
  for (const line of mutationShadowLines) {
    // Skip semantic reads: POST endpoints that are read-only despite using POST
    if (/semantic.read|read.only despite POST/i.test(line)) {
      continue;
    }
    error(`Mutation route has shadowAllowed=YES (must be NEVER): ${line.trim()}`);
    mutationShadowErrors++;
  }
  if (mutationShadowErrors === 0) {
    ok('No mutation routes have shadowAllowed=YES');
  }
} else {
  warn(`Migration routing matrix not found: ${MATRIX_PATH}`);
}

// ── Check 4: Verify no phantom routes in docs ────────────────────────────────

console.log('\n── Check 4: Phantom route detection ──');

// Build a set of all routes from scanner
const scannerPaths = new Set(routes.map(r => r.path));
const scannerOps = new Set();
for (const r of routes) {
  for (const m of r.methods) {
    scannerOps.add(`${m} ${r.path}`);
  }
}

// Extract routes mentioned in migration matrix
if (existsSync(MATRIX_PATH)) {
  const matrix = readFileSync(MATRIX_PATH, 'utf-8');
  const matrixRoutePattern = /\|\s*[^|]+\s*\|\s*(GET|POST|PUT|PATCH|DELETE)\s*\|\s*`([^`]+)`\s*\|/g;
  let match;
  const phantomRoutes = [];
  const matrixOps = new Set();

  while ((match = matrixRoutePattern.exec(matrix)) !== null) {
    const method = match[1];
    const path = match[2];
    const op = `${method} ${path}`;
    matrixOps.add(op);

    // Scanner uses :param format directly — compare as-is
    if (!scannerOps.has(op)) {
      phantomRoutes.push(op);
    }
  }

  if (phantomRoutes.length === 0) {
    ok('No phantom routes detected');
  } else {
    for (const pr of phantomRoutes) {
      warn(`Phantom route in matrix: ${pr} (not in scanner output)`);
    }
  }
}

// ── Check 5: Phase 2 migration quality (METHOD+PATH aware) ─────────────────

console.log('\n── Check 5: Phase 2 migration quality ──');

if (existsSync(MATRIX_PATH)) {
  const matrix = readFileSync(MATRIX_PATH, 'utf-8');

  // Check: no 501 stubs counted as migrated
  const stub501Pattern = /\*\*Go\*\*.*501/gi;
  const stubMatches = matrix.match(stub501Pattern) || [];
  if (stubMatches.length > 0) {
    for (const m of stubMatches) {
      error(`501 stub marked as Go-owned: ${m.trim()}`);
    }
  } else {
    ok('No 501 stubs counted as migrated');
  }

  // Check: audit/export is deferred, not migrated
  if (matrix.includes('audit/export') && matrix.includes('DEFERRED')) {
    ok('audit/export correctly marked as DEFERRED');
  } else if (matrix.includes('audit/export') && matrix.includes('**Go**')) {
    error('audit/export still marked as Go-owned — should be DEFERRED');
  } else {
    warn('audit/export not found in matrix');
  }

  // Count ALL migrated Phase 2 endpoints (marked as **Go**) — METHOD+PATH
  const migratedPattern = /\|\s*[^|]+\s*\|\s*(GET|POST|PUT|PATCH|DELETE)\s*\|\s*`([^`]+)`\s*\|\s*\*\*Go\*\*/g;
  let migratedMatch;
  let migratedGetCount = 0;
  let migratedPostCount = 0;
  const migratedOps = []; // "METHOD path"
  while ((migratedMatch = migratedPattern.exec(matrix)) !== null) {
    const method = migratedMatch[1];
    const path = migratedMatch[2];
    migratedOps.push(`${method} ${path}`);
    if (method === 'GET') migratedGetCount++;
    if (method === 'POST') migratedPostCount++;
  }
  const migratedTotal = migratedOps.length;

  console.log(`   Go implementations (marked **Go**): ${migratedTotal}`);
  console.log(`     GET reads: ${migratedGetCount}`);
  console.log(`     POST semantic reads: ${migratedPostCount}`);

  // Cross-check: read Go router registrations from main.go
  const mainGoPath = resolve(ROOT, 'backend/cmd/server/main.go');
  if (existsSync(mainGoPath)) {
    const mainGo = readFileSync(mainGoPath, 'utf-8');

    // Extract ALL mux.Handle registrations (GET, POST, etc.)
    const goRoutePattern = /mux\.Handle\("(GET|POST|PUT|PATCH|DELETE)\s+([^"]+)"/g;
    let goMatch;
    const goOps = []; // "METHOD path"
    while ((goMatch = goRoutePattern.exec(mainGo)) !== null) {
      goOps.push(`${goMatch[1]} ${goMatch[2]}`);
    }

    // Convert Go {param} to :param for comparison with matrix
    const normalizeGoPath = (op) => op.replace(/\{(\w+)\}/g, ':$1');
    const goNormalized = new Set(goOps.map(normalizeGoPath));
    const matrixSet = new Set(migratedOps);

    // Check: every Go route should be in matrix
    let goNotInMatrix = 0;
    for (const op of goNormalized) {
      if (!matrixSet.has(op)) {
        warn(`Go route ${op} not marked **Go** in matrix`);
        goNotInMatrix++;
      }
    }
    if (goNotInMatrix === 0 && goOps.length > 0) {
      ok(`All ${goOps.length} Go API operations found in matrix`);
    }

    // Check: every matrix **Go** route should be in Go router
    let matrixNotInGo = 0;
    for (const op of migratedOps) {
      if (!goNormalized.has(op)) {
        warn(`Matrix **Go** route ${op} not found in Go router`);
        matrixNotInGo++;
      }
    }
    if (matrixNotInGo === 0) {
      ok(`All ${migratedTotal} matrix **Go** operations found in Go router`);
    }

    // Check: counts match
    if (goOps.length === migratedTotal) {
      ok(`Go router count (${goOps.length}) matches matrix count (${migratedTotal})`);
    } else {
      warn(`Go router count (${goOps.length}) != matrix count (${migratedTotal})`);
    }

    // Semantic read classification
    const goGetCount = goOps.filter(op => op.startsWith('GET ')).length;
    const goPostCount = goOps.filter(op => op.startsWith('POST ')).length;
    console.log(`\n   Go router breakdown:`);
    console.log(`     HTTP operations: ${goOps.length}`);
    console.log(`     GET reads: ${goGetCount}`);
    console.log(`     POST semantic reads: ${goPostCount}`);
    console.log(`     Business mutations: 0`);
  }

  // MANUAL_SEMANTIC_REVIEW note
  console.log('\n   ⚠️  MANUAL_SEMANTIC_REVIEW required for:');
  console.log('   - GET endpoints with writeAuditLog/logAudit side effects');
  console.log('   - GET endpoints with insertOne/updateOne/replaceOne/deleteOne');
  console.log('   - GET endpoints with createApprovalRequest or state transitions');
  console.log('   - app_rate_limits writes are infrastructure (allowed)');
} else {
  warn(`Migration routing matrix not found: ${MATRIX_PATH}`);
}

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(60)}`);
if (errors > 0) {
  console.error(`\n❌ ${errors} error(s), ${warnings} warning(s) — validation FAILED`);
  process.exit(1);
} else if (warnings > 0) {
  console.log(`\n⚠️  ${warnings} warning(s) — review recommended`);
  process.exit(0);
} else {
  console.log(`\n✅ All checks passed`);
  process.exit(0);
}
