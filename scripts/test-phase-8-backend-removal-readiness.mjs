#!/usr/bin/env node
/**
 * Phase 8.3 - Next.js Business Backend Physical Removal Verification.
 *
 * READ-ONLY with respect to production behavior. Pure source analysis: no network,
 * no MongoDB, no build step. It runs in the CI `node` job (which has no database
 * service) and must keep doing so.
 *
 * The script answers ONE question truthfully, purely from source:
 *   "has the Next.js business backend been PHYSICALLY REMOVED and is the Go backend
 *    now the single production owner?"
 *
 * It therefore validates:
 *   - the Next.js App Router business API tree is gone (0 route files, 0 operations);
 *   - the Next.js business server tree is gone (frontend/src/server);
 *   - no surviving ACTIVE executable code imports the removed tree;
 *   - the surviving Next.js runtime owns no business MongoDB read/write data plane;
 *   - the Go router registration site matches CUTOVER_TABLE as an EXACT METHOD+PATH set;
 *   - every Go registration is independently classified (never tautological);
 *   - the proxy session-validation contract still exists and stays read-only;
 *   - frontend API callers map to Go-owned operations;
 *   - dependency consumers (mongodb / jose / bcryptjs) are all classified.
 *
 * The P8-I11 negative synthetic-registration sentinel is preserved: a synthetic
 * registration that is neither an inventory operation nor an approved CUTOVER_TABLE
 * operation MUST be classified UNCLASSIFIED.
 *
 * The machine-readable block at the end is DERIVED from evidence; nothing is hard-coded
 * green except the historical Phase 7.5 baseline size (47), which is used only to
 * DERIVE the expected current CUTOVER_TABLE size.
 *
 * Usage: node scripts/test-phase-8-backend-removal-readiness.mjs
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const selfPath = resolve(root, 'scripts/test-phase-8-backend-removal-readiness.mjs');
const apiRoot = resolve(root, 'frontend/src/app/api');
const serverRoot = resolve(root, 'frontend/src/server');
const srcRoot = resolve(root, 'frontend/src');
const testsRoot = resolve(root, 'frontend/tests');
const scriptsRoot = resolve(root, 'scripts');
const githubRoot = resolve(root, '.github');
const inventoryPath = resolve(root, 'docs/backend-migration/generated/api-routes.json');
const cutoverPath = resolve(root, 'frontend/src/lib/cutover-routing.ts');
const sessionLibPath = resolve(root, 'frontend/src/lib/sessionMongo.ts');
const proxyPath = resolve(root, 'frontend/src/proxy.ts');
const accountSessionPath = resolve(root, 'frontend/src/lib/accountSession.ts');
const sessionStorePath = resolve(root, 'frontend/src/lib/sessionAccountStore.ts');
const goRouterRoots = [resolve(root, 'backend/cmd'), resolve(root, 'backend/internal')];

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'];
const CODE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

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
  if (!existsSync(dir)) return out;
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

/** Replace a canonical pattern with a concrete instance path for routing probes. */
function concretePath(canonicalPath) {
  return canonicalPath.replace(/\{[^}]+\}/g, '__p83__');
}

/**
 * Blank out code comments while preserving line numbers exactly, so documentation prose
 * inside comments is never counted as a live reference (and reported lines stay accurate).
 */
