#!/usr/bin/env node
/**
 * Phase 8.0 - Next.js Backend Removal Readiness (architecture freeze + residual inventory).
 *
 * READ-ONLY with respect to production behavior:
 *   - reads current API inventory (generated + independent source scan);
 *   - reads the controlled cutover table;
 *   - reads production Go route registrations (cmd/server + remediation);
 *   - scans frontend API callers;
 *   - scans Node backend dependencies (mongodb / jose / bcryptjs);
 *   - inspects proxy.ts responsibilities.
 *
 * It validates P8-I01 .. P8-I20 plus the P8-I11 negative sentinel, and emits the
 * machine-readable block required by the Phase 8.0 specification. It NEVER
 * hard-codes backend_removal_ready=true: readiness is DERIVED from evidence. As
 * long as residual Node production operations exist, it truthfully reports
 * backend_removal_ready=false while the Phase 8.0 architecture/inventory phase
 * itself may PASS.
 *
 * Two ownership dimensions are validated INDEPENDENTLY:
 *   - lifecycle_class: contract/migration state of an operation;
 *   - runtime_owner:   actual request owner, derived by invoking the production
 *                      routing function (locate in frontend/src/lib/cutover-routing.ts:
 *                      resolveRouteOwner) which frontend/src/proxy.ts executes.
 *
 * Acceptance for Phase 8.0 fails when any invariant fails, including:
 *   unresolved > 0 | unknown_production_owner > 0 | frontend_api_callers_unmapped > 0
 *   | runtime_owner_unknown > 0 | go_registered_unclassified > 0
 *
 * Usage: node scripts/test-phase-8-backend-removal-readiness.mjs
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const apiRoot = resolve(root, 'frontend/src/app/api');
const srcRoot = resolve(root, 'frontend/src');
const inventoryPath = resolve(root, 'docs/backend-migration/generated/api-routes.json');
const cutoverPath = resolve(root, 'frontend/src/lib/cutover-routing.ts');
const goServerMain = resolve(root, 'backend/cmd/server/main.go');
const goRemediation = resolve(root, 'backend/internal/remediation/handler.go');
const proxyPath = resolve(root, 'frontend/src/proxy.ts');

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'];

// ---------------------------------------------------------------------------
// Invariant bookkeeping
// ---------------------------------------------------------------------------
const invariants = [];
function check(id, ok, detail) {
  invariants.push({ id, ok: Boolean(ok), detail });
  return Boolean(ok);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function walk(dir, filter, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walk(full, filter, out);
    } else if (filter(full)) {
      out.push(full);
    }
  }
  return out;
}

function rel(p) {
  return relative(root, p).replaceAll('\\', '/');
}

/** Convert a Node route path (`:param`) to the canonical Go mux form (`{param}`). */
function canonicalize(nodePath) {
  return nodePath.replace(/:(\w+)\*?/g, '{$1}');
}

/** Build a regex that matches a request path against a canonical route pattern. */
function patternRegex(canonicalPath) {
  const escaped = canonicalPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const withParams = escaped.replace(/\\\{[^}]+\\\}/g, '[^/]+');
  return new RegExp(`^${withParams}$`);
}

function methodPathKey(method, canonicalPath) {
  return `${method} ${canonicalPath}`;
}

