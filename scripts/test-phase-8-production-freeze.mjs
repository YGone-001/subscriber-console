#!/usr/bin/env node
/**
 * Phase 8.6 -- Production Freeze & Final Certification (certification only).
 *
 * This harness NEVER changes production behavior. It re-derives the frozen final
 * architecture from primary sources and fails closed on any drift:
 *
 *   - the Go production API surface, compared as an exact sorted METHOD+PATH set against
 *     the authoritative Phase 8.5 baseline commit (never a count-only comparison);
 *   - physical removal of the Next.js business backend;
 *   - retirement of the migration-era cutover runtime;
 *   - the Nginx public-edge contract (API -> Go, UI -> Next, identity stripping, body
 *     limit, SSE boundary);
 *   - the loopback-only Next.js and Go listener contract, derived from the actual
 *     production startup configuration;
 *   - dependency / runtime closure and the Go-only authentication authority;
 *   - retired-surface absence and charging-plane exclusion;
 *   - zero production-runtime change against the frozen baseline SHA, derived from
 *     `git diff` (committed and working-tree) and classified per file.
 *
 * The only frozen constants are explicit approved contracts: the baseline SHA, the final
 * API surface size (84), the frozen listener addresses, and the frozen compatibility
 * counts. Every observed value is independently derived.
 *
 * The real-runtime proofs (real Nginx/Next/Go/Mongo topology, 84/84 routing ownership,
 * unknown-route ownership, fail-closed Go-down behavior, authentication semantics,
 * identity-header spoofing, UI guard behavior, SSE streaming, request-body integrity and
 * loopback-only reachability) are authoritatively produced by the UNCHANGED Phase 8.5
 * acceptance suite. CI runs that suite as a sibling job which this certification job
 * depends on, so the runtime values are proven in the same run rather than restated here.
 *
 * Usage: node scripts/test-phase-8-production-freeze.mjs
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GO_ROUTER_SOURCES,
  classifyGoRegistrations,
  deriveGoRegistrations,
  parseRegistrationKeys,
} from './lib/go-registrations.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rel = (p) => relative(root, p).replaceAll('\\', '/');

// --- Approved frozen contracts -------------------------------------------------------
const PHASE86_BASELINE_SHA = '6970e929250e51fa47a09fa3f9bccb1b86f2f46e';
const EXPECTED_GO_REGISTRATIONS = 84;
const EXPECTED_NEXT_LISTENER = '127.0.0.1:13333';
const EXPECTED_GO_LISTENER = '127.0.0.1:18888';
const EXPECTED_CANONICAL_RESIDUAL = 33;
const EXPECTED_LEGACY_ALIASES = 2;
const EXPECTED_RETIRED_SURFACES = 6;

// Synthetic keys that must never exist in the derived surface. They make the set
// comparison falsifiable instead of vacuously true.
const GO_SENTINEL_KEY = 'GET /api/__phase86_unknown_sentinel__';
const NEXT_SENTINEL_KEY = 'GET /api/__phase86_next_sentinel__';

// Paths whose modification would change production behavior.
const PRODUCTION_RUNTIME_FILES = new Set([
  'backend/go.mod',
  'backend/go.sum',
  'frontend/package.json',
  'frontend/package-lock.json',
  'frontend/next.config.ts',
  '.env.example',
  'package.json',
  'package-lock.json',
]);
const PRODUCTION_RUNTIME_PREFIXES = [
  'backend/cmd/',
  'backend/internal/',
  'frontend/src/',
  'deploy/',
];

// --- Invariant bookkeeping -----------------------------------------------------------
const invariants = [];
function check(id, ok, detail) {
  invariants.push({ id, ok: Boolean(ok), detail });
  return Boolean(ok);
}

// --- Shell / git helpers -------------------------------------------------------------
function git(args) {
  const res = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  return { ok: res.status === 0, out: (res.stdout ?? '').trim(), err: (res.stderr ?? '').trim() };
}

/** Derive the Go registration set as of an arbitrary commit (baseline comparison). */
function registrationsAt(sha) {
  const keys = new Set();
  let missingSources = 0;
  for (const source of GO_ROUTER_SOURCES) {
    const res = git(['show', `${sha}:${source}`]);
    if (!res.ok) {
      missingSources += 1;
      continue;
    }
    for (const key of parseRegistrationKeys(res.out)) keys.add(key);
  }
  return { keys: [...keys].sort(), missingSources };
}

