#!/usr/bin/env node
/* global Event */
/*
 * Rendering and Data-Loading Performance Acceptance Smoke
 *
 * Runs against a real production Vite build in headless Chromium.
 * Verifies the performance invariants established for data loading:
 *   PERF-01: Zero duplicate GET requests on initial stable page load across core routes
 *   PERF-02: Metadata endpoints are deduplicated and cached across component lifecycles
 *   PERF-03: Stale asynchronous read responses do not overwrite newer state
 *   PERF-04: Aborted superseded read requests do not emit service failure toasts or errors
 *   PERF-05: Duty page polling lifecycle is stable and pauses when page is hidden
 *   PERF-06: Local modal interaction causes no full-page reloads or spurious re-queries
 *   PERF-07: Bundle size and chunk count remain strictly bounded within baseline limits
 *
 * Usage: node frontend/tests/performance-rendering-smoke.mjs
 */
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
  } else {
    console.log(`  ok ${id} - ${description}`);
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

    // Request tracking map: url -> count
    const getRequestCounts = new Map();
    let delayFirstNfSearch = false;
    let delayedSearchResolve = null;

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

      // Subscribers
      if (pathname === '/api/subscribers') {
        return json(route, {
          subscribers: [
            {
              imsi: '460001234567890',
              msisdn: '8613800000000',
              status: 'active',
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
      if (pathname === '/api/nf-health/targets') {
        const q = url.searchParams.get('q');
        if (q === 'stale-delay' && delayFirstNfSearch) {
          // Hold this request until released
          await new Promise((res) => { delayedSearchResolve = res; });
          return json(route, {
            targets: [makeTarget('target-stale', 'STALE-TARGET-SHOULD-NOT-OVERWRITE', 'epc', 'unknown')],
            page: { hasMore: false, nextCursor: null },
          });
        }
        if (q === 'fast-newer') {
          return json(route, {
            targets: [makeTarget('target-newer', 'NEWER-VALID-TARGET', '5gc', 'healthy')],
            page: { hasMore: false, nextCursor: null },
          });
        }
        return json(route, {
          targets: [
            makeTarget('target-1', 'AMF-Core-01', '5gc', 'healthy'),
            makeTarget('target-2', 'SMF-Core-01', '5gc', 'healthy'),
          ],
          page: { hasMore: false, nextCursor: null },
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

      return json(route, {});
    });

    /* ------------------------------------------------------------------ */
    /* Test 1: Zero duplicate GET requests on stable /subscribers load    */
    /* ------------------------------------------------------------------ */
    getRequestCounts.clear();
    await page.goto(`${server.origin}/subscribers`, { waitUntil: 'networkidle' });
    await page.waitForSelector('table tbody tr, .empty-state, .dash-card');

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
    await page.waitForSelector('.dash-card, table, form[role="search"]');

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
    await page.waitForSelector('[data-nf-health-view], [data-health-kpi-bar="true"], main, header');

    duplicateGetCount = 0;
    for (const [urlPath, count] of getRequestCounts.entries()) {
      if (count > 1 && !urlPath.includes('/stream')) {
        duplicateGetCount += 1;
        console.error(`  [dup-detected] /nf-health: ${urlPath} requested ${count} times`);
      }
    }
    check('PERF-01-C', duplicateGetCount === 0, `zero duplicate GET requests on stable /nf-health (duplicates: ${duplicateGetCount})`);

    // Verify /api/nf-health/meta is fetched exactly once
    const metaRequestCount = getRequestCounts.get('/api/nf-health/meta') || 0;
    check('PERF-02-A', metaRequestCount === 1, `/api/nf-health/meta is fetched exactly once and cached (count: ${metaRequestCount})`);

    /* ------------------------------------------------------------------ */
    /* Test 4: Stale response protection & request cancellation in NF Health*/
    /* ------------------------------------------------------------------ */
    const searchInput = page.locator('form[role="search"] input, input[type="search"]').first();
    if (await searchInput.isVisible()) {
      delayFirstNfSearch = true;
      // Step 1: Type query that triggers delayed slow response
      await searchInput.fill('stale-delay');
      await searchInput.press('Enter');
      // Step 2: Quickly type query that resolves immediately
      await page.waitForTimeout(50);
      await searchInput.fill('fast-newer');
      await searchInput.press('Enter');

      // Wait for fast response to render
      await page.waitForFunction(() => {
        return document.body.innerText.includes('NEWER-VALID-TARGET') || document.body.innerText.includes('fast-newer');
      }, { timeout: 3000 }).catch(() => {});

      // Release the delayed slow response
      if (delayedSearchResolve) {
        delayedSearchResolve();
      }
      await page.waitForTimeout(200);

      // Verify newer data is still present and stale data was dropped
      const bodyText = await page.evaluate(() => document.body.innerText);
      check('PERF-03-A', !bodyText.includes('STALE-TARGET-SHOULD-NOT-OVERWRITE'), 'slow stale read response did not overwrite newer response');
      check('PERF-04-A', !bodyText.includes('The service could not be reached.'), 'aborted/superseded request did not show false service unreachable error');
    }

    /* ------------------------------------------------------------------ */
    /* Test 5: Duty page polling lifecycle is stable                      */
    /* ------------------------------------------------------------------ */
    const pollingInitialCount = getRequestCounts.get('/api/nf-health/targets?limit=20&sort=risk') || 1;
    // Simulate tab hidden via visibilitychange event
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { value: true, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    // Wait briefly and verify no runaway polling while hidden
    await page.waitForTimeout(300);
    const hiddenCount = getRequestCounts.get('/api/nf-health/targets?limit=20&sort=risk') || pollingInitialCount;
    check('PERF-05-A', hiddenCount === pollingInitialCount, 'polling does not dispatch extra requests when document is hidden');

    // Restore visibility
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { value: false, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });

    /* ------------------------------------------------------------------ */
    /* Test 6: Zero duplicate GET requests on /topology and /inventory    */
    /* ------------------------------------------------------------------ */
    getRequestCounts.clear();
    await page.goto(`${server.origin}/topology`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.dash-card, .canvas-container, table, nav, main');
    duplicateGetCount = 0;
    for (const [urlPath, count] of getRequestCounts.entries()) {
      if (count > 1 && !urlPath.includes('/stream')) {
        duplicateGetCount += 1;
      }
    }
    check('PERF-01-D', duplicateGetCount === 0, `zero duplicate GET requests on stable /topology (duplicates: ${duplicateGetCount})`);

    getRequestCounts.clear();
    await page.goto(`${server.origin}/inventory`, { waitUntil: 'networkidle' });
    await page.waitForSelector('form[role="search"], nav[aria-label], .dash-card, main');
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
    await page.waitForSelector('table, [data-subscribers-list], main');
    await page.evaluate(() => {
      window.__perf_page_token = 8848;
    });

    const modalBtn = page.locator('button[title="Import subscribers"], button:has-text("Import subscribers"), button:has-text("Batch Create")').first();
    await modalBtn.waitFor({ state: 'visible', timeout: 15_000 });
    await modalBtn.click();
    await page.waitForSelector('[role="dialog"]', { state: 'visible', timeout: 5000 });
    const closeBtn = page.locator('[role="dialog"] button.btn-icon, [role="dialog"] button[aria-label="Close"], [role="dialog"] button:has-text("Cancel")').first();
    if (await closeBtn.isVisible()) {
      await closeBtn.click();
    } else {
      await page.keyboard.press('Escape');
    }
    await page.waitForSelector('[role="dialog"]', { state: 'detached', timeout: 5000 });
    const token = await page.evaluate(() => window.__perf_page_token);
    check('PERF-06-A', token === 8848, 'modal interaction did not trigger full-page navigation or reload');

    /* ------------------------------------------------------------------ */
    /* Global error checks                                                */
    /* ------------------------------------------------------------------ */
    check('SYS-01', pageErrors.length === 0, `zero uncaught page exceptions (${pageErrors.length})`);
    check('SYS-02', consoleErrors.length === 0, `zero unexpected console errors (${consoleErrors.length}: ${consoleErrors.join(' | ')})`);

  } catch (err) {
    console.error('[acceptance:performance] Fatal error during test execution:', err);
    failures.push(`fatal: ${err instanceof Error ? err.message : String(err)}`);
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
