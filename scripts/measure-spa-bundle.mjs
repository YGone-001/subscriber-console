#!/usr/bin/env node
/*
 * Reproducible SPA bundle measurement.
 *
 * Runs the production Vite build in memory (`write: false`) so nothing is
 * written to `frontend/dist` and no build output can leak into Git, then reports
 * the numbers the lazy-loading evidence needs:
 *
 *   - total emitted JavaScript bytes and chunk count
 *   - total emitted CSS bytes
 *   - the entry (initial) chunk closure: bytes, gzip, brotli, request count
 *   - the extra bytes a representative route needs on first visit
 *   - the heaviest modules reachable from the entry chunk
 *
 * The entry closure is the set of chunks the browser must download before the
 * SPA can boot: the entry chunk plus everything it imports statically. A route
 * that is loaded through `route.lazy` only contributes after the boot, which is
 * exactly the distinction this script measures.
 *
 * Usage:
 *   node scripts/measure-spa-bundle.mjs            human readable summary
 *   node scripts/measure-spa-bundle.mjs --json f   also write raw numbers to f
 *   node scripts/measure-spa-bundle.mjs --label X  tag the output with a label
 */
import { brotliCompressSync, constants as zlibConstants, gzipSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';

const frontendRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'frontend');

/* Vite is a frontend dependency; resolve it from the frontend package. */
const requireFromFrontend = createRequire(resolve(frontendRoot, 'package.json'));
const { build } = await import(pathToFileURL(requireFromFrontend.resolve('vite')).href);

/*
 * Representative entry points. Each value is the module a route resolves to, so
 * the script can attribute an emitted chunk to a route without depending on
 * hashed file names.
 */
const ROUTE_MODULES = {
  '/login': 'src/auth/LoginPage.tsx',
  '/': 'src/features/read/ReadPages.tsx',
  '/subscribers': 'src/features/subscribers/SubscribersPage.tsx',
  '/ocs/balances': 'src/features/ocs/balances/BalancesPage.tsx',
  '/ocs/tariffs': 'src/features/ocs/tariffs/TariffsPage.tsx',
  '/inventory': 'src/features/inventory/InventoryPage.tsx',
  '/topology': 'src/features/topology/TopologyPage.tsx',
  '/nf-health': 'src/features/nf-health/NfHealthPage.tsx',
  '/knowledge': 'src/features/knowledge/KnowledgePage.tsx',
  '/users': 'src/features/users/UsersPage.tsx',
};

const args = process.argv.slice(2);
const label = valueOfFlag('--label') ?? 'build';
const jsonPath = valueOfFlag('--json');

function valueOfFlag(flag) {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

const gzipSize = (code) => gzipSync(Buffer.from(code, 'utf8'), { level: 9 }).length;
const brotliSize = (code) =>
  brotliCompressSync(Buffer.from(code, 'utf8'), {
    params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 },
  }).length;
const bytes = (code) => Buffer.byteLength(code, 'utf8');

const result = await build({
  root: frontendRoot,
  logLevel: 'silent',
  build: { write: false, reportCompressedSize: false },
});

const output = (Array.isArray(result) ? result[0] : result).output;
const chunks = output.filter((entry) => entry.type === 'chunk');
const assets = output.filter((entry) => entry.type === 'asset');

const chunkByFileName = new Map(chunks.map((chunk) => [chunk.fileName, chunk]));

/** Entry chunk plus every chunk it imports statically, transitively. */
function staticClosure(fileNames) {
  const seen = new Set();
  const stack = [...fileNames];
  while (stack.length > 0) {
    const name = stack.pop();
    if (!name || seen.has(name)) continue;
    const chunk = chunkByFileName.get(name);
    if (!chunk) continue;
    seen.add(name);
    stack.push(...chunk.imports);
  }
  return seen;
}

function describeClosure(fileNames) {
  const names = staticClosure(fileNames);
  let raw = 0;
  let gzip = 0;
  let brotli = 0;
  for (const name of names) {
    const code = chunkByFileName.get(name)?.code ?? '';
    raw += bytes(code);
    gzip += gzipSize(code);
    brotli += brotliSize(code);
  }
  return { files: [...names].sort(), requests: names.size, raw, gzip, brotli };
}

const entryChunks = chunks.filter((chunk) => chunk.isEntry);
const entryClosure = describeClosure(entryChunks.map((chunk) => chunk.fileName));

/** Resolve the chunk Vite emitted for a route module. */
function chunkForModule(modulePath) {
  const suffix = modulePath.replaceAll('\\', '/');
  return chunks.find((chunk) => {
    const facade = (chunk.facadeModuleId ?? '').replaceAll('\\', '/');
    if (facade.endsWith(suffix)) return true;
    return Object.keys(chunk.modules ?? {}).some((id) => id.replaceAll('\\', '/').endsWith(suffix));
  });
}

