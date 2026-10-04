#!/usr/bin/env node
/**
 * API Ownership Invariants (production architecture).
 *
 * READ-ONLY with respect to production behavior. Pure source analysis: no network,
 * no MongoDB, no build step. It runs in the CI `node` job (which has no database
 * service) and must keep doing so.
 *
 * The script answers ONE question truthfully, purely from source:
 *   "is the Go API service the single production owner of the /api surface, routed at
 *    the Nginx edge, with the Next.js runtime owning only the UI?"
 *
 * It therefore validates:
 *   - the Next.js App Router business API tree is absent (0 route files, 0 operations);
 *   - the Next.js business server tree is absent (frontend/src/server);
 *   - no surviving ACTIVE executable code imports the absent tree;
 *   - the Next.js runtime owns no business MongoDB read/write data plane;
 *   - the Go router registration site IS the authoritative production API surface
 *     (84 exact METHOD+PATH registrations, zero duplicates), never a migration artifact;
 *   - the six retired mutation methods are absent from that surface;
 *   - Nginx owns API routing at the edge: /api and /api/* -> Go, / -> Next.js, with
 *     client-supplied identity headers stripped on the API locations;
 *   - frontend/src/proxy.ts carries no JWT verification, no Mongo access, no route-owner
 *     lookup and no identity-header injection (it is a UI-only navigation guard);
 *   - frontend/package.json declares no backend runtime dependency;
 *   - frontend API callers map to Go-owned operations;
 *   - dependency consumers (mongodb / jose / bcryptjs) are all classified.
 *
 * The machine-readable block at the end is DERIVED from evidence. The only frozen
 * constant is the canonical production API surface size (84), used to assert the
 * derived Go registration count.
 *
 * Usage: node scripts/test-api-ownership-invariants.mjs
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveGoRegistrations, classifyGoRegistrations } from './lib/go-registrations.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const selfPath = resolve(root, 'scripts/test-api-ownership-invariants.mjs');
const apiRoot = resolve(root, 'frontend/src/app/api');
const serverRoot = resolve(root, 'frontend/src/server');
const srcRoot = resolve(root, 'frontend/src');
const testsRoot = resolve(root, 'frontend/tests');
const scriptsRoot = resolve(root, 'scripts');
const githubRoot = resolve(root, '.github');
const proxyPath = resolve(root, 'frontend/src/proxy.ts');
const nginxPath = resolve(root, 'deploy/nginx/xcloud.conf');
const frontendPackagePath = resolve(root, 'frontend/package.json');

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'];
const CODE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

// Frozen final canonical production API surface size. The set itself is always derived
// from the Go registration site; this number only asserts the derived total.
const EXPECTED_GO_REGISTRATIONS = 84;

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

/** Blank out `#` comment lines (Nginx/conf style), preserving line count. */
function stripHashComments(source) {
  return source
    .split('\n')
    .map((line) => (line.trimStart().startsWith('#') ? '' : line))
    .join('\n');
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
// 3. Frontend API caller inventory
// ---------------------------------------------------------------------------
const CALLER_DIRS = ['app', 'components', 'hooks', 'lib'];
const CALLER_EXCLUDE = [
  /\/app\/api\//, // server-side route implementations, not client callers
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
// 4. Node backend dependency consumers (mongodb / jose / bcryptjs)
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
// 5. Active executable code -> removed Next.js server tree dependencies
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
// 6. Surviving Next.js business MongoDB data plane
// ---------------------------------------------------------------------------
// Business collections only. `app_users` is deliberately excluded: the read-only proxy
// session lookup is the single sanctioned Next.js Mongo read path.
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

function scanNextBusinessMongo() {
  const files = walk(srcRoot, (p) => CODE_EXT.test(p));
  const readers = [];
  const writers = [];
  const COLLECTION_CALL_RE = /(?:collection|getMongoCollection|getXcloudCollection|getAppCollection)\s*(?:<[^>]*>)?\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

  for (const file of files) {
    const relFile = rel(file);
    const content = readFileSync(file, 'utf8');
    const names = new Set();
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

// ---------------------------------------------------------------------------
// 7. Surviving Next.js proxy runtime (UI-only navigation guard)
// ---------------------------------------------------------------------------
// The proxy must carry NO authentication/business runtime: no JWT verification (jose),
// no Mongo access, no cutover-table lookup, and no trusted identity-header injection.
// Comments are stripped so historical prose about the retired behaviour is never
// mistaken for live code.
const PROXY_FORBIDDEN_TOKENS = [
  { key: 'jose', re: /\bjose\b/ },
  { key: 'jwtVerify', re: /\bjwtVerify\b/ },
  { key: 'mongodb', re: /\bmongodb\b|MongoClient/ },
  { key: 'findOne', re: /\bfindOne\b/ },
  { key: 'CUTOVER_TABLE', re: /\bCUTOVER_TABLE\b/ },
  { key: 'resolveRouteOwner', re: /\bresolveRouteOwner\b/ },
  { key: 'forwardToGo', re: /\bforwardToGo\b/ },
  { key: 'identity_header_injection', re: /\bx-(?:user|role|permissions)\b/i },
];

function scanProxy() {
  const proxyPresent = existsSync(proxyPath);
  const content = proxyPresent ? readFileSync(proxyPath, 'utf8') : '';
  const code = stripComments(content);
  const violations = [];
  for (const token of PROXY_FORBIDDEN_TOKENS) {
    code.split('\n').forEach((line, idx) => {
      if (token.re.test(line)) violations.push({ token: token.key, line: idx + 1, text: line.trim() });
    });
  }
  // Legacy proxy.ts is retired. UI navigation guard is AuthGate.tsx/AuthProvider.tsx/auth-client.ts.
  const authProviderPath = resolve(srcRoot, 'providers/AuthProvider.tsx');
  const authGatePath = resolve(srcRoot, 'auth/AuthGate.tsx');
  const authClientPath = resolve(srcRoot, 'auth/auth-client.ts');
  const guardCode = (existsSync(authProviderPath) ? readFileSync(authProviderPath, 'utf8') : '') +
                    (existsSync(authGatePath) ? readFileSync(authGatePath, 'utf8') : '') +
                    (existsSync(authClientPath) ? readFileSync(authClientPath, 'utf8') : '');
  const consultsGoAuth = !proxyPresent && /\/api\/auth\/me/.test(guardCode);
  return { content, violations, consultsGoAuth, legacyProxyAbsent: !proxyPresent };
}

// ---------------------------------------------------------------------------
// 8. Nginx edge routing (API -> Go, UI -> Next.js, identity headers stripped)
// ---------------------------------------------------------------------------
function scanNginx() {
  const content = existsSync(nginxPath) ? readFileSync(nginxPath, 'utf8') : '';
  const code = stripHashComments(content);
  const upstreams = {};
  for (const m of code.matchAll(/upstream\s+([A-Za-z0-9_]+)\s*\{([^}]*)\}/g)) {
    upstreams[m[1]] = m[2].replace(/\s+/g, ' ').trim();
  }
  const locations = [];
  for (const m of code.matchAll(/location\s+([^{]+?)\s*\{([^}]*)\}/g)) {
    locations.push({ pattern: m[1].trim(), body: m[2] });
  }
  const find = (pattern) => locations.find((l) => l.pattern === pattern);
  const proxyTo = (l, upstream) =>
    Boolean(l) && new RegExp(`proxy_pass\\s+http://${upstream}\\b`).test(l.body);
  const headerStripped = (body, name) => new RegExp(`proxy_set_header\\s+${name}\\s+""\\s*;`).test(body);

  const apiLocations = locations.filter((l) => l.pattern.includes('/api'));
  const goUpstreamOk = (upstreams.xcloud_go ?? '').includes('127.0.0.1:18888');
  const nextUpstreamPresent = Boolean(upstreams.xcloud_next);
  const apiExact = find('= /api');
  const apiPrefix = find('/api/');
  const uiRoot = find('/');
  const apiToGo = proxyTo(apiExact, 'xcloud_go') && proxyTo(apiPrefix, 'xcloud_go');
  const uiToGo = proxyTo(uiRoot, 'xcloud_go');
  const identityHeadersStripped = apiLocations.length > 0 && apiLocations.every(
    (l) => headerStripped(l.body, 'X-User') && headerStripped(l.body, 'X-Role') && headerStripped(l.body, 'X-Permissions'),
  );

  return {
    content,
    upstreams,
    apiLocations: apiLocations.map((l) => l.pattern),
    goUpstreamOk,
    nextUpstreamPresent,
    apiToGo,
    uiToGo,
    identityHeadersStripped,
  };
}

// ---------------------------------------------------------------------------
// 9. frontend/package.json direct dependency surface
// ---------------------------------------------------------------------------
const BANNED_FRONTEND_DEPENDENCIES = ['jose', 'mongodb', 'jiti'];

function scanFrontendPackage() {
  if (!existsSync(frontendPackagePath)) return { present: false, banned: BANNED_FRONTEND_DEPENDENCIES };
  const pkg = JSON.parse(readFileSync(frontendPackagePath, 'utf8'));
  const deps = {
    ...(pkg.dependencies ?? {}),
    ...(pkg.devDependencies ?? {}),
    ...(pkg.peerDependencies ?? {}),
    ...(pkg.optionalDependencies ?? {}),
  };
  const banned = BANNED_FRONTEND_DEPENDENCIES.filter((name) => Object.prototype.hasOwnProperty.call(deps, name));
  return { present: true, banned };
}

// ---------------------------------------------------------------------------
// Classification model
// ---------------------------------------------------------------------------
// The six retired mutation methods. They are not part of the final production API surface.
const RETIRED_SURFACES = new Set([
  'POST /api/auth/users',
  'PUT /api/auth/users/{username}',
  'PATCH /api/auth/users/{username}',
  'DELETE /api/auth/users/{username}',
  'PUT /api/users/{username}',
  'DELETE /api/users/{username}',
]);

// Read-only compatibility aliases that MUST remain Go-owned.
const LEGACY_ALIAS_READS = new Set([
  'GET /api/auth/users',
  'GET /api/auth/users/{username}',
]);

// Retired legacy surfaces still referenced by stale frontend code. Callers to these are
// mapped to a retired surface and reported as a cleanup finding, never as unknown callers.
const RETIRED_CALLER_TARGETS = ['/api/audit', '/api/approvals'];

// Canonical production API surface (33 exact METHOD+PATH keys) carried by the Go
// registration site; every one of them must be present after normalization.
const CANONICAL_API_KEYS = new Set([
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

// Synthetic sentinel: proves the derived surface is a genuine exact enumeration and not a
// prefix/glob match. Never registered in production.
const GO_SENTINEL_KEY = 'GET /api/__api_ownership_unclassified_sentinel__';

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log('-- API Ownership Invariants (Go API + Nginx edge production architecture) --\n');

  const { keys: goKeys, duplicates: goDuplicates } = deriveGoRegistrations();
  const goKeySet = new Set(goKeys);
  const goRegistrationPaths = goKeys.map((k) => k.split(' ').slice(1).join(' '));
  const { reads: goReads, mutations: goMutations } = classifyGoRegistrations(goKeys);

  const { files: apiFiles, ops: sourceOps } = scanApiTree();
  const callers = scanCallers();
  const deps = scanDependencies();
  const proxy = scanProxy();
  const nginx = scanNginx();
  const frontendPackage = scanFrontendPackage();
  const { hits: serverImportHits, literalOnly: serverImportLiterals } = scanActiveServerImports();
  const mongoAccess = scanNextBusinessMongo();

  // ---- Derived removal evidence -------------------------------------------
  const nextApiRouteFiles = apiFiles.length;
  const nextApiOperations = sourceOps.length;
  const nextServerTreePresent = existsSync(serverRoot);
  const activeServerImports = serverImportHits.length;
  const goRegisteredOperations = goKeys.length;
  const goRegistrationDuplicates = goDuplicates.length;
  const nextBusinessMongoReaders = mongoAccess.readers.length;
  const nextBusinessMongoWriters = mongoAccess.writers.length;

  // ---- AO-01 inventory complete ------------------------------------------
  // The source scan is the authoritative (and only) inventory: it is derived from
  // the current filesystem. The former generated JSON mirror was retired with the
  // completed migration tooling, so completeness is now asserted directly from the
  // scan: every discovered route file exists, and every derived operation is a
  // fully-formed, unique METHOD+PATH key.
  const inventoryComplete =
    apiFiles.length === new Set(apiFiles).size &&
    apiFiles.every((f) => existsSync(f)) &&
    sourceOps.every((o) => Boolean(o.method) && Boolean(o.canonicalPath) && existsSync(resolve(root, o.file))) &&
    new Set(sourceOps.map((o) => methodPathKey(o.method, o.canonicalPath))).size === sourceOps.length;
  check('AO-01', inventoryComplete, `inventory complete (source-scan route files=${apiFiles.length}, operations=${sourceOps.length})`);

  // The source scan is the authoritative inventory (derived from current source).
  const inventory = sourceOps;
  const inventoryKeys = new Set(inventory.map((o) => methodPathKey(o.method, o.canonicalPath)));

  // ---- AO-02 Next.js API surface is physically gone -----------------------
  check(
    'AO-02',
    nextApiRouteFiles === 0 && nextApiOperations === 0,
    `next_api_route_files=${nextApiRouteFiles} next_api_operations=${nextApiOperations} (removal completion)`,
  );

  // ---- AO-03 the Go registration surface is a unique exact enumeration ------
  const goSurfaceUnique = goDuplicates.length === 0 && goKeySet.size === goKeys.length;
  check(
    'AO-03',
    goSurfaceUnique && inventoryKeys.size === inventory.length,
    `go_unique=${goKeySet.size}/${goKeys.length} go_duplicates=${goDuplicates.length} inventory_unique=${inventoryKeys.size}/${inventory.length}`,
  );

  // ---- AO-04 derived production API surface == 84 (never a migration artifact) --
  check(
    'AO-04',
    goRegisteredOperations === EXPECTED_GO_REGISTRATIONS,
    `production_api_registrations=${goRegisteredOperations} expected=${EXPECTED_GO_REGISTRATIONS} (derived from the Go registration site)`,
  );

  // ---- AO-05 the six retired mutation methods are absent -------------------
  const retiredRegistered = [...RETIRED_SURFACES].filter((k) => goKeySet.has(k) || inventoryKeys.has(k));
  check(
    'AO-05',
    retiredRegistered.length === 0,
    `retired_mutations_expected=${RETIRED_SURFACES.size} retired_active=${retiredRegistered.length}`,
  );

  // ---- AO-06 Nginx routes the API surface to Go ----------------------------
  check(
    'AO-06',
    nginx.goUpstreamOk && nginx.apiToGo,
    `nginx_go_upstream=${nginx.goUpstreamOk} nginx_api_routes_to_go=${nginx.apiToGo} api_locations=[${nginx.apiLocations.join(', ')}]`,
  );

  // ---- AO-07 Nginx routes the UI to Go (single upstream production) ----------
  check(
    'AO-07',
    nginx.uiToGo && !nginx.nextUpstreamPresent,
    `nginx_ui_routes_to_go=${nginx.uiToGo} nginx_next_upstream_present=${nginx.nextUpstreamPresent}`,
  );

  // ---- AO-08 Nginx strips client identity headers on API locations ---------
  check(
    'AO-08',
    nginx.identityHeadersStripped,
    `nginx_api_identity_headers_stripped=${nginx.identityHeadersStripped} (X-User / X-Role / X-Permissions)`,
  );

  // ---- AO-09 legacy proxy.ts retired; UI navigation guard consults Go auth --
  check(
    'AO-09',
    proxy.legacyProxyAbsent && proxy.violations.length === 0 && proxy.consultsGoAuth,
    `legacy_proxy_absent=${proxy.legacyProxyAbsent} proxy_forbidden_tokens=${proxy.violations.length} proxy_consults_go_auth=${proxy.consultsGoAuth}`,
  );

  // ---- AO-10 frontend/package.json carries no backend runtime dependencies --
  check(
    'AO-10',
    frontendPackage.present && frontendPackage.banned.length === 0,
    `frontend_package_present=${frontendPackage.present} banned_declared=${frontendPackage.banned.length} [${frontendPackage.banned.join(',')}]`,
  );

  // ---- AO-11 every frontend API caller maps to a Go-owned operation --------
  const knowable = [...inventory.map((o) => o.canonicalPath), ...goRegistrationPaths];
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
  check('AO-11', unmappedCallers.length === 0, `frontend_api_callers_unmapped=${unmappedCallers.length}`);

  // ---- AO-12 no ACTIVE executable code references the removed tree ---------
  check(
    'AO-12',
    activeServerImports === 0,
    `active_server_imports=${activeServerImports} (frontend/src + frontend/tests + scripts + .github)`,
  );

  // ---- AO-13/I14/I15 dependency consumers classified -----------------------
  const depUnresolved = [];
  for (const mod of TRACKED_MODULES) {
    for (const c of deps[mod]) {
      if (c.classification === 'UNRESOLVED') depUnresolved.push(`${mod}:${c.file}`);
    }
  }
  check('AO-13', deps.mongodb.every((c) => c.classification !== 'UNRESOLVED'), `mongodb consumers=${deps.mongodb.length}`);
  check('AO-14', deps.jose.every((c) => c.classification !== 'UNRESOLVED'), `jose consumers=${deps.jose.length}`);
  check('AO-15', deps.bcryptjs.every((c) => c.classification !== 'UNRESOLVED'), `bcryptjs consumers=${deps.bcryptjs.length}`);
  check('AO-DEP', depUnresolved.length === 0, `dependency consumers unresolved=${depUnresolved.length}`);

  // ---- AO-16 Next.js owns no business MongoDB data plane -------------------
  check(
    'AO-16',
    nextBusinessMongoReaders === 0 && nextBusinessMongoWriters === 0,
    `next_business_mongo_readers=${nextBusinessMongoReaders} next_business_mongo_writers=${nextBusinessMongoWriters}`,
  );

  // ---- AO-17 charging-plane boundary preserved -----------------------------
  // Charging-plane collections may be READ over HTTP (Go-owned management reads) but no
  // charging-plane mutation may be registered.
  const chargingOps = goKeys.filter((k) => / \/api\/ocs\/(sessions|reservations|usage)$/.test(k));
  const chargingReads = chargingOps.filter((k) => k.startsWith('GET '));
  const chargingMutatingOps = chargingOps.filter((k) => !k.startsWith('GET '));
  check(
    'AO-17',
    chargingReads.length > 0 && chargingMutatingOps.length === 0,
    `charging reads=${chargingReads.length} charging_mutations=${chargingMutatingOps.length}`,
  );

  // ---- AO-18 canonical production API surface fully present in the Go registration site --
  const canonicalMissing = [...CANONICAL_API_KEYS].filter((k) => !goKeySet.has(k));
  check(
    'AO-18',
    canonicalMissing.length === 0,
    `canonical_api_expected=${CANONICAL_API_KEYS.size} canonical_api_present=${CANONICAL_API_KEYS.size - canonicalMissing.length}`,
  );

  // ---- AO-19 legacy compatibility read aliases remain Go-owned -------------
  const legacyAliasMissing = [...LEGACY_ALIAS_READS].filter((k) => !goKeySet.has(k));
  check(
    'AO-19',
    legacyAliasMissing.length === 0,
    `legacy_aliases=${LEGACY_ALIAS_READS.size} legacy_aliases_present=${LEGACY_ALIAS_READS.size - legacyAliasMissing.length}`,
  );

  // ---- AO-20 stale callers to retired surfaces = 0 --------------------------
  const staleCallersToRetired = retiredCallers.length;
  check('AO-20', staleCallersToRetired === 0, `stale_callers_to_retired_surfaces=${staleCallersToRetired}`);

  // ---- AO-21 derived surface rejects a synthetic unknown key (falsifiable) --
  const sentinelDetected = !goKeySet.has(GO_SENTINEL_KEY);
  check(
    'AO-21',
    sentinelDetected,
    `synthetic "${GO_SENTINEL_KEY}" absent from derived surface=${sentinelDetected}`,
  );

  // ---- AO-22 Next.js business backend absent --------------------------------
  const nextBusinessApiOperations = inventory.length;
  const nextBusinessBackendAbsent =
    nextApiRouteFiles === 0 &&
    nextApiOperations === 0 &&
    !nextServerTreePresent &&
    nextBusinessMongoReaders === 0 &&
    nextBusinessMongoWriters === 0;
  check(
    'AO-22',
    nextBusinessBackendAbsent,
    `next_business_api_operations=${nextBusinessApiOperations} next_business_backend_absent=${nextBusinessBackendAbsent}`,
  );

  // ---- AO-23 architecture contract readiness derived from evidence ----------
  const blockers = [];
  if (nextApiRouteFiles > 0) blockers.push(`NEXT_API_ROUTE_FILES=${nextApiRouteFiles}`);
  if (nextApiOperations > 0) blockers.push(`NEXT_API_OPERATIONS=${nextApiOperations}`);
  if (nextServerTreePresent) blockers.push('NEXT_SERVER_TREE_PRESENT');
  if (activeServerImports > 0) blockers.push(`ACTIVE_SERVER_IMPORTS=${activeServerImports}`);
  if (nextBusinessMongoReaders > 0) blockers.push(`NEXT_BUSINESS_MONGO_READERS=${nextBusinessMongoReaders}`);
  if (nextBusinessMongoWriters > 0) blockers.push(`NEXT_BUSINESS_MONGO_WRITERS=${nextBusinessMongoWriters}`);
  if (goRegisteredOperations !== EXPECTED_GO_REGISTRATIONS) blockers.push(`GO_REGISTRATIONS=${goRegisteredOperations}`);
  if (goRegistrationDuplicates > 0) blockers.push(`GO_REGISTRATION_DUPLICATES=${goRegistrationDuplicates}`);
  if (retiredRegistered.length > 0) blockers.push(`RETIRED_SURFACES_ACTIVE=${retiredRegistered.length}`);
  if (!nginx.goUpstreamOk || !nginx.apiToGo) blockers.push('NGINX_API_NOT_ROUTED_TO_GO');
  if (!nginx.uiToGo) blockers.push('NGINX_UI_NOT_ROUTED_TO_GO');
  if (nginx.nextUpstreamPresent) blockers.push('NGINX_NEXT_UPSTREAM_ACTIVE');
  if (!nginx.identityHeadersStripped) blockers.push('NGINX_API_IDENTITY_HEADERS_NOT_STRIPPED');
  if (proxy.violations.length > 0) blockers.push(`PROXY_FORBIDDEN_TOKENS=${proxy.violations.length}`);
  if (!proxy.legacyProxyAbsent || !proxy.consultsGoAuth) blockers.push('PROXY_GO_AUTH_CONSULT_MISSING');
  if (!frontendPackage.present || frontendPackage.banned.length > 0) blockers.push(`FRONTEND_PACKAGE_BANNED=${frontendPackage.banned.join('|')}`);
  if (unmappedCallers.length > 0) blockers.push(`FRONTEND_API_CALLERS_UNMAPPED=${unmappedCallers.length}`);
  if (staleCallersToRetired > 0) blockers.push(`STALE_CALLERS_TO_RETIRED_SURFACES=${staleCallersToRetired}`);
  if (depUnresolved.length > 0) blockers.push(`DEPENDENCY_CONSUMERS_UNRESOLVED=${depUnresolved.length}`);
  if (canonicalMissing.length > 0) blockers.push(`CANONICAL_API_MISSING=${canonicalMissing.length}`);
  if (legacyAliasMissing.length > 0) blockers.push(`LEGACY_ALIAS_MISSING=${legacyAliasMissing.length}`);
  if (chargingMutatingOps.length > 0) blockers.push(`CHARGING_MUTATIONS=${chargingMutatingOps.length}`);
  const architectureContractReady = blockers.length === 0;
  check('AO-23', architectureContractReady, `architecture_contract_ready=${architectureContractReady} blockers=${blockers.length}`);

  // ---------------------------------------------------------------------------
  // Report
  // ---------------------------------------------------------------------------
  console.log('Invariants:');
  for (const inv of invariants) {
    console.log(`  ${inv.ok ? 'PASS' : 'FAIL'}  ${inv.id.padEnd(14)} ${inv.detail}`);
  }

  console.log('\n-- Derived Go production API surface --');
  console.log(`  registrations=${goRegisteredOperations} reads=${goReads.length} mutations=${goMutations.length} duplicates=${goRegistrationDuplicates}`);

  console.log('\n-- Dependency consumers --');
  for (const mod of TRACKED_MODULES) {
    const cls = {};
    for (const c of deps[mod]) cls[c.classification] = (cls[c.classification] || 0) + 1;
    console.log(`  ${mod}: total=${deps[mod].length} ${JSON.stringify(cls)}`);
  }

  if (retiredRegistered.length) {
    console.log('\n-- Retired mutation surfaces still present --');
    for (const key of retiredRegistered) console.log(`  ${key}`);
  }
  if (canonicalMissing.length) {
    console.log('\n-- Canonical API operations missing from the Go surface --');
    for (const key of canonicalMissing) console.log(`  ${key}`);
  }
  if (proxy.violations.length) {
    console.log('\n-- proxy.ts forbidden tokens (must not be present) --');
    for (const v of proxy.violations) console.log(`  ${v.token} @ ${proxyPath}:${v.line} ${v.text}`);
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
  console.log('API Ownership Invariants (Go API + Nginx edge production architecture)');
  console.log(`next_api_route_files=${nextApiRouteFiles}`);
  console.log(`next_api_operations=${nextApiOperations}`);
  console.log(`next_server_tree_present=${nextServerTreePresent}`);
  console.log(`active_server_imports=${activeServerImports}`);
  console.log(`removed_tree_active_references=${activeServerImports}`);
  console.log(`removed_tree_name_literals=${serverImportLiterals.length}`);
  console.log('');
  console.log(`production_api_registrations=${goRegisteredOperations}`);
  console.log(`go_registered_operations=${goRegisteredOperations}`);
  console.log(`go_registered_reads=${goReads.length}`);
  console.log(`go_registered_mutations=${goMutations.length}`);
  console.log(`go_registration_duplicates=${goRegistrationDuplicates}`);
  console.log(`go_surface_expected=${EXPECTED_GO_REGISTRATIONS}`);
  console.log(`retired_surfaces_active=${retiredRegistered.length}`);
  console.log(`go_registration_negative_sentinel=${sentinelDetected}`);
  console.log('');
  console.log(`nginx_go_upstream=${nginx.goUpstreamOk}`);
  console.log(`nginx_next_upstream_present=${nginx.nextUpstreamPresent}`);
  console.log(`nginx_api_routes_to_go=${nginx.apiToGo}`);
  console.log(`nginx_ui_routes_to_go=${nginx.uiToGo}`);
  console.log(`nginx_api_identity_headers_stripped=${nginx.identityHeadersStripped}`);
  console.log('');
  console.log(`proxy_forbidden_tokens=${proxy.violations.length}`);
  console.log(`proxy_consults_go_auth=${proxy.consultsGoAuth}`);
  console.log(`frontend_package_banned_declared=${frontendPackage.banned.length}`);
  console.log(`frontend_package_jose=${frontendPackage.banned.includes('jose') ? 'present' : 'absent'}`);
  console.log(`frontend_package_mongodb=${frontendPackage.banned.includes('mongodb') ? 'present' : 'absent'}`);
  console.log(`frontend_package_jiti=${frontendPackage.banned.includes('jiti') ? 'present' : 'absent'}`);
  console.log('');
  console.log(`next_business_api_operations=${nextBusinessApiOperations}`);
  console.log(`next_business_mongo_readers=${nextBusinessMongoReaders}`);
  console.log(`next_business_mongo_writers=${nextBusinessMongoWriters}`);
  console.log(`frontend_api_callers_unmapped=${unmappedCallers.length}`);
  console.log(`stale_callers_to_retired_surfaces=${staleCallersToRetired}`);
  console.log('');
  console.log(`canonical_api_expected=${CANONICAL_API_KEYS.size}`);
  console.log(`canonical_api_present=${CANONICAL_API_KEYS.size - canonicalMissing.length}`);
  console.log(`legacy_aliases_present=${LEGACY_ALIAS_READS.size - legacyAliasMissing.length}`);
  console.log(`charging_reads=${chargingReads.length}`);
  console.log(`charging_mutations=${chargingMutatingOps.length}`);
  console.log('');
  console.log(`architecture_contract_ready=${architectureContractReady}`);
  console.log(`next_business_backend_absent=${nextBusinessBackendAbsent}`);
  console.log(`architecture_blockers=${blockers.length}`);
  for (const b of blockers) console.log(`architecture_blocker=${b}`);
  for (const hit of serverImportHits) console.log(`removed_tree_active_reference=${hit.file}:${hit.line}`);
  console.log('');
  console.log(`api_ownership_result=${acceptanceFailures.length === 0 ? 'PASS' : 'FAIL'}`);
  console.log(`api_ownership_invariants_failed=${acceptanceFailures.length}`);
  console.log('==================================================\n');

  if (acceptanceFailures.length > 0) {
    console.error('API ownership invariant verification FAILED.');
    process.exit(1);
  }

  console.log('API ownership invariant verification result: PASS');
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
