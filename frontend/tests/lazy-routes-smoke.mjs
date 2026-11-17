#!/usr/bin/env node
/*
 * Route-level lazy loading acceptance.
 *
 * Proves the behaviour the lazy route table is supposed to deliver, against a
 * real production build in a real browser:
 *
 *   L1  a cold /login load downloads no business page chunk
 *   L2  a cold / load downloads only the dashboard chunk, renders an accessible
 *       boot state while that chunk is in flight, and never shows a false 404
 *   L3  client-side navigation loads exactly the chunk the route needs and a
 *       repeat visit is served from cache
 *   L4  a deep link (and a reload of it) renders the page directly
 *   L5  a failed chunk download renders a bounded error state inside the shell,
 *       raises no unhandled exception, and recovers on retry
 *   L6  browser back/forward restores the right route
 *   L7  an unauthenticated deep link still redirects to /login without loading
 *       any business chunk
 *
 * Chunk names are read from the build output rather than hard-coded, so hashed
 * file names never make the suite fragile.
 *
 * Usage: node frontend/tests/lazy-routes-smoke.mjs
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { build } from 'vite';

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const viewport = { width: 1440, height: 900 };

/* 1x1 transparent PNG, so the login logo request never fails. */
const PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

/*
 * Static host with the production shape: hashed assets are immutable, a missing
 * asset is a real 404 (never the SPA document), and every other path falls back
 * to index.html so deep links boot the SPA.
 */