function stripComments(source) {
  const out = [];
  let inBlock = false;
  for (const raw of source.split('\n')) {
    let i = 0;
    let built = '';
    while (i < raw.length) {
      if (inBlock) {
        const end = raw.indexOf('*/', i);
        if (end === -1) {
          i = raw.length;
          break;
        }
        inBlock = false;
        i = end + 2;
        continue;
      }
      if (raw.startsWith('/*', i)) {
        inBlock = true;
        i += 2;
        continue;
      }
      if (raw.startsWith('//', i) && (i === 0 || raw[i - 1] !== ':')) break;
      built += raw[i];
      i += 1;
    }
    out.push(built);
  }
  return out.join('\n');
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
function scanGoRouter() {
  const files = [];
  for (const base of goRouterRoots) {
    files.push(...walk(base, (p) => p.endsWith('.go') && !p.endsWith('_test.go') && !p.includes('testserver')));
  }
  const ops = [];
  for (const file of files.sort()) {
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
    files.push(...walk(base, (p) => CODE_EXT.test(p)));
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
    /\/lib\/(mongo|session|audit|auth|security|rateLimit)/.test(p) ||
    /__tests__|\.test\.|\.spec\./.test(p)
  );
}

/** Reverse import graph (imported file -> set of importers) for src-internal specifiers. */
function buildImportGraph() {
  const files = walk(srcRoot, (p) => CODE_EXT.test(p));
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
  const files = walk(srcRoot, (p) => CODE_EXT.test(p));
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
  const accountSessionContent = existsSync(accountSessionPath) ? readFileSync(accountSessionPath, 'utf8') : '';
  const responsibilities = [
    { key: 'public_api_routes', ok: content.includes("'/api/auth/login'") && content.includes("'/api/auth/logout'") },
    { key: 'api_prefix_gate', ok: content.includes("startsWith('/api/')") },
    { key: 'route_owner_resolution', ok: content.includes('resolveRouteOwner') },
    { key: 'go_forwarding', ok: /forwardToGo|GO_BACKEND_URL/.test(content) },
    { key: 'fail_closed_502', ok: content.includes('GO_BACKEND_UNREACHABLE') && content.includes('502') },
    { key: 'cutover_telemetry', ok: content.includes('cutover_forward') },
    { key: 'node_passthrough', ok: content.includes('NextResponse.next()') },
  ];
  const sessionValidationPresent =
    existsSync(accountSessionPath) &&
    content.includes('validateCurrentAccount') &&
    accountSessionContent.includes('validateCurrentAccount');
  return { content, responsibilities, sessionValidationPresent };
}

// ---------------------------------------------------------------------------
// 8. Active executable code -> removed Next.js server tree dependencies
// ---------------------------------------------------------------------------
// Roots: frontend/src (removed trees excluded - they no longer exist), frontend/tests,
// scripts and .github. Documentation (docs/**) is intentionally NOT scanned. Comments
// inside code are blanked (line numbers preserved) so historical prose is never counted.
//
// A hit is an ACTIVE dependency on the removed tree: an import specifier, a dynamic
// module load (import / require / jiti / loadModule) or a filesystem resolution
// (readFileSync / readFile / existsSync / statSync / readdirSync / path.join /
// path.resolve / resolve / join / new URL). Bare string literals that merely NAME the
// removed tree - for example removal assertions that verify a path is ABSENT - are data,
// not dependencies, and are reported separately (`literalOnly`). Counting them as live
// imports would make the hygiene gate impossible to clear while removal verification
// itself exists, so they are surfaced for transparency but never gate acceptance.
const SERVER_TREE_RE = /@\/server\/|src\/server\//;
const RESOLUTION_OP_RE =
  /(?:\bimport\b|\brequire\s*\(|\b[Bb]ase[Jj]iti\b|\b[Jj]iti\b|\bloadModule\s*\(|\breadFileSync\b|\breadFile\b|\bexistsSync\b|\bstatSync\b|\breaddirSync\b|\bnew\s+URL\s*\(|\bpath\s*\.\s*(?:join|resolve)\s*\(|\bresolve\s*\(|\bjoin\s*\()/;

function scanActiveServerImports() {
  const roots = [srcRoot, testsRoot, scriptsRoot, githubRoot];
  const hits = [];
  const literalOnly = [];
  for (const base of roots) {
    if (!existsSync(base)) continue;
    const files = walk(base, (p) => CODE_EXT.test(p) || /\.ya?ml$/.test(p));
    for (const file of files) {
      const relFile = rel(file);
      // The scanner itself contains the pattern as a diagnostic literal.
      if (resolve(file) === selfPath) continue;
      stripComments(readFileSync(file, 'utf8')).split('\n').forEach((line, idx) => {
        if (!SERVER_TREE_RE.test(line)) return;
        const entry = { file: relFile, line: idx + 1, text: line.trim() };
        if (RESOLUTION_OP_RE.test(line)) hits.push(entry);
        else literalOnly.push(entry);
      });
    }
  }
  return { hits, literalOnly };
}

// ---------------------------------------------------------------------------
// 9. Surviving Next.js business MongoDB data plane
// ---------------------------------------------------------------------------
// Business collections only. `app_users` is deliberately excluded: the proxy session
// revalidation store is the single sanctioned read path against it.
const BUSINESS_COLLECTIONS = new Set([
  'subscribers',
  'app_profiles',
  'profiles',
  'app_profile_versions',
  'app_ratings',
  'ratings',
  'ocs_tariff_plans',
  'ocs_subscribers',
  'ocs_balances',
  'ocs_sessions',
  'ocs_reservations',
  'ocs_usage',
  'ocs_usage_records',
  'ocs_events',
  'ocs_config',
  'ocs_balance_adjustments',
  'app_alerts',
  'alerts',
  'app_audit_logs',
  'app_approvals',
]);

const MONGO_OP_RE = /\.(findOneAndUpdate|findOneAndDelete|findOneAndReplace|findOne|find|insertMany|insertOne|updateMany|updateOne|replaceOne|deleteMany|deleteOne|bulkWrite|aggregate|countDocuments|distinct|estimatedDocumentCount|createIndexes|createIndex|drop)\s*\(/g;
const MONGO_READ_OPS = new Set(['findOne', 'find', 'aggregate', 'countDocuments', 'distinct', 'estimatedDocumentCount']);
const MONGO_WRITE_OPS = new Set([
  'findOneAndUpdate',
  'findOneAndDelete',
  'findOneAndReplace',
  'insertOne',
  'insertMany',
  'updateOne',
  'updateMany',
  'replaceOne',
  'deleteOne',
  'deleteMany',
  'bulkWrite',
  'createIndex',
  'createIndexes',
  'drop',
]);

/** Collection key -> physical name map, derived from the surviving session Mongo lib source. */
function loadCollectionMap() {
  const map = new Map();
  if (!existsSync(sessionLibPath)) return map;
  const content = readFileSync(sessionLibPath, 'utf8');
  const m = content.match(/\.collection\s*(?:<[^>]*>)?\s*\(\s*'([^']+)'\s*\)/);
  if (m) map.set('users', m[1]);
  return map;
}

function scanNextBusinessMongo() {
  const collectionMap = loadCollectionMap();
  const files = walk(srcRoot, (p) => CODE_EXT.test(p));
  const readers = [];
  const writers = [];
  const COLLECTION_CALL_RE = /(?:collection|getMongoCollection|getXcloudCollection|getAppCollection)\s*(?:<[^>]*>)?\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

  for (const file of files) {
    const relFile = rel(file);
    const content = readFileSync(file, 'utf8');
    const names = new Set();
    for (const m of content.matchAll(/mongoCollections\.(\w+)/g)) {
      names.add(collectionMap.get(m[1]) ?? m[1]);
    }
    let cm;
    COLLECTION_CALL_RE.lastIndex = 0;
    while ((cm = COLLECTION_CALL_RE.exec(content)) !== null) names.add(cm[1]);
    const business = [...names].filter((name) => BUSINESS_COLLECTIONS.has(name));
    if (business.length === 0) continue;

    const ops = new Set();
    let om;
    MONGO_OP_RE.lastIndex = 0;
    while ((om = MONGO_OP_RE.exec(content)) !== null) ops.add(om[1]);
    if ([...ops].some((op) => MONGO_READ_OPS.has(op))) readers.push({ file: relFile, collections: business });
    if ([...ops].some((op) => MONGO_WRITE_OPS.has(op))) writers.push({ file: relFile, collections: business });
  }
  return { readers, writers };
}

/** Read-only verification of the surviving proxy session-validation store. */
function scanSessionStore() {
  if (!existsSync(sessionStorePath) || !existsSync(sessionLibPath)) {
    return { present: false, readOnly: false, ops: [], collections: [] };
  }
  const storeContent = stripComments(readFileSync(sessionStorePath, 'utf8'));
  const libContent = stripComments(readFileSync(sessionLibPath, 'utf8'));
  const ops = [];
  let m;
  for (const content of [storeContent, libContent]) {
    MONGO_OP_RE.lastIndex = 0;
    while ((m = MONGO_OP_RE.exec(content)) !== null) ops.push(m[1]);
  }
  const collections = [...libContent.matchAll(/\.collection\s*(?:<[^>]*>)?\s*\(\s*'([^']+)'\s*\)/g)].map((x) => x[1]);
  const readOnly = ops.length > 0 && ops.every((op) => MONGO_READ_OPS.has(op));
  const usersCollectionOnly = collections.length === 1 && collections[0] === 'app_users';
  const findOneOnly = ops.length > 0 && ops.every((op) => op === 'findOne');
  return { present: true, readOnly: readOnly && usersCollectionOnly && findOneOnly, ops, collections };
}

// ---------------------------------------------------------------------------
// Classification model
// ---------------------------------------------------------------------------
// Documented canonical contract (AGENTS.md section 7):
//   - /api/auth/users + /api/auth/users/{username} are READ-ONLY compatibility aliases.
//   - User mutations are canonical only on /api/users.
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
// Retired legacy surfaces still referenced by stale frontend code (removed from the
// contract during Phase 5.7-C). Callers to these are mapped to a retired surface and
// reported as a cleanup finding, never as an unknown caller.
const RETIRED_CALLER_TARGETS = ['/api/audit', '/api/approvals'];

// Phase 8.2 frozen canonical residual cutover set (33 exact METHOD+PATH keys).
const CANONICAL_RESIDUAL_KEYS = new Set([
  'GET /api/analytics/metrics',
  'GET /api/analytics/sparkline',
  'GET /api/ocs/balances',
  'GET /api/ocs/reservations',
  'GET /api/ocs/sessions',
  'GET /api/ocs/usage',
  'GET /api/profiles',
  'GET /api/profiles/{name}',
  'GET /api/profiles/{name}/stats',
  'GET /api/profiles/{name}/versions',
  'GET /api/ratings',
  'POST /api/ratings',
  'GET /api/ratings/{id}',
  'PUT /api/ratings/{id}',
  'DELETE /api/ratings/{id}',
  'GET /api/search',
  'GET /api/subscribers',
  'GET /api/subscribers/{imsi}',
  'POST /api/subscribers/batch/precheck',
  'POST /api/subscribers/policy',
  'POST /api/subscribers/{imsi}/traffic-adjustments',
  'GET /api/tariff-plans',
  'GET /api/tariff-plans/{planId}',
  'GET /api/tariff-plans/{planId}/export',
  'GET /api/tariff-plans/{planId}/migrate',
  'POST /api/tariff-plans/{planId}/migrate',
  'GET /api/tariff-plans/{planId}/rules',
  'POST /api/tariff-plans/{planId}/rules',
  'PUT /api/tariff-plans/{planId}/rules/{ruleId}',
  'PATCH /api/tariff-plans/{planId}/rules/{ruleId}',
  'DELETE /api/tariff-plans/{planId}/rules/{ruleId}',
  'GET /api/tariff-plans/{planId}/subscribers',
  'POST /api/tariff-plans/import',
]);

// Frozen Phase 7.5 / Phase 8.1 production routing table size before Phase 8.2.
// Historical fact, referenced only to DERIVE the current expected size.
const PHASE_7_5_CUTOVER_BASELINE = 47;

// ---------------------------------------------------------------------------
// Runtime ownership (independent of lifecycle classification)
// ---------------------------------------------------------------------------
// Derived by invoking the ACTUAL production routing function (resolveRouteOwner).
const RUNTIME_OWNER = { GO: 'go', NODE: 'node', UNKNOWN: 'unknown' };

function deriveRuntimeOwner(method, canonicalPath, resolveRouteOwner) {
  try {
    return resolveRouteOwner(method, concretePath(canonicalPath)) === 'go' ? RUNTIME_OWNER.GO : RUNTIME_OWNER.NODE;
  } catch {
    return RUNTIME_OWNER.UNKNOWN;
  }
}

// ---------------------------------------------------------------------------
// Go registration classification (non-tautological)
// ---------------------------------------------------------------------------
// Every production Go registration must map to exactly one accepted category:
//   A. exact CUTOVER_TABLE (approved, production-routed Go-native) operation, or
//   B. exact reviewed entry of the curated not-production-routed read residue list.
// Anything else is UNCLASSIFIED_GO_REGISTRATION and fails Phase 8.3 acceptance.
const GO_REG_CLASS = {
  GO_NATIVE: 'GO_NATIVE_CUTOVER_OPERATION',
  GO_NATIVE_UNROUTED: 'GO_NATIVE_UNROUTED_READ',
  UNCLASSIFIED: 'UNCLASSIFIED_GO_REGISTRATION',
};

// Category B: curated allowlist of Go-native READ registrations that are NOT
// production-routed. EMPTY after Phase 8.2 (both former entries were resolved by adding
// exact production routing). The former entries are retained for provenance and are
// asserted to be inside CUTOVER_TABLE with owner=go.
const GO_NATIVE_UNROUTED_READS = new Set([
  // EMPTY after Phase 8.2. Do not add entries without an explicit architecture decision.
]);

const FORMER_GO_NATIVE_UNROUTED_READS = [
  'GET /api/tariff-plans/{planId}/operations',
  'GET /api/ocs/balances/{imsi}',
];

function classifyGoRegistration(key, cutoverKeys) {
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
  console.log('-- Phase 8.3 Next.js Business Backend Physical Removal --\n');

  const { table: cutover, resolveRouteOwner } = await loadCutoverTable();
  const cutoverKeys = new Set(cutover.map((r) => methodPathKey(r.method, r.path)));
  const cutoverByKey = new Map(cutover.map((r) => [methodPathKey(r.method, r.path), r]));

  const { files: apiFiles, ops: sourceOps } = scanApiTree();
  const generated = loadGeneratedInventory();
  const goRegs = scanGoRouter();
  const goKeys = new Set(goRegs.map((r) => methodPathKey(r.method, r.canonicalPath)));

  const callers = scanCallers();
  const deps = scanDependencies();
  const proxy = scanProxy();
  const { hits: serverImportHits, literalOnly: serverImportLiterals } = scanActiveServerImports();
  const mongoAccess = scanNextBusinessMongo();
  const sessionStore = scanSessionStore();

  // ---- Derived removal evidence -------------------------------------------
  const nextApiRouteFiles = apiFiles.length;
  const nextApiOperations = sourceOps.length;
  const nextServerTreePresent = existsSync(serverRoot);
  const activeServerImports = serverImportHits.length;
  const goRegisteredOperations = goRegs.length;
  const goOwnerCount = cutover.filter((r) => r.owner === 'go').length;
  const nextBusinessMongoReaders = mongoAccess.readers.length;
  const nextBusinessMongoWriters = mongoAccess.writers.length;

  // ---- P8-I01 inventory complete ------------------------------------------
  const generatedOps = [];
  if (Array.isArray(generated)) {
    for (const route of generated) {
      for (const method of route.methods) {
        generatedOps.push({ method, canonicalPath: canonicalize(route.path) });
      }
    }
  }
  const inventoryComplete =
    Array.isArray(generated) && generatedOps.length === sourceOps.length && apiFiles.every((f) => existsSync(f));
  check('P8-I01', inventoryComplete, `inventory complete (generated=${generatedOps.length}, source-scan=${sourceOps.length})`);

  // The source scan is the authoritative inventory (derived from current source).
  const inventory = sourceOps;
  const inventoryKeys = new Set(inventory.map((o) => methodPathKey(o.method, o.canonicalPath)));

  // ---- P8-I02 Next.js API surface is physically gone -----------------------
  // Replaces the historic "exactly 72 operations" gate, which is structurally
  // impossible once the tree is removed. Keeps the identifier.
  check(
    'P8-I02',
    nextApiRouteFiles === 0 && nextApiOperations === 0,
    `next_api_route_files=${nextApiRouteFiles} next_api_operations=${nextApiOperations} (removal completion)`,
  );

  // ---- P8-I03 no duplicate METHOD+PATH -------------------------------------
  const goRegsUnique = goKeys.size === goRegs.length;
  check('P8-I03', goRegsUnique && inventoryKeys.size === inventory.length, `go_unique=${goKeys.size}/${goRegs.length} inventory_unique=${inventoryKeys.size}/${inventory.length}`);

  // ---- P8-I04 CUTOVER_TABLE size DERIVED, never hard-coded -----------------
  const canonicalMissing = [...CANONICAL_RESIDUAL_KEYS].filter((k) => !cutoverKeys.has(k));
  const legacyMissing = [...LEGACY_ALIAS_READS].filter((k) => !cutoverKeys.has(k));
  const residueCutoverKeys = FORMER_GO_NATIVE_UNROUTED_READS.filter((k) => cutoverKeys.has(k));
  const expectedCutover =
    PHASE_7_5_CUTOVER_BASELINE +
    CANONICAL_RESIDUAL_KEYS.size +
    LEGACY_ALIAS_READS.size +
    residueCutoverKeys.length;
  check(
    'P8-I04',
    cutover.length === expectedCutover && canonicalMissing.length === 0 && legacyMissing.length === 0,
    `CUTOVER_TABLE=${cutover.length} derived_expected=${expectedCutover} (47 baseline + ${CANONICAL_RESIDUAL_KEYS.size} canonical + ${LEGACY_ALIAS_READS.size} legacy + ${residueCutoverKeys.length} residue) canonical_missing=${canonicalMissing.length} legacy_missing=${legacyMissing.length}`,
  );

  // ---- P8-I05 ACTUALLY_ROUTED == CUTOVER_TABLE and every entry owner=go -----
  const cutoverUniqueKeys = new Set(cutover.map((r) => methodPathKey(r.method, r.path)));
  check(
    'P8-I05',
    goOwnerCount === cutover.length && cutoverUniqueKeys.size === cutover.length,
    `owner=go count=${goOwnerCount} unique=${cutoverUniqueKeys.size} total=${cutover.length}`,
  );

  // ---- P8-I06 every cutover route is Go-registered (missing-route detection) --
  const cutoverWithoutGoRegistration = [...cutoverKeys].filter((k) => !goKeys.has(k)).sort();
  check(
    'P8-I06',
    cutoverWithoutGoRegistration.length === 0,
    `cutover_without_go_registration=${cutoverWithoutGoRegistration.length}`,
  );

  // ---- P8-I07 every Go registration is cutover-routed (phantom detection) ----
  const goRegisteredUnrouted = [...goKeys].filter((k) => !cutoverKeys.has(k)).sort();
  check(
    'P8-I07',
    goRegisteredUnrouted.length === 0,
    `go_registered_unrouted=${goRegisteredUnrouted.length}`,
  );

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

  // ---- P8-I08 unknown production owner = 0 ----------------------------------
  check(
    'P8-I08',
    unmappedCallers.length === 0 && goRegisteredUnrouted.length === 0,
    `unknown_production_owner=${unmappedCallers.length + goRegisteredUnrouted.length}`,
  );

  // ---- P8-I10 no ACTIVE executable code references the removed tree ---------
  // Roots: frontend/src/** (removed trees excluded), frontend/tests/**, scripts/**,
  // .github/**; documentation (docs/**) is excluded and code comments are stripped.
  // This is the "physical removal is truly complete" hygiene gate: any surviving
  // reference is either a live import of a deleted module or a stale toolchain path.
  check(
    'P8-I10',
    activeServerImports === 0,
    `active_server_imports=${activeServerImports} (frontend/src + frontend/tests + scripts + .github)`,
  );

  // ---- P8-I11 every Go production route registration classified -------------
  // Non-tautological: each registration must independently map to an exact approved
  // CUTOVER_TABLE operation, otherwise it is UNCLASSIFIED_GO_REGISTRATION.
  const goRegistrationClasses = goRegs.map((r) => {
    const key = methodPathKey(r.method, r.canonicalPath);
    return { key, file: r.file, category: classifyGoRegistration(key, cutoverKeys) };
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
  const sentinelCategory = classifyGoRegistration(GO_SENTINEL_KEY, cutoverKeys);
  const sentinelDetected = sentinelCategory === GO_REG_CLASS.UNCLASSIFIED;
  check(
    'P8-I11-SENTINEL',
    sentinelDetected,
    `synthetic "${GO_SENTINEL_KEY}" -> ${sentinelCategory} (must be UNCLASSIFIED_GO_REGISTRATION)`,
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
  check(
    'P8-I15',
    proxy.responsibilities.every((r) => r.ok),
    `proxy responsibilities=${proxy.responsibilities.filter((r) => r.ok).length}/${proxy.responsibilities.length}`,
  );

  // ---- P8-I16 Next.js owns no business MongoDB data plane -------------------
  // Replaces the historic "canonical Node migration remainder == 0" gate, which is
  // vacuously true once no Node operation exists. This is the equivalent
  // removal-completion invariant: the surviving Next.js production source performs
  // zero reads and zero writes against business collections.
  check(
    'P8-I16',
    nextBusinessMongoReaders === 0 && nextBusinessMongoWriters === 0,
    `next_business_mongo_readers=${nextBusinessMongoReaders} next_business_mongo_writers=${nextBusinessMongoWriters}`,
  );

  // ---- P8-I17 charging-plane boundary preserved -----------------------------
  // Charging-plane collections may be READ over HTTP (Go-owned management reads) but no
  // charging-plane mutation may be routed.
  const chargingCutoverOps = [...cutoverKeys].filter((k) => /^\w+ \/api\/ocs\/(sessions|reservations|usage)$/.test(k));
  const chargingReadOnly = chargingCutoverOps.every((k) => k.startsWith('GET '));
  const chargingMutatingOps = [...cutoverKeys].filter(
    (k) => /\/api\/ocs\/(sessions|reservations|usage)/.test(k) && !k.startsWith('GET '),
  );
  check(
    'P8-I17',
    chargingCutoverOps.length > 0 && chargingReadOnly && chargingMutatingOps.length === 0,
    `charging reads=${chargingCutoverOps.length} read-only=${chargingReadOnly} charging_mutations=${chargingMutatingOps.length}`,
  );

  // ---- P8-I19 runtime ownership fully Go (derived by resolveRouteOwner) -----
  const runtimeUnknown = cutover.filter(
    (r) => deriveRuntimeOwner(r.method, r.path, resolveRouteOwner) !== RUNTIME_OWNER.GO,
  );
  const runtimeCounts = { go: 0, node: 0, unknown: 0 };
  for (const r of cutover) runtimeCounts[deriveRuntimeOwner(r.method, r.path, resolveRouteOwner)] += 1;
  check(
    'P8-I19',
    runtimeUnknown.length === 0 && runtimeCounts.unknown === 0,
    `cutover runtime_owner go=${runtimeCounts.go} node=${runtimeCounts.node} unknown=${runtimeCounts.unknown}, non_go=${runtimeUnknown.length}`,
  );

  // ---- P8-I20 legacy alias / retired surface ownership from routing --------
  const routingDiscriminates = cutover.some((r) => r.owner === 'go');
  const legacyGoOwned = [...LEGACY_ALIAS_READS].every(
    (k) => cutoverByKey.get(k)?.owner === 'go' && goKeys.has(k),
  );
  const retiredSurfacesNotExecutable = [...RETIRED_SURFACES].every((k) => !cutoverKeys.has(k) && !goKeys.has(k));
  check(
    'P8-I20',
    routingDiscriminates && legacyGoOwned && retiredSurfacesNotExecutable,
    `legacy_aliases=${LEGACY_ALIAS_READS.size} legacy_go_owned=${legacyGoOwned} retired_not_executable=${retiredSurfacesNotExecutable}, routing discriminates=${routingDiscriminates}`,
  );

  // ---- P8-I21 frozen canonical residual set is fully cut over to Go ---------
  const canonicalKeys = [...CANONICAL_RESIDUAL_KEYS];
  const canonicalNotCutover = canonicalKeys.filter((k) => !cutoverKeys.has(k));
  const canonicalNotGoOwned = canonicalKeys.filter((k) => cutoverByKey.get(k)?.owner !== 'go');
  const canonicalNotGoRegistered = canonicalKeys.filter((k) => !goKeys.has(k));
  const canonicalRuntimeGo = canonicalKeys.filter(
    (k) => {
      const [method, path] = k.split(' ');
      return deriveRuntimeOwner(method, path, resolveRouteOwner) === RUNTIME_OWNER.GO;
    },
  ).length;
  check(
    'P8-I21',
    canonicalNotCutover.length === 0 &&
      canonicalNotGoOwned.length === 0 &&
      canonicalNotGoRegistered.length === 0 &&
      canonicalRuntimeGo === CANONICAL_RESIDUAL_KEYS.size,
    `canonical_expected=${CANONICAL_RESIDUAL_KEYS.size} cutover=${canonicalKeys.length - canonicalNotCutover.length} go_registered=${canonicalKeys.length - canonicalNotGoRegistered.length} runtime_go=${canonicalRuntimeGo}`,
  );

  // ---- P8-I22 the six retired surfaces are no longer executable -------------
  const retiredKeys = [...RETIRED_SURFACES];
  const retiredStillInInventory = retiredKeys.filter((k) => inventoryKeys.has(k));
  const retiredStillRouted = retiredKeys.filter((k) => cutoverKeys.has(k));
  const retiredInGoRouter = retiredKeys.filter((k) => goKeys.has(k));
  check(
    'P8-I22',
    retiredStillInInventory.length === 0 && retiredStillRouted.length === 0 && retiredInGoRouter.length === 0,
    `retired_expected=${retiredKeys.length} still_in_inventory=${retiredStillInInventory.length} still_routed=${retiredStillRouted.length} go_registered=${retiredInGoRouter.length}`,
  );

  // ---- P8-I23 both Go-native unrouted reads resolved to production routing ---
  const residueNotCutover = FORMER_GO_NATIVE_UNROUTED_READS.filter((k) => !cutoverKeys.has(k));
  const residueNotGoOwned = FORMER_GO_NATIVE_UNROUTED_READS.filter((k) => cutoverByKey.get(k)?.owner !== 'go');
  check(
    'P8-I23',
    FORMER_GO_NATIVE_UNROUTED_READS.length === 2 &&
      residueNotCutover.length === 0 &&
      residueNotGoOwned.length === 0 &&
      goUnroutedReads.length === 0,
    `go_native_unrouted_start=${FORMER_GO_NATIVE_UNROUTED_READS.length} residue_cutover=${residueCutoverKeys.length} remaining_unrouted=${goUnroutedReads.length}`,
  );

  // ---- P8-I24 stale callers to retired surfaces = 0 --------------------------
  const staleCallersToRetired = retiredCallers.length;
  check('P8-I24', staleCallersToRetired === 0, `stale_callers_to_retired_surfaces=${staleCallersToRetired}`);

  // ---- P8-I25 proxy session validation contract preserved -------------------
  check(
    'P8-I25',
    proxy.sessionValidationPresent,
    `proxy_session_validation_present=${proxy.sessionValidationPresent}`,
  );

  // ---- P8-I26 surviving session store is read-only --------------------------
  check(
    'P8-I26',
    sessionStore.present && sessionStore.readOnly,
    `session_store present=${sessionStore.present} read_only=${sessionStore.readOnly} ops=[${sessionStore.ops.join(',')}] collections=[${sessionStore.collections.join(',')}]`,
  );

  // ---- P8-I27 Next.js business backend removed ------------------------------
  // "Business backend removed" = the App Router API tree, the server layer and the
  // business MongoDB data plane are physically gone. Stale references from test/tooling
  // harness code are a separate hygiene gate (P8-I10) and do not redefine this fact.
  const nextBusinessApiOperations = inventory.length;
  const nextBusinessBackendRemoved =
    nextApiRouteFiles === 0 &&
    nextApiOperations === 0 &&
    !nextServerTreePresent &&
    nextBusinessMongoReaders === 0 &&
    nextBusinessMongoWriters === 0;
  check(
    'P8-I27',
    nextBusinessBackendRemoved,
    `next_business_api_operations=${nextBusinessApiOperations} next_business_backend_removed=${nextBusinessBackendRemoved}`,
  );

  // ---- P8-I18 removal readiness derived from evidence ----------------------
  const blockers = [];
  if (nextApiRouteFiles > 0) blockers.push(`NEXT_API_ROUTE_FILES=${nextApiRouteFiles}`);
  if (nextApiOperations > 0) blockers.push(`NEXT_API_OPERATIONS=${nextApiOperations}`);
  if (nextServerTreePresent) blockers.push('NEXT_SERVER_TREE_PRESENT');
  if (activeServerImports > 0) blockers.push(`ACTIVE_SERVER_IMPORTS=${activeServerImports}`);
  if (nextBusinessMongoReaders > 0) blockers.push(`NEXT_BUSINESS_MONGO_READERS=${nextBusinessMongoReaders}`);
  if (nextBusinessMongoWriters > 0) blockers.push(`NEXT_BUSINESS_MONGO_WRITERS=${nextBusinessMongoWriters}`);
  if (goRegisteredUnrouted.length > 0) blockers.push(`GO_REGISTERED_UNROUTED=${goRegisteredUnrouted.length}`);
  if (goUnclassified.length > 0) blockers.push(`GO_REGISTERED_UNCLASSIFIED=${goUnclassified.length}`);
  if (cutoverWithoutGoRegistration.length > 0) blockers.push(`CUTOVER_WITHOUT_GO_REGISTRATION=${cutoverWithoutGoRegistration.length}`);
  if (unmappedCallers.length > 0) blockers.push(`FRONTEND_API_CALLERS_UNMAPPED=${unmappedCallers.length}`);
  if (staleCallersToRetired > 0) blockers.push(`STALE_CALLERS_TO_RETIRED_SURFACES=${staleCallersToRetired}`);
  if (depUnresolved.length > 0) blockers.push(`DEPENDENCY_CONSUMERS_UNRESOLVED=${depUnresolved.length}`);
  if (runtimeCounts.unknown > 0) blockers.push(`RUNTIME_OWNER_UNKNOWN=${runtimeCounts.unknown}`);
  if (!proxy.sessionValidationPresent) blockers.push('PROXY_SESSION_VALIDATION_MISSING');
  if (!sessionStore.present || !sessionStore.readOnly) blockers.push('SESSION_STORE_NOT_READ_ONLY');
  const backendRemovalReady = blockers.length === 0;
  check('P8-I18', backendRemovalReady, `backend_removal_ready=${backendRemovalReady} blockers=${blockers.length}`);

  // ---------------------------------------------------------------------------
  // Report
  // ---------------------------------------------------------------------------
  console.log('Invariants:');
  for (const inv of invariants) {
    console.log(`  ${inv.ok ? 'PASS' : 'FAIL'}  ${inv.id.padEnd(14)} ${inv.detail}`);
  }

  console.log('\n-- Runtime ownership of CUTOVER_TABLE (derived by invoking resolveRouteOwner) --');
  console.log(`  go=${runtimeCounts.go} node=${runtimeCounts.node} unknown=${runtimeCounts.unknown} total=${cutover.length}`);

  console.log('\n-- Dependency consumers --');
  for (const mod of TRACKED_MODULES) {
    const cls = {};
    for (const c of deps[mod]) cls[c.classification] = (cls[c.classification] || 0) + 1;
    console.log(`  ${mod}: total=${deps[mod].length} ${JSON.stringify(cls)}`);
  }

  if (goUnclassified.length) {
    console.log('\n-- UNCLASSIFIED Go registrations --');
    for (const r of goUnclassified) console.log(`  ${r.key} (${r.file})`);
  }
  if (cutoverWithoutGoRegistration.length) {
    console.log('\n-- CUTOVER_TABLE routes missing from the Go router --');
    for (const key of cutoverWithoutGoRegistration) console.log(`  ${key}`);
  }
  if (goRegisteredUnrouted.length) {
    console.log('\n-- Go registrations outside CUTOVER_TABLE (phantom) --');
    for (const key of goRegisteredUnrouted) console.log(`  ${key}`);
  }
  if (serverImportHits.length) {
    console.log('\n-- ACTIVE dependencies on the removed Next.js server tree --');
    for (const hit of serverImportHits) console.log(`  ${hit.file}:${hit.line} ${hit.text}`);
  }
  if (serverImportLiterals.length) {
    console.log('\n-- INFO: bare literals naming the removed tree (not dependencies) --');
    for (const hit of serverImportLiterals) console.log(`  ${hit.file}:${hit.line} ${hit.text}`);
  }
  if (retiredCallers.length) {
    console.log('\n-- Stale frontend callers to retired surfaces --');
    for (const c of retiredCallers) console.log(`  ${c.file}:${c.line} -> ${c.normalised}`);
  }
  if (unmappedCallers.length) {
    console.log('\n-- UNMAPPED frontend callers --');
    for (const c of unmappedCallers) console.log(`  ${c.file}:${c.line} -> ${c.normalised}`);
  }
  if (mongoAccess.readers.length || mongoAccess.writers.length) {
    console.log('\n-- Surviving Next.js business MongoDB access --');
    for (const r of mongoAccess.readers) console.log(`  READ  ${r.file} [${r.collections.join(',')}]`);
    for (const w of mongoAccess.writers) console.log(`  WRITE ${w.file} [${w.collections.join(',')}]`);
  }

  const acceptanceFailures = invariants.filter((i) => !i.ok);

  console.log('\n==================================================');
  console.log('Phase 8.3 Next.js Business Backend Physical Removal');
  console.log(`next_api_route_files=${nextApiRouteFiles}`);
  console.log(`next_api_operations=${nextApiOperations}`);
  console.log(`next_server_tree_present=${nextServerTreePresent}`);
  console.log(`active_server_imports=${activeServerImports}`);
  console.log(`removal_residual_references=${activeServerImports}`);
  console.log(`removal_reference_literals=${serverImportLiterals.length}`);
  console.log('');
  console.log(`cutover_routes=${cutover.length}`);
  console.log(`actually_routed=${goOwnerCount}`);
  console.log(`go_registered_operations=${goRegisteredOperations}`);
  console.log(`go_cutover_operations=${goOwnerCount}`);
  console.log(`go_registered_classified=${goClassifiedRegistrations.length}`);
  console.log(`go_registered_unclassified=${goUnclassified.length}`);
  console.log(`go_registered_unrouted=${goRegisteredUnrouted.length}`);
  console.log(`cutover_without_go_registration=${cutoverWithoutGoRegistration.length}`);
  console.log(`go_registration_negative_sentinel=${sentinelDetected}`);
  console.log('');
  console.log(`next_business_api_operations=${nextBusinessApiOperations}`);
  console.log(`next_business_mongo_readers=${nextBusinessMongoReaders}`);
  console.log(`next_business_mongo_writers=${nextBusinessMongoWriters}`);
  console.log(`frontend_api_callers_unmapped=${unmappedCallers.length}`);
  console.log(`stale_callers_to_retired_surfaces=${staleCallersToRetired}`);
  console.log('');
  console.log(`proxy_session_validation_present=${proxy.sessionValidationPresent}`);
  console.log(`proxy_session_store_read_only=${sessionStore.present && sessionStore.readOnly}`);
  console.log('');
  console.log(`canonical_residual_expected=${CANONICAL_RESIDUAL_KEYS.size}`);
  console.log(`canonical_residual_runtime_go=${canonicalRuntimeGo}`);
  console.log(`runtime_owner_unknown=${runtimeCounts.unknown}`);
  console.log(`go_native_unrouted_start=${FORMER_GO_NATIVE_UNROUTED_READS.length}`);
  console.log(`go_native_residue_cutover=${residueCutoverKeys.length}`);
  console.log(`go_native_unrouted_remaining=${goUnroutedReads.length}`);
  console.log(`retired_surfaces_active=${retiredStillInInventory.length + retiredStillRouted.length + retiredInGoRouter.length}`);
  console.log('');
  console.log(`backend_removal_ready=${backendRemovalReady}`);
  console.log(`next_business_backend_removed=${nextBusinessBackendRemoved}`);
  console.log(`backend_removal_blockers=${blockers.length}`);
  for (const b of blockers) console.log(`backend_removal_blocker=${b}`);
  for (const hit of serverImportHits) console.log(`removal_residual_reference=${hit.file}:${hit.line}`);
  console.log('');
  console.log(`phase83_acceptance=${acceptanceFailures.length === 0 ? 'PASS' : 'FAIL'}`);
  console.log(`phase83_invariants_failed=${acceptanceFailures.length}`);
  console.log('==================================================\n');

  if (acceptanceFailures.length > 0) {
    console.error('Phase 8.3 Next.js business backend removal verification FAILED.');
    process.exit(1);
  }

  console.log('Phase 8.3 Next.js business backend removal verification result: PASS');
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
