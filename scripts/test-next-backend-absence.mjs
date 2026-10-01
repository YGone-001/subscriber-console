#!/usr/bin/env node
/**
 * Next.js Backend Absence acceptance suite.
 *
 * READ-ONLY with respect to production behavior. Pure source analysis: no network, no
 * MongoDB, no build step, so it runs in the CI `node` job (which has no database service).
 *
 * It certifies the durable architecture contract: Next.js is the UI runtime only and owns
 * no backend business API. Concretely, it derives from source that:
 *
 *   - the Next.js App Router business API tree is absent (0 route files, 0 operations);
 *   - the Next.js business server tree is absent (frontend/src/server);
 *   - Next.js owns no business MongoDB read/write data plane;
 *   - no Next.js runtime module verifies a JWT, reads MongoDB, or forwards an API request;
 *   - the UI navigation guard consults the Go authentication authority instead;
 *   - the frontend manifest declares no backend runtime dependency;
 *   - no ACTIVE source imports the removed Next.js backend tree;
 *   - the Go registration site remains the single production API surface.
 *
 * Usage: node scripts/test-next-backend-absence.mjs
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveGoRegistrations } from './lib/go-registrations.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rel = (p) => relative(root, p).replaceAll('\\', '/');

const apiRoot = resolve(root, 'frontend/src/app/api');
const serverRoot = resolve(root, 'frontend/src/server');
const srcRoot = resolve(root, 'frontend/src');
const testsRoot = resolve(root, 'frontend/tests');
const scriptsRoot = resolve(root, 'scripts');
const githubRoot = resolve(root, '.github');
const proxyPath = resolve(root, 'frontend/src/proxy.ts');
const packagePath = resolve(root, 'frontend/package.json');

const CODE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'];

/** Canonical production API surface size asserted against the derived Go registration set. */
const EXPECTED_GO_REGISTRATIONS = 84;

/** Backend runtime modules the UI runtime must never declare. */
const BANNED_RUNTIME_MODULES = ['jose', 'mongodb', 'jiti', 'bcryptjs'];

/** Runtime tokens the UI navigation guard must never contain. */
const GUARD_FORBIDDEN_TOKENS = [
  { key: 'jose', re: /\bjose\b/ },
  { key: 'jwtVerify', re: /\bjwtVerify\b/ },
  { key: 'mongodb', re: /\bmongodb\b|MongoClient/ },
  { key: 'CUTOVER_TABLE', re: /\bCUTOVER_TABLE\b/ },
  { key: 'resolveRouteOwner', re: /\bresolveRouteOwner\b/ },
  { key: 'forwardToGo', re: /\bforwardToGo\b|\bproxyToBackend\b/ },
  { key: 'identity_header_injection', re: /\bx-(?:user|role|permissions)\b/i },
];