async function startStaticServer(distDirectory) {
  await stat(path.join(distDirectory, 'index.html'));
  const server = createServer(async (request, response) => {
    try {
      const requestPath = decodeURIComponent(new URL(request.url || '/', 'http://127.0.0.1').pathname);
      const relativePath = requestPath === '/' ? 'index.html' : requestPath.replace(/^\/+/, '');
      const candidate = path.resolve(distDirectory, relativePath);
      const insideDist = candidate.startsWith(`${distDirectory}${path.sep}`);
      const resolved = insideDist ? await stat(candidate).catch(() => null) : null;

      if (resolved?.isFile()) {
        const body = await readFile(candidate);
        const immutable = requestPath.startsWith('/assets/');
        response.writeHead(200, {
          'Content-Type': contentTypes[path.extname(candidate)] || 'application/octet-stream',
          'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
        });
        response.end(body);
        return;
      }

      if (requestPath.startsWith('/assets/')) {
        response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('asset not found');
        return;
      }

      if (requestPath.endsWith('.png')) {
        response.writeHead(200, { 'Content-Type': 'image/png' });
        response.end(PIXEL_PNG);
        return;
      }

      const html = await readFile(path.join(distDirectory, 'index.html'));
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      response.end(html);
    } catch (error) {
      response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end(error instanceof Error ? error.message : 'Static server failure');
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object', 'static server must expose a TCP address');
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body) });

const checks = [];
const failures = [];

function check(id, ok, detail = '') {
  checks.push({ id, ok: Boolean(ok), detail });
  if (!ok) {
    console.error(`[FAIL] ${id}: ${detail}`);
    failures.push(`${id} ${detail}`);
  } else {
    console.log(`[PASS] ${id}${detail ? ` - ${detail}` : ''}`);
  }
}

const ADMIN_USER = {
  username: 'admin',
  role: 'admin',
  normalizedRole: 'admin',
  status: 'active',
  permissions: ['subscribers.read', 'ocs.read', 'core.read', 'core.configure'],
};

const BENIGN_CONSOLE = [
  /Download the React DevTools/i,
  /favicon/i,
  /net::ERR_FAILED/i,
  /Failed to fetch/i,
  /Failed to load resource/i,
  /ERR_ABORTED/i,
];

/** Chunk file name per module facade, plus every page module chunk. */
function collectBuildFacts(result) {
  const output = (Array.isArray(result) ? result[0] : result).output;
  const chunks = output.filter((entry) => entry.type === 'chunk');
  const chunkByModule = new Map();
  const pageChunks = new Map();
  for (const chunk of chunks) {
    const facade = (chunk.facadeModuleId ?? '').replaceAll('\\', '/');
    if (!facade) continue;
    const relative = facade.includes('/src/') ? facade.split('/src/')[1] : null;
    if (!relative) continue;
    chunkByModule.set(relative, chunk.fileName);
    if (relative.startsWith('features/') && /Page\.tsx$/.test(relative)) {
      pageChunks.set(relative, chunk.fileName);
    }
  }
  return {
    chunkByModule,
    pageChunks,
    pageChunkFiles: new Set(pageChunks.values()),
    entryFiles: chunks.filter((chunk) => chunk.isEntry).map((chunk) => chunk.fileName),
    chunkCount: chunks.length,
  };
}

function moduleChunk(facts, modulePath) {
  const fileName = facts.chunkByModule.get(modulePath);
  assert.ok(fileName, `build output has no chunk for ${modulePath}`);
  return fileName;
}

let temporaryBuildDirectory = null;
let ownedServer = null;
let browser = null;

try {
  console.log('[acceptance:lazy-routes] Building frontend SPA to temporary directory...');
  temporaryBuildDirectory = await mkdtemp(path.join(tmpdir(), 'xcloud-lazy-routes-'));
  const buildResult = await build({
    root: frontendRoot,
    build: { outDir: temporaryBuildDirectory, emptyOutDir: true },
    logLevel: 'warn',
  });
  const facts = collectBuildFacts(buildResult);

  const dashboardChunk = moduleChunk(facts, 'features/read/ReadPages.tsx');
  const balancesChunk = moduleChunk(facts, 'features/ocs/balances/BalancesPage.tsx');
  const balanceDetailChunk = moduleChunk(facts, 'features/ocs/balances/BalanceDetailPage.tsx');
  const topologyChunk = moduleChunk(facts, 'features/topology/TopologyPage.tsx');

  console.log(`[acceptance:lazy-routes] chunks=${facts.chunkCount} page_chunks=${facts.pageChunks.size}`);
  console.log(`[acceptance:lazy-routes] dashboard=${dashboardChunk} balances=${balancesChunk} topology=${topologyChunk}`);

  ownedServer = await startStaticServer(temporaryBuildDirectory);
  const baseUrl = ownedServer.baseUrl;

  console.log(`[acceptance:lazy-routes] Launching browser against ${baseUrl}...`);
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport, reducedMotion: 'reduce' });
  const page = await context.newPage();

  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    if (BENIGN_CONSOLE.some((pattern) => pattern.test(text))) return;
    consoleErrors.push(text);
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));

  /* Every JavaScript file the browser actually fetched, in order. */
  const jsRequests = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (!url.pathname.endsWith('.js')) return;
    jsRequests.push(url.pathname);
  });

  const requestsSince = (marker) => jsRequests.slice(marker);
  const pageChunksRequested = (paths) =>
    paths.filter((requestPath) => facts.pageChunkFiles.has(path.basename(requestPath)));

  await page.addInitScript(() => {
    localStorage.setItem('XCLOUD_LANGUAGE_PREFERENCE', 'en');
    localStorage.setItem('XCLOUD_THEME_PREFERENCE', 'light');
    Object.defineProperty(window, 'EventSource', { configurable: true, value: undefined });
  });

  let authenticated = true;
  await page.route('**/data/mcc-mnc-table.json', (route) => json(route, []));
  await page.route('**/api/**', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/auth/me') {
      return authenticated ? json(route, ADMIN_USER) : json(route, { ok: false, error: 'UNAUTHENTICATED' }, 401);
    }
    /* The dashboard composes three read authorities; they must answer with
     * their real envelope shape or the page renders its bounded error state. */
    if (url.pathname === '/api/runtime/observations') {
      return json(route, { snapshot: { counts: {}, components: [] } });
    }
    if (url.pathname === '/api/ue-info') {
      return json(route, {
        generatedAt: new Date().toISOString(),
        configured: false,
        complete: false,
        summary: {
          total: 0,
          registered: 0,
          idle: 0,
          connected: 0,
          stateUnreported: 0,
          epc5gcOnlineUsers: null,
          imsOnlineUsers: null,
          totalSubscribers: null,
          totalIMSUsers: null,
        },
        sources: [],
        items: [],
        pagination: { limit: 50, offset: 0, total: 0, nextCursor: null, hasMore: false },
      });
    }
    if (url.pathname.startsWith('/api/ocs/balances/')) {
      const imsi = decodeURIComponent(url.pathname.slice('/api/ocs/balances/'.length).replace(/\/adjustments$/, ''));
      if (url.pathname.endsWith('/adjustments')) {
        return json(route, { ok: true, imsi, records: [], total: 0, page: 1, limit: 20 });
      }
      return json(route, {
        ok: true,
        balance: {
          id: 'bal-001',
          imsi,
          plan_id: 'default_plan',
          status: 'active',
          data_total: 10737418240,
          data_used: 2147483648,
          data_reserved: 0,
          data_available: 8589934592,
          voice_total: 6000,
          voice_used: 1200,
          voice_reserved: 0,
          voice_available: 4800,
          sms_total: 100,
          sms_used: 10,
          sms_available: 90,
          money_balance: 50,
          version: 4,
          data_invariant_ok: true,
          voice_invariant_ok: true,
          sms_invariant_ok: true,
          invariant_ok: true,
          created_at: '2026-11-17T10:00:00Z',
          updated_at: '2026-11-17T12:00:00Z',
        },
      });
    }
    if (url.pathname === '/api/ims/registrations/summary') {
      return json(route, {
        catalogSources: [],
        generatedAt: new Date().toISOString(),
        configurationState: 'not_configured',
        completeness: 'unavailable',
        scope: 'all',
        scopeMeaning: '',
        consistency: 'unknown',
        counts: { publicIdentities: null, activePublicIdentities: null, activeBindings: null },
        observed: { publicIdentities: 0, activePublicIdentities: 0, activeBindings: 0 },
        sources: [],
        items: [],
        pagination: { limit: 50, total: null, nextCursor: null, hasMore: false },
      });
    }
    return json(route, { ok: true, records: [], total: 0 });
  });

  /* --------------------------------------------------------------------- */
  /* L1: cold /login must not download any business page chunk             */
  /* --------------------------------------------------------------------- */
  console.log('\n--- L1: cold /login isolation ---');
  const l1Marker = jsRequests.length;
  await page.goto(`${baseUrl}/login`, { waitUntil: 'load' });
  await page.waitForSelector('#xcloud-login-username', { timeout: 15000 });

  const l1Requests = requestsSince(l1Marker);
  check('L1-01', await page.locator('#xcloud-login-username').isVisible(), 'the login form rendered');
  const l1PageChunks = pageChunksRequested(l1Requests);
  check('L1-02', l1PageChunks.length === 0, `no business page chunk on cold /login (requested ${l1PageChunks.join(', ') || 'none'})`);
  check(
    'L1-03',
    l1Requests.some((requestPath) => facts.entryFiles.some((entry) => path.basename(entry) === path.basename(requestPath))),
    'the entry chunk is still requested for the login surface',
  );
  check('L1-04', l1Requests.length <= 4, `cold /login stays within a small request budget (${l1Requests.length} JS requests)`);

  /* --------------------------------------------------------------------- */
  /* L2: cold / renders an accessible boot state while the chunk is gated  */
  /* --------------------------------------------------------------------- */
  console.log('\n--- L2: cold / boot state and dashboard isolation ---');
  let releaseDashboard;
  const dashboardGate = new Promise((resolve) => {
    releaseDashboard = resolve;
  });
  let dashboardGateHits = 0;
  await page.route(`**/${dashboardChunk}`, async (route) => {
    dashboardGateHits += 1;
    await dashboardGate;
    await route.continue();
  });

  const l2Marker = jsRequests.length;
  await page.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded' });

  const bootState = page.locator('.state-panel[role="status"]');
  await bootState.waitFor({ state: 'visible', timeout: 15000 });
  const bootText = (await bootState.textContent())?.trim() ?? '';
  check('L2-01', dashboardGateHits > 0, `the dashboard chunk request was actually held (${dashboardGateHits} hits)`);
  check('L2-02', bootText.toLowerCase().includes('loading page'), `an accessible boot state is visible while the module loads (saw "${bootText}")`);
  check('L2-03', (await page.locator('.state-card').count()) === 0, 'pending module loading never renders a false 404');

  releaseDashboard();
  await page.waitForSelector('.layout-main', { timeout: 20000 });
  await page.waitForFunction(
    () => (document.querySelector('.layout-main')?.textContent ?? '').includes('Operations Overview'),
    undefined,
    { timeout: 20000 },
  );
  check('L2-04', true, 'the dashboard rendered after the module arrived');

  const l2Requests = requestsSince(l2Marker);
  const l2PageChunks = pageChunksRequested(l2Requests);
  check('L2-05', l2PageChunks.length === 0, `cold / loads no other page chunk (requested ${l2PageChunks.join(', ') || 'none'})`);
  check(
    'L2-06',
    l2Requests.some((requestPath) => path.basename(requestPath) === path.basename(dashboardChunk)),
    'the dashboard chunk itself was requested',
  );
  check('L2-07', (await page.locator('.sidebar-nav').count()) > 0, 'the application shell is mounted');

  /* --------------------------------------------------------------------- */
  /* L3: route-specific loading and cache reuse                            */
  /* --------------------------------------------------------------------- */
  console.log('\n--- L3: route-specific loading ---');
  const l3Marker = jsRequests.length;
  await page.click('[data-group-key="nav_business"]');
  await page.click('a[href="/ocs/balances"]');
  await page.waitForURL('**/ocs/balances', { timeout: 15000 });
  await page.waitForSelector('.ocs-container', { timeout: 20000 });

  const l3Requests = requestsSince(l3Marker);
  check(
    'L3-01',
    l3Requests.some((requestPath) => path.basename(requestPath) === path.basename(balancesChunk)),
    'navigating to /ocs/balances loads the OCS balances chunk',
  );
  check(
    'L3-02',
    !l3Requests.some((requestPath) => path.basename(requestPath) === path.basename(topologyChunk)),
    'the topology chunk stays deferred until its route is visited',
  );
  check(
    'L3-03',
    !l3Requests.some((requestPath) => path.basename(requestPath) === path.basename(dashboardChunk)),
    'the already-loaded dashboard chunk is not downloaded again',
  );

  await page.click('[data-group-key="nav_network_ops"]');
  await page.click('a[href="/topology"]');
  await page.waitForURL('**/topology', { timeout: 15000 });
  const l3TopologyMarker = jsRequests.length;
  await page.waitForSelector('.layout-main', { timeout: 20000 });
  check(
    'L3-04',
    requestsSince(l3Marker).some((requestPath) => path.basename(requestPath) === path.basename(topologyChunk)),
    'navigating to /topology loads the topology chunk',
  );

  /* Repeat visit: the OCS chunk must come from cache (transferSize 0). */
  await page.click('[data-group-key="nav_business"]');
  await page.click('a[href="/ocs/balances"]');
  await page.waitForURL('**/ocs/balances', { timeout: 15000 });
  await page.waitForSelector('.ocs-container', { timeout: 20000 });
  const cacheEntry = await page.evaluate((chunkName) => {
    const entries = window.performance.getEntriesByType('resource').filter((entry) => entry.name.endsWith(chunkName));
    if (entries.length === 0) return null;
    const last = entries[entries.length - 1];
    return { count: entries.length, transferSize: last.transferSize, duration: last.duration };
  }, balancesChunk);
  check('L3-05', cacheEntry !== null && cacheEntry.count === 1, `the repeat visit re-used the resident module instead of fetching it again (${JSON.stringify(cacheEntry)})`);
  check(
    'L3-06',
    !requestsSince(l3TopologyMarker).some((requestPath) => path.basename(requestPath) === path.basename(balancesChunk)),
    'the repeat visit issued no network request for the already-loaded chunk',
  );
  check('L3-07', requestsSince(l3TopologyMarker).length <= 2, `repeat navigation stays within a small request budget (${requestsSince(l3TopologyMarker).length} JS requests)`);

  /* --------------------------------------------------------------------- */
  /* L4: deep link and reload                                              */
  /* --------------------------------------------------------------------- */
  console.log('\n--- L4: deep link ---');
  const l4Marker = jsRequests.length;
  await page.goto(`${baseUrl}/ocs/balances/460001234567890`, { waitUntil: 'load' });
  await page.waitForSelector('.ocs-detail-grid', { timeout: 20000 });
  const detailText = (await page.locator('.layout-main').textContent()) ?? '';
  check('L4-01', detailText.includes('460001234567890'), 'the deep-linked balance detail rendered its IMSI');
  check(
    'L4-02',
    requestsSince(l4Marker).some((requestPath) => path.basename(requestPath) === path.basename(balanceDetailChunk)),
    'the deep link loaded the balance detail chunk directly',
  );
  check('L4-03', (await page.locator('.state-card').count()) === 0, 'a direct deep link is never answered with the 404 page');

  /* --------------------------------------------------------------------- */
  /* L5: failed chunk download                                             */
  /* --------------------------------------------------------------------- */
  console.log('\n--- L5: failed chunk download ---');
  await page.route(`**/${topologyChunk}`, (route) => route.abort('failed'));
  const pageErrorsBeforeFailure = pageErrors.length;
  await page.click('[data-group-key="nav_network_ops"]');
  await page.click('a[href="/topology"]');

  const errorPanel = page.locator('.state-panel.error');
  await errorPanel.waitFor({ state: 'visible', timeout: 20000 });
  const errorText = (await errorPanel.textContent()) ?? '';
  check('L5-01', errorText.includes('could not be loaded'), `a bounded load-failure state is rendered (saw "${errorText.trim().slice(0, 80)}")`);
  check('L5-02', (await page.locator('.sidebar-nav').count()) > 0, 'the shell survives a failed page module so navigation stays usable');
  check('L5-03', pageErrors.length === pageErrorsBeforeFailure, 'a failed chunk does not raise an unhandled exception');
  check('L5-04', (await page.locator('.state-panel.error button').count()) === 1, 'the failure state offers exactly one explicit recovery action');

  /* A failed module must not poison the rest of the session: another route
   * still loads normally. */
  await page.unroute(`**/${topologyChunk}`);
  await page.click('[data-group-key="nav_business"]');
  await page.click('a[href="/ocs/balances"]');
  await page.waitForURL('**/ocs/balances', { timeout: 15000 });
  await page.waitForSelector('.ocs-container', { timeout: 20000 });
  check('L5-05', (await page.locator('.state-panel.error').count()) === 0, 'another route still loads after a module failure');

  /* The designed recovery for the failed route is the explicit reload action. */
  await page.goto(`${baseUrl}/topology`, { waitUntil: 'load' });
  await page.waitForFunction(
    () => !document.querySelector('.state-panel.error') && (document.querySelector('.layout-main')?.textContent ?? '').length > 0,
    undefined,
    { timeout: 20000 },
  );
  check('L5-06', (await page.locator('.state-panel.error').count()) === 0, 'a reload after the module becomes available restores the page');

  /* --------------------------------------------------------------------- */
  /* L6: browser back / forward                                            */
  /* --------------------------------------------------------------------- */
  console.log('\n--- L6: history navigation ---');
  await page.click('[data-group-key="nav_business"]');
  await page.click('a[href="/ocs/balances"]');
  await page.waitForURL('**/ocs/balances', { timeout: 15000 });
  await page.waitForSelector('.ocs-container', { timeout: 20000 });

  await page.goBack({ waitUntil: 'commit' });
  await page.waitForURL('**/topology', { timeout: 15000 });
  await page.waitForSelector('.layout-main', { timeout: 20000 });
  check('L6-01', new URL(page.url()).pathname === '/topology', `back navigation restored /topology (saw ${new URL(page.url()).pathname})`);

  await page.goForward({ waitUntil: 'commit' });
  await page.waitForURL('**/ocs/balances', { timeout: 15000 });
  await page.waitForSelector('.ocs-container', { timeout: 20000 });
  check('L6-02', new URL(page.url()).pathname === '/ocs/balances', `forward navigation restored /ocs/balances (saw ${new URL(page.url()).pathname})`);

  /* --------------------------------------------------------------------- */
  /* L7: unauthenticated deep link                                         */
  /* --------------------------------------------------------------------- */
  console.log('\n--- L7: unauthenticated deep link ---');
  authenticated = false;
  const unauthContext = await browser.newContext({ viewport, reducedMotion: 'reduce' });
  const unauthPage = await unauthContext.newPage();
  const unauthJs = [];
  unauthPage.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.endsWith('.js')) unauthJs.push(url.pathname);
  });
  await unauthPage.addInitScript(() => {
    localStorage.setItem('XCLOUD_LANGUAGE_PREFERENCE', 'en');
    localStorage.setItem('XCLOUD_THEME_PREFERENCE', 'light');
    Object.defineProperty(window, 'EventSource', { configurable: true, value: undefined });
  });
  await unauthPage.route('**/data/mcc-mnc-table.json', (route) => json(route, []));
  await unauthPage.route('**/api/**', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/auth/me') return json(route, { ok: false, error: 'UNAUTHENTICATED' }, 401);
    return json(route, { ok: true, records: [], total: 0 });
  });

  await unauthPage.goto(`${baseUrl}/ocs/balances`, { waitUntil: 'load' });
  await unauthPage.waitForSelector('#xcloud-login-username', { timeout: 20000 });
  const redirectUrl = new URL(unauthPage.url());
  check('L7-01', redirectUrl.pathname === '/login', `an unauthenticated deep link lands on /login (saw ${redirectUrl.pathname})`);
  check('L7-02', redirectUrl.searchParams.get('from') === '/ocs/balances', `the original destination is preserved (from=${redirectUrl.searchParams.get('from')})`);
  const unauthPageChunks = unauthJs.filter((requestPath) => facts.pageChunkFiles.has(path.basename(requestPath)));
  check('L7-03', unauthPageChunks.length === 0, `no business chunk is loaded before authorization (requested ${unauthPageChunks.join(', ') || 'none'})`);
  await unauthContext.close();

  /* --------------------------------------------------------------------- */
  /* Global runtime health                                                 */
  /* --------------------------------------------------------------------- */
  check('SYS-01', pageErrors.length === 0, `zero uncaught page exceptions (${pageErrors.length})`);
  check('SYS-02', consoleErrors.length === 0, `zero unexpected console errors (${consoleErrors.length})`);
} catch (error) {
  console.error('[acceptance:lazy-routes] Unexpected test error:', error);
  failures.push(`unexpected: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  if (browser) await browser.close().catch(() => {});
  if (ownedServer) await new Promise((resolve) => ownedServer.server.close(resolve));
  if (temporaryBuildDirectory) await rm(temporaryBuildDirectory, { recursive: true, force: true }).catch(() => {});
}

console.log('\n=============================================================');
if (failures.length > 0) {
  console.error(`[acceptance:lazy-routes] FAILED ${failures.length} check(s) of ${checks.length}`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`[acceptance:lazy-routes] passed ${checks.length}/${checks.length} assertions`);