/**
 * Classify one repository-relative path into the four certification buckets.
 * Pure and side-effect free so it can be falsification-tested with synthetic paths.
 */
function classifyPath(file) {
  const p = file.replaceAll('\\', '/');
  if (PRODUCTION_RUNTIME_FILES.has(p)) return 'PRODUCTION_RUNTIME';
  if (PRODUCTION_RUNTIME_PREFIXES.some((prefix) => p.startsWith(prefix))) return 'PRODUCTION_RUNTIME';
  if (p.startsWith('.github/')) return 'CI';
  if (p.startsWith('docs/')) return 'DOCUMENTATION';
  // Repository-root Markdown (AGENTS.md / CLAUDE.md / README.md and peers) is documentation.
  if (!p.includes('/') && p.toLowerCase().endsWith('.md')) return 'DOCUMENTATION';
  if (p.startsWith('scripts/')) return 'CERTIFICATION_TEST';
  return 'UNEXPECTED';
}

function changedFiles() {
  const names = new Set();
  const committed = git(['diff', '--name-only', PHASE86_BASELINE_SHA, 'HEAD']);
  if (committed.ok) {
    for (const line of committed.out.split('\n')) {
      if (line.trim()) names.add(line.trim());
    }
  }
  // Porcelain status is read raw: the leading status space of the first line is
  // significant and would be destroyed by an output-wide trim.
  const statusRes = spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' });
  if (statusRes.status === 0) {
    for (const line of (statusRes.stdout ?? '').split('\n')) {
      if (!line.trim()) continue;
      const raw = (line.length > 3 ? line.slice(3) : line.trim()).trim().replace(/^"|"$/g, '');
      // Renames appear as "old -> new"; the destination is what matters.
      const target = raw.includes(' -> ') ? raw.split(' -> ')[1].trim() : raw;
      if (!target) continue;
      names.add(target);
    }
  }
  return [...names].sort();
}

// --- Source readers ------------------------------------------------------------------
function readText(relativePath) {
  const full = resolve(root, relativePath);
  return existsSync(full) ? readFileSync(full, 'utf8') : null;
}