/**
 * Blank `//` and block comments while preserving line count, so documentation prose is
 * never mistaken for live code.
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

function walk(dir, filter, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, filter, out);
    else if (filter(full)) out.push(full);
  }
  return out;
}

const invariants = [];
function check(id, ok, detail) {
  invariants.push({ id, ok: Boolean(ok), detail });
  return Boolean(ok);
}

// --- 1. App Router business API tree ------------------------------------------------
function scanApiTree() {
  const files = walk(apiRoot, (p) => p.endsWith('route.ts') || p.endsWith('route.js'));
  const operations = [];
  for (const file of files) {
    const content = readFileSync(file, 'utf8');
    for (const method of HTTP_METHODS) {
      const re = new RegExp(`export\\s+(?:async\\s+)?(?:function|const)\\s+${method}\\b`);
      if (re.test(content)) operations.push(`${method} ${rel(file)}`);
    }
  }
  return { files, operations };
}

// --- 2. Removed server tree ---------------------------------------------------------
function scanServerTreeAbsence() {
  const trees = ['frontend/src/server', 'frontend/src/app/api'];
  const present = trees.filter((t) => existsSync(resolve(root, t)));
  return { present };
}

// --- 3. Surviving Next.js business MongoDB data plane -------------------------------
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

// BSON value types (Long / ObjectId) are data modelling, not a data plane. The invariant
// is about a live MongoDB client: a driver connection or an operation on a business
// collection. Those are what the UI runtime must never own.
const MONGO_CLIENT_RE = /\bnew\s+MongoClient\s*\(|\bMongoClient\s*\.\s*connect\s*\(/;
const COLLECTION_CALL_RE =
  /(?:collection|getMongoCollection|getXcloudCollection|getAppCollection)\s*(?:<[^>]*>)?\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function scanNextBusinessMongo() {
  const hits = [];
  for (const file of walk(srcRoot, (p) => CODE_EXT.test(p))) {
    const code = stripComments(readFileSync(file, 'utf8'));
    const collections = new Set();
    let m;
    COLLECTION_CALL_RE.lastIndex = 0;
    while ((m = COLLECTION_CALL_RE.exec(code)) !== null) collections.add(m[1]);
    const business = [...collections].filter((name) => BUSINESS_COLLECTIONS.has(name));
    const client = MONGO_CLIENT_RE.test(code);
    if (client || business.length > 0) {
      hits.push({ file: rel(file), mongoClient: client, collections: business });
    }
  }
  return hits;
}

// --- 4. UI navigation guard ---------------------------------------------------------
function scanGuard() {
  const raw = existsSync(proxyPath) ? readFileSync(proxyPath, 'utf8') : '';
  const code = stripComments(raw);
  const violations = [];
  for (const token of GUARD_FORBIDDEN_TOKENS) {
    code.split('\n').forEach((line, idx) => {
      if (token.re.test(line)) violations.push({ token: token.key, line: idx + 1 });
    });
  }
  return {
    present: raw.length > 0,
    violations,
    consultsGoAuth: /\/api\/auth\/me/.test(code) && /auth_token/.test(code),
    forwardsApi: /\bfetch\s*\(/.test(code) && /\/api\/(?!auth\/me)/.test(code),
  };
}

// --- 5. Frontend manifest -----------------------------------------------------------
function scanManifest() {
  if (!existsSync(packagePath)) return { present: false, banned: BANNED_RUNTIME_MODULES };
  const pkg = JSON.parse(readFileSync(packagePath, 'utf8'));
  const declared = {
    ...(pkg.dependencies ?? {}),
    ...(pkg.devDependencies ?? {}),
    ...(pkg.peerDependencies ?? {}),
    ...(pkg.optionalDependencies ?? {}),
  };
  return {
    present: true,
    banned: BANNED_RUNTIME_MODULES.filter((name) => Object.prototype.hasOwnProperty.call(declared, name)),
  };
}

// --- 6. Active imports of the removed backend tree ----------------------------------
const REMOVED_TREE_RE = /@\/server\/|src\/server\/|src\/app\/api\//;
const RESOLUTION_OP_RE = /\bimport\b|\brequire\s*\(|\bjiti\b|\breadFileSync\b|\bexistsSync\b|\bresolve\s*\(|\bjoin\s*\(/;

function scanRemovedTreeImports() {
  const hits = [];
  const roots = [srcRoot, testsRoot, scriptsRoot, githubRoot];
  const self = resolve(root, 'scripts/test-next-backend-absence.mjs');
  for (const base of roots) {
    if (!existsSync(base)) continue;
    for (const file of walk(base, (p) => CODE_EXT.test(p) || /\.ya?ml$/.test(p))) {
      if (resolve(file) === self) continue;
      stripComments(readFileSync(file, 'utf8')).split('\n').forEach((line, idx) => {
        if (!REMOVED_TREE_RE.test(line)) return;
        if (!RESOLUTION_OP_RE.test(line)) return;
        // Import assertions that merely NAME the removed path are reporting, not dependencies.
        if (/scripts\/|docs\//.test(line)) return;
        hits.push({ file: rel(file), line: idx + 1, text: line.trim() });
      });
    }
  }
  return hits;
}

// --- Main ---------------------------------------------------------------------------
function main() {
  console.log('-- Next.js backend absence (UI-only runtime) --\n');

  const apiTree = scanApiTree();
  const serverTree = scanServerTreeAbsence();
  const mongoHits = scanNextBusinessMongo();
  const guard = scanGuard();
  const manifest = scanManifest();
  const removedImports = scanRemovedTreeImports();
  const { keys: goKeys, duplicates: goDuplicates } = deriveGoRegistrations();
  const goSentinel = 'GET /api/__absence_unclassified_probe__';

  check(
    'NBA-01',
    apiTree.files.length === 0 && apiTree.operations.length === 0,
    `next_api_route_files=${apiTree.files.length} next_api_operations=${apiTree.operations.length}`,
  );
  check(
    'NBA-02',
    serverTree.present.length === 0,
    `removed_trees_present=[${serverTree.present.join(', ')}]`,
  );
  check('NBA-03', mongoHits.length === 0, `next_business_mongo_modules=${mongoHits.length}`);
  check(
    'NBA-04',
    guard.present && guard.violations.length === 0,
    `guard_present=${guard.present} guard_forbidden_tokens=${guard.violations.length}`,
  );
  check(
    'NBA-05',
    guard.consultsGoAuth && !guard.forwardsApi,
    `guard_consults_go_auth=${guard.consultsGoAuth} guard_forwards_api=${guard.forwardsApi}`,
  );
  check(
    'NBA-06',
    manifest.present && manifest.banned.length === 0,
    `frontend_manifest_present=${manifest.present} banned_declared=[${manifest.banned.join(',')}]`,
  );
  check('NBA-07', removedImports.length === 0, `active_removed_tree_imports=${removedImports.length}`);
  check(
    'NBA-08',
    goKeys.length === EXPECTED_GO_REGISTRATIONS && goDuplicates.length === 0,
    `go_registrations=${goKeys.length} expected=${EXPECTED_GO_REGISTRATIONS} duplicates=${goDuplicates.length}`,
  );
  check('NBA-09', !goKeys.includes(goSentinel), `unknown_probe_registered_in_go=${goKeys.includes(goSentinel)}`);

  console.log('Invariants:');
  for (const inv of invariants) console.log(`  ${inv.ok ? 'PASS' : 'FAIL'}  ${inv.id} ${inv.detail}`);

  if (mongoHits.length) {
    console.log('\n-- Next.js business MongoDB modules --');
    for (const hit of mongoHits) console.log(`  ${hit.file} mongo_client=${hit.mongoClient} collections=[${hit.collections.join(',')}]`);
  }
  if (guard.violations.length) {
    console.log('\n-- UI guard forbidden tokens --');
    for (const v of guard.violations) console.log(`  ${v.token} @ ${rel(proxyPath)}:${v.line}`);
  }
  if (removedImports.length) {
    console.log('\n-- ACTIVE imports of the removed Next.js backend tree --');
    for (const hit of removedImports) console.log(`  ${hit.file}:${hit.line} ${hit.text}`);
  }

  const failed = invariants.filter((i) => !i.ok);

  console.log('\n==================================================');
  console.log(`next_api_route_files=${apiTree.files.length}`);
  console.log(`next_api_operations=${apiTree.operations.length}`);
  console.log(`next_server_tree_present=${existsSync(serverRoot)}`);
  console.log(`next_business_mongo_modules=${mongoHits.length}`);
  console.log(`next_guard_forbidden_tokens=${guard.violations.length}`);
  console.log(`next_guard_consults_go_auth=${guard.consultsGoAuth}`);
  console.log(`next_guard_forwards_api=${guard.forwardsApi}`);
  console.log(`frontend_manifest_banned_declared=${manifest.banned.length}`);
  console.log(`active_removed_tree_imports=${removedImports.length}`);
  console.log(`go_registrations=${goKeys.length}`);
  console.log(`unknown_probe_registered_in_go=${goKeys.includes(goSentinel)}`);
  console.log(`next_backend_absence_invariants_failed=${failed.length}`);
  console.log(`next_backend_absence_result=${failed.length === 0 ? 'PASS' : 'FAIL'}`);
  console.log('==================================================\n');

  if (failed.length > 0) {
    console.error('Next.js backend absence verification FAILED.');
    process.exit(1);
  }
  console.log('Next.js backend absence verification result: PASS');
}

main();
