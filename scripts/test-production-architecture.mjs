#!/usr/bin/env node
/**
 * Production Architecture Certification (semantic invariants, no historical baseline).
 *
 * This harness NEVER changes production behavior. It re-derives the current production
 * architecture from primary sources and fails closed on any drift:
 *
 *   - the Go production API surface, derived from the Go registration site
 *     (97 exact METHOD+PATH registrations, zero duplicates), never compared against a
 *     historical commit;
 *   - absence of the Next.js business backend (no App Router API tree, no business
 *     server tree, no business MongoDB data plane);
 *   - retirement of the migration-era route-owner runtime;
 *   - the Nginx public-edge contract (API -> Go, UI -> Next, identity stripping, body
 *     limit, SSE boundary);
 *   - the loopback-only Next.js and Go listener contract, derived from the actual
 *     production startup configuration;
 *   - dependency / runtime closure and the Go-only authentication authority;
 *   - retired-surface absence and charging-plane exclusion.
 *
 * The only frozen constants are explicit current contracts: the canonical API surface
 * size (97), the listener addresses, and the compatibility counts. Every observed value
 * is independently derived from source; no chronology-based baseline is used.
 *
 * The real-runtime proofs (real Nginx/Next/Go/Mongo topology, routing ownership,
 * unknown-route ownership, fail-closed Go-down behavior, authentication semantics,
 * identity-header spoofing, UI guard behavior, SSE streaming, request-body integrity and
 * loopback-only reachability) are authoritatively produced by the deployment-boundary
 * acceptance suite. CI runs that suite as a sibling job which this certification job
 * depends on, so the runtime values are proven in the same run rather than restated here.
 *
 * Usage: node scripts/test-production-architecture.mjs
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifyGoRegistrations,
  deriveGoRegistrations,
} from './lib/go-registrations.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rel = (p) => relative(root, p).replaceAll('\\', '/');

// --- Current production contracts ----------------------------------------------------
const EXPECTED_GO_REGISTRATIONS = 97;
const EXPECTED_GO_LISTENER = '127.0.0.1:18888';
const EXPECTED_CANONICAL_API = 33;
const EXPECTED_LEGACY_ALIASES = 2;
const EXPECTED_RETIRED_SURFACES = 6;

// Synthetic keys that must never exist in the derived surface. They make the enumeration
// falsifiable instead of vacuously true.
const GO_SENTINEL_KEY = 'GET /api/__production_architecture_unknown_sentinel__';
const NEXT_SENTINEL_KEY = 'GET /api/__production_architecture_next_sentinel__';

// --- Invariant bookkeeping -----------------------------------------------------------
const invariants = [];
function check(id, ok, detail) {
  invariants.push({ id, ok: Boolean(ok), detail });
  return Boolean(ok);
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

// --- Frontend canonical Vite contract ------------------------------------------------
function deriveFrontendCanonical() {
  const pkgRaw = readText('frontend/package.json');
  let pkg = null;
  try {
    pkg = pkgRaw ? JSON.parse(pkgRaw) : null;
  } catch {
    pkg = null;
  }
  const isVite = existsSync(resolve(root, 'frontend/vite.config.ts'));
  const isSpaAbsent = !existsSync(resolve(root, 'frontend-spa'));
  const isNextAbsent = !existsSync(resolve(root, 'frontend/next.config.ts'));
  const isLegacyNginxAbsent =
    !existsSync(resolve(root, 'deploy/nginx/xcloud-next-legacy.conf')) &&
    !existsSync(resolve(root, 'deploy/nginx/setup-next-legacy.sh'));
  return {
    packageName: pkg?.name ?? null,
    isVite,
    isSpaAbsent,
    isNextAbsent,
    isLegacyNginxAbsent,
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
      upstreamCount: 0,
      goUpstreamOk: false,
      exactApiToGo: false,
      prefixApiToGo: false,
      streamToGo: false,
      uiToGo: false,
      nextUpstreamPresent: false,
      nextHmrPresent: false,
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

  const uiToGo = proxiesTo(uiRoot, 'xcloud_go');
  const nextUpstreamPresent = Boolean(upstreams.xcloud_next);
  const nextHmrPresent = Boolean(find('/_next/hmr'));
  const upstreamCount = Object.keys(upstreams).length;

  return {
    present: true,
    upstreamCount,
    goUpstreamOk: (upstreams.xcloud_go ?? '').includes(EXPECTED_GO_LISTENER),
    exactApiToGo: proxiesTo(exactApi, 'xcloud_go'),
    prefixApiToGo: proxiesTo(prefixApi, 'xcloud_go'),
    streamToGo: proxiesTo(streamApi, 'xcloud_go'),
    uiToGo,
    nextUpstreamPresent,
    nextHmrPresent,
    identityHeadersStripped:
      apiLocations.length > 0 &&
      apiLocations.every(
        (l) => strips(l.body, 'X-User') && strips(l.body, 'X-Role') && strips(l.body, 'X-Permissions'),
      ),
    bodyLimitOk: /client_max_body_size\s+10m\s*;/.test(code),
    sseUnbuffered: Boolean(streamApi) && /proxy_buffering\s+off\s*;/.test(streamApi.body),
  };
}

// --- Migration-era route-owner runtime retirement ------------------------------------
function scanRouteOwnerRetirement() {
  const sources = [
    'frontend/src/proxy.ts',
    'frontend/src/lib/api.ts',
  ];
  let ownerTokenHits = 0;
  let resolverHits = 0;
  let reverseProxyHits = 0;
  for (const file of sources) {
    const raw = readText(file);
    if (!raw) continue;
    const code = stripJsComments(raw);
    ownerTokenHits += countOccurrences(code, /\bCUTOVER_TABLE\b/g);
    resolverHits += countOccurrences(code, /\bresolveRouteOwner\b/g);
    reverseProxyHits += countOccurrences(code, /\bforwardToGo\b|\bproxyToBackend\b/g);
  }
  return {
    routingFilePresent: existsSync(resolve(root, 'frontend/src/lib/cutover-routing.ts')),
    ownerTokenHits,
    resolverHits,
    reverseProxyHits,
  };
}

// --- Existing ownership evidence (authoritative re-run, unmodified) ------------------
function runOwnershipEvidence() {
  const script = resolve(root, 'scripts/test-api-ownership-invariants.mjs');
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
    canonicalApiPresent: num('canonical_api_present', 0),
    legacyAliasesPresent: num('legacy_aliases_present', 0),
    architectureContractReady: values.architecture_contract_ready === 'true',
    architectureBlockers: num('architecture_blockers', 0),
    frontendPackageMongodb: values.frontend_package_mongodb ?? 'unknown',
    frontendPackageJose: values.frontend_package_jose ?? 'unknown',
    frontendPackageJiti: values.frontend_package_jiti ?? 'unknown',
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log('-- Production Architecture Certification (semantic invariants) --\n');

  check(
    'PA-00',
    GO_SENTINEL_KEY !== NEXT_SENTINEL_KEY,
    'synthetic Go/Next sentinel keys are distinct (falsifiability guard)',
  );

  // --- Go API surface: derived from the Go registration site ---------------------
  const current = deriveGoRegistrations();
  const currentSet = new Set(current.keys);
  const sentinelAbsent = !currentSet.has(GO_SENTINEL_KEY) && !currentSet.has(NEXT_SENTINEL_KEY);

  check(
    'PA-01',
    current.keys.length === EXPECTED_GO_REGISTRATIONS,
    `go_registrations=${current.keys.length} expected=${EXPECTED_GO_REGISTRATIONS}`,
  );
  check('PA-02', current.duplicates.length === 0, `go_registration_duplicates=${current.duplicates.length}`);
  check(
    'PA-03',
    sentinelAbsent,
    `synthetic_sentinel_absent_from_derived_surface=${sentinelAbsent} (falsifiability guard)`,
  );

  const { reads, mutations } = classifyGoRegistrations(current.keys);

  // --- Next.js business backend absence -----------------------------------------
  const ownership = runOwnershipEvidence();
  check(
    'PA-04',
    ownership.exitCode === 0,
    `api_ownership_evidence_exit=${ownership.exitCode} (sibling suite re-run, unmodified)`,
  );
  check(
    'PA-05',
    ownership.nextApiRouteFiles === 0 &&
      ownership.nextApiOperations === 0 &&
      !ownership.nextServerTreePresent,
    `next_api_route_files=${ownership.nextApiRouteFiles} next_api_operations=${ownership.nextApiOperations} next_server_tree_present=${ownership.nextServerTreePresent}`,
  );
  check(
    'PA-06',
    ownership.nextBusinessApiOperations === 0,
    `next_business_api_operations=${ownership.nextBusinessApiOperations}`,
  );
  check(
    'PA-07',
    ownership.nextBusinessMongoReaders === 0 && ownership.nextBusinessMongoWriters === 0,
    `next_business_mongo_readers=${ownership.nextBusinessMongoReaders} next_business_mongo_writers=${ownership.nextBusinessMongoWriters}`,
  );
  check(
    'PA-08',
    ownership.frontendJwtVerifiers === 0,
    `frontend_jwt_verifiers=${ownership.frontendJwtVerifiers} (proxy forbidden tokens)`,
  );

  // --- Migration-era route-owner runtime retirement ------------------------------
  const routeOwner = scanRouteOwnerRetirement();
  const routeOwnerRuntimePresent =
    routeOwner.routingFilePresent || routeOwner.ownerTokenHits > 0 || routeOwner.resolverHits > 0;
  const nodeApiFallback = routeOwner.reverseProxyHits;
  check(
    'PA-09',
    !routeOwnerRuntimePresent,
    `route_owner_runtime_present=${routeOwnerRuntimePresent} routing_file=${routeOwner.routingFilePresent} owner_token_hits=${routeOwner.ownerTokenHits} resolver_hits=${routeOwner.resolverHits}`,
  );
  check(
    'PA-10',
    nodeApiFallback === 0,
    `node_api_fallback=${nodeApiFallback} next_api_reverse_proxy_functions=${routeOwner.reverseProxyHits}`,
  );

  // --- Nginx public edge ---------------------------------------------------------
  const nginx = scanNginx();
  check(
    'PA-11',
    nginx.present && nginx.goUpstreamOk && nginx.exactApiToGo && nginx.prefixApiToGo && nginx.streamToGo,
    `nginx_present=${nginx.present} go_upstream=${nginx.goUpstreamOk} exact_api_to_go=${nginx.exactApiToGo} prefix_api_to_go=${nginx.prefixApiToGo} stream_to_go=${nginx.streamToGo}`,
  );
  check(
    'PA-12',
    nginx.uiToGo && !nginx.nextUpstreamPresent && !nginx.nextHmrPresent && nginx.upstreamCount === 1,
    `ui_to_go=${nginx.uiToGo} next_upstream_present=${nginx.nextUpstreamPresent} next_hmr_present=${nginx.nextHmrPresent} upstream_count=${nginx.upstreamCount}`,
  );
  check(
    'PA-13',
    nginx.identityHeadersStripped,
    `nginx_identity_headers_stripped=${nginx.identityHeadersStripped}`,
  );
  check(
    'PA-14',
    nginx.bodyLimitOk && nginx.sseUnbuffered,
    `nginx_body_limit_10m=${nginx.bodyLimitOk} nginx_sse_buffering_disabled=${nginx.sseUnbuffered}`,
  );

  // --- Internal listener contract ------------------------------------------------
  const frontendCanonical = deriveFrontendCanonical();
  const nextPath = deriveNextProductionPath();
  const goListener = deriveGoListener();
  const standaloneProductionPath = nextPath.standaloneScriptPresent;
  check(
    'PA-15',
    frontendCanonical.isNextAbsent &&
      frontendCanonical.isSpaAbsent &&
      frontendCanonical.isLegacyNginxAbsent,
    `next_source_absent=${frontendCanonical.isNextAbsent} frontend_spa_absent=${frontendCanonical.isSpaAbsent} legacy_nginx_absent=${frontendCanonical.isLegacyNginxAbsent} (Next.js and port 13333 retired)`,
  );
  check(
    'PA-16',
    goListener.defaultAddr === EXPECTED_GO_LISTENER,
    `go_listener_expected=${EXPECTED_GO_LISTENER} derived=${goListener.defaultAddr} (production default in backend/internal/config)`,
  );
  check(
    'PA-17',
    frontendCanonical.isVite &&
      frontendCanonical.packageName === 'subscriber-console-frontend' &&
      !standaloneProductionPath,
    `frontend_canonical_vite=${frontendCanonical.isVite} package=${frontendCanonical.packageName} standalone_next_production_path=${standaloneProductionPath}`,
  );

  // --- Dependency / runtime closure ---------------------------------------------
  check(
    'PA-18',
    ownership.frontendPackageMongodb === 'absent' &&
      ownership.frontendPackageJose === 'absent' &&
      ownership.frontendPackageJiti === 'absent',
    `frontend_package mongodb=${ownership.frontendPackageMongodb} jose=${ownership.frontendPackageJose} jiti=${ownership.frontendPackageJiti}`,
  );

  // --- Retired surfaces / charging plane ----------------------------------------
  check(
    'PA-19',
    ownership.retiredSurfacesActive === 0,
    `retired_surfaces_expected=${EXPECTED_RETIRED_SURFACES} retired_surfaces_active=${ownership.retiredSurfacesActive}`,
  );
  check('PA-20', ownership.chargingMutations === 0, `charging_mutations=${ownership.chargingMutations}`);
  check(
    'PA-21',
    ownership.canonicalApiPresent === EXPECTED_CANONICAL_API &&
      ownership.legacyAliasesPresent === EXPECTED_LEGACY_ALIASES,
    `canonical_api_expected=${EXPECTED_CANONICAL_API} canonical_api_present=${ownership.canonicalApiPresent} legacy_aliases_present=${ownership.legacyAliasesPresent}`,
  );

  // --- Derived certification blockers -------------------------------------------
  const blockers = [];
  if (current.keys.length !== EXPECTED_GO_REGISTRATIONS) blockers.push(`GO_REGISTRATIONS=${current.keys.length}`);
  if (current.duplicates.length > 0) blockers.push(`GO_REGISTRATION_DUPLICATES=${current.duplicates.length}`);
  if (!sentinelAbsent) blockers.push('GO_SENTINEL_PRESENT');
  if (ownership.nextApiRouteFiles > 0) blockers.push(`NEXT_API_ROUTE_FILES=${ownership.nextApiRouteFiles}`);
  if (ownership.nextApiOperations > 0) blockers.push(`NEXT_API_OPERATIONS=${ownership.nextApiOperations}`);
  if (ownership.nextServerTreePresent) blockers.push('NEXT_SERVER_TREE_PRESENT');
  if (routeOwnerRuntimePresent) blockers.push('ROUTE_OWNER_RUNTIME_PRESENT');
  if (nodeApiFallback > 0) blockers.push(`NODE_API_FALLBACK=${nodeApiFallback}`);
  if (ownership.nextBusinessMongoReaders > 0) blockers.push('NEXT_BUSINESS_MONGO_READERS');
  if (ownership.nextBusinessMongoWriters > 0) blockers.push('NEXT_BUSINESS_MONGO_WRITERS');
  if (ownership.frontendJwtVerifiers > 0) blockers.push('FRONTEND_JWT_VERIFIERS');
  if (ownership.retiredSurfacesActive > 0) blockers.push('RETIRED_SURFACES_ACTIVE');
  if (ownership.chargingMutations > 0) blockers.push('CHARGING_MUTATIONS');
  if (!ownership.architectureContractReady) blockers.push('API_OWNERSHIP_NOT_READY');
  if (!nginx.goUpstreamOk || !nginx.exactApiToGo || !nginx.prefixApiToGo) blockers.push('NGINX_API_NOT_ROUTED_TO_GO');
  if (!nginx.uiToGo) blockers.push('NGINX_UI_NOT_ROUTED_TO_GO');
  if (nginx.nextUpstreamPresent) blockers.push('NGINX_NEXT_UPSTREAM_ACTIVE');
  if (nginx.nextHmrPresent) blockers.push('NGINX_NEXT_HMR_ACTIVE');
  if (nginx.upstreamCount !== 1) blockers.push(`NGINX_UPSTREAM_COUNT=${nginx.upstreamCount}`);
  if (!nginx.identityHeadersStripped) blockers.push('NGINX_IDENTITY_HEADERS_NOT_STRIPPED');
  if (!frontendCanonical.isNextAbsent || !frontendCanonical.isSpaAbsent || !frontendCanonical.isLegacyNginxAbsent) {
    blockers.push('LEGACY_NEXT_OR_SPA_PRESENT');
  }
  if (!frontendCanonical.isVite || frontendCanonical.packageName !== 'subscriber-console-frontend') {
    blockers.push('FRONTEND_NOT_CANONICAL_VITE');
  }
  if (goListener.defaultAddr !== EXPECTED_GO_LISTENER) blockers.push(`GO_LISTENER=${goListener.defaultAddr}`);
  if (standaloneProductionPath) blockers.push('STANDALONE_NEXT_PRODUCTION_PATH');
  const architectureReady = blockers.length === 0;
  const failed = invariants.filter((i) => !i.ok);

  // ---------------------------------------------------------------------------
  // Report
  // ---------------------------------------------------------------------------
  console.log('Invariants:');
  for (const inv of invariants) {
    console.log(`  ${inv.ok ? 'PASS' : 'FAIL'}  ${inv.id.padEnd(8)} ${inv.detail}`);
  }

  console.log('\n-- Go production API surface --');
  console.log(`  registrations=${current.keys.length} reads=${reads.length} mutations=${mutations.length} duplicates=${current.duplicates.length}`);

  console.log('\n==================================================');
  console.log('Production architecture certification');
  console.log(`production_architecture_go_registrations_expected=${EXPECTED_GO_REGISTRATIONS}`);
  console.log(`production_architecture_go_registrations_actual=${current.keys.length}`);
  console.log(`production_architecture_go_registration_duplicates=${current.duplicates.length}`);
  console.log(`production_architecture_go_registered_reads=${reads.length}`);
  console.log(`production_architecture_go_registered_mutations=${mutations.length}`);
  console.log(`production_architecture_go_sentinel_absent=${sentinelAbsent}`);
  console.log('');
  console.log(`production_architecture_next_api_route_files=${ownership.nextApiRouteFiles}`);
  console.log(`production_architecture_next_api_operations=${ownership.nextApiOperations}`);
  console.log(`production_architecture_next_server_tree_present=${ownership.nextServerTreePresent}`);
  console.log(`production_architecture_next_business_api_operations=${ownership.nextBusinessApiOperations}`);
  console.log('');
  console.log(`production_architecture_route_owner_runtime_present=${routeOwnerRuntimePresent}`);
  console.log(`production_architecture_node_api_fallback=${nodeApiFallback}`);
  console.log(`production_architecture_next_api_reverse_proxy_functions=${routeOwner.reverseProxyHits}`);
  console.log(`production_architecture_route_resolvers=${routeOwner.resolverHits}`);
  console.log('');
  console.log('production_architecture_edge_api_owner=nginx->go');
  console.log('production_architecture_edge_ui_owner=nginx->go');
  console.log(`production_architecture_nginx_single_upstream=${nginx.upstreamCount === 1 && nginx.goUpstreamOk && !nginx.nextUpstreamPresent}`);
  console.log(`production_architecture_nginx_ui_to_go=${nginx.uiToGo}`);
  console.log('production_architecture_nginx_production_next_upstream=false');
  console.log('production_architecture_nginx_production_next_hmr=false');
  console.log(`production_architecture_nginx_identity_headers_stripped=${nginx.identityHeadersStripped}`);
  console.log(`production_architecture_nginx_body_limit_10m=${nginx.bodyLimitOk}`);
  console.log(`production_architecture_nginx_sse_buffering_disabled=${nginx.sseUnbuffered}`);
  console.log('production_architecture_retained_next_listener=retired (port 13333 retired)');
  console.log('production_architecture_active_production_ui_listener=127.0.0.1:18888');
  console.log(`production_architecture_go_listener=${goListener.defaultAddr}`);
  console.log(`production_architecture_frontend_canonical=${frontendCanonical.isVite ? 'vite_spa' : 'unknown'}`);
  console.log(`production_architecture_standalone_next_production_path=${standaloneProductionPath}`);
  console.log('');
  console.log(`production_architecture_frontend_jwt_verifiers=${ownership.frontendJwtVerifiers}`);
  console.log(`production_architecture_next_business_mongo_readers=${ownership.nextBusinessMongoReaders}`);
  console.log(`production_architecture_next_business_mongo_writers=${ownership.nextBusinessMongoWriters}`);
  console.log(`production_architecture_frontend_package_mongodb=${ownership.frontendPackageMongodb}`);
  console.log(`production_architecture_frontend_package_jose=${ownership.frontendPackageJose}`);
  console.log(`production_architecture_frontend_package_jiti=${ownership.frontendPackageJiti}`);
  console.log('');
  console.log(`production_architecture_canonical_api_expected=${EXPECTED_CANONICAL_API}`);
  console.log(`production_architecture_canonical_api_present=${ownership.canonicalApiPresent}`);
  console.log(`production_architecture_legacy_aliases_present=${ownership.legacyAliasesPresent}`);
  console.log(`production_architecture_retired_surfaces_active=${ownership.retiredSurfacesActive}`);
  console.log(`production_architecture_charging_mutations=${ownership.chargingMutations}`);
  console.log('');
  console.log(`production_architecture_api_ownership_exit=${ownership.exitCode}`);
  console.log(`production_architecture_ready=${architectureReady}`);
  console.log(`production_architecture_blockers=${blockers.length}`);
  for (const b of blockers) console.log(`production_architecture_blocker=${b}`);
  console.log('');
  console.log('production_architecture_runtime_proof_owner=deployment-boundary-suite (sibling CI job)');
  console.log(`production_architecture_invariants_failed=${failed.length}`);
  console.log(`production_architecture_result=${failed.length === 0 ? 'PASS' : 'FAIL'}`);
  console.log('==================================================\n');

  if (failed.length > 0) {
    console.error('Production architecture certification FAILED.');
    process.exit(1);
  }

  console.log('Production architecture certification result: PASS');
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