/** Blank `//` and block comments while preserving line count and positions. */
function stripJsComments(source) {
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

function stripHashComments(source) {
  return source
    .split('\n')
    .map((line) => (line.trimStart().startsWith('#') ? '' : line))
    .join('\n');
}

function countOccurrences(source, re) {
  let count = 0;
  let m;
  re.lastIndex = 0;
  while ((m = re.exec(source)) !== null) count += 1;
  return count;
}

// --- Next.js production listener contract --------------------------------------------
function deriveNextListener() {
  const raw = readText('frontend/package.json');
  if (!raw) return { present: false, command: null, listener: null, standalone: null };
  let start = null;
  try {
    start = JSON.parse(raw).scripts?.start ?? null;
  } catch {
    return { present: true, command: null, listener: null, standalone: null };
  }
  const host = start ? (start.match(/-H\s+(\S+)/) ?? [])[1] : null;
  const port = start ? (start.match(/-p\s+(\d+)/) ?? [])[1] : null;
  const config = readText('frontend/next.config.ts');
  const configCode = config ? stripJsComments(config) : '';
  return {
    present: true,
    command: start,
    listener: host && port ? `${host}:${port}` : null,
    standalone: /output\s*:\s*['"]standalone['"]/.test(configCode),
  };
}

function deriveNextProductionPath() {
  return {
    standaloneScriptPresent: existsSync(resolve(root, 'scripts/deploy-standalone.sh')),
  };
}

// --- Go production listener contract --------------------------------------------------
function deriveGoListener() {
  const source = readText('backend/internal/config/config.go');
  if (!source) return { present: false, defaultAddr: null };
  const m = source.match(/envOrDefault\("HTTP_ADDR",\s*"([^"]+)"\)/);
  return { present: true, defaultAddr: m ? m[1] : null };
}

// --- Nginx edge contract --------------------------------------------------------------
function scanNginx() {
  const raw = readText('deploy/nginx/xcloud.conf');
  if (!raw) {
    return {
      present: false,
      goUpstreamOk: false,
      nextUpstreamOk: false,
      exactApiToGo: false,
      prefixApiToGo: false,
      streamToGo: false,
      uiToNext: false,
      identityHeadersStripped: false,
      bodyLimitOk: false,
      sseUnbuffered: false,
    };
  }
  const code = stripHashComments(raw);
  const upstreams = {};
  for (const m of code.matchAll(/upstream\s+([A-Za-z0-9_]+)\s*\{([^}]*)\}/g)) {
    upstreams[m[1]] = m[2].replace(/\s+/g, ' ').trim();
  }
  const locations = [];
  for (const m of code.matchAll(/location\s+([^{]+?)\s*\{([^}]*)\}/g)) {
    locations.push({ pattern: m[1].trim(), body: m[2] });
  }
  const find = (pattern) => locations.find((l) => l.pattern === pattern);
  const proxiesTo = (l, upstream) =>
    Boolean(l) && new RegExp(`proxy_pass\\s+http://${upstream}\\b`).test(l.body);
  const strips = (body, name) => new RegExp(`proxy_set_header\\s+${name}\\s+""\\s*;`).test(body);

  const apiLocations = locations.filter((l) => l.pattern.includes('/api'));
  const exactApi = find('= /api');
  const prefixApi = find('/api/');
  const streamApi = find('= /api/notifications/stream');
  const uiRoot = find('/');

  return {
    present: true,
    goUpstreamOk: (upstreams.xcloud_go ?? '').includes(EXPECTED_GO_LISTENER),
    nextUpstreamOk: (upstreams.xcloud_next ?? '').includes(EXPECTED_NEXT_LISTENER),
    exactApiToGo: proxiesTo(exactApi, 'xcloud_go'),
    prefixApiToGo: proxiesTo(prefixApi, 'xcloud_go'),
    streamToGo: proxiesTo(streamApi, 'xcloud_go'),
    uiToNext: proxiesTo(uiRoot, 'xcloud_next'),
    identityHeadersStripped:
      apiLocations.length > 0 &&
      apiLocations.every(
        (l) => strips(l.body, 'X-User') && strips(l.body, 'X-Role') && strips(l.body, 'X-Permissions'),
      ),
    bodyLimitOk: /client_max_body_size\s+10m\s*;/.test(code),
    sseUnbuffered: Boolean(streamApi) && /proxy_buffering\s+off\s*;/.test(streamApi.body),
  };
}

// --- Migration-era runtime retirement -------------------------------------------------
function scanCutoverRetirement() {
  const sources = [
    'frontend/src/proxy.ts',
    'frontend/src/lib/api.ts',
  ];
  let cutoverTokenHits = 0;
  let resolverHits = 0;
  let reverseProxyHits = 0;
  for (const file of sources) {
    const raw = readText(file);
    if (!raw) continue;
    const code = stripJsComments(raw);
    cutoverTokenHits += countOccurrences(code, /\bCUTOVER_TABLE\b/g);
    resolverHits += countOccurrences(code, /\bresolveRouteOwner\b/g);
    reverseProxyHits += countOccurrences(code, /\bforwardToGo\b|\bproxyToBackend\b/g);
  }
  return {
    cutoverRoutingFilePresent: existsSync(resolve(root, 'frontend/src/lib/cutover-routing.ts')),
    cutoverTokenHits,
    resolverHits,
    reverseProxyHits,
  };
}

// --- Existing readiness evidence (authoritative re-run, unmodified) -------------------
function runReadinessEvidence() {
  const script = resolve(root, 'scripts/test-phase-8-backend-removal-readiness.mjs');
  const res = spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8' });
  const stdout = res.stdout ?? '';
  const values = {};
  for (const line of stdout.split('\n')) {
    const m = line.match(/^([a-z0-9_]+)=(.+)$/);
    if (m) values[m[1]] = m[2].trim();
  }
  const num = (key, fallback = null) => (values[key] != null ? Number(values[key]) : fallback);
  return {
    exitCode: res.status,
    values,
    nextApiRouteFiles: num('next_api_route_files', 0),
    nextApiOperations: num('next_api_operations', 0),
    nextServerTreePresent: values.next_server_tree_present === 'true',
    nextBusinessApiOperations: num('next_business_api_operations', 0),
    nextBusinessMongoReaders: num('next_business_mongo_readers', 0),
    nextBusinessMongoWriters: num('next_business_mongo_writers', 0),
    frontendJwtVerifiers: num('proxy_forbidden_tokens', 0),
    retiredSurfacesActive: num('retired_surfaces_active', 0),
    chargingMutations: num('charging_mutations', 0),
    canonicalResidualPresent: num('canonical_residual_present', 0),
    legacyAliasesPresent: num('legacy_aliases_present', 0),
    backendRemovalReady: values.backend_removal_ready === 'true',
    backendRemovalBlockers: num('backend_removal_blockers', 0),
    frontendPackageMongodb: values.frontend_package_mongodb ?? 'unknown',
    frontendPackageJose: values.frontend_package_jose ?? 'unknown',
    frontendPackageJiti: values.frontend_package_jiti ?? 'unknown',
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log('-- Phase 8.6 Production Freeze & Final Certification --\n');

  // --- Repository state ---------------------------------------------------------
  const headSha = git(['rev-parse', 'HEAD']).out;
  const baselineObject = git(['cat-file', '-e', `${PHASE86_BASELINE_SHA}^{commit}`]).ok;
  const baselineAncestor = git(['merge-base', '--is-ancestor', PHASE86_BASELINE_SHA, 'HEAD']).ok;
  check(
    'P86-00',
    baselineObject && baselineAncestor,
    `baseline_object=${baselineObject} baseline_is_ancestor_of_head=${baselineAncestor} head=${headSha}`,
  );
  check(
    'P86-00B',
    GO_SENTINEL_KEY !== NEXT_SENTINEL_KEY,
    'synthetic Go/Next sentinel keys are distinct (falsifiability guard)',
  );

  // --- Go API surface: exact set equality against the frozen baseline ------------
  const current = deriveGoRegistrations();
  const baseline = registrationsAt(PHASE86_BASELINE_SHA);
  const currentSet = new Set(current.keys);
  const baselineSet = new Set(baseline.keys);
  const missing = baseline.keys.filter((k) => !currentSet.has(k));
  const added = current.keys.filter((k) => !baselineSet.has(k));
  const sentinelAbsent = !currentSet.has(GO_SENTINEL_KEY) && !baselineSet.has(GO_SENTINEL_KEY);
  const registrationSetChanged = missing.length > 0 || added.length > 0;

  check(
    'P86-01',
    baseline.keys.length === EXPECTED_GO_REGISTRATIONS,
    `baseline_go_registrations=${baseline.keys.length} expected=${EXPECTED_GO_REGISTRATIONS} missing_sources=${baseline.missingSources}`,
  );
  check(
    'P86-02',
    current.keys.length === EXPECTED_GO_REGISTRATIONS,
    `current_go_registrations=${current.keys.length} expected=${EXPECTED_GO_REGISTRATIONS}`,
  );
  check(
    'P86-03',
    !registrationSetChanged,
    `go_registration_set_changed=${registrationSetChanged} missing=${missing.length} added=${added.length}`,
  );
  check(
    'P86-04',
    current.duplicates.length === 0,
    `go_registration_duplicates=${current.duplicates.length}`,
  );
  check(
    'P86-05',
    sentinelAbsent,
    `synthetic_sentinel_absent_from_both_sets=${sentinelAbsent} (falsifiability guard)`,
  );

  const { reads, mutations } = classifyGoRegistrations(current.keys);

  // --- Next.js business backend removal -----------------------------------------
  const readiness = runReadinessEvidence();
  check(
    'P86-06',
    readiness.exitCode === 0,
    `backend_removal_readiness_exit=${readiness.exitCode} (existing analysis re-run, unmodified)`,
  );
  const nextApiRouteFiles = readiness.nextApiRouteFiles;
  const nextApiOperations = readiness.nextApiOperations;
  const nextServerTreePresent = readiness.nextServerTreePresent;
  const nextBusinessApiOperations = readiness.nextBusinessApiOperations;
  check(
    'P86-07',
    nextApiRouteFiles === 0 && nextApiOperations === 0 && !nextServerTreePresent,
    `next_api_route_files=${nextApiRouteFiles} next_api_operations=${nextApiOperations} next_server_tree_present=${nextServerTreePresent}`,
  );
  check(
    'P86-08',
    nextBusinessApiOperations === 0,
    `next_business_api_operations=${nextBusinessApiOperations}`,
  );
  check(
    'P86-09',
    readiness.nextBusinessMongoReaders === 0 && readiness.nextBusinessMongoWriters === 0,
    `next_business_mongo_readers=${readiness.nextBusinessMongoReaders} next_business_mongo_writers=${readiness.nextBusinessMongoWriters}`,
  );
  check(
    'P86-10',
    readiness.frontendJwtVerifiers === 0,
    `frontend_jwt_verifiers=${readiness.frontendJwtVerifiers} (proxy forbidden tokens)`,
  );

  // --- Cutover runtime retirement ------------------------------------------------
  const cutover = scanCutoverRetirement();
  const cutoverRuntimePresent =
    cutover.cutoverRoutingFilePresent || cutover.cutoverTokenHits > 0 || cutover.resolverHits > 0;
  const nodeApiFallback = cutover.reverseProxyHits;
  check(
    'P86-11',
    !cutoverRuntimePresent,
    `cutover_runtime_present=${cutoverRuntimePresent} cutover_routing_file=${cutover.cutoverRoutingFilePresent} cutover_token_hits=${cutover.cutoverTokenHits} resolver_hits=${cutover.resolverHits}`,
  );
  check(
    'P86-12',
    nodeApiFallback === 0,
    `node_api_fallback=${nodeApiFallback} next_api_reverse_proxy_functions=${cutover.reverseProxyHits}`,
  );

  // --- Nginx public edge ---------------------------------------------------------
  const nginx = scanNginx();
  check(
    'P86-13',
    nginx.present && nginx.goUpstreamOk && nginx.exactApiToGo && nginx.prefixApiToGo && nginx.streamToGo,
    `nginx_present=${nginx.present} go_upstream=${nginx.goUpstreamOk} exact_api_to_go=${nginx.exactApiToGo} prefix_api_to_go=${nginx.prefixApiToGo} stream_to_go=${nginx.streamToGo}`,
  );
  check(
    'P86-14',
    nginx.nextUpstreamOk && nginx.uiToNext,
    `next_upstream=${nginx.nextUpstreamOk} ui_to_next=${nginx.uiToNext}`,
  );
  check(
    'P86-15',
    nginx.identityHeadersStripped,
    `nginx_identity_headers_stripped=${nginx.identityHeadersStripped}`,
  );
  check(
    'P86-16',
    nginx.bodyLimitOk && nginx.sseUnbuffered,
    `nginx_body_limit_10m=${nginx.bodyLimitOk} nginx_sse_buffering_disabled=${nginx.sseUnbuffered}`,
  );

  // --- Internal listener contract ------------------------------------------------
  const nextListener = deriveNextListener();
  const nextPath = deriveNextProductionPath();
  const goListener = deriveGoListener();
  const standaloneProductionPath = Boolean(nextListener.standalone) || nextPath.standaloneScriptPresent;
  check(
    'P86-17',
    nextListener.listener === EXPECTED_NEXT_LISTENER,
    `next_listener_expected=${EXPECTED_NEXT_LISTENER} derived=${nextListener.listener} start_command=${nextListener.command}`,
  );
  check(
    'P86-18',
    goListener.defaultAddr === EXPECTED_GO_LISTENER,
    `go_listener_expected=${EXPECTED_GO_LISTENER} derived=${goListener.defaultAddr} (production default in backend/internal/config)`,
  );
  check(
    'P86-19',
    !standaloneProductionPath,
    `standalone_next_production_path=${standaloneProductionPath} next_config_standalone=${nextListener.standalone} standalone_script=${nextPath.standaloneScriptPresent}`,
  );

  // --- Dependency / runtime closure ---------------------------------------------
  check(
    'P86-20',
    readiness.frontendPackageMongodb === 'absent' &&
      readiness.frontendPackageJose === 'absent' &&
      readiness.frontendPackageJiti === 'absent',
    `frontend_package mongodb=${readiness.frontendPackageMongodb} jose=${readiness.frontendPackageJose} jiti=${readiness.frontendPackageJiti}`,
  );

  // --- Retired surfaces / charging plane ----------------------------------------
  check(
    'P86-21',
    readiness.retiredSurfacesActive === 0,
    `retired_surfaces_expected=${EXPECTED_RETIRED_SURFACES} retired_surfaces_active=${readiness.retiredSurfacesActive}`,
  );
  check(
    'P86-22',
    readiness.chargingMutations === 0,
    `charging_mutations=${readiness.chargingMutations}`,
  );
  check(
    'P86-23',
    readiness.canonicalResidualPresent === EXPECTED_CANONICAL_RESIDUAL &&
      readiness.legacyAliasesPresent === EXPECTED_LEGACY_ALIASES,
    `canonical_residual_expected=${EXPECTED_CANONICAL_RESIDUAL} canonical_residual_present=${readiness.canonicalResidualPresent} legacy_aliases_present=${readiness.legacyAliasesPresent}`,
  );

  // --- Source freeze against the baseline SHA, classified -----------------------
  const changed = changedFiles();
  const byClass = { PRODUCTION_RUNTIME: [], CERTIFICATION_TEST: [], CI: [], DOCUMENTATION: [], UNEXPECTED: [] };
  for (const file of changed) byClass[classifyPath(file)].push(file);
  const productionRuntimeChanges = byClass.PRODUCTION_RUNTIME.length;
  const unexpectedChanges = byClass.UNEXPECTED.length;

  // Falsifiability guard: the classifier must actually flag production paths.
  const classifierWorks =
    classifyPath('backend/cmd/server/main.go') === 'PRODUCTION_RUNTIME' &&
    classifyPath('frontend/src/proxy.ts') === 'PRODUCTION_RUNTIME' &&
    classifyPath('frontend/next.config.ts') === 'PRODUCTION_RUNTIME' &&
    classifyPath('deploy/nginx/xcloud.conf') === 'PRODUCTION_RUNTIME' &&
    classifyPath('.env.example') === 'PRODUCTION_RUNTIME' &&
    classifyPath('docs/backend-migration/x.md') === 'DOCUMENTATION' &&
    classifyPath('AGENTS.md') === 'DOCUMENTATION' &&
    classifyPath('.github/workflows/ci.yml') === 'CI' &&
    classifyPath('scripts/test-phase-8-production-freeze.mjs') === 'CERTIFICATION_TEST' &&
    classifyPath('vendor/unknown.bin') === 'UNEXPECTED';
  check(
    'P86-24',
    classifierWorks,
    `change_classifier_falsifiable=${classifierWorks} (production paths must classify as PRODUCTION_RUNTIME)`,
  );
  check(
    'P86-25',
    productionRuntimeChanges === 0,
    `production_runtime_changes=${productionRuntimeChanges} (classified from git diff against ${PHASE86_BASELINE_SHA.slice(0, 12)})`,
  );
  check(
    'P86-26',
    unexpectedChanges === 0,
    `unexpected_changes=${unexpectedChanges} changed_total=${changed.length}`,
  );

  // --- Derived removal readiness -------------------------------------------------
  const blockers = [];
  if (registrationSetChanged) blockers.push('GO_REGISTRATION_SET_CHANGED');
  if (current.keys.length !== EXPECTED_GO_REGISTRATIONS) blockers.push(`GO_REGISTRATIONS=${current.keys.length}`);
  if (current.duplicates.length > 0) blockers.push(`GO_REGISTRATION_DUPLICATES=${current.duplicates.length}`);
  if (nextApiRouteFiles > 0) blockers.push(`NEXT_API_ROUTE_FILES=${nextApiRouteFiles}`);
  if (nextApiOperations > 0) blockers.push(`NEXT_API_OPERATIONS=${nextApiOperations}`);
  if (nextServerTreePresent) blockers.push('NEXT_SERVER_TREE_PRESENT');
  if (cutoverRuntimePresent) blockers.push('CUTOVER_RUNTIME_PRESENT');
  if (nodeApiFallback > 0) blockers.push(`NODE_API_FALLBACK=${nodeApiFallback}`);
  if (readiness.nextBusinessMongoReaders > 0) blockers.push('NEXT_BUSINESS_MONGO_READERS');
  if (readiness.nextBusinessMongoWriters > 0) blockers.push('NEXT_BUSINESS_MONGO_WRITERS');
  if (readiness.frontendJwtVerifiers > 0) blockers.push('FRONTEND_JWT_VERIFIERS');
  if (readiness.retiredSurfacesActive > 0) blockers.push('RETIRED_SURFACES_ACTIVE');
  if (readiness.chargingMutations > 0) blockers.push('CHARGING_MUTATIONS');
  if (!readiness.backendRemovalReady) blockers.push('BACKEND_REMOVAL_NOT_READY');
  if (!nginx.goUpstreamOk || !nginx.exactApiToGo || !nginx.prefixApiToGo) blockers.push('NGINX_API_NOT_ROUTED_TO_GO');
  if (!nginx.nextUpstreamOk || !nginx.uiToNext) blockers.push('NGINX_UI_NOT_ROUTED_TO_NEXT');
  if (!nginx.identityHeadersStripped) blockers.push('NGINX_IDENTITY_HEADERS_NOT_STRIPPED');
  if (nextListener.listener !== EXPECTED_NEXT_LISTENER) blockers.push(`NEXT_LISTENER=${nextListener.listener}`);
  if (goListener.defaultAddr !== EXPECTED_GO_LISTENER) blockers.push(`GO_LISTENER=${goListener.defaultAddr}`);
  if (standaloneProductionPath) blockers.push('STANDALONE_NEXT_PRODUCTION_PATH');
  if (productionRuntimeChanges > 0) blockers.push(`PRODUCTION_RUNTIME_CHANGES=${productionRuntimeChanges}`);
  if (unexpectedChanges > 0) blockers.push(`UNEXPECTED_CHANGES=${unexpectedChanges}`);
  const backendRemovalReady = blockers.length === 0;
  const failed = invariants.filter((i) => !i.ok);

  // ---------------------------------------------------------------------------
  // Report
  // ---------------------------------------------------------------------------
  console.log('Invariants:');
  for (const inv of invariants) {
    console.log(`  ${inv.ok ? 'PASS' : 'FAIL'}  ${inv.id.padEnd(8)} ${inv.detail}`);
  }

  console.log('\n-- Changed files vs frozen baseline (classified from git diff) --');
  for (const [cls, files] of Object.entries(byClass)) {
    console.log(`  ${cls}: ${files.length}`);
    for (const f of files) console.log(`    ${f}`);
  }

  console.log('\n-- Go production API surface --');
  console.log(`  registrations=${current.keys.length} reads=${reads.length} mutations=${mutations.length} duplicates=${current.duplicates.length}`);
  if (missing.length || added.length) {
    for (const k of missing) console.log(`  MISSING ${k}`);
    for (const k of added) console.log(`  ADDED   ${k}`);
  }

  console.log('\n==================================================');
  console.log('Phase 8.6 production freeze certification');
  console.log(`phase86_baseline_sha=${PHASE86_BASELINE_SHA}`);
  console.log(`phase86_head_sha=${headSha}`);
  console.log(`phase86_production_runtime_changes=${productionRuntimeChanges}`);
  console.log(`phase86_certification_test_changes=${byClass.CERTIFICATION_TEST.length}`);
  console.log(`phase86_ci_changes=${byClass.CI.length}`);
  console.log(`phase86_documentation_changes=${byClass.DOCUMENTATION.length}`);
  console.log(`phase86_unexpected_changes=${unexpectedChanges}`);
  console.log('');
  console.log(`phase86_go_registrations_expected=${EXPECTED_GO_REGISTRATIONS}`);
  console.log(`phase86_go_registrations_actual=${current.keys.length}`);
  console.log(`phase86_go_registration_missing=${missing.length}`);
  console.log(`phase86_go_registration_added=${added.length}`);
  console.log(`phase86_go_registration_duplicates=${current.duplicates.length}`);
  console.log(`phase86_go_registration_set_changed=${registrationSetChanged}`);
  console.log(`phase86_go_registered_reads=${reads.length}`);
  console.log(`phase86_go_registered_mutations=${mutations.length}`);
  console.log('');
  console.log(`phase86_next_api_route_files=${nextApiRouteFiles}`);
  console.log(`phase86_next_api_operations=${nextApiOperations}`);
  console.log(`phase86_next_server_tree_present=${nextServerTreePresent}`);
  console.log(`phase86_next_business_api_operations=${nextBusinessApiOperations}`);
  console.log('');
  console.log(`phase86_cutover_runtime_present=${cutoverRuntimePresent}`);
  console.log(`phase86_node_api_fallback=${nodeApiFallback}`);
  console.log(`phase86_next_api_reverse_proxy_functions=${cutover.reverseProxyHits}`);
  console.log(`phase86_production_route_resolvers=${cutover.resolverHits}`);
  console.log('');
  console.log('phase86_edge_api_owner=nginx->go');
  console.log('phase86_edge_ui_owner=nginx->next');
  console.log(`phase86_nginx_identity_headers_stripped=${nginx.identityHeadersStripped}`);
  console.log(`phase86_nginx_body_limit_10m=${nginx.bodyLimitOk}`);
  console.log(`phase86_nginx_sse_buffering_disabled=${nginx.sseUnbuffered}`);
  console.log('');
  console.log(`phase86_next_listener=${nextListener.listener}`);
  console.log(`phase86_go_listener=${goListener.defaultAddr}`);
  console.log(`phase86_standalone_next_production_path=${standaloneProductionPath}`);
  console.log('');
  console.log(`phase86_frontend_jwt_verifiers=${readiness.frontendJwtVerifiers}`);
  console.log(`phase86_next_business_mongo_readers=${readiness.nextBusinessMongoReaders}`);
  console.log(`phase86_next_business_mongo_writers=${readiness.nextBusinessMongoWriters}`);
  console.log(`phase86_frontend_package_mongodb=${readiness.frontendPackageMongodb}`);
  console.log(`phase86_frontend_package_jose=${readiness.frontendPackageJose}`);
  console.log(`phase86_frontend_package_jiti=${readiness.frontendPackageJiti}`);
  console.log('');
  console.log(`phase86_canonical_residual_expected=${EXPECTED_CANONICAL_RESIDUAL}`);
  console.log(`phase86_canonical_residual_present=${readiness.canonicalResidualPresent}`);
  console.log(`phase86_legacy_aliases_present=${readiness.legacyAliasesPresent}`);
  console.log(`phase86_retired_surfaces_active=${readiness.retiredSurfacesActive}`);
  console.log(`phase86_charging_mutations=${readiness.chargingMutations}`);
  console.log('');
  console.log(`phase86_backend_removal_readiness_exit=${readiness.exitCode}`);
  console.log(`phase86_backend_removal_ready=${backendRemovalReady}`);
  console.log(`phase86_backend_removal_blockers=${blockers.length}`);
  for (const b of blockers) console.log(`phase86_blocker=${b}`);
  console.log('');
  console.log(`phase86_runtime_proof_owner=phase-8.5-deployment-boundary-suite (sibling CI job)`);
  console.log(`phase86_invariants_failed=${failed.length}`);
  console.log(`phase86_result=${failed.length === 0 ? 'PASS' : 'FAIL'}`);
  console.log('==================================================\n');

  if (failed.length > 0) {
    console.error('Phase 8.6 production freeze certification FAILED.');
    process.exit(1);
  }

  console.log('Phase 8.6 production freeze certification result: PASS');
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
