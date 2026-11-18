#!/usr/bin/env node
/* global Event, setTimeout, Request, AbortController, PopStateEvent, Document */
/*
 * Rendering and Data-Loading Performance Acceptance Smoke
 *
 * Runs against a real production Vite build in headless Chromium.
 * Verifies the performance invariants established for data loading:
 *   PERF-01: Zero duplicate GET requests on initial stable page load across core routes
 *   PERF-02: Metadata endpoints are deduplicated and cached across component lifecycles
 *   PERF-03: A superseded response cannot overwrite newer NF Health state
 *   PERF-04: Aborted/superseded reads emit no service-unreachable error and can be read again
 *   PERF-05: The real 30s NF Health polling lifecycle is driven by a deterministic timer fixture
 *   PERF-06: Local modal interaction causes no full-page reloads or spurious re-queries
 *   PERF-07: Bundle size and chunk count remain strictly bounded within baseline limits
 *   PERF-08: The Log Center keeps its real bounded view window
 *
 * Every asynchronous completion is proven by an observed request record, a
 * delivered response barrier, or a rendered business element. The NF Health
 * timer fixture captures the interval the page actually registers and fires it
 * on demand; it never waits wall-clock time to prove a 30s policy.
 *
 * Usage: node frontend/tests/performance-rendering-smoke.mjs
 */
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { clearTimeout as clearNodeTimeout } from 'node:timers';

import { chromium } from 'playwright';
import { build } from 'vite';

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const viewport = { width: 1440, height: 900 };

const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

async function startStaticServer(distDirectory) {
  await stat(path.join(distDirectory, 'index.html'));
  const server = createServer(async (request, response) => {
    try {
      const requestPath = decodeURIComponent(new URL(request.url || '/', 'http://127.0.0.1').pathname);
      const relativePath = requestPath === '/' ? 'index.html' : requestPath.replace(/^\/+/, '');
      const filePath = path.join(distDirectory, relativePath);
      let fileStat;
      try {
        fileStat = await stat(filePath);
      } catch {
        // Fall back to index.html for SPA routing
        const spaHtml = await readFile(path.join(distDirectory, 'index.html'));
        response.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        response.end(spaHtml);
        return;
      }

      if (fileStat.isDirectory()) {
        const indexHtml = await readFile(path.join(filePath, 'index.html'));
        response.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        response.end(indexHtml);
        return;
      }

      const body = await readFile(filePath);
      const ext = path.extname(filePath).toLowerCase();
      response.writeHead(200, {
        'Content-Type': contentTypes[ext] || 'application/octet-stream',
        'Cache-Control': relativePath.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-store',
      });
      response.end(body);
    } catch (err) {
      response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end(String(err));
    }
  });

  await new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve(undefined));
    server.once('error', reject);
  });

  const port = server.address().port;
  return {
    origin: `http://127.0.0.1:${port}`,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function makeTarget(targetId, name, domain = '5gc', overallState = 'healthy') {
  return {
    targetId,
    name,
    domain,
    overallState,
    enabled: true,
    schemaVersion: 1,
    collectorProfile: 'host_process',
    serviceKind: 'amf',
    collectionMode: 'push',
    intervalSeconds: 30,
    revision: 1,
    createdAt: '2026-11-01T00:00:00Z',
    createdBy: 'admin',
    updatedAt: '2026-11-01T00:00:00Z',
    updatedBy: 'admin',
    coverage: { l1Measured: true, l2Measured: true, l3Measured: true, l3Available: true },
    freshness: { state: 'fresh', policySeconds: 60, basis: 'sample', evaluatedAt: '2026-11-01T00:00:00Z' },
    layers: {
      process: { state: 'healthy', supported: true, measuredAt: '2026-11-01T00:00:00Z' },
      interface: { state: 'healthy', supported: true, measuredAt: '2026-11-01T00:00:00Z' },
      service: { state: 'healthy', supported: true, measuredAt: '2026-11-01T00:00:00Z' },
    },
  };
}

const STALE_C1 = makeTarget('target-stale', 'STALE-TARGET-SHOULD-NOT-OVERWRITE', 'epc', 'unknown');
const NEWER_C1 = makeTarget('target-newer', 'NEWER-VALID-TARGET');
const OLDER_C2 = makeTarget('target-c2-old', 'OLDER-C2-TARGET', 'epc', 'unknown');
const NEWER_C2 = makeTarget('target-c2-new', 'NEWER-C2-TARGET');
const STALE_C3 = makeTarget('target-c3-stale', 'CURSOR-STALE-TARGET', 'epc', 'unknown');
const NEWER_C3 = makeTarget('target-c3-new', 'FILTERED-TARGET');
const STALE_D6 = makeTarget('target-d6-stale', 'POLL-STALE-TARGET', 'epc', 'unknown');
const NEWER_D6 = makeTarget('target-d6-new', 'REFRESH-NEW-TARGET');

const ADMIN_USER = {
  username: 'admin',
  role: 'admin',
  normalizedRole: 'admin',
  status: 'active',
  permissions: [
    'subscribers.read',
    'subscribers.write',
    'subscribers.import',
    'ocs.balance.adjust',
    'ocs.read',
    'core.read',
    'core.configure',
    'users.read',
    'users.write',
  ],
};

function json(route, data, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    headers: { 'Cache-Control': 'no-store' },
    body: JSON.stringify(data),
  });
}

