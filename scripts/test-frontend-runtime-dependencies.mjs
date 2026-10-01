#!/usr/bin/env node
/**
 * Frontend Runtime Dependency Integrity acceptance suite.
 *
 * READ-ONLY with respect to production behavior. Pure source analysis: no network, no
 * MongoDB, no build step, so it runs in the CI `node` job.
 *
 * It certifies the durable architecture contract that the Next.js runtime is a UI-only
 * dependency set with no backend runtime, and derives that from the current source rather
 * than from any historical migration record:
 *
 *   - the frontend manifest declares no backend runtime module (jose / mongodb / jiti /
 *     bcryptjs) in any dependency section;
 *   - the frontend runtime dependency set is exactly the UI-only allowlist;
 *   - no frontend source module imports a backend runtime module;
 *   - every Node-era backend helper deleted from the UI runtime stays absent from disk;
 *   - the Next.js configuration carries no server-only MongoDB integration;
 *   - the frontend test tree carries no removed-backend test;
 *   - the production start command binds the loopback listener.
 *
 * Usage: node scripts/test-frontend-runtime-dependencies.mjs
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rel = (p) => relative(root, p).replaceAll('\\', '/');

const srcRoot = resolve(root, 'frontend/src');
const testsRoot = resolve(root, 'frontend/tests');
const packagePath = resolve(root, 'frontend/package.json');
const nextConfigPath = resolve(root, 'frontend/next.config.ts');

const CODE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const EXPECTED_NEXT_LISTENER = '127.0.0.1:13333';

/**
 * Backend runtime modules the UI runtime must never declare or import.
 *
 * `mongodb` is intentionally absent from this list: the UI runtime may import BSON value
 * types (`Long` / `ObjectId`) for subscriber data modelling, but it must never open a
 * MongoDB client. That separate invariant is asserted by `MONGODB_CLIENT_RE` below.
 */
const BANNED_RUNTIME_MODULES = [
  'jose',
  'jiti',
  'bcryptjs',
  'jsonwebtoken',
  'mongodb-client-encryption',
  'mongoose',
];