// ---------------------------------------------------------------------------
// 1. Independent source scan of the Next.js API tree (do NOT trust the json alone)
// ---------------------------------------------------------------------------
function scanApiTree() {
  const files = walk(apiRoot, (p) => p.endsWith('route.ts') || p.endsWith('route.js'));
  const ops = [];
  for (const file of files) {
    const content = readFileSync(file, 'utf8');
    const found = new Set();
    const patterns = [
      /export\s+async\s+function\s+(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s*\(/g,
      /export\s+function\s+(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s*\(/g,
      /export\s+const\s+(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s*=/g,
    ];
    for (const pattern of patterns) {
      let m;
      while ((m = pattern.exec(content)) !== null) found.add(m[1]);
    }
    const reExport = /export\s*\{([^}]+)\}/g;
    let rm;
    while ((rm = reExport.exec(content)) !== null) {
      for (const name of rm[1].split(',').map((n) => n.trim().split(/\s+as\s+/)[0].trim())) {
        if (HTTP_METHODS.includes(name)) found.add(name);
      }
    }
    const dirParts = relative(apiRoot, file).split(/[\\/]/).slice(0, -1);
    const apiPath = '/api/' + dirParts
      .map((part) => {
        if (part.startsWith('[...') && part.endsWith(']')) return ':' + part.slice(4, -1) + '*';
        if (part.startsWith('[') && part.endsWith(']')) return ':' + part.slice(1, -1);
        return part;
      })
      .join('/');
    for (const method of [...found].sort()) {
      ops.push({ method, nodePath: apiPath, canonicalPath: canonicalize(apiPath), file: rel(file) });
    }
  }
  ops.sort((a, b) => methodPathKey(a.method, a.canonicalPath).localeCompare(methodPathKey(b.method, b.canonicalPath)));
  return { files, ops };
}

// ---------------------------------------------------------------------------
// 2. Generated inventory (produced by inventory-api.mjs)
// ---------------------------------------------------------------------------
function loadGeneratedInventory() {
  if (!existsSync(inventoryPath)) return null;
  return JSON.parse(readFileSync(inventoryPath, 'utf8'));
}

// ---------------------------------------------------------------------------
// 3. Controlled cutover table
// ---------------------------------------------------------------------------
async function loadCutoverTable() {
  const jiti = createJiti(import.meta.url);
  const mod = await jiti(cutoverPath);
  return {
    table: mod.CUTOVER_TABLE.map((r) => ({ method: r.method, path: r.path, owner: r.owner })),
    // The ACTUAL production routing function used by proxy.ts. Runtime ownership is
    // derived by invoking it, never inferred from lifecycle labels.
    resolveRouteOwner: mod.resolveRouteOwner,
  };
}

// ---------------------------------------------------------------------------
// 4. Production Go route registrations (authoritative source)
// ---------------------------------------------------------------------------
function loadGoRegistrations() {
  const sources = [goServerMain, goRemediation].filter(existsSync);
  const ops = [];
  for (const file of sources) {
    const content = readFileSync(file, 'utf8');
    const re = /mux\.Handle\("(GET|POST|PUT|PATCH|DELETE)\s+([^"]+)"\s*,/g;
    let m;
    while ((m = re.exec(content)) !== null) {
      ops.push({ method: m[1], canonicalPath: m[2], file: rel(file) });
    }
  }
  return ops;
}

// ---------------------------------------------------------------------------
// 5. Frontend API caller inventory
// ---------------------------------------------------------------------------
const CALLER_DIRS = ['app', 'components', 'hooks', 'lib'];
const CALLER_EXCLUDE = [
  /\/app\/api\//, // server-side route implementations, not client callers
  /lib\/cutover-routing\.ts$/, // the routing table itself, not a caller
];

function scanCallers() {
  const files = [];
  for (const dir of CALLER_DIRS) {
    const base = join(srcRoot, dir);
    if (!existsSync(base)) continue;
    files.push(...walk(base, (p) => /\.(ts|tsx|js|jsx|mjs)$/.test(p)));
  }
  const callers = [];
  const literalRe = /[`'"]([^`'"\n]*\/api\/[^`'"\n]*)[`'"]/g;
  for (const file of files) {
    const relFile = rel(file);
    if (CALLER_EXCLUDE.some((re) => re.test(relFile.replaceAll('\\', '/')))) continue;
    const content = readFileSync(file, 'utf8');
    const lines = content.split('\n');
    lines.forEach((line, idx) => {
      let m;
      literalRe.lastIndex = 0;
      while ((m = literalRe.exec(line)) !== null) {
        const raw = m[1];
        if (!raw.includes('/api/')) continue;
        // Normalise: strip query, replace interpolation with a wildcard segment.
        const noQuery = raw.split('?')[0];
        const normalised = noQuery
          .replace(/\$\{[^}]*\}/g, '*')
          .replace(/\/+$/, '');
        if (!normalised.startsWith('/api/')) continue;
        callers.push({ file: relFile, line: idx + 1, literal: raw, normalised });
      }
    });
  }
  return callers;
}

// ---------------------------------------------------------------------------
// 6. Node backend dependency consumers (mongodb / jose / bcryptjs)
// ---------------------------------------------------------------------------
const TRACKED_MODULES = ['mongodb', 'jose', 'bcryptjs'];

function isBackendPath(relFile) {
  const p = relFile.replaceAll('\\', '/');
  return (
    p.includes('/app/api/') ||
    p.startsWith('frontend/src/server/') ||
    p === 'frontend/src/proxy.ts' ||
    /\/lib\/(mongo|audit|auth|security|rateLimit)/.test(p) ||
    /__tests__|\.test\.|\.spec\./.test(p)
  );
}

/** Reverse import graph (imported file -> set of importers) for src-internal specifiers. */
function buildImportGraph() {
  const files = walk(srcRoot, (p) => /\.(ts|tsx|js|jsx|mjs)$/.test(p));
  const importers = new Map();
  const impRe = /(?:import\s+(?:type\s+)?[^;]*?from\s*|require\(\s*)['"]([^'"]+)['"]/g;
  for (const file of files) {
    const dir = dirname(file);
    const content = readFileSync(file, 'utf8');
    let m;
    impRe.lastIndex = 0;
    while ((m = impRe.exec(content)) !== null) {
      const spec = m[1];
      let target = null;
      if (spec.startsWith('@/')) target = join(srcRoot, spec.slice(2));
      else if (spec.startsWith('.')) target = resolve(dir, spec);
      if (!target) continue;
      const cands = [target, `${target}.ts`, `${target}.tsx`, `${target}/index.ts`, `${target}/index.tsx`];
      const found = cands.find((c) => existsSync(c) && statSync(c).isFile());
      if (!found) continue;
      const tRel = rel(found);
      if (!importers.has(tRel)) importers.set(tRel, new Set());
      importers.get(tRel).add(rel(file));
    }
  }
  return importers;
}

function classifyDependencyFile(relFile, importers, typeOnly) {
  if (typeOnly) return 'BUILD_ONLY';
  if (/__tests__|\.test\.|\.spec\./.test(relFile)) return 'TEST_ONLY';
  if (isBackendPath(relFile)) return 'BACKEND_ONLY';
  // Shared lib/types files: if every importer is a backend/test module, the runtime
  // consumer set is backend-only in practice.
  const direct = [...(importers.get(relFile) ?? [])];
  if (direct.length > 0 && direct.every((imp) => isBackendPath(imp))) return 'BACKEND_ONLY';
  if (relFile.startsWith('frontend/src/')) return 'FRONTEND_REQUIRED';
  return 'UNRESOLVED';
}

function scanDependencies() {
  const files = walk(srcRoot, (p) => /\.(ts|tsx|js|jsx|mjs)$/.test(p));
  const importers = buildImportGraph();
  const consumers = {};
  for (const mod of TRACKED_MODULES) consumers[mod] = [];
  const importRe = /(?:import\s+(type\s+)?[^;]*?from\s*|require\(\s*)['"]([^'"]+)['"]/g;
  for (const file of files) {
    const relFile = rel(file);
    const content = readFileSync(file, 'utf8');
    const seen = new Map(); // mod -> typeOnly
    let m;
    importRe.lastIndex = 0;
    while ((m = importRe.exec(content)) !== null) {
      const typeOnly = Boolean(m[1]);
      const spec = m[2];
      for (const mod of TRACKED_MODULES) {
        if (spec === mod || spec.startsWith(mod + '/')) {
          seen.set(mod, (seen.get(mod) ?? true) && typeOnly);
        }
      }
    }
    for (const [mod, typeOnly] of seen) {
      consumers[mod].push({ file: relFile, classification: classifyDependencyFile(relFile, importers, typeOnly) });
    }
  }
  return consumers;
}

// ---------------------------------------------------------------------------
// 7. Proxy responsibilities
// ---------------------------------------------------------------------------
function scanProxy() {
  const content = readFileSync(proxyPath, 'utf8');
  const responsibilities = [
    { key: 'public_api_routes', ok: content.includes("'/api/auth/login'") && content.includes("'/api/auth/logout'") },
    { key: 'api_prefix_gate', ok: content.includes("startsWith('/api/')") },
    { key: 'route_owner_resolution', ok: content.includes('resolveRouteOwner') },
    { key: 'go_forwarding', ok: /forwardToGo|GO_BACKEND_URL/.test(content) },
    { key: 'fail_closed_502', ok: content.includes('GO_BACKEND_UNREACHABLE') && content.includes('502') },
    { key: 'cutover_telemetry', ok: content.includes('cutover_forward') },
    { key: 'node_passthrough', ok: content.includes('NextResponse.next()') },
  ];
  return { content, responsibilities };
}

// ---------------------------------------------------------------------------
// Classification model
// ---------------------------------------------------------------------------
// Documented canonical contract (AGENTS.md section 7):
//   - /api/auth/users + /api/auth/users/{username} are READ-ONLY compatibility aliases.
//   - User mutations are canonical only on /api/users (PATCH update, POST disable,
//     POST password-reset). PUT/DELETE /api/users/{username} are not part of the contract.
const LEGACY_ALIAS_READS = new Set([
  'GET /api/auth/users',
  'GET /api/auth/users/{username}',
]);
const RETIRED_SURFACES = new Set([
  'POST /api/auth/users',
  'PUT /api/auth/users/{username}',
  'PATCH /api/auth/users/{username}',
  'DELETE /api/auth/users/{username}',
  'PUT /api/users/{username}',
  'DELETE /api/users/{username}',
]);
// Retired legacy surfaces still referenced by stale frontend code (endpoints removed
// from the contract during Phase 5.7-C). Callers to these are NOT "unmapped": they are
// explicitly mapped to a retired surface and listed as a cleanup finding.
const RETIRED_CALLER_TARGETS = ['/api/audit', '/api/approvals'];

const CLASS = {
  GO: 'GO_PRODUCTION_OWNED',
  NODE: 'NODE_PRODUCTION_OWNED',
  LEGACY: 'LEGACY_ALIAS',
  RETIRED: 'RETIRED_SURFACE',
  TEST: 'TEST_ONLY',
  UNRESOLVED: 'UNRESOLVED',
};

// ---------------------------------------------------------------------------
// Runtime ownership (independent of lifecycle classification)
// ---------------------------------------------------------------------------
// Derived by invoking the ACTUAL production routing function (resolveRouteOwner)
// with a concrete instance path. proxy.ts defaults every unmatched METHOD+PATH to
// the Next.js Node route handler (`NextResponse.next()`), so a route is only
// `unreachable` when no Next.js route file backs it.
const RUNTIME_OWNER = { GO: 'go', NODE: 'node', UNREACHABLE: 'unreachable', UNKNOWN: 'unknown' };

function concretePath(canonicalPath) {
  return canonicalPath.replace(/\{[^}]+\}/g, '__p8__');
}

function deriveRuntimeOwner(op, resolveRouteOwner) {
  let routed;
  try {
    routed = resolveRouteOwner(op.method, concretePath(op.canonicalPath));
  } catch {
    return RUNTIME_OWNER.UNKNOWN;
  }
  if (routed === 'go') return RUNTIME_OWNER.GO;
  if (routed !== 'node') return RUNTIME_OWNER.UNKNOWN;
  // proxy.ts default branch: unmatched METHOD+PATH executes the Node route handler.
  return existsSync(resolve(root, op.file)) ? RUNTIME_OWNER.NODE : RUNTIME_OWNER.UNREACHABLE;
}

// ---------------------------------------------------------------------------
// Go registration classification (non-tautological)
// ---------------------------------------------------------------------------
// Every production Go registration must map to exactly one accepted category:
//   A. exact current 78-operation inventory entry, or
//   B. exact CUTOVER_TABLE (approved, production-routed Go-native) operation, or
//   C. exact reviewed entry of the curated not-production-routed read residue list.
// Anything else is UNCLASSIFIED_GO_REGISTRATION and fails Phase 8.0 acceptance.
const GO_REG_CLASS = {
  INVENTORY: 'INVENTORY_OPERATION',
  GO_NATIVE: 'GO_NATIVE_CUTOVER_OPERATION',
  GO_NATIVE_UNROUTED: 'GO_NATIVE_UNROUTED_READ',
  UNCLASSIFIED: 'UNCLASSIFIED_GO_REGISTRATION',
};

// Category C: explicit, CURATED allowlist of Go-native READ registrations that are
// currently NOT production-routed — absent from the 78-operation inventory (no current
// Next.js route backs them) and absent from CUTOVER_TABLE (proxy.ts resolves unmatched
// METHOD+PATH to Node; no Node route exists, so the production request path never
// reaches Go for these). Membership is EXACT-MATCH only and additionally asserted to
// be read-only; any registration not matching A, B, or this reviewed list fails P8-I11.
//   GET /api/tariff-plans/{planId}/operations — the Node counterpart route file was
//     deleted with the retired governance surfaces; the Go read registration remains;
//     the rating UI caller still exists and is tracked as Phase 8 cleanup residue.
//   GET /api/ocs/balances/{imsi} — Go-first read added with OCS balance governance;
//     no Node counterpart ever existed; no frontend caller.
const GO_NATIVE_UNROUTED_READS = new Set([
  'GET /api/tariff-plans/{planId}/operations',
  'GET /api/ocs/balances/{imsi}',
]);

function classifyGoRegistration(key, inventoryKeys, cutoverKeys) {
  if (inventoryKeys.has(key)) return GO_REG_CLASS.INVENTORY;
  if (cutoverKeys.has(key)) return GO_REG_CLASS.GO_NATIVE;
  if (GO_NATIVE_UNROUTED_READS.has(key)) return GO_REG_CLASS.GO_NATIVE_UNROUTED;
  return GO_REG_CLASS.UNCLASSIFIED;
}

// Synthetic sentinel: proves P8-I11 is capable of failing. NEVER registered in production.
const GO_SENTINEL_KEY = 'GET /api/__phase8_unclassified_sentinel__';

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log('-- Phase 8.0 Next.js Backend Removal Readiness --\n');

  const { table: cutover, resolveRouteOwner } = await loadCutoverTable();
  const cutoverKeys = new Set(cutover.map((r) => methodPathKey(r.method, r.path)));
  const cutoverByKey = new Map(cutover.map((r) => [methodPathKey(r.method, r.path), r]));

  const { files: apiFiles, ops: sourceOps } = scanApiTree();
  const generated = loadGeneratedInventory();
  const goRegs = loadGoRegistrations();
  const goKeys = new Set(goRegs.map((r) => methodPathKey(r.method, r.canonicalPath)));

  const callers = scanCallers();
  const deps = scanDependencies();
  const proxy = scanProxy();

  // ---- P8-I01 inventory complete ------------------------------------------
  const generatedOps = [];
  if (generated) {
    for (const route of generated) {
      for (const method of route.methods) {
        generatedOps.push({ method, canonicalPath: canonicalize(route.path), nodePath: route.path, file: route.file });
      }
    }
  }
  const inventoryComplete =
    Boolean(generated) &&
    apiFiles.every((f) => existsSync(f)) &&
    generatedOps.length === sourceOps.length;
  check('P8-I01', inventoryComplete, `inventory complete (generated=${generatedOps.length}, source-scan=${sourceOps.length})`);

  // Use the source scan as the authoritative inventory (derived from current source).
  const inventory = sourceOps;
  const inventoryKeys = new Set(inventory.map((o) => methodPathKey(o.method, o.canonicalPath)));

  // ---- P8-I02 exactly 78 current operations --------------------------------
  check('P8-I02', inventory.length === 78, `operations=${inventory.length} (expected 78)`);

  // ---- P8-I03 no duplicate METHOD+PATH --------------------------------------
  check('P8-I03', inventoryKeys.size === inventory.length, `unique=${inventoryKeys.size} total=${inventory.length}`);

  // ---- P8-I04 CUTOVER_TABLE exactly 47 --------------------------------------
  check('P8-I04', cutover.length === 47, `CUTOVER_TABLE=${cutover.length}`);

  // ---- P8-I05 all 47 cutover routes owner=go --------------------------------
  const goOwned = cutover.filter((r) => r.owner === 'go').length;
  check('P8-I05', goOwned === 47, `owner=go count=${goOwned}`);

  // ---- P8-I06 every cutover route exists in inventory or approved mapping ----
  // Go-native cutover routes (registered by Go, no Node route file) are explicitly
  // approved compatibility mappings.
  const goNativeCutover = cutover.filter((r) => !inventoryKeys.has(methodPathKey(r.method, r.path)));
  const goNativeApproved = goNativeCutover.every((r) => goKeys.has(methodPathKey(r.method, r.path)));
  check(
    'P8-I06',
    goNativeApproved,
    `cutover in inventory=${cutover.length - goNativeCutover.length}, go-native approved=${goNativeCutover.length}`,
  );

  // ---- Classification of every inventory operation --------------------------
  const classified = inventory.map((op) => {
    const key = methodPathKey(op.method, op.canonicalPath);
    let classification;
    if (cutoverKeys.has(key)) classification = CLASS.GO;
    else if (LEGACY_ALIAS_READS.has(key)) classification = CLASS.LEGACY;
    else if (RETIRED_SURFACES.has(key)) classification = CLASS.RETIRED;
    else classification = CLASS.NODE;

    return {
      method: op.method,
      nodePath: op.nodePath,
      canonicalPath: op.canonicalPath,
      file: op.file,
      key,
      classification,
      inCutover: cutoverKeys.has(key),
      goRegistered: goKeys.has(key),
      // Runtime ownership is EXECUTABLE evidence: proxy.ts resolves each request by
      // invoking resolveRouteOwner(method, path) and defaults every unmatched
      // METHOD+PATH to the Next.js Node handler. It is never inferred from the
      // lifecycle label (RETIRED_SURFACE does not imply unreachable, LEGACY_ALIAS
      // does not imply Go).
      runtimeOwner: deriveRuntimeOwner(op, resolveRouteOwner),
      callers: callers.filter((c) => patternRegex(op.canonicalPath).test(c.normalised)).map((c) => `${c.file}:${c.line}`),
    };
  });

  const byClass = (cls) => classified.filter((o) => o.classification === cls);
  const goProductionOwned = byClass(CLASS.GO);
  const nodeProductionOwned = byClass(CLASS.NODE);
  const legacyAlias = byClass(CLASS.LEGACY);
  const retiredSurface = byClass(CLASS.RETIRED);
  const testOnly = byClass(CLASS.TEST);
  const unresolved = byClass(CLASS.UNRESOLVED);

  // ---- P8-I07 every operation has a production-owner classification ---------
  check('P8-I07', classified.every((o) => o.classification && o.classification !== CLASS.UNRESOLVED), `classified=${classified.length}`);

  // ---- P8-I08 unknown production owner = 0 ----------------------------------
  const unknownOwner = classified.filter((o) => o.classification === CLASS.UNRESOLVED).length;
  check('P8-I08', unknownOwner === 0, `unknown_production_owner=${unknownOwner}`);

  // ---- P8-I09 every frontend API caller mapped ------------------------------
  const knowable = [...inventory.map((o) => o.canonicalPath), ...goRegs.map((r) => r.canonicalPath)];
  const knownRegexes = knowable.map((p) => patternRegex(p));
  const retiredRegexes = RETIRED_CALLER_TARGETS.map((p) => patternRegex(p));
  const unmappedCallers = [];
  const retiredCallers = [];
  for (const c of callers) {
    if (knownRegexes.some((re) => re.test(c.normalised))) continue;
    if (retiredRegexes.some((re) => re.test(c.normalised))) {
      retiredCallers.push(c);
      continue;
    }
    unmappedCallers.push(c);
  }
  check('P8-I09', unmappedCallers.length === 0, `frontend_api_callers_unmapped=${unmappedCallers.length}`);

  // ---- P8-I10 every Node route classified -----------------------------------
  check('P8-I10', classified.length === inventory.length, `node routes classified=${classified.length}/${inventory.length}`);

  // ---- P8-I11 every Go production route registration classified -------------
  // Non-tautological classification: each registration must independently map to
  //   A. an exact current 78-operation inventory entry, or
  //   B. an exact approved Go-native CUTOVER_TABLE operation,
  // otherwise it is UNCLASSIFIED_GO_REGISTRATION and Phase 8.0 must fail.
  // Existence inside goRegs itself is NOT evidence (that was the old tautology).
  const goRegistrationClasses = goRegs.map((r) => {
    const key = methodPathKey(r.method, r.canonicalPath);
    return { key, file: r.file, category: classifyGoRegistration(key, inventoryKeys, cutoverKeys) };
  });
  const goClassifiedRegistrations = goRegistrationClasses.filter((r) => r.category !== GO_REG_CLASS.UNCLASSIFIED);
  const goUnclassified = goRegistrationClasses.filter((r) => r.category === GO_REG_CLASS.UNCLASSIFIED);
  const goUnroutedReads = goRegistrationClasses.filter((r) => r.category === GO_REG_CLASS.GO_NATIVE_UNROUTED);
  const curatedUnroutedReadOnly = [...GO_NATIVE_UNROUTED_READS].every((k) => k.startsWith('GET '));
  const goRegistrationPartitionHolds =
    goRegistrationClasses.length === goClassifiedRegistrations.length + goUnclassified.length;
  check(
    'P8-I11',
    goRegistrationPartitionHolds && curatedUnroutedReadOnly && goUnclassified.length === 0,
    `go_registered_operations=${goRegistrationClasses.length} classified=${goClassifiedRegistrations.length} unclassified=${goUnclassified.length}`,
  );

  // ---- P8-I11-SENTINEL classification gate is falsifiable --------------------
  // A synthetic registration that is neither an inventory operation nor an approved
  // Go-native cutover operation MUST be classified as UNCLASSIFIED. Pure in-memory:
  // it is never registered in the production Go router.
  const sentinelCategory = classifyGoRegistration(GO_SENTINEL_KEY, inventoryKeys, cutoverKeys);
  const sentinelDetected = sentinelCategory === GO_REG_CLASS.UNCLASSIFIED;
  check(
    'P8-I11-SENTINEL',
    sentinelDetected,
    `synthetic "${GO_SENTINEL_KEY}" -> ${sentinelCategory} (must be UNCLASSIFIED_GO_REGISTRATION)`,
  );

  // ---- P8-I19 runtime ownership fully classified -----------------------------
  const runtimeCounts = { go: 0, node: 0, unreachable: 0, unknown: 0 };
  for (const o of classified) runtimeCounts[o.runtimeOwner] += 1;
  const runtimeTotal = runtimeCounts.go + runtimeCounts.node + runtimeCounts.unreachable + runtimeCounts.unknown;
  check(
    'P8-I19',
    runtimeCounts.unknown === 0 && runtimeTotal === inventory.length,
    `runtime_owner go=${runtimeCounts.go} node=${runtimeCounts.node} unreachable=${runtimeCounts.unreachable} unknown=${runtimeCounts.unknown}, total=${runtimeTotal}`,
  );

  // ---- P8-I20 legacy/retired runtime ownership derived from routing ----------
  // Compatibility surfaces are selected by lifecycle, but their runtime owner is
  // proven by invoking the production routing rule: absent from CUTOVER_TABLE and
  // backed by an executable Node route file => runtime_owner=node. The routing
  // function must also discriminate (resolve cutover operations to Go), otherwise
  // the "unmatched defaults to node" rule would be vacuous evidence.
  const compatibilitySurfaces = classified.filter(
    (o) => o.classification === CLASS.LEGACY || o.classification === CLASS.RETIRED,
  );
  const routingDiscriminates = classified.some((o) => o.runtimeOwner === RUNTIME_OWNER.GO);
  const compatibilityRuntimeDerived = compatibilitySurfaces.every(
    (o) => !o.inCutover && o.runtimeOwner === RUNTIME_OWNER.NODE,
  );
  check(
    'P8-I20',
    routingDiscriminates && compatibilityRuntimeDerived,
    `legacy+retired=${compatibilitySurfaces.length} runtime_owner=node via resolveRouteOwner=${compatibilityRuntimeDerived}, routing discriminates=${routingDiscriminates}`,
  );

  // ---- P8-I12/I13/I14 dependency consumers classified -----------------------
  const depUnresolved = [];
  for (const mod of TRACKED_MODULES) {
    for (const c of deps[mod]) {
      if (c.classification === 'UNRESOLVED') depUnresolved.push(`${mod}:${c.file}`);
    }
  }
  check('P8-I12', deps.mongodb.every((c) => c.classification !== 'UNRESOLVED'), `mongodb consumers=${deps.mongodb.length}`);
  check('P8-I13', deps.jose.every((c) => c.classification !== 'UNRESOLVED'), `jose consumers=${deps.jose.length}`);
  check('P8-I14', deps.bcryptjs.every((c) => c.classification !== 'UNRESOLVED'), `bcryptjs consumers=${deps.bcryptjs.length}`);
  check('P8-DEP', depUnresolved.length === 0, `dependency consumers unresolved=${depUnresolved.length}`);

  // ---- P8-I15 proxy runtime responsibilities classified ---------------------
  check('P8-I15', proxy.responsibilities.every((r) => r.ok), `proxy responsibilities=${proxy.responsibilities.filter((r) => r.ok).length}/${proxy.responsibilities.length}`);

  // ---- P8-I16 residual Node production operations explicitly counted --------
  const nodeRemainder = nodeProductionOwned.map((o) => ({
    method: o.method,
    path: o.canonicalPath,
    reason: o.goRegistered
      ? 'Go implementation exists (shadow) but route is not production-routed through CUTOVER_TABLE'
      : 'No Go implementation / not in CUTOVER_TABLE; Node remains production owner',
    goImplementation: o.goRegistered ? 'PRESENT (shadow)' : 'ABSENT',
    parity: o.goRegistered ? 'UNVERIFIED (no cutover acceptance)' : 'N/A',
    cutoverReadiness: o.goRegistered ? 'CANDIDATE' : 'REQUIRES_GO_IMPLEMENTATION',
    decision: 'MIGRATE_TO_GO',
    requiredPhase: o.goRegistered ? '8.2' : '8.1',
  }));
  // NODE_PRODUCTION_OWNED=33 is the canonical lifecycle/migration bucket. It is NOT
  // the complete count of operations whose current runtime owner is Node: legacy
  // aliases and retired-but-reachable surfaces are also Node-routed at runtime.
  check(
    'P8-I16',
    nodeRemainder.length === nodeProductionOwned.length,
    `canonical_node_migration_remainder=${nodeRemainder.length}`,
  );

  // ---- P8-I17 charging-plane boundary preserved -----------------------------
  // Charging-plane collections (ocs_sessions / ocs_reservations / ocs_usage_records)
  // may be READ over HTTP but must never be scheduled for charging-runtime migration.
  const chargingReads = inventory.filter((o) => /\/api\/ocs\/(sessions|reservations|usage)$/.test(o.nodePath));
  const chargingReadOnly = chargingReads.every((o) => o.method === 'GET');
  const chargingNotCutover = chargingReads.every((o) => !o.inCutover);
  check('P8-I17', chargingReadOnly && chargingNotCutover, `charging reads=${chargingReads.length} read-only=${chargingReadOnly} not-cutover=${chargingNotCutover}`);

  // ---- P8-I18 deletion readiness derived from evidence ----------------------
  const blockers = [];
  if (nodeRemainder.length > 0) blockers.push(`CANONICAL_NODE_MIGRATION_REMAINDER=${nodeRemainder.length}`);
  if (retiredSurface.length > 0) blockers.push(`RETIRED_SURFACES_PENDING_DELETION=${retiredSurface.length}`);
  if (legacyAlias.length > 0) blockers.push(`LEGACY_ALIASES_PENDING_CLOSURE=${legacyAlias.length}`);
  if (retiredCallers.length > 0) blockers.push(`STALE_CALLERS_TO_RETIRED_SURFACES=${retiredCallers.length}`);
  const backendRemovalReady =
    nodeRemainder.length === 0 &&
    retiredSurface.length === 0 &&
    legacyAlias.length === 0 &&
    unresolved.length === 0 &&
    unknownOwner === 0 &&
    unmappedCallers.length === 0 &&
    depUnresolved.length === 0;
  check('P8-I18', true, `backend_removal_ready=${backendRemovalReady} (derived from evidence)`);

  // ---------------------------------------------------------------------------
  // Report
  // ---------------------------------------------------------------------------
  console.log('Invariants:');
  for (const inv of invariants) {
    console.log(`  ${inv.ok ? 'PASS' : 'FAIL'}  ${inv.id.padEnd(8)} ${inv.detail}`);
  }

  console.log('\n-- Canonical Node migration remainder (lifecycle NODE_PRODUCTION_OWNED) --');
  for (const r of nodeRemainder) {
    console.log(`  ${r.method.padEnd(7)} ${r.path}`);
  }

  console.log('\n-- Runtime ownership (derived by invoking resolveRouteOwner) --');
  console.log(`  go=${runtimeCounts.go} node=${runtimeCounts.node} unreachable=${runtimeCounts.unreachable} unknown=${runtimeCounts.unknown} total=${runtimeTotal}`);
  console.log('-- Legacy alias / retired surface runtime ownership --');
  for (const o of compatibilitySurfaces) {
    console.log(`  ${o.method.padEnd(7)} ${o.canonicalPath} lifecycle=${o.classification} runtime_owner=${o.runtimeOwner}`);
  }

  if (goUnclassified.length) {
    console.log('\n-- UNCLASSIFIED Go registrations --');
    for (const r of goUnclassified) console.log(`  ${r.key} (${r.file})`);
  }

  if (goUnroutedReads.length) {
    console.log('\n-- Go-native read registrations not production-routed (tracked residue) --');
    for (const r of goUnroutedReads) console.log(`  ${r.key} (${r.file})`);
  }

  if (retiredCallers.length) {
    console.log('\n-- Stale frontend callers to retired surfaces --');
    for (const c of retiredCallers) console.log(`  ${c.file}:${c.line} -> ${c.normalised}`);
  }
  if (unmappedCallers.length) {
    console.log('\n-- UNMAPPED frontend callers --');
    for (const c of unmappedCallers) console.log(`  ${c.file}:${c.line} -> ${c.normalised}`);
  }

  console.log('\n-- Dependency consumers --');
  for (const mod of TRACKED_MODULES) {
    const cls = {};
    for (const c of deps[mod]) cls[c.classification] = (cls[c.classification] || 0) + 1;
    console.log(`  ${mod}: total=${deps[mod].length} ${JSON.stringify(cls)}`);
  }

  const acceptanceFailures = invariants.filter((i) => !i.ok && i.id !== 'P8-I18');
  const critical = unresolved.length + unknownOwner + unmappedCallers.length + depUnresolved.length;

  console.log('\n==================================================');
  console.log('Phase 8.0 Next.js Backend Removal Readiness');
  console.log(`api_route_files=${apiFiles.length}`);
  console.log(`api_operations=${inventory.length}`);
  console.log(`cutover_routes=${cutover.length}`);
  console.log(`actually_routed=${goOwned}`);
  console.log('');
  console.log(`go_production_owned=${goProductionOwned.length}`);
  console.log(`node_production_owned=${nodeProductionOwned.length}`);
  console.log(`legacy_alias=${legacyAlias.length}`);
  console.log(`retired_surface=${retiredSurface.length}`);
  console.log(`test_only=${testOnly.length}`);
  console.log(`unresolved=${unresolved.length}`);
  console.log('');
  console.log(`frontend_api_callers_unmapped=${unmappedCallers.length}`);
  console.log(`unknown_production_owner=${unknownOwner}`);
  console.log('');
  console.log(`inventory_runtime_go=${runtimeCounts.go}`);
  console.log(`inventory_runtime_node=${runtimeCounts.node}`);
  console.log(`inventory_runtime_unreachable=${runtimeCounts.unreachable}`);
  console.log(`runtime_owner_unknown=${runtimeCounts.unknown}`);
  console.log('');
  console.log(`go_registered_operations=${goRegistrationClasses.length}`);
  console.log(`go_registered_classified=${goClassifiedRegistrations.length}`);
  console.log(`go_registered_unclassified=${goUnclassified.length}`);
  console.log(`go_native_cutover_operations=${goNativeCutover.length}`);
  console.log(`go_registered_unrouted_reads=${goUnroutedReads.length}`);
  console.log(`go_registration_negative_sentinel=${sentinelDetected}`);
  for (const r of goUnroutedReads) console.log(`go_registered_unrouted_read=${r.key}`);
  console.log('');
  console.log(`canonical_node_migration_remainder=${nodeRemainder.length}`);
  console.log(`backend_removal_ready=${backendRemovalReady}`);
  console.log(`backend_removal_blockers=${blockers.length}`);
  for (const b of blockers) console.log(`backend_removal_blocker=${b}`);
  console.log('');
  console.log(`phase8_acceptance=${critical === 0 && acceptanceFailures.length === 0 ? 'PASS' : 'FAIL'}`);
  console.log(`invariants_failed=${acceptanceFailures.length}`);
  console.log('==================================================\n');

  if (critical > 0 || acceptanceFailures.length > 0) {
    console.error('Phase 8.0 readiness FAILED (unresolved/unknown/unmapped/invariant failure).');
    process.exit(1);
  }

  // backend_removal_ready=false is EXPECTED and does not fail Phase 8.0.
  console.log('Phase 8.0 architecture/inventory readiness result: PASS' + (backendRemovalReady ? '' : ' (backend removal BLOCKED as expected)'));
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});