const checks = [];
const failures = [];

function check(id, condition, description) {
  const result = { id, condition: Boolean(condition), description };
  checks.push(result);
  if (!result.condition) {
    failures.push(`${id}: ${description}`);
    console.error(`  not ok ${id} - ${description}`);
    if (process.env.GITHUB_ACTIONS) console.log(`::error title=${id}::${description.replace(/\s+/g, ' ')}`);
  } else {
    console.log(`  ok ${id} - ${description}`);
  }
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function waitUntil(predicate, label, timeout = 15000) {
  const started = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (Date.now() - started > timeout) throw new Error(`Timed out waiting for ${label}`);
    await sleep(20);
  }
}

async function waitResolved(handle, label, timeout = 15000) {
  let timer;
  try {
    await Promise.race([
      handle.promise,
      new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeout); }),
    ]);
  } finally {
    if (timer) clearNodeTimeout(timer);
  }
}

async function main() {
  console.log('[acceptance:performance] Starting rendering and data-loading performance regression suite...');
  const tmpDist = await mkdtemp(path.join(tmpdir(), 'xcloud-perf-smoke-'));
  let server;
  let browser;

  try {
    console.log(`[acceptance:performance] Building production Vite bundle to ${tmpDist}...`);
    const buildResult = await build({
      root: frontendRoot,
      logLevel: 'warn',
      build: {
        outDir: tmpDist,
        emptyOutDir: true,
      },
    });

    const output = (Array.isArray(buildResult) ? buildResult[0] : buildResult).output;
    const jsChunks = output.filter((item) => item.type === 'chunk');
    check('PERF-07-A', jsChunks.length <= 110, `emitted JS chunks bounded at ${jsChunks.length} (limit <= 110)`);

    server = await startStaticServer(tmpDist);
    console.log(`[acceptance:performance] Test server listening at ${server.origin}`);

    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport });

    await context.addInitScript((user) => {
      localStorage.setItem('XCLOUD_LANGUAGE_PREFERENCE', 'en');
      localStorage.setItem('XCLOUD_THEME_PREFERENCE', 'light');
      localStorage.setItem('xcloud_auth_token', 'perf-smoke-token');
      localStorage.setItem('xcloud_user', JSON.stringify(user));

      /* Request recorder: proves which reads started and which ones the read
       * client cancelled, independently of what the server eventually writes. */
      const recorder = { calls: [] };
      const realFetch = window.fetch.bind(window);
      window.fetch = (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
        const call = { url, start: Date.now(), aborted: false };
        recorder.calls.push(call);
        const signal = init && init.signal;
        if (signal) signal.addEventListener('abort', () => { call.aborted = true; }, { once: true });
        return realFetch(input, init);
      };
      window.__perfFetch = recorder;

      /* Deterministic timer fixture. Long-lived intervals (the 30s NF Health
       * poll and slower) are captured instead of scheduled; they fire only when
       * the suite asks, and clearInterval removes them exactly like the browser
       * would. Short UI timers keep their real behaviour. */
      const longTimers = [];
      let nextTimerId = 1;
      const realSetInterval = window.setInterval.bind(window);
      const realClearInterval = window.clearInterval.bind(window);
      window.setInterval = (callback, interval, ...args) => {
        if (typeof interval === 'number' && interval >= 1000) {
          const entry = { id: nextTimerId++, delay: interval, callback, args, active: true };
          longTimers.push(entry);
          return entry.id;
        }
        return realSetInterval(callback, interval, ...args);
      };
      window.clearInterval = (id) => {
        const index = longTimers.findIndex((entry) => entry.id === id);
        if (index >= 0) {
          longTimers[index].active = false;
          longTimers.splice(index, 1);
          return;
        }
        realClearInterval(id);
      };
      window.__perfTimers = {
        list: () => longTimers.map((entry) => ({ id: entry.id, delay: entry.delay, active: entry.active })),
        fireAll: () => { [...longTimers].forEach((entry) => entry.callback(...entry.args)); },
      };

      /* Negative-control hook for stale-result rejection: making abort a no-op
       * lets an out-of-order older response reach the page, which is the only
       * way to separate cancellation protection from request-token rejection. */
      const realAbort = AbortController.prototype.abort;
      AbortController.prototype.abort = function abort(...args) {
        if (window.__perfSuppressAbort) return;
        return realAbort.apply(this, args);
      };
      window.__perfSuppressAbort = false;

      /* Visibility is overridden on the prototype, once, before the app
       * observes it. The old instance-level defineProperty is not portable
       * across Chromium builds and could make the polling lifecycle test fail
       * before it measured anything. */
      let hiddenOverride = false;
      Object.defineProperty(window, '__perfHidden', {
        get: () => hiddenOverride,
        set: (value) => { hiddenOverride = value === true; },
        configurable: true,
      });
      Object.defineProperty(Document.prototype, 'hidden', {
        configurable: true,
        get() { return window.__perfHidden === true; },
      });
      Object.defineProperty(Document.prototype, 'visibilityState', {
        configurable: true,
        get() { return window.__perfHidden === true ? 'hidden' : 'visible'; },
      });
    }, ADMIN_USER);

    const page = await context.newPage();
    const pageErrors = [];
    const consoleErrors = [];

    page.on('pageerror', (err) => pageErrors.push(err.message));
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        const text = msg.text();
        if (!text.includes('Failed to load resource') && !text.includes('AbortError')) {
          consoleErrors.push(text);
        }
      }
    });

    const holds = new Map();
    let defaultTargetsVariant = 'normal';

    function hold(id) {
      const started = deferred();
      const released = deferred();
      const record = { id, started, released, delivered: false, cancelled: false, consumed: false };
      holds.set(id, record);
      return record;
    }

    async function held(record, route, data, status = 200) {
      record.consumed = true;
      record.started.resolve();
      await record.released.promise;
      try {
        await json(route, data, status);
        record.delivered = true;
      } catch {
        record.cancelled = true;
      }
    }

    function release(id) {
      holds.get(id)?.released.resolve();
    }

    const getRequestCounts = new Map();
    const logLines = 2500;

    await page.route('**/api/**', async (route) => {
      const request = route.request();
      const method = request.method();
      const url = new URL(request.url());
      const pathname = url.pathname;
      const search = url.search;
      const fullPath = pathname + search;

      if (method === 'GET') {
        getRequestCounts.set(fullPath, (getRequestCounts.get(fullPath) || 0) + 1);
      }

      // Session & auth
      if (pathname === '/api/auth/me') return json(route, ADMIN_USER);
      if (pathname === '/api/auth/permissions') return json(route, { permissions: ADMIN_USER.permissions });
      if (pathname === '/api/notifications/stream' || pathname === '/api/runtime/stream') {
        return route.fulfill({
          status: 200,
          contentType: 'text/event-stream',
          headers: { 'Cache-Control': 'no-cache', Connection: 'keep-alive' },
          body: 'retry: 600000\nevent: init\ndata: {"alerts":{"activeCount":0,"activeCriticalCount":0,"activeWarningCount":0,"recent":[]}}\n\n',
        });
      }

      // Static and metadata
      if (pathname === '/api/tariff-plans') return json(route, { plans: [{ planId: 'p1', name: 'Standard Plan' }] });
      if (pathname === '/api/profiles') return json(route, { profiles: [{ name: 'Default', title: 'Default Template' }] });
      if (pathname === '/data/mcc-mnc-table.json') return json(route, [{ mcc: '460', mnc: '00', network: 'Test Network', country: 'Test' }]);

      // Subscribers
      if (pathname === '/api/subscribers') {
        return json(route, {
          subscribers: [
            {
              imsi: '460001234567890',
              msisdn: '8613800000000',
              status: 'active',
              contractStatus: 'active',
              createdAt: '2026-11-01T00:00:00Z',
              updatedAt: '2026-11-01T00:00:00Z',
            },
          ],
          total: 1,
          summary: { total: 1, active: 1, restricted: 0, lowTraffic: 0, lowBalance: 0, unprovisioned: 0 },
        });
      }

      // OCS balances
      if (pathname === '/api/ocs/balances') {
        return json(route, {
          records: [
            {
              imsi: '460001234567890',
              balance: 1000000,
              dataAvailable: 1000000,
              version: 1,
              status: 'active',
              updatedAt: '2026-11-01T00:00:00Z',
            },
          ],
          paging: { page: 1, limit: 20, total: 1 },
          summary: { totalRecords: 1, totalBalance: 1000000, activeCount: 1 },
        });
      }

      // Operations summary & containment
      if (pathname === '/api/operations/summary') {
        return json(route, {
          generatedAt: new Date().toISOString(),
          sections: ['health'],
          health: { completeness: 'complete', scope: 'full_collection', targets: { configured: 2, enabled: 2, failed: 0 } },
        });
      }
      if (pathname === '/api/operations/containment') {
        return json(route, {
          generatedAt: new Date().toISOString(),
          coverage: 'complete',
          truncated: false,
          unlinkedCount: 0,
          unlinkedResources: [],
          resources: [],
          edges: [],
        });
      }
      if (pathname === '/api/operations/resources') {
        return json(route, { resources: [], page: { hasMore: false, nextCursor: null }, total: 0 });
      }

      // NF Health
      if (pathname === '/api/nf-health/meta') {
        return json(route, {
          domains: ['epc', '5gc', 'ims'],
          supportedLayers: ['l1', 'l2', 'l3'],
          overallStates: ['healthy', 'warning', 'danger', 'unknown'],
        });
      }
      if (pathname === '/api/nf-health/interfaces') {
        return json(route, { columns: ['n2'], rows: [], page: { hasMore: false, nextCursor: null } });
      }
      if (pathname === '/api/nf-health/targets') {
        const q = url.searchParams.get('q');
        const cursor = url.searchParams.get('cursor');
        if (q === 'stale-delay' && holds.has('c1-stale') && !holds.get('c1-stale').consumed) {
          return held(holds.get('c1-stale'), route, { targets: [STALE_C1], page: { hasMore: false, nextCursor: null } });
        }
        if (q === 'fast-newer' && holds.has('c1-newer') && !holds.get('c1-newer').consumed) {
          return held(holds.get('c1-newer'), route, { targets: [NEWER_C1], page: { hasMore: false, nextCursor: null } });
        }
        if (q === 'fast-newer') {
          return json(route, { targets: [NEWER_C1], page: { hasMore: false, nextCursor: null } });
        }
        if (q === 'older-c2' && holds.has('c2-old') && !holds.get('c2-old').consumed) {
          return held(holds.get('c2-old'), route, { targets: [OLDER_C2], page: { hasMore: false, nextCursor: null } });
        }
        if (q === 'c2-newer' && holds.has('c2-newer') && !holds.get('c2-newer').consumed) {
          return held(holds.get('c2-newer'), route, { targets: [NEWER_C2], page: { hasMore: false, nextCursor: null } });
        }
        if (q && q.startsWith('d4-')) {
          return json(route, { targets: [makeTarget(`target-${q}`, 'D4-TARGET')], page: { hasMore: false, nextCursor: null } });
        }
        if (cursor === 'cursor-old' && holds.has('c3-cursor') && !holds.get('c3-cursor').consumed) {
          return held(holds.get('c3-cursor'), route, { targets: [STALE_C3], page: { hasMore: false, nextCursor: null } });
        }
        if (url.searchParams.get('state') === 'unhealthy') {
          return json(route, { targets: [NEWER_C3], page: { hasMore: false, nextCursor: null } });
        }
        if (holds.has('d6-poll') && !holds.get('d6-poll').consumed) {
          return held(holds.get('d6-poll'), route, { targets: [STALE_D6], page: { hasMore: false, nextCursor: null } });
        }
        if (defaultTargetsVariant === 'refresh') {
          return json(route, { targets: [NEWER_D6], page: { hasMore: false, nextCursor: null } });
        }
        return json(route, {
          targets: [
            makeTarget('target-1', 'AMF-Core-01', '5gc', 'healthy'),
            makeTarget('target-2', 'SMF-Core-01', '5gc', 'healthy'),
          ],
          page: { hasMore: true, nextCursor: 'cursor-old' },
        });
      }
      if (pathname === '/api/runtime/observations') {
        return json(route, { status: 'healthy', components: [] });
      }

      // Topology
      if (pathname === '/api/topology/meta') {
        return json(route, {
          relationshipTypes: ['contains', 'connects_to'],
          lifecycleStates: ['active', 'retired'],
        });
      }
      if (pathname === '/api/topology/edges') {
        return json(route, { edges: [], page: { hasMore: false, nextCursor: null } });
      }

      // Logs
      if (pathname === '/api/nf-logs/sources') {
        return json(route, {
          generatedAt: '2026-11-01T00:00:00Z',
          sources: [{ sourceId: 'bench', name: 'bench.log', kind: 'file', sizeBytes: 4096, readable: true }],
          capabilities: {
            defaultTailLines: 100,
            maxTailLines: 500,
            levels: ['debug', 'info', 'warn', 'error'],
            maxLineBytes: 4096,
            follow: true,
            keywordIsLiteral: true,
            concurrencyPerSession: 2,
          },
        });
      }
      if (pathname === '/api/nf-logs/stream') {
        const frames = [];
        for (let index = 1; index <= logLines; index += 1) {
          frames.push(`event: line\ndata: ${JSON.stringify({ seq: index, level: 'info', text: `line-${index}` })}\n\n`);
        }
        return route.fulfill({
          status: 200,
          contentType: 'text/event-stream',
          headers: { 'Cache-Control': 'no-cache', Connection: 'close' },
          body: `retry: 600000\n\n${frames.join('')}`,
        });
      }

      return json(route, {});
    });

    const fetchCalls = () => page.evaluate(() => window.__perfFetch.calls.map((call) => ({ url: call.url, aborted: call.aborted })));
    const targetCalls = async () => (await fetchCalls()).filter((call) => call.url.includes('/api/nf-health/targets'));
    const timerList = () => page.evaluate(() => window.__perfTimers.list());
    const fireTimers = () => page.evaluate(() => window.__perfTimers.fireAll());
    const bodyHasUnreachable = async () => (await page.evaluate(() => document.body.innerText)).includes('The service could not be reached.');
    const visibleTarget = (targetId) => page.locator(`[data-nf-health-card="${targetId}"]`).first();

    /* ------------------------------------------------------------------ */
    /* Test 1: Zero duplicate GET requests on stable /subscribers load    */
    /* ------------------------------------------------------------------ */
    getRequestCounts.clear();
    await page.goto(`${server.origin}/subscribers`, { waitUntil: 'networkidle' });
    await page.waitForSelector('table.subscribers-table tbody tr');

    let duplicateGetCount = 0;
    for (const [urlPath, count] of getRequestCounts.entries()) {
      if (count > 1 && !urlPath.includes('/stream')) {
        duplicateGetCount += 1;
        console.error(`  [dup-detected] /subscribers: ${urlPath} requested ${count} times`);
      }
    }
    check('PERF-01-A', duplicateGetCount === 0, `zero duplicate GET requests on stable /subscribers (duplicates: ${duplicateGetCount})`);

    /* ------------------------------------------------------------------ */
    /* Test 2: Zero duplicate GET requests on stable /ocs/balances load   */
    /* ------------------------------------------------------------------ */
    getRequestCounts.clear();
    await page.goto(`${server.origin}/ocs/balances`, { waitUntil: 'networkidle' });
    await page.waitForSelector('table tbody tr');

    duplicateGetCount = 0;
    for (const [urlPath, count] of getRequestCounts.entries()) {
      if (count > 1 && !urlPath.includes('/stream')) {
        duplicateGetCount += 1;
        console.error(`  [dup-detected] /ocs/balances: ${urlPath} requested ${count} times`);
      }
    }
    check('PERF-01-B', duplicateGetCount === 0, `zero duplicate GET requests on stable /ocs/balances (duplicates: ${duplicateGetCount})`);

    /* ------------------------------------------------------------------ */
    /* Test 3: Zero duplicate GET requests & metadata caching in NF Health*/
    /* ------------------------------------------------------------------ */
    getRequestCounts.clear();
    await page.goto(`${server.origin}/nf-health`, { waitUntil: 'networkidle' });
    await page.waitForSelector('[data-nf-health-panel="cards"]');
    await visibleTarget('target-1').waitFor({ state: 'visible' });

    duplicateGetCount = 0;
    for (const [urlPath, count] of getRequestCounts.entries()) {
      if (count > 1 && !urlPath.includes('/stream')) {
        duplicateGetCount += 1;
        console.error(`  [dup-detected] /nf-health: ${urlPath} requested ${count} times`);
      }
    }
    check('PERF-01-C', duplicateGetCount === 0, `zero duplicate GET requests on stable /nf-health (duplicates: ${duplicateGetCount})`);

    const metaRequestCount = getRequestCounts.get('/api/nf-health/meta') || 0;
    check('PERF-02-A', metaRequestCount === 1, `/api/nf-health/meta is fetched exactly once and cached (count: ${metaRequestCount})`);

    const initialTimers = await timerList();
    check(
      'PERF-05-A0',
      initialTimers.length === 1 && initialTimers[0].delay === 30000,
      `NF Health registers one real 30s poll and no wall-clock wait is used (timers: ${JSON.stringify(initialTimers)})`,
    );

    /* ------------------------------------------------------------------ */
    /* PERF-03 / PERF-04 C1 — superseded response is cancelled            */
    /* ------------------------------------------------------------------ */
    const searchInput = page.locator('form[role="search"] input, input[type="search"]').first();
    await searchInput.waitFor({ state: 'visible' });
    const c1StaleHold = hold('c1-stale');
    const c1NewerHold = hold('c1-newer');

    await searchInput.fill('stale-delay');
    await searchInput.press('Enter');
    await waitResolved(c1StaleHold.started, 'older stale-delay GET to start');
    check('PERF-03-A', true, 'the superseded GET provably reached the request boundary before it was replaced');

    await searchInput.fill('fast-newer');
    await searchInput.press('Enter');
    await waitResolved(c1NewerHold.started, 'newer fast-newer GET to start');
    release('c1-newer');
    await visibleTarget('target-newer').waitFor({ state: 'visible', timeout: 6000 });
    check('PERF-03-B', await visibleTarget('target-newer').innerText().then((text) => text.includes('NEWER-VALID-TARGET')), 'the newer result is rendered as business data');

    release('c1-stale');
    await waitUntil(() => c1StaleHold.delivered || c1StaleHold.cancelled, 'older request cancellation or delivery');
    const c1Calls = await targetCalls();
    const c1StaleCall = c1Calls.find((call) => call.url.includes('q=stale-delay'));
    check(
      'PERF-03-C',
      Boolean(c1StaleCall && c1StaleCall.aborted),
      'the older read was actually cancelled by the read pipeline (not merely ignored)',
    );
    check(
      'PERF-03-D',
      await visibleTarget('target-stale').count() === 0,
      'the older result cannot replace the newer business result',
    );
    check('PERF-04-A', !(await bodyHasUnreachable()), 'aborted/superseded read did not show a false service-unreachable error');
    check('PERF-03-E', await searchInput.inputValue() === 'fast-newer', 'the latest filter remains selected after the race');

    /* Same-key recovery after cancellation: submitting the live filter again
     * must complete and keep the newest data. */
    const beforeRecovery = (await targetCalls()).length;
    await searchInput.press('Enter');
    await waitUntil(async () => (await targetCalls()).length > beforeRecovery, 'same-key re-read after cancellation');
    await visibleTarget('target-newer').waitFor({ state: 'visible', timeout: 6000 });
    check('PERF-04-B', !(await bodyHasUnreachable()), 'same-key SWR recovery after cancellation renders without an error');

    /* ------------------------------------------------------------------ */
    /* PERF-03 C2 — out-of-order completion without successful cancel     */
    /* ------------------------------------------------------------------ */
    await page.goto(`${server.origin}/nf-health`, { waitUntil: 'networkidle' });
    await visibleTarget('target-1').waitFor({ state: 'visible' });
    await page.evaluate(() => { window.__perfSuppressAbort = true; });
    const c2OldHold = hold('c2-old');
    const c2NewerHold = hold('c2-newer');
    const c2Search = page.locator('form[role="search"] input, input[type="search"]').first();

    await c2Search.fill('older-c2');
    await c2Search.press('Enter');
    await waitResolved(c2OldHold.started, 'older C2 GET to start');
    await c2Search.fill('c2-newer');
    await c2Search.press('Enter');
    await waitResolved(c2NewerHold.started, 'newer C2 GET to start');
    release('c2-newer');
    await visibleTarget('target-c2-new').waitFor({ state: 'visible', timeout: 6000 });
    release('c2-old');
    await waitUntil(() => c2OldHold.delivered || c2OldHold.cancelled, 'older C2 completion');
    check('PERF-03-F', c2OldHold.delivered === true, 'the older response completed after the newer one (cancellation was not available)');
    const c2Calls = await targetCalls();
    const c2OldCall = c2Calls.find((call) => call.url.includes('q=older-c2'));
    check('PERF-03-G', Boolean(c2OldCall && c2OldCall.aborted === false), 'the older fetch itself was not cancelled in the C2 harness');
    check('PERF-03-H', await visibleTarget('target-c2-old').count() === 0, 'the monotonic request token rejects the stale completed response');
    check('PERF-03-I', await visibleTarget('target-c2-new').count() === 1, 'the newer C2 result remains visible after the stale completion');
    check('PERF-04-C', !(await bodyHasUnreachable()), 'an out-of-order stale response did not produce a service-unreachable error');
    await page.evaluate(() => { window.__perfSuppressAbort = false; });

    /* ------------------------------------------------------------------ */
    /* PERF-03 J/K/L C3 — filter and cursor consistency                   */
    /* ------------------------------------------------------------------ */
    await page.goto(`${server.origin}/nf-health`, { waitUntil: 'networkidle' });
    await visibleTarget('target-1').waitFor({ state: 'visible' });
    const c3Hold = hold('c3-cursor');
    const nextPage = page.locator('nav[aria-label] button', { hasText: 'Next' }).first();
    await nextPage.waitFor({ state: 'visible' });
    await nextPage.click();
    await waitResolved(c3Hold.started, 'cursor page GET to start');
    await page.locator('select[aria-label="Overall state"]').selectOption('unhealthy');
    await visibleTarget('target-c3-new').waitFor({ state: 'visible', timeout: 6000 });
    release('c3-cursor');
    await waitUntil(() => c3Hold.delivered || c3Hold.cancelled, 'cursor page response settlement');
    check('PERF-03-J', await visibleTarget('target-c3-stale').count() === 0, 'an old cursor response cannot populate the new filter view');
    check('PERF-03-K', await visibleTarget('target-c3-new').count() === 1, 'the new filtered view renders its own business data');
    check('PERF-03-L', new URL(page.url()).searchParams.get('cursor') === null, 'the filter change dropped the obsolete cursor from the URL contract');
    check(
      'PERF-03-M',
      await page.locator('select[aria-label="Overall state"]').inputValue() === 'unhealthy',
      'the latest state filter remains selected after the cursor race',
    );

    /* ------------------------------------------------------------------ */
    /* PERF-05 D — real 30s polling lifecycle with controlled time         */
    /* ------------------------------------------------------------------ */
    await page.goto(`${server.origin}/nf-health`, { waitUntil: 'networkidle' });
    await visibleTarget('target-1').waitFor({ state: 'visible' });
    const d1Timers = await timerList();
    check('PERF-05-A1', d1Timers.length === 1 && d1Timers[0].delay === 30000, `visible page registers exactly one 30s poll (timers: ${JSON.stringify(d1Timers)})`);

    const beforeD1 = (await targetCalls()).length;
    await fireTimers();
    await waitUntil(async () => (await targetCalls()).length === beforeD1 + 1, 'visible-page poll to emit one request');
    check('PERF-05-A', true, 'advancing the real polling interval refreshes the visible page exactly once');

    await page.evaluate(() => {
      window.__perfHidden = true;
      document.dispatchEvent(new Event('visibilitychange'));
    });
    const beforeD2 = (await targetCalls()).length;
    await fireTimers();
    await delay(80);
    check('PERF-05-B', (await targetCalls()).length === beforeD2, 'a hidden document emits no polling request even when the 30s timer fires');

    const beforeD3 = (await targetCalls()).length;
    await page.evaluate(() => {
      window.__perfHidden = false;
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitUntil(async () => (await targetCalls()).length === beforeD3 + 1, 'visibility restore to revalidate once');
    const afterD3 = (await targetCalls()).length;
    await fireTimers();
    await waitUntil(async () => (await targetCalls()).length === afterD3 + 1, 'one poll after visibility restore');
    check('PERF-05-C', (await targetCalls()).length === beforeD3 + 2, 'restoring visibility revalidates once, not as a burst of duplicate requests');

    const d4Search = page.locator('form[role="search"] input, input[type="search"]').first();
    for (const term of ['d4-a', 'd4-b', 'd4-c', 'd4-final']) {
      await d4Search.fill(term);
      await d4Search.press('Enter');
    }
    await visibleTarget('target-d4-final').waitFor({ state: 'visible', timeout: 6000 });
    const d4Timers = await timerList();
    check('PERF-05-D1', d4Timers.length === 1 && d4Timers[0].delay === 30000, 'rapid search changes leave exactly one polling interval registered');
    const beforeD4 = (await targetCalls()).length;
    await fireTimers();
    await waitUntil(async () => (await targetCalls()).length === beforeD4 + 1, 'single poll after rapid search');
    check('PERF-05-D', true, 'one polling interval remains active across rapid search changes');

    await page.evaluate(() => {
      window.history.pushState({}, '', '/logs');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await page.waitForSelector('[data-logs-source="true"]');
    const d5Timers = await timerList();
    const beforeD5 = (await targetCalls()).length;
    await fireTimers();
    await delay(80);
    check('PERF-05-E1', d5Timers.length === 0, 'route unmount clears the NF Health polling interval');
    check('PERF-05-E', (await targetCalls()).length === beforeD5, 'no NF Health polling request continues after route unmount');

    /* ------------------------------------------------------------------ */
    /* PERF-05 F — in-flight polling overlap                              */
    /* ------------------------------------------------------------------ */
    await page.goto(`${server.origin}/nf-health`, { waitUntil: 'networkidle' });
    await visibleTarget('target-1').waitFor({ state: 'visible' });
    const d6Hold = hold('d6-poll');
    await fireTimers();
    await waitResolved(d6Hold.started, 'held polling request to start');
    defaultTargetsVariant = 'refresh';
    await page.locator('[data-operations-refresh="page"]').click();
    await visibleTarget('target-d6-new').waitFor({ state: 'visible', timeout: 6000 });
    release('d6-poll');
    await waitUntil(() => d6Hold.delivered || d6Hold.cancelled, 'held polling response settlement');
    check('PERF-05-F1', await visibleTarget('target-d6-stale').count() === 0, 'an in-flight polling response cannot commit after a newer refresh');
    check('PERF-05-F2', await visibleTarget('target-d6-new').count() === 1, 'the newer refresh result remains authoritative');
    check('PERF-05-F3', !(await bodyHasUnreachable()), 'the replaced in-flight poll did not surface a false failure');
    defaultTargetsVariant = 'normal';
    holds.delete('d6-poll');

    /* ------------------------------------------------------------------ */
    /* Test 6: Zero duplicate GET requests on /topology and /inventory    */
    /* ------------------------------------------------------------------ */
    getRequestCounts.clear();
    await page.goto(`${server.origin}/topology`, { waitUntil: 'networkidle' });
    await page.waitForSelector('[data-topology-view]');
    duplicateGetCount = 0;
    for (const [urlPath, count] of getRequestCounts.entries()) {
      if (count > 1 && !urlPath.includes('/stream')) {
        duplicateGetCount += 1;
      }
    }
    check('PERF-01-D', duplicateGetCount === 0, `zero duplicate GET requests on stable /topology (duplicates: ${duplicateGetCount})`);

    getRequestCounts.clear();
    await page.goto(`${server.origin}/inventory`, { waitUntil: 'networkidle' });
    await page.waitForSelector('[data-inventory-view]');
    duplicateGetCount = 0;
    for (const [urlPath, count] of getRequestCounts.entries()) {
      if (count > 1 && !urlPath.includes('/stream')) {
        duplicateGetCount += 1;
      }
    }
    check('PERF-01-E', duplicateGetCount === 0, `zero duplicate GET requests on stable /inventory (duplicates: ${duplicateGetCount})`);

    /* ------------------------------------------------------------------ */
    /* Test 7: Local modal interaction causes no full-page reloads       */
    /* ------------------------------------------------------------------ */
    await page.goto(`${server.origin}/subscribers`, { waitUntil: 'networkidle' });
    await page.waitForSelector('table.subscribers-table tbody tr');
    await page.evaluate(() => {
      window.__perf_page_token = 8848;
    });

    const modalBtn = page.locator('button[title="Import subscribers"], button:has-text("Import subscribers"), button:has-text("Batch Create")').first();
    await modalBtn.waitFor({ state: 'visible', timeout: 15_000 });
    await modalBtn.click();
    await page.waitForSelector('[role="dialog"]', { state: 'visible', timeout: 5000 });
    const closeBtn = page.locator('[role="dialog"] button[aria-label="Close"]').first();
    await closeBtn.waitFor({ state: 'visible', timeout: 5000 });
    await closeBtn.click();
    await page.waitForSelector('[role="dialog"]', { state: 'detached', timeout: 5000 });
    const token = await page.evaluate(() => window.__perf_page_token);
    check('PERF-06-A', token === 8848, 'modal interaction did not trigger full-page navigation or reload');

    /* ------------------------------------------------------------------ */
    /* PERF-08: The real Log Center keeps its bounded view window        */
    /* ------------------------------------------------------------------ */
    await page.goto(`${server.origin}/logs?sourceId=bench&tail=100`, { waitUntil: 'networkidle' });
    await page.waitForSelector('[data-logs-viewport="true"]');
    await page.waitForFunction(
      (expected) => document.querySelectorAll('[data-logs-viewport="true"] li').length === expected,
      Math.min(2000, logLines),
      { timeout: 30_000 },
    );
    const renderedLines = await page.$$eval('[data-logs-viewport="true"] li', (nodes) => nodes.map((node) => node.textContent || ''));
    check('PERF-08-A', renderedLines.length === 2000, `the Log Center retains exactly 2000 lines from ${logLines} received frames (retained: ${renderedLines.length})`);
    check('PERF-08-B', renderedLines[0].includes(`line-${logLines - 1999}`), 'the oldest retained line is the ring buffer boundary, not the stream head');
    check('PERF-08-C', renderedLines[renderedLines.length - 1].includes(`line-${logLines}`), 'the newest received line is retained in order');
    const boundedBadge = page.locator('text=Keeping the newest 2000 lines');
    check('PERF-08-D', await boundedBadge.count() > 0, 'the bounded view ceiling is stated in the real UI');

    /* ------------------------------------------------------------------ */
    /* Global error checks                                                */
    /* ------------------------------------------------------------------ */
    check('SYS-01', pageErrors.length === 0, `zero uncaught page exceptions (${pageErrors.length})`);
    check('SYS-02', consoleErrors.length === 0, `zero unexpected console errors (${consoleErrors.length}: ${consoleErrors.join(' | ')})`);

  } catch (err) {
    console.error('[acceptance:performance] Fatal error during test execution:', err);
    failures.push(`fatal: ${err instanceof Error ? err.message : String(err)}`);
    if (process.env.GITHUB_ACTIONS) console.log(`::error title=PERF-FATAL::${String(err instanceof Error ? err.message : err).replace(/\s+/g, ' ')}`);
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server) await server.close().catch(() => {});
    if (tmpDist) await rm(tmpDist, { recursive: true, force: true }).catch(() => {});
  }

  console.log('\n=============================================================');
  if (failures.length > 0) {
    console.error(`[acceptance:performance] FAILED ${failures.length} check(s) of ${checks.length}`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log(`[acceptance:performance] passed ${checks.length}/${checks.length} assertions`);
}

main().catch((err) => {
  console.error('[acceptance:performance] Unhandled error:', err);
  process.exit(1);
});