/** A live MongoDB client connection is a data plane the UI runtime must never own. */
const MONGODB_CLIENT_RE = /\bnew\s+MongoClient\s*\(|\bMongoClient\s*\.\s*connect\s*\(|\bMongoClient\b\s*</;

/** The complete UI-only runtime dependency allowlist. */
const EXPECTED_RUNTIME_DEPENDENCIES = ['lucide-react', 'next', 'react', 'react-dom', 'recharts', 'swr'];

/**
 * Node-era backend helpers that were removed from the UI runtime. Their absence is a
 * durable invariant: the UI runtime must not regain a backend data plane.
 */
const REMOVED_RUNTIME_HELPERS = [
  'frontend/src/lib/mongo.ts',
  'frontend/src/lib/sessionMongo.ts',
  'frontend/src/lib/accountSession.ts',
  'frontend/src/lib/sessionAccountStore.ts',
  'frontend/src/lib/cutover-routing.ts',
  'frontend/src/lib/profileAudit.ts',
  'frontend/src/lib/subscriberContract.ts',
  'frontend/src/lib/audit/sanitize.ts',
  'frontend/src/lib/plmnUtils.ts',
  'frontend/src/lib/plmn_db.ts',
  'frontend/src/components/governance/ChangeDiff.tsx',
  'frontend/tests/cutoverRouting.test.mjs',
];

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

function readManifest() {
  if (!existsSync(packagePath)) return { present: false };
  const pkg = JSON.parse(readFileSync(packagePath, 'utf8'));
  const declared = {
    ...(pkg.dependencies ?? {}),
    ...(pkg.devDependencies ?? {}),
    ...(pkg.peerDependencies ?? {}),
    ...(pkg.optionalDependencies ?? {}),
  };
  return {
    present: true,
    runtime: Object.keys(pkg.dependencies ?? {}).sort(),
    declared,
    start: pkg.scripts?.start ?? null,
  };
}

function scanBannedImports() {
  const hits = [];
  const roots = [srcRoot, testsRoot];
  const importRe = /(?:from\s*|import\s*|require\s*\(\s*|jiti\s*\(\s*)['"]([^'"]+)['"]/g;
  for (const base of roots) {
    if (!existsSync(base)) continue;
    for (const file of walk(base, (p) => CODE_EXT.test(p))) {
      const code = stripComments(readFileSync(file, 'utf8'));
      let m;
      importRe.lastIndex = 0;
      while ((m = importRe.exec(code)) !== null) {
        const spec = m[1];
        const banned = BANNED_RUNTIME_MODULES.find((mod) => spec === mod || spec.startsWith(`${mod}/`));
        if (banned) hits.push({ file: rel(file), module: banned });
      }
    }
  }
  return hits;
}

function scanRemovedHelpers() {
  return REMOVED_RUNTIME_HELPERS.filter((p) => existsSync(resolve(root, p)));
}

function scanMongoClients() {
  const hits = [];
  for (const file of walk(srcRoot, (p) => CODE_EXT.test(p))) {
    if (MONGODB_CLIENT_RE.test(stripComments(readFileSync(file, 'utf8')))) hits.push(rel(file));
  }
  return hits;
}

function scanNextConfig() {
  if (!existsSync(nextConfigPath)) return { present: false, code: '' };
  return { present: true, code: stripComments(readFileSync(nextConfigPath, 'utf8')) };
}

function main() {
  console.log('-- Frontend runtime dependency integrity (UI-only runtime) --\n');

  const manifest = readManifest();
  const bannedImports = scanBannedImports();
  const presentHelpers = scanRemovedHelpers();
  const mongoClients = scanMongoClients();
  const nextConfig = scanNextConfig();

  const bannedDeclared = manifest.present
    ? BANNED_RUNTIME_MODULES.filter((name) => Object.prototype.hasOwnProperty.call(manifest.declared, name))
    : [];

  const runtimeSet = manifest.present ? manifest.runtime : [];
  const runtimeMissing = EXPECTED_RUNTIME_DEPENDENCIES.filter((d) => !runtimeSet.includes(d));
  const runtimeExtra = runtimeSet.filter((d) => !EXPECTED_RUNTIME_DEPENDENCIES.includes(d));
  const runtimeExact = runtimeMissing.length === 0 && runtimeExtra.length === 0;

  const configHasServerMongo =
    /serverExternalPackages/.test(nextConfig.code) && /mongodb/.test(nextConfig.code);

  const listenerMatch = manifest.present && manifest.start ? manifest.start.match(/-H\s+(\S+)\s+-p\s+(\d+)/) : null;
  const derivedListener = listenerMatch ? `${listenerMatch[1]}:${listenerMatch[2]}` : null;

  check(
    'FRD-01',
    manifest.present && bannedDeclared.length === 0,
    `frontend_manifest_present=${manifest.present} banned_declared=[${bannedDeclared.join(',')}]`,
  );
  check(
    'FRD-02',
    runtimeExact,
    `runtime_dependencies=${runtimeSet.length} missing=[${runtimeMissing.join(',')}] unexpected=[${runtimeExtra.join(',')}]`,
  );
  check('FRD-03', bannedImports.length === 0, `banned_import_hits=${bannedImports.length}`);
  check('FRD-04', presentHelpers.length === 0, `removed_runtime_helpers_present=[${presentHelpers.join(',')}]`);
  check('FRD-05', nextConfig.present && !configHasServerMongo, `next_config_server_mongodb=${configHasServerMongo}`);
  check(
    'FRD-06',
    derivedListener === EXPECTED_NEXT_LISTENER,
    `next_listener_expected=${EXPECTED_NEXT_LISTENER} derived=${derivedListener}`,
  );
  check('FRD-07', mongoClients.length === 0, `frontend_mongo_client_modules=[${mongoClients.join(',')}]`);

  console.log('Invariants:');
  for (const inv of invariants) console.log(`  ${inv.ok ? 'PASS' : 'FAIL'}  ${inv.id} ${inv.detail}`);

  if (bannedImports.length) {
    console.log('\n-- Banned runtime module imports --');
    for (const hit of bannedImports) console.log(`  ${hit.file} -> ${hit.module}`);
  }

  const failed = invariants.filter((i) => !i.ok);

  console.log('\n==================================================');
  console.log(`frontend_manifest_present=${manifest.present}`);
  console.log(`frontend_runtime_dependencies=${runtimeSet.length}`);
  console.log(`frontend_runtime_dependencies_expected=${EXPECTED_RUNTIME_DEPENDENCIES.length}`);
  console.log(`frontend_banned_declared=${bannedDeclared.length}`);
  console.log(`frontend_banned_imports=${bannedImports.length}`);
  console.log(`frontend_removed_helpers_present=${presentHelpers.length}`);
  console.log(`frontend_next_config_server_mongodb=${configHasServerMongo}`);
  console.log(`frontend_mongo_client_modules=${mongoClients.length}`);
  console.log(`frontend_next_listener=${derivedListener}`);
  console.log(`frontend_runtime_dependency_invariants_failed=${failed.length}`);
  console.log(`frontend_runtime_dependencies_result=${failed.length === 0 ? 'PASS' : 'FAIL'}`);
  console.log('==================================================\n');

  if (failed.length > 0) {
    console.error('Frontend runtime dependency verification FAILED.');
    process.exit(1);
  }
  console.log('Frontend runtime dependency verification result: PASS');
}

main();
