#!/usr/bin/env node
/**
 * Frontend Runtime Dependency Integrity acceptance suite.
 *
 * READ-ONLY with respect to production behavior. Pure source analysis: no network, no
 * MongoDB, no build step, so it runs in the CI `node` job.
 *
 * It certifies the durable architecture contract that the canonical React/Vite SPA is a
 * UI-only dependency set with no backend runtime and no Next.js framework:
 *
 *   - the frontend manifest declares no backend runtime module (jose / mongodb / jiti /
 *     bcryptjs / next) in any dependency section;
 *   - the frontend runtime dependency set is exactly the UI-only allowlist;
 *   - no frontend source module imports a backend runtime module or Next;
 *   - every Node-era backend helper deleted from the UI runtime stays absent from disk;
 *   - Next.js configuration is absent;
 *   - the dev start command binds the loopback listener 127.0.0.1:13333.
 *
 * Usage: node scripts/test-frontend-runtime-dependencies.mjs
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rel = (p) => relative(root, p).replaceAll('\\', '/');

const srcRoot = resolve(root, 'frontend/src');
const packagePath = resolve(root, 'frontend/package.json');
const nextConfigPath = resolve(root, 'frontend/next.config.ts');
const viteConfigPath = resolve(root, 'frontend/vite.config.ts');

const CODE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const EXPECTED_DEV_LISTENER = '127.0.0.1:13333';

/** Backend runtime modules the UI runtime must never declare or import. */
const BANNED_RUNTIME_MODULES = [
  'next',
  'jose',
  'jiti',
  'bcryptjs',
  'jsonwebtoken',
  'mongodb',
  'mongodb-client-encryption',
  'mongoose',
];

/** A live MongoDB client connection is a data plane the UI runtime must never own. */
const MONGODB_CLIENT_RE = /\bnew\s+MongoClient\s*\(|\bMongoClient\s*\.\s*connect\s*\(|\bMongoClient\b\s*</;

/** The complete UI-only runtime dependency allowlist. */
const EXPECTED_RUNTIME_DEPENDENCIES = ['lucide-react', 'react', 'react-dom', 'react-router-dom', 'recharts', 'swr'];

/**
 * Node-era backend helpers that were removed from the UI runtime.
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
  'frontend/src/proxy.ts',
  'frontend/src/components/governance/ChangeDiff.tsx',
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
      if (raw.startsWith('//', i)) break;
      built += raw[i];
      i += 1;
    }
    out.push(built);
  }
  return out.join('\n');
}

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    let stat;
    try { stat = statSync(full); } catch { continue; }
    if (stat.isDirectory()) {
      if (entry === 'node_modules' || entry === '.git' || entry === 'dist') continue;
      walk(full, out);
    } else if (stat.isFile() && CODE_EXT.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

function readManifest() {
  if (!existsSync(packagePath)) return { present: false, declared: {}, runtime: [] };
  const raw = JSON.parse(readFileSync(packagePath, 'utf8'));
  const deps = raw.dependencies ?? {};
  const devDeps = raw.devDependencies ?? {};
  const declared = { ...deps, ...devDeps };
  return {
    present: true,
    declared,
    runtime: Object.keys(deps).sort(),
    devScript: raw.scripts?.dev ?? null,
  };
}

function scanBannedImports() {
  const violations = [];
  for (const file of walk(srcRoot)) {
    const code = stripComments(readFileSync(file, 'utf8'));
    for (const mod of BANNED_RUNTIME_MODULES) {
      const re = new RegExp(
        `(?:from\\s+['"]|import\\s*\\(['"]|require\\(['"])${mod}(?:['"/]|$)`,
      );
      if (re.test(code)) violations.push({ file: rel(file), module: mod });
    }
  }
  return violations;
}

function scanRemovedHelpers() {
  return REMOVED_RUNTIME_HELPERS.filter((p) => existsSync(resolve(root, p)));
}

function scanMongoClients() {
  const hits = [];
  for (const file of walk(srcRoot)) {
    const code = stripComments(readFileSync(file, 'utf8'));
    if (MONGODB_CLIENT_RE.test(code)) hits.push(rel(file));
  }
  return hits;
}

const invariants = [];
function check(id, ok, detail) {
  invariants.push({ id, ok: Boolean(ok), detail });
  return Boolean(ok);
}

function main() {
  console.log('-- Frontend runtime dependency integrity (UI-only runtime) --\n');

  const manifest = readManifest();
  const bannedImports = scanBannedImports();
  const presentHelpers = scanRemovedHelpers();
  const mongoClients = scanMongoClients();

  const bannedDeclared = manifest.present
    ? BANNED_RUNTIME_MODULES.filter((name) => Object.prototype.hasOwnProperty.call(manifest.declared, name))
    : [];

  const runtimeSet = manifest.present ? manifest.runtime : [];
  const runtimeMissing = EXPECTED_RUNTIME_DEPENDENCIES.filter((d) => !runtimeSet.includes(d));
  const runtimeExtra = runtimeSet.filter((d) => !EXPECTED_RUNTIME_DEPENDENCIES.includes(d));
  const runtimeExact = runtimeMissing.length === 0 && runtimeExtra.length === 0;

  const nextConfigAbsent = !existsSync(nextConfigPath);

  const devListenerMatch = manifest.present && manifest.devScript ? manifest.devScript.match(/--host\s+(\S+)\s+--port\s+(\d+)/) : null;
  const derivedDevListener = devListenerMatch ? `${devListenerMatch[1]}:${devListenerMatch[2]}` : null;

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
  check('FRD-05', nextConfigAbsent, `next_config_absent=${nextConfigAbsent}`);
  check(
    'FRD-06',
    derivedDevListener === EXPECTED_DEV_LISTENER,
    `dev_listener_expected=${EXPECTED_DEV_LISTENER} derived=${derivedDevListener}`,
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
  console.log(`frontend_next_config_absent=${nextConfigAbsent}`);
  console.log(`frontend_mongo_client_modules=${mongoClients.length}`);
  console.log(`frontend_dev_listener=${derivedDevListener}`);
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