const routes = {};
for (const [route, modulePath] of Object.entries(ROUTE_MODULES)) {
  const chunk = chunkForModule(modulePath);
  if (!chunk) {
    routes[route] = { module: modulePath, chunk: null, deferred: false, extraRaw: 0, extraGzip: 0, extraBrotli: 0 };
    continue;
  }
  const inEntry = entryClosure.files.includes(chunk.fileName);
  const routeClosure = describeClosure([chunk.fileName]);
  const extra = [...staticClosure([chunk.fileName])].filter((name) => !entryClosure.files.includes(name));
  let extraRaw = 0;
  let extraGzip = 0;
  let extraBrotli = 0;
  for (const name of extra) {
    const code = chunkByFileName.get(name)?.code ?? '';
    extraRaw += bytes(code);
    extraGzip += gzipSize(code);
    extraBrotli += brotliSize(code);
  }
  routes[route] = {
    module: modulePath,
    chunk: chunk.fileName,
    deferred: !inEntry,
    routeRaw: routeClosure.raw,
    routeGzip: routeClosure.gzip,
    routeBrotli: routeClosure.brotli,
    extraRaw,
    extraGzip,
    extraBrotli,
  };
}

/* Heaviest modules reachable from the entry closure. */
const heavyModules = [];
for (const name of entryClosure.files) {
  const chunk = chunkByFileName.get(name);
  for (const [id, info] of Object.entries(chunk?.modules ?? {})) {
    const normalized = id.replaceAll('\\', '/');
    const relative = normalized.includes('/frontend/') ? normalized.split('/frontend/')[1] : normalized;
    if (!relative.startsWith('src/') && !relative.includes('node_modules')) continue;
    heavyModules.push({ module: relative, bytes: info.renderedLength ?? 0 });
  }
}
heavyModules.sort((left, right) => right.bytes - left.bytes);

const totalJs = chunks.reduce((sum, chunk) => sum + bytes(chunk.code), 0);
const totalJsGzip = chunks.reduce((sum, chunk) => sum + gzipSize(chunk.code), 0);
const totalJsBrotli = chunks.reduce((sum, chunk) => sum + brotliSize(chunk.code), 0);
const cssAssets = assets.filter((asset) => asset.fileName.endsWith('.css'));
const totalCss = cssAssets.reduce((sum, asset) => sum + bytes(String(asset.source)), 0);

/*
 * Duplication audit: a module that appears in more than one chunk is code the
 * browser downloads twice. Route-level splitting should keep this at zero for
 * everything except the bundler runtime.
 */
const moduleChunkCount = new Map();
for (const chunk of chunks) {
  for (const id of Object.keys(chunk.modules ?? {})) {
    moduleChunkCount.set(id, (moduleChunkCount.get(id) ?? 0) + 1);
  }
}
const duplicatedModules = [...moduleChunkCount.entries()]
  .filter(([, count]) => count > 1)
  .map(([id, count]) => {
    const normalized = id.replaceAll('\\', '/');
    const relative = normalized.includes('/frontend/') ? normalized.split('/frontend/')[1] : normalized;
    return { module: relative, chunks: count };
  })
  .sort((left, right) => right.chunks - left.chunks);

const report = {
  label,
  generatedAt: new Date().toISOString(),
  totalJsBytes: totalJs,
  totalJsGzip: totalJsGzip,
  totalJsBrotli: totalJsBrotli,
  totalCssBytes: totalCss,
  jsChunkCount: chunks.length,
  cssAssetCount: cssAssets.length,
  entry: entryClosure,
  entryFileNames: entryChunks.map((chunk) => chunk.fileName),
  routes,
  heavyModules: heavyModules.slice(0, 15),
  duplicatedModules: duplicatedModules.slice(0, 20),
  duplicatedModuleCount: duplicatedModules.length,
};

console.log(`[measure] label=${label}`);
console.log(`[measure] total_js_bytes=${totalJs} total_js_gzip=${totalJsGzip} total_js_brotli=${totalJsBrotli}`);
console.log(`[measure] total_css_bytes=${totalCss} css_assets=${cssAssets.length}`);
console.log(`[measure] js_chunk_count=${chunks.length}`);
console.log(`[measure] duplicated_module_count=${duplicatedModules.length}`);
for (const entry of duplicatedModules.slice(0, 5)) {
  console.log(`[measure]   duplicated_in_${entry.chunks}_chunks  ${entry.module}`);
}
console.log(
  `[measure] entry_raw=${entryClosure.raw} entry_gzip=${entryClosure.gzip} entry_brotli=${entryClosure.brotli} entry_requests=${entryClosure.requests}`,
);
for (const [route, info] of Object.entries(routes)) {
  console.log(
    `[measure] route=${route} deferred=${info.deferred} extra_raw=${info.extraRaw} extra_gzip=${info.extraGzip} extra_requests=${
      info.deferred ? staticClosure([info.chunk]).size : 0
    }`,
  );
}
console.log('[measure] heavy_modules_in_entry:');
for (const entry of report.heavyModules) {
  console.log(`[measure]   ${entry.bytes.toString().padStart(9)}  ${entry.module}`);
}

if (args.includes('--verbose')) {
  for (const [route, info] of Object.entries(routes)) {
    if (!info.chunk) continue;
    const extra = [...staticClosure([info.chunk])].filter((name) => !entryClosure.files.includes(name));
    console.log(`[measure] chunks_for=${route} count=${extra.length}`);
    for (const name of extra.sort((left, right) => (chunkByFileName.get(right)?.code.length ?? 0) - (chunkByFileName.get(left)?.code.length ?? 0))) {
      const chunk = chunkByFileName.get(name);
      console.log(`[measure]   ${String(chunk ? bytes(chunk.code) : 0).padStart(8)}  ${name}`);
    }
  }
}

if (jsonPath) {
  writeFileSync(resolve(process.cwd(), jsonPath), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`[measure] json=${jsonPath}`);
}
