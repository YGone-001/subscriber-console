#!/usr/bin/env node
/*
 * OCS Balance Adjustment Interaction Acceptance Smoke Test.
 *
 * Verifies the asynchronous mutation lifecycle of governed balance adjustments:
 *   1. Normal editing, review projection, zero mutations before confirmation,
 *      exact BigInt canonical delta and version sent in POST, and page update.
 *   2. Synchronous submission latch: in-flight double-submission prevention,
 *      disabled controls and overlays while pending.
 *   3. CAS precondition conflict recovery: 412 permanently disables confirm,
 *      stale read defense blocks re-review, fresh read unlocks editing with updated version.
 *   4. Uncertain outcome reconciliation: detail page refreshes balance & history,
 *      list page provides link to detail and list refresh without false claims.
 *   5. Keyboard accessibility: modal dialog role, focus trap, and focus restoration.
 *
 * Usage: node frontend/tests/ocs-balance-interaction-smoke.mjs
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
      const candidate = path.resolve(distDirectory, relativePath);
      const safeCandidate = candidate.startsWith(`${distDirectory}${path.sep}`) ? candidate : path.join(distDirectory, 'index.html');
      const filePath = await stat(safeCandidate).then((entry) => (entry.isFile() ? safeCandidate : path.join(distDirectory, 'index.html'))).catch(() => path.join(distDirectory, 'index.html'));
      const body = await readFile(filePath);
      response.writeHead(200, { 'Content-Type': contentTypes[path.extname(filePath)] || 'application/octet-stream' });
      response.end(body);
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
  route.fulfill({
    status,
    contentType: 'application/json; charset=utf-8',
    body: JSON.stringify(body),
  });

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

const TEST_IMSI = '460001234567890';
const ADMIN_USER = {
  username: 'admin',
  role: 'admin',
  normalizedRole: 'admin',
  status: 'active',
  permissions: [
    'subscribers.read',
    'subscribers.write',
    'ocs.read',
    'ocs.balance.adjust',
    'ocs.contracts.read',
    'tariffs.read',
    'profiles.read',
    'core.read',
    'core.configure',
  ],
};

function makeBalanceRecordView(overrides = {}) {
  return {
    id: 'bal-001',
    imsi: TEST_IMSI,
    plan_id: 'default_plan',
    status: 'active',
    data_total: 10737418240,     // 10 GiB
    data_used: 2147483648,       // 2 GiB
    data_reserved: 0,
    data_available: 8589934592,  // 8 GiB
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
    ...overrides,
  };
}

const BENIGN_CONSOLE = [
  /Download the React DevTools/i,
  /favicon/i,
  /status of 412/i,
  /net::ERR_FAILED/i,
  /Failed to fetch/i,
];

let temporaryBuildDirectory = null;
let ownedServer = null;
let browser = null;

try {
  let effectiveDistDir = process.env.OCS_BALANCE_UI_DIST_DIR
    ? path.resolve(process.env.OCS_BALANCE_UI_DIST_DIR)
    : null;

  if (!effectiveDistDir && !process.env.OCS_BALANCE_UI_BASE_URL) {
    console.log('[acceptance:ocs-balance] Building frontend SPA to temporary directory...');
    temporaryBuildDirectory = await mkdtemp(path.join(tmpdir(), 'xcloud-ocs-balance-'));
    await build({
      root: frontendRoot,
      build: { outDir: temporaryBuildDirectory, emptyOutDir: true },
      logLevel: 'warn',
    });
    effectiveDistDir = temporaryBuildDirectory;
  }

  ownedServer = effectiveDistDir ? await startStaticServer(effectiveDistDir) : null;
  const baseUrl = process.env.OCS_BALANCE_UI_BASE_URL || ownedServer.baseUrl;

  console.log(`[acceptance:ocs-balance] Launching browser against ${baseUrl}...`);
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport, reducedMotion: 'reduce' });
  const page = await context.newPage();

  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      const text = msg.text();
      if (BENIGN_CONSOLE.some((pattern) => pattern.test(text))) return;
      consoleErrors.push(text);
    }
  });
  page.on('pageerror', (err) => pageErrors.push(err.message));

  await page.addInitScript(() => {
    localStorage.setItem('XCLOUD_LANGUAGE_PREFERENCE', 'en');
    localStorage.setItem('XCLOUD_THEME_PREFERENCE', 'light');
    Object.defineProperty(window, 'EventSource', { configurable: true, value: undefined });
  });

  // Dynamic route states
  let currentBalance = makeBalanceRecordView();
  let adjustPostLog = [];
  let postAdjustHandler = null;
  let getDetailBalanceHandler = null;
  let getAdjustmentsHandler = null;
  let detailBalanceReadCount = 0;
  let adjustmentsReadCount = 0;
  let listReadCount = 0;

  await page.route('**/data/mcc-mnc-table.json', (route) => json(route, []));
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();

    if (url.pathname === '/api/auth/me') {
      return json(route, ADMIN_USER);
    }
    if (url.pathname.startsWith('/api/ocs/balances/') && !url.pathname.endsWith('/adjustments') && !url.pathname.endsWith('/adjust')) {
      const matchImsi = decodeURIComponent(url.pathname.slice('/api/ocs/balances/'.length));
      if (matchImsi === TEST_IMSI) {
        detailBalanceReadCount++;
      }
      if (getDetailBalanceHandler) {
        return getDetailBalanceHandler(route, matchImsi);
      }
      return json(route, { ok: true, balance: matchImsi === TEST_IMSI ? currentBalance : makeBalanceRecordView({ imsi: matchImsi, version: 1 }) });
    }
    if (url.pathname.startsWith('/api/ocs/balances/') && url.pathname.endsWith('/adjustments')) {
      const matchImsi = decodeURIComponent(url.pathname.slice('/api/ocs/balances/'.length, -'/adjustments'.length));
      if (matchImsi === TEST_IMSI) {
        adjustmentsReadCount++;
      }
      if (getAdjustmentsHandler) {
        return getAdjustmentsHandler(route, matchImsi);
      }
      return json(route, {
        ok: true,
        imsi: matchImsi,
        records: [
          {
            id: 'adj-001',
            createdAt: '2026-11-17T10:00:00Z',
            action: 'BALANCE_ADJUST',
            actor: 'admin',
            role: 'admin',
            result: 'success',
            reason: 'Initial credit',
            bucket: 'data',
            operation: 'credit',
            amount: 1073741824,
            beforeVersion: 3,
            afterVersion: 4,
          },
        ],
        total: 1,
        page: 1,
        limit: 20,
      });
    }
    if (url.pathname === '/api/ocs/balances') {
      listReadCount++;
      return json(route, {
        ok: true,
        records: [currentBalance],
        total: 1,
        page: 1,
        limit: 10,
        totalPages: 1,
        summary: {
          totalSubscribers: 1,
          totalDataAllocated: currentBalance.data_total,
          totalDataUsed: currentBalance.data_used,
          totalDataReserved: currentBalance.data_reserved,
          totalDataAvailable: currentBalance.data_available,
        },
      });
    }
    if (url.pathname === '/api/tariff-plans') {
      return json(route, { plans: [{ id: 'default_plan', name: 'Standard 5G Plan' }] });
    }
    if (url.pathname === `/api/ocs/balances/${TEST_IMSI}/adjust` && method === 'POST') {
      const payload = route.request().postDataJSON();
      adjustPostLog.push({ payload, url: url.pathname });
      if (postAdjustHandler) {
        return postAdjustHandler(route, payload);
      }
      return json(route, { ok: true, outcome: 'success', message: 'Balance adjusted successfully' });
    }

    return json(route, {});
  });

  // =========================================================================
  // Deterministic request/response synchronisation helpers
  // =========================================================================
  /*
   * A detail-page refresh issues a direct authoritative GET (awaited by the
   * refresh handler) and an SWR revalidation. Completion is therefore observed
   * on the actual responses instead of on a fixed delay, and every scenario
   * below states explicitly how many responses it waits for.
   */
  const balanceResponseLog = [];
  const balanceResponseWaiters = [];

  const drainBalanceResponseWaiters = () => {
    for (let index = balanceResponseWaiters.length - 1; index >= 0; index -= 1) {
      if (balanceResponseWaiters[index]()) balanceResponseWaiters.splice(index, 1);
    }
  };

  page.on('response', (response) => {
    const request = response.request();
    if (request.method() !== 'GET') return;
    const responseUrl = new URL(response.url());
    if (!responseUrl.pathname.startsWith('/api/ocs/balances/')) return;
    if (responseUrl.pathname.endsWith('/adjustments')) return;
    balanceResponseLog.push({ path: responseUrl.pathname, status: response.status() });
    drainBalanceResponseWaiters();
  });

  /** Resolves once `target` balance GET responses have been observed. */
  const waitForBalanceResponseCount = (target, timeoutMs = 20_000) =>
    new Promise((resolve, reject) => {
      const attempt = () => {
        if (balanceResponseLog.length < target) return false;
        globalThis.clearTimeout(timer);
        resolve(balanceResponseLog.length);
        return true;
      };
      const timer = globalThis.setTimeout(() => {
        const index = balanceResponseWaiters.indexOf(attempt);
        if (index >= 0) balanceResponseWaiters.splice(index, 1);
        reject(
          new Error(
            `timed out waiting for ${target} balance GET responses; observed ${balanceResponseLog.length}`,
          ),
        );
      }, timeoutMs);
      if (!attempt()) balanceResponseWaiters.push(attempt);
    });

  /*
   * Flushes the React commit that follows a delivered response (two animation
   * frames). This is a rendering flush, never a completion proof: request
   * completion is proven by waitForBalanceResponseCount.
   */
  const settleUiAfterResponses = () =>
    page.evaluate(
      () =>
        new Promise((resolve) => {
          window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve(undefined)));
        }),
    );

  /** Reads the version cell of the governance section. */
  const readDetailVersion = async () => {
    const value = await page
      .locator('.ocs-detail-field:has-text("Version") .ocs-detail-value')
      .first()
      .textContent();
    return value?.trim() ?? '';
  };

  /** Waits until the detail surface renders `expected` as its version. */
  const waitForDetailVersion = (expected, timeout = 15_000) =>
    page.waitForFunction(
      (want) => {
        const fields = Array.from(document.querySelectorAll('.ocs-detail-field'));
        const versionField = fields.find((field) => (field.textContent || '').includes('Version'));
        const value = versionField?.querySelector('.ocs-detail-value');
        return Boolean(value) && (value.textContent || '').trim() === want;
      },
      expected,
      { timeout },
    );

  /** Waits until the adjust trigger is enabled (CAS-eligible snapshot). */
  const waitForAdjustEnabled = (timeout = 15_000) =>
    page.waitForFunction(
      () => {
        const button = Array.from(document.querySelectorAll('button')).find((node) =>
          (node.textContent || '').includes('Adjust Balance'),
        );
        return Boolean(button) && button.disabled === false;
      },
      undefined,
      { timeout },
    );

  // =========================================================================
  // Scenario 1: Normal Editing, Preview and Confirmation Lifecycle
  // =========================================================================
  console.log('\n--- Scenario 1: Normal Editing, Preview and Confirmation ---');
  await page.goto(`${baseUrl}/ocs/balances/${TEST_IMSI}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.locator('.ocs-detail-grid').waitFor({ state: 'visible', timeout: 15_000 });
  check('S1-01', true, 'balance detail page loaded');

  // Verify initial data available
  const initialAvailText = await page.locator('.ocs-detail-value-strong').first().textContent();
  check('S1-02', initialAvailText?.includes('8 GB'), `initial available shows 8 GB (saw ${initialAvailText})`);

  // Open adjustment modal
  const adjustTrigger = page.locator('button:has-text("Adjust Balance")').first();
  await adjustTrigger.click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor({ state: 'visible' });
  check('S1-03', true, 'adjust balance modal opened');

  // Verify editing step title & controls
  const dialogTitle = await dialog.locator('#balance-modal-title').textContent();
  check('S1-04', dialogTitle === 'Governed Balance Adjustment', `dialog title in editing step is 'Governed Balance Adjustment' (saw ${dialogTitle})`);

  // Modify amount: 1.5 GB
  const amountInput = dialog.locator('#adjust-amount');
  await amountInput.fill('1.5');
  const reasonInput = dialog.locator('#adjust-reason');
  await reasonInput.fill('Routine tier top-up');
  const ticketInput = dialog.locator('#adjust-ticket');
  await ticketInput.fill('TICK-1001');

  // Assert 0 mutations dispatched during editing
  check('S1-05', adjustPostLog.length === 0, `zero POST mutations dispatched during editing (${adjustPostLog.length})`);

  // Proceed to review
  const reviewButton = dialog.locator('button[type="submit"]');
  await reviewButton.click();
  await dialog.locator('.ocs-review-workflow').waitFor({ state: 'visible' });

  // Verify review step title and preview details
  const reviewTitle = await dialog.locator('#balance-modal-title').textContent();
  check('S1-06', reviewTitle === 'Review Balance Adjustment', `dialog title in review step is 'Review Balance Adjustment' (saw ${reviewTitle})`);

  // Verify Before / Delta / After projection
  const deltaText = await dialog.locator('.ocs-delta-credit').first().textContent();
  check('S1-07', deltaText?.includes('+1,610,612,736'), `projected signed delta is +1,610,612,736 (saw ${deltaText})`);

  // Assert 0 mutations dispatched during preview
  check('S1-08', adjustPostLog.length === 0, `zero POST mutations dispatched during preview (${adjustPostLog.length})`);

  // Configure successful execution that updates server balance to version 5
  postAdjustHandler = async (route) => {
    currentBalance = makeBalanceRecordView({
      version: 5,
      data_total: 10737418240 + 1610612736,
      data_used: 2147483648,
      data_reserved: 0,
      data_available: 8589934592 + 1610612736,
    });
    return json(route, { ok: true, outcome: 'success', message: 'Balance adjusted successfully' });
  };

  // Confirm adjustment
  const confirmButton = dialog.locator('button:has-text("Confirm Adjustment")');
  await confirmButton.scrollIntoViewIfNeeded();
  await confirmButton.click();
  await dialog.waitFor({ state: 'detached' });
  check('S1-09', true, 'dialog closed after successful confirmation');

  // Verify exact POST payload
  check('S1-10', adjustPostLog.length === 1, `exactly 1 POST mutation dispatched (${adjustPostLog.length})`);
  const post1 = adjustPostLog[0]?.payload;
  check('S1-11', post1?.operation === 'credit' && post1?.bucket === 'data', 'mutation operation is credit data');
  check('S1-12', post1?.amount === 1610612736, `canonical delta is 1610612736 (saw ${post1?.amount})`);
  check('S1-13', post1?.version === 4, `expectedVersion is 4 (saw ${post1?.version})`);
  check('S1-14', post1?.reason === 'Routine tier top-up' && post1?.ticketId === 'TICK-1001', 'audit reason and ticket match input');

  // Verify page updated with new balance (9.5 GB available)
  await page.waitForTimeout(300);
  const updatedAvailText = await page.locator('.ocs-detail-value-strong').first().textContent();
  check('S1-15', updatedAvailText?.includes('9.5 GB'), `refreshed available shows 9.5 GB (saw ${updatedAvailText})`);

  // =========================================================================
  // Scenario 2: Double-submission and In-flight Protection
  // =========================================================================
  console.log('\n--- Scenario 2: Double-submission and In-flight Protection ---');
  adjustPostLog = [];
  await adjustTrigger.click();
  await dialog.waitFor({ state: 'visible' });

  await dialog.locator('#adjust-amount').fill('0.5');
  await dialog.locator('#adjust-reason').fill('In-flight lock verification');
  await dialog.locator('button[type="submit"]').click();
  await dialog.locator('.ocs-review-workflow').waitFor({ state: 'visible' });

  // Setup delayed response
  let releaseDelayedPost;
  const delayPromise = new Promise((resolve) => {
    releaseDelayedPost = resolve;
  });
  postAdjustHandler = async (route) => {
    await delayPromise;
    currentBalance = makeBalanceRecordView({ version: 6 });
    return json(route, { ok: true, outcome: 'success', message: 'Delayed mutation done' });
  };

  const confirmBtn2 = dialog.locator('button:has-text("Confirm Adjustment")');
  await confirmBtn2.scrollIntoViewIfNeeded();
  await confirmBtn2.click();

  // Rapidly attempt repeated clicks and keyboard triggers
  await confirmBtn2.click({ force: true }).catch(() => {});
  await confirmBtn2.click({ force: true }).catch(() => {});
  await page.keyboard.press('Enter').catch(() => {});
  await page.keyboard.press('Escape').catch(() => {});

  // Assert dialog remains open and close button is disabled in-flight
  const closeBtn = dialog.locator('button[aria-label="Close"]');
  const closeDisabled = await closeBtn.isDisabled();
  check('S2-01', closeDisabled === true, 'dialog close button is disabled while mutation is in flight');
  check('S2-02', await dialog.isVisible(), 'dialog remains open while in-flight');

  // Release post response
  releaseDelayedPost();
  await dialog.waitFor({ state: 'detached' });

  // Assert EXACTLY ONE POST was dispatched across the whole burst
  check('S2-03', adjustPostLog.length === 1, `synchronous latch ensured exactly 1 POST dispatched despite burst (${adjustPostLog.length})`);
  check('S2-04', adjustPostLog[0]?.payload?.version === 5, `expectedVersion sent was 5 (saw ${adjustPostLog[0]?.payload?.version})`);

  // =========================================================================
  // Scenario 3: CAS Conflict Recovery & Stale Refresh Defense
  // =========================================================================
  console.log('\n--- Scenario 3: CAS Conflict Recovery & Stale Refresh Defense ---');
  adjustPostLog = [];
  await adjustTrigger.click();
  await dialog.waitFor({ state: 'visible' });

  await dialog.locator('#adjust-amount').fill('1');
  await dialog.locator('#adjust-reason').fill('Precondition test');
  await dialog.locator('button[type="submit"]').click();
  await dialog.locator('.ocs-review-workflow').waitFor({ state: 'visible' });

  // Return 412 CAS Precondition Changed
  postAdjustHandler = async (route) => {
    return json(route, { code: 'BALANCE_PRECONDITION_CHANGED', message: 'Precondition changed' }, 412);
  };

  const confirmBtn3 = dialog.locator('button:has-text("Confirm Adjustment")');
  await confirmBtn3.scrollIntoViewIfNeeded();
  await confirmBtn3.click();
  await dialog.locator('button:has-text("Refresh & Re-review")').waitFor({ state: 'visible' });

  // Assert confirm button is completely gone
  const confirmGone = (await dialog.locator('button:has-text("Confirm Adjustment")').count()) === 0;
  check('S3-01', confirmGone, 'Confirm button eliminated on CAS conflict');

  // Verify conflict step alert
  const conflictAlertText = await dialog.locator('.ocs-feedback-error').textContent();
  check('S3-02', conflictAlertText?.includes('modified concurrently') || conflictAlertText?.includes('precondition'), `alert reports precondition change (saw ${conflictAlertText})`);

  // Clear post log to verify 0 POST mutations during conflict recovery attempts
  adjustPostLog = [];

  // Test Stale Read Defense: mock returns the SAME version 6
  currentBalance = makeBalanceRecordView({ version: 6 });
  const refreshRereviewBtn = dialog.locator('button:has-text("Refresh & Re-review")');
  await refreshRereviewBtn.click();
  await page.waitForTimeout(300);

  // Assert unresolved conflict warning is shown and still in conflict step
  const unresolvedWarning = await dialog.locator('.ocs-feedback-error').textContent();
  check('S3-03', unresolvedWarning?.includes('conflicting version') || unresolvedWarning?.includes('conflicted version'), `stale read defense displayed unresolved warning (saw ${unresolvedWarning})`);
  check('S3-04', (await dialog.locator('button:has-text("Refresh & Re-review")').count()) > 0, 'remained in conflict step without advancing to review with stale data');

  // Scenario C1: Lower-version CAS refresh rejection (v5 < v6)
  currentBalance = makeBalanceRecordView({ version: 5 });
  await refreshRereviewBtn.click();
  await page.waitForTimeout(300);
  const lowerWarning = await dialog.locator('.ocs-feedback-error').textContent();
  check('S3-C1-01', lowerWarning?.includes('conflicted version') || lowerWarning?.includes('v5'), `lower-version CAS refresh rejected (saw ${lowerWarning})`);
  check('S3-C1-02', (await dialog.locator('button:has-text("Refresh & Re-review")').count()) > 0, 'remained in conflict step without advancing to review for v5 < v6');
  check('S3-C1-03', adjustPostLog.length === 0, 'zero POST dispatched during lower-version rejection');

  // Scenario C2: Delayed authoritative GET holding conflict state and disabled controls
  let releaseDelayedGet;
  const delayedGetPromise = new Promise((resolve) => {
    releaseDelayedGet = resolve;
  });
  getDetailBalanceHandler = async (route) => {
    await delayedGetPromise;
    currentBalance = makeBalanceRecordView({ version: 7 });
    return json(route, { ok: true, balance: currentBalance });
  };
  await refreshRereviewBtn.click();

  const isRefreshingSpin = (await dialog.locator('.ocs-spin').count()) > 0;
  check('S3-C2-01', isRefreshingSpin, 'refreshing indicator active during in-flight authoritative read');
  const isCloseDisabledDuringRefresh = await dialog.locator('button[aria-label="Close"]').isDisabled();
  check('S3-C2-02', isCloseDisabledDuringRefresh, 'close button disabled during in-flight authoritative refresh');

  // Release delayed authoritative read
  releaseDelayedGet();
  getDetailBalanceHandler = null;
  await dialog.locator('#adjust-amount').waitFor({ state: 'visible' });
  check('S3-05', true, 'fresh snapshot v7 cleanly unlocked editing step');

  // Review step reflects fresh version v7
  await dialog.locator('button[type="submit"]').click();
  await dialog.locator('.ocs-review-workflow').waitFor({ state: 'visible' });
  const reviewV7 = await dialog.locator('.ocs-review-item-value.ocs-mono').last().textContent();
  check('S3-06', reviewV7?.includes('v7'), `review step reflects fresh version v7 (saw ${reviewV7})`);

  // =========================================================================
  // Scenario C5-1: Authoritative v7 preservation on delayed v6 SWR arrival
  // =========================================================================
  console.log('\n--- Scenario C5-1: Authoritative v7 Preservation on Delayed v6 SWR ---');
  // Step 3 of C5-1: Close modal to inspect detail surface
  await dialog.locator('button:has-text("Cancel")').click();
  await dialog.waitFor({ state: 'detached' });

  // Step 4 of C5-1: Hold the next balance read behind a controlled gate, then
  // release it with a stale version 6 payload once the request is in flight.
  const staleV6Balance = makeBalanceRecordView({
    version: 6,
    data_used: 5368709120,
    data_available: 5368709120,
  });
  let releaseStaleV6;
  const staleV6Gate = new Promise((resolve) => {
    releaseStaleV6 = resolve;
  });
  let resolveStaleV6Requested;
  const staleV6Requested = new Promise((resolve) => {
    resolveStaleV6Requested = resolve;
  });
  let staleV6Delivered = 0;

  getDetailBalanceHandler = async (route, reqImsi) => {
    if (reqImsi !== TEST_IMSI) {
      return json(route, { ok: true, balance: makeBalanceRecordView({ imsi: reqImsi, version: 1 }) });
    }
    resolveStaleV6Requested();
    await staleV6Gate;
    await json(route, { ok: true, balance: staleV6Balance });
    staleV6Delivered += 1;
  };

  currentBalance = staleV6Balance;
  const refreshBtnC5 = page.locator('button:has-text("Refresh")').first();
  const c51Baseline = balanceResponseLog.length;
  await refreshBtnC5.click();
  // The refresh really issued a balance read before the stale payload is released.
  await staleV6Requested;
  releaseStaleV6();
  // Direct authoritative GET plus the SWR revalidation must both complete.
  await waitForBalanceResponseCount(c51Baseline + 2);
  await settleUiAfterResponses();
  getDetailBalanceHandler = null;

  check('S3-C5-1-00', staleV6Delivered >= 1, `delayed v6 response actually delivered to the page (${staleV6Delivered} deliveries)`);

  // Step 5 of C5-1: Assert detail page displays version 7 and retains v7 available metrics
  const detailVerC51 = await readDetailVersion();
  check('S3-C5-1-01', detailVerC51 === '7', `detail surface strictly retains authoritative version 7 against stale v6 (saw ${detailVerC51})`);
  const detailAvailC51 = await page.locator('.ocs-detail-value-strong').first().textContent();
  check('S3-C5-1-02', detailAvailC51?.includes('8 GB'), `detail surface retains v7 available metrics (saw ${detailAvailC51})`);

  // Step 6 of C5-1: Assert version 6 is strictly rejected and never rendered
  check('S3-C5-1-03', !detailVerC51.includes('6'), 'stale version 6 strictly rejected from rendering');
  check('S3-C5-1-04', (await page.locator('.ocs-feedback-error[role="alert"]').count()) === 0, 'stale lower version did not raise a conflict alert');

  // Submit recovered mutation with fresh version 7 to advance to v8 and verify S3-07
  adjustPostLog = [];
  postAdjustHandler = async (route) => {
    currentBalance = makeBalanceRecordView({
      version: 8,
      data_total: 10737418240,
      data_used: 3221225472,       // 3 GiB used
      data_reserved: 0,
      data_available: 7516192768,  // 7 GiB available
    });
    return json(route, { ok: true, outcome: 'success', message: 'Recovered mutation done' });
  };
  await adjustTrigger.click();
  await dialog.waitFor({ state: 'visible' });
  await dialog.locator('#adjust-amount').fill('1');
  await dialog.locator('#adjust-reason').fill('Recovered v7 mutation');
  await dialog.locator('button[type="submit"]').click();
  await dialog.locator('.ocs-review-workflow').waitFor({ state: 'visible' });
  await dialog.locator('button:has-text("Confirm Adjustment")').scrollIntoViewIfNeeded();
  await dialog.locator('button:has-text("Confirm Adjustment")').click();
  await dialog.waitFor({ state: 'detached' });
  check('S3-07', adjustPostLog[0]?.payload?.version === 7, `mutation submitted with fresh version 7 (saw ${adjustPostLog[0]?.payload?.version})`);

  // =========================================================================
  // Scenario C5-2: Monotonic progression to higher version
  // =========================================================================
  console.log('\n--- Scenario C5-2: Monotonic Progression to Higher Version ---');
  // 1. Deliver valid version 8 balance snapshot through the real refresh path
  const c52Baseline = balanceResponseLog.length;
  await refreshBtnC5.click();
  await waitForBalanceResponseCount(c52Baseline + 2);
  await waitForDetailVersion('8');
  const detailVerC52 = await readDetailVersion();
  check('S3-C5-2-01', detailVerC52 === '8', `detail page monotonically advanced to version 8 (saw ${detailVerC52})`);
  const detailAvailC52 = await page.locator('.ocs-detail-value-strong').first().textContent();
  check('S3-C5-2-02', detailAvailC52?.includes('7 GB'), `detail page displays v8 metrics 7 GB (saw ${detailAvailC52})`);

  // 2. Deliver a stale version 7 snapshot through the same refresh path
  currentBalance = makeBalanceRecordView({ version: 7 });
  const c52bBaseline = balanceResponseLog.length;
  await refreshBtnC5.click();
  await waitForBalanceResponseCount(c52bBaseline + 2);
  await settleUiAfterResponses();
  const detailVerAfterDelayed7 = await readDetailVersion();
  check('S3-C5-2-03', detailVerAfterDelayed7 === '8', `detail page remains strictly at version 8 after delayed v7 arrival (saw ${detailVerAfterDelayed7})`);
  const detailAvailAfterDelayed7 = await page.locator('.ocs-detail-value-strong').first().textContent();
  check('S3-C5-2-04', detailAvailAfterDelayed7?.includes('7 GB'), `detail page retains v8 metrics after delayed v7 arrival (saw ${detailAvailAfterDelayed7})`);

  // =========================================================================
  // Scenario C5-3: Same-version conflicting snapshot handling
  // =========================================================================
  console.log('\n--- Scenario C5-3: Same-Version Conflicting Snapshot Handling ---');
  // 1. Deliver a version 8 balance snapshot with conflicting data metrics (altered data.available)
  currentBalance = makeBalanceRecordView({
    version: 8,
    data_total: 10737418240,
    data_used: 5368709120,       // altered metrics: used 5 GiB, available 5 GiB instead of used 3 GiB, available 7 GiB
    data_reserved: 0,
    data_available: 5368709120,
  });
  const c53Baseline = balanceResponseLog.length;
  await refreshBtnC5.click();
  await waitForBalanceResponseCount(c53Baseline + 2);

  // 2 & 3. Assert detail page identifies conflict and displays conflict warning
  const conflictAlert = page.locator('.ocs-feedback-error[role="alert"]');
  await conflictAlert.waitFor({ state: 'visible', timeout: 5000 });
  const detailConflictAlertText = await conflictAlert.textContent();
  check('S3-C5-3-01', detailConflictAlertText?.includes('conflict') || detailConflictAlertText?.includes('Balance snapshot'), `conflict alert displayed on identical version with conflicting metrics (saw ${detailConflictAlertText})`);

  // 4. Assert 'Adjust Balance' button is disabled
  const isAdjustDisabledConflict = await adjustTrigger.isDisabled();
  check('S3-C5-3-02', isAdjustDisabledConflict === true, 'Adjust Balance button is disabled during snapshot conflict');

  // 5. Assert clicking 'Adjust Balance' does not open modal and dispatches 0 adjustment requests
  adjustPostLog = [];
  await adjustTrigger.click({ force: true }).catch(() => {});
  const isModalOpenDuringConflict = (await page.locator('[role="dialog"]').count()) > 0;
  check('S3-C5-3-03', !isModalOpenDuringConflict && adjustPostLog.length === 0, 'clicking disabled adjust button did not open modal and dispatched 0 POSTs');

  // Clear conflict state by advancing to valid higher version 9
  const v9Balance = makeBalanceRecordView({
    version: 9,
    data_total: 10737418240,
    data_used: 2147483648,
    data_reserved: 0,
    data_available: 8589934592,
  });
  currentBalance = v9Balance;
  const c53bBaseline = balanceResponseLog.length;
  await refreshBtnC5.click();
  await waitForBalanceResponseCount(c53bBaseline + 2);
  await conflictAlert.waitFor({ state: 'detached', timeout: 10_000 });
  await waitForDetailVersion('9');
  const conflictCleared = (await page.locator('.ocs-feedback-error[role="alert"]').count()) === 0;
  check('S3-C5-3-04', conflictCleared, 'higher version 9 cleared conflict state and warning alert');
  check('S3-C5-3-05', (await readDetailVersion()) === '9', 'detail surface advanced to version 9 after conflict recovery');

  // =========================================================================
  // Scenario C5-5: Missing-version fail-closed protection on the detail surface
  // =========================================================================
  console.log('\n--- Scenario C5-5: Missing-Version Fail-Closed on the Detail Surface ---');
  // 1. An unversioned response must never replace the established v9 watermark.
  currentBalance = makeBalanceRecordView({
    version: null,
    data_total: 10737418240,
    data_used: 0,
    data_reserved: 0,
    data_available: 10737418240,
  });
  const c55Baseline = balanceResponseLog.length;
  await refreshBtnC5.click();
  await waitForBalanceResponseCount(c55Baseline + 2);

  const versionWarning = page.locator('.ocs-feedback-warning[role="alert"]');
  await versionWarning.waitFor({ state: 'visible', timeout: 5000 });
  const versionWarningText = await versionWarning.textContent();
  check('S3-C5-5-01', Boolean(versionWarningText && versionWarningText.includes('v9')), `version-unavailable warning names the retained high-watermark v9 (saw ${versionWarningText})`);
  check('S3-C5-5-02', (await readDetailVersion()) === '9', 'unversioned response did not replace the accepted v9 snapshot');
  const availAfterMissingVersion = await page.locator('.ocs-detail-value-strong').first().textContent();
  check('S3-C5-5-03', availAfterMissingVersion?.includes('8 GB'), `unversioned response did not replace v9 metrics (saw ${availAfterMissingVersion})`);

  // 2. Mutation eligibility fails closed while the version is unavailable.
  check('S3-C5-5-04', (await adjustTrigger.isDisabled()) === true, 'Adjust Balance button is disabled while the version is unavailable');
  adjustPostLog = [];
  await adjustTrigger.click({ force: true }).catch(() => {});
  check('S3-C5-5-05', (await page.locator('[role="dialog"]').count()) === 0 && adjustPostLog.length === 0, 'no dialog opened and zero POSTs dispatched while the version is unavailable');

  // 3. A valid authoritative snapshot restores CAS eligibility.
  currentBalance = v9Balance;
  const c55bBaseline = balanceResponseLog.length;
  await refreshBtnC5.click();
  await waitForBalanceResponseCount(c55bBaseline + 2);
  await versionWarning.waitFor({ state: 'detached', timeout: 10_000 });
  await waitForAdjustEnabled();
  check('S3-C5-5-06', (await page.locator('.ocs-feedback-warning[role="alert"]').count()) === 0, 'valid authoritative snapshot cleared the version-unavailable warning');
  check('S3-C5-5-07', (await adjustTrigger.isDisabled()) === false, 'adjustment became available again after a valid snapshot was recovered');

  // =========================================================================
  // Scenario C5-4: IMSI route transition isolation
  // =========================================================================
  console.log('\n--- Scenario C5-4: IMSI Route Transition Isolation ---');
  // 1. Verify IMSI A data renders at version 9
  const detailVerA = await page.locator('.ocs-detail-field:has-text("Version") .ocs-detail-value').first().textContent();
  check('S3-C5-4-01', detailVerA?.trim() === '9', `IMSI A verified rendering version 9 before transition (saw ${detailVerA})`);

  // 2. Client-side navigate to IMSI B (460009999999999) with delayed response
  let releaseImsiB;
  const imsiBPromise = new Promise((resolve) => {
    releaseImsiB = resolve;
  });
  getDetailBalanceHandler = async (route, reqImsi) => {
    if (reqImsi === '460009999999999') {
      await imsiBPromise;
      return json(route, {
        ok: true,
        balance: makeBalanceRecordView({
          imsi: '460009999999999',
          version: 1,
          data_total: 5368709120,
          data_used: 1073741824,
          data_reserved: 0,
          data_available: 4294967296,
        }),
      });
    }
    return json(route, { ok: true, balance: currentBalance });
  };

  await page.evaluate(() => {
    window.history.pushState({}, '', '/ocs/balances/460009999999999');
    window.dispatchEvent(new window.PopStateEvent('popstate'));
  });

  // 3. Assert detail page immediately renders loading state, NOT previous IMSI's data
  await page.locator('.ocs-detail-state').waitFor({ state: 'visible', timeout: 5000 });
  const previousImsiVisible = await page.evaluate((imsi) => {
    const container = document.querySelector('.ocs-container') || document.body;
    return container.innerText.includes(imsi);
  }, TEST_IMSI);
  check('S3-C5-4-02', !previousImsiVisible, 'detail page immediately rendered loading state with zero leakage of previous IMSI data');

  // 4 & 5. Deliver IMSI B response (version 1) and assert detail displays IMSI B with version 1
  releaseImsiB();
  getDetailBalanceHandler = null;

  await page.locator('.ocs-detail-grid').waitFor({ state: 'visible', timeout: 10000 });
  const pageTitleB = await page.locator('h1').textContent();
  check('S3-C5-4-03', pageTitleB?.includes('460009999999999'), `page renders new IMSI 460009999999999 (saw ${pageTitleB})`);
  const detailVerB = await page.locator('.ocs-detail-field:has-text("Version") .ocs-detail-value').first().textContent();
  check('S3-C5-4-04', detailVerB?.trim() === '1', `page renders version 1 for new IMSI (saw ${detailVerB})`);

  // 6. Open Adjust Balance modal and assert target IMSI is strictly 460009999999999
  const adjustBtnB = page.locator('button:has-text("Adjust Balance")').first();
  await adjustBtnB.click();
  await dialog.waitFor({ state: 'visible' });
  const dialogHtml = await dialog.innerHTML();
  check('S3-C5-4-05', dialogHtml.includes('460009999999999') && !dialogHtml.includes(TEST_IMSI), 'adjustment modal targets strictly new IMSI 460009999999999');
  await dialog.locator('button:has-text("Cancel")').click();
  await dialog.waitFor({ state: 'detached' });

  // Navigate back to TEST_IMSI for Scenario 4
  currentBalance = makeBalanceRecordView({ version: 8 });
  await page.evaluate((imsi) => {
    window.history.pushState({}, '', `/ocs/balances/${imsi}`);
    window.dispatchEvent(new window.PopStateEvent('popstate'));
  }, TEST_IMSI);
  await page.locator('.ocs-detail-grid').waitFor({ state: 'visible', timeout: 10000 });

  // =========================================================================
  // Scenario 4: Unknown Outcome & Truthful Reconciliation Permutations (Task D)
  // =========================================================================
  console.log('\n--- Scenario 4: Unknown Outcome & Truthful Reconciliation ---');
  // Part A: Detail Page
  await adjustTrigger.click();
  await dialog.waitFor({ state: 'visible' });
  await dialog.locator('#adjust-amount').fill('1');
  await dialog.locator('#adjust-reason').fill('Transport drop test');
  await dialog.locator('button[type="submit"]').click();
  await dialog.locator('.ocs-review-workflow').waitFor({ state: 'visible' });

  // Simulate transport drop
  postAdjustHandler = async (route) => {
    await route.abort('failed');
  };
  await dialog.locator('button:has-text("Confirm Adjustment")').scrollIntoViewIfNeeded();
  await dialog.locator('button:has-text("Confirm Adjustment")').click();
  await dialog.locator('button:has-text("Refresh Balance & History")').waitFor({ state: 'visible' });

  check('S4-01', (await dialog.locator('button:has-text("Confirm Adjustment")').count()) === 0, 'resubmission blocked on transport failure');

  const reconcileBtn = dialog.locator('button:has-text("Refresh Balance & History")');

  // Permutation 1: Both succeed
  detailBalanceReadCount = 0;
  adjustmentsReadCount = 0;
  await reconcileBtn.click();
  await dialog.locator('.ocs-feedback-info').waitFor({ state: 'visible', timeout: 10_000 });
  check('S4-02', detailBalanceReadCount >= 1 && adjustmentsReadCount >= 1, `detail reconciliation triggered both balance (${detailBalanceReadCount}) and history (${adjustmentsReadCount}) reads`);
  const statusMsgInfo = await dialog.locator('.ocs-feedback-info').textContent();
  check('S4-03', statusMsgInfo?.includes('refreshed'), `reconciliation confirms evidence refreshed on dual success (saw ${statusMsgInfo})`);

  // Permutation 2: Balance succeeds, history fails
  getAdjustmentsHandler = async (route) => route.abort('failed');
  await reconcileBtn.click();
  await dialog.locator('.ocs-feedback-warning').waitFor({ state: 'visible', timeout: 10_000 });
  const statusMsgHistFail = await dialog.locator('.ocs-feedback-warning').textContent();
  check('S4-03b', statusMsgHistFail?.includes('history could not be updated'), `partial history failure renders warning (saw ${statusMsgHistFail})`);
  getAdjustmentsHandler = null;

  // Permutation 3: Balance fails, history succeeds
  getDetailBalanceHandler = async (route) => route.abort('failed');
  await reconcileBtn.click();
  await page.waitForTimeout(300);
  await dialog.locator('.ocs-feedback-warning').waitFor({ state: 'visible', timeout: 10_000 });
  const statusMsgBalFail = await dialog.locator('.ocs-feedback-warning').textContent();
  check('S4-03c', statusMsgBalFail?.includes('balance could not be updated'), `partial balance failure renders warning (saw ${statusMsgBalFail})`);
  getDetailBalanceHandler = null;

  // Permutation 4: Both fail
  getDetailBalanceHandler = async (route) => route.abort('failed');
  getAdjustmentsHandler = async (route) => route.abort('failed');
  await reconcileBtn.click();
  const bothFailFeedback = dialog.locator('.ocs-feedback-error[role="status"]');
  await bothFailFeedback.waitFor({ state: 'visible', timeout: 10_000 });
  const statusMsgBothFail = await bothFailFeedback.textContent();
  check('S4-03d', statusMsgBothFail?.includes('Failed to refresh') || statusMsgBothFail?.includes('failed'), `both failing renders error (saw ${statusMsgBothFail})`);
  getDetailBalanceHandler = null;
  getAdjustmentsHandler = null;

  check('S4-03e', (await dialog.locator('button:has-text("Confirm Adjustment")').count()) === 0, 'resubmission remains blocked throughout all reconciliation permutations');

  await dialog.locator('button:has-text("Close")').click();
  await dialog.waitFor({ state: 'detached' });

  // Part B: List Page Reconciliation
  await page.goto(`${baseUrl}/ocs/balances`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.locator('.ocs-table').waitFor({ state: 'visible', timeout: 15_000 });
  const rowAdjustBtn = page.locator(`button[aria-label="Adjust Balance ${TEST_IMSI}"]`).first();
  await rowAdjustBtn.click();
  await dialog.waitFor({ state: 'visible' });

  await dialog.locator('#adjust-amount').fill('1');
  await dialog.locator('#adjust-reason').fill('List page unknown outcome');
  await dialog.locator('button[type="submit"]').click();
  await dialog.locator('.ocs-review-workflow').waitFor({ state: 'visible' });

  postAdjustHandler = async (route) => {
    await route.abort('failed');
  };
  await dialog.locator('button:has-text("Confirm Adjustment")').scrollIntoViewIfNeeded();
  await dialog.locator('button:has-text("Confirm Adjustment")').click();
  await dialog.locator('a:has-text("View Balance & History")').waitFor({ state: 'visible' });

  check('S4-04', (await dialog.locator('button:has-text("Refresh Balance & History")').count()) === 0, 'list page does NOT falsely claim history refresh');
  const viewHistoryLink = dialog.locator('a:has-text("View Balance & History")');
  const historyHref = await viewHistoryLink.getAttribute('href');
  check('S4-05', historyHref === `/ocs/balances/${TEST_IMSI}`, `view history link targets /ocs/balances/${TEST_IMSI} (saw ${historyHref})`);

  listReadCount = 0;
  const refreshListBtn = dialog.locator('button:has-text("Refresh List")');
  check('S4-06', (await refreshListBtn.count()) === 1, 'Refresh List button available on list surface');
  await refreshListBtn.click();
  await dialog.waitFor({ state: 'detached' });
  check('S4-07', listReadCount >= 1, `Refresh List triggered list read (${listReadCount}) and dismissed modal`);

  // Scenario C3 & C4: List-page CAS recovery workflow with fresh version and parent regression defense
  console.log('\n--- Scenario C3/C4: List-Page CAS Recovery & Parent Regression Defense ---');
  await rowAdjustBtn.click();
  await dialog.waitFor({ state: 'visible' });

  await dialog.locator('#adjust-amount').fill('1');
  await dialog.locator('#adjust-reason').fill('List page CAS conflict recovery');
  await dialog.locator('button[type="submit"]').click();
  await dialog.locator('.ocs-review-workflow').waitFor({ state: 'visible' });

  // Induce CAS conflict 412 on list surface
  postAdjustHandler = async (route) => {
    return json(route, { code: 'BALANCE_PRECONDITION_CHANGED', message: 'Precondition changed' }, 412);
  };
  const listConfirmBtn = dialog.locator('button:has-text("Confirm Adjustment")');
  await listConfirmBtn.scrollIntoViewIfNeeded();
  await listConfirmBtn.click();

  await dialog.locator('button:has-text("Refresh & Re-review")').waitFor({ state: 'visible' });
  check('S3-C3-01', (await dialog.locator('button:has-text("Confirm Adjustment")').count()) === 0, 'list surface eliminated confirm button on CAS conflict');

  // Setup server balance progression to version 10
  currentBalance = makeBalanceRecordView({ version: 10 });
  await dialog.locator('button:has-text("Refresh & Re-review")').click();
  await dialog.locator('#adjust-amount').waitFor({ state: 'visible' });
  check('S3-C3-02', true, 'list modal successfully unlocked editing step with v10');

  // Scenario C4: Modal review preserves fresh version v10 against parent regression
  await dialog.locator('button[type="submit"]').click();
  await dialog.locator('.ocs-review-workflow').waitFor({ state: 'visible' });
  const listReviewVer = await dialog.locator('.ocs-review-item-value.ocs-mono').last().textContent();
  check('S3-C4-01', listReviewVer?.includes('v10'), `modal review preserves fresh version v10 against regression (saw ${listReviewVer})`);

  // Confirm recovered mutation
  adjustPostLog = [];
  postAdjustHandler = async (route) => {
    currentBalance = makeBalanceRecordView({ version: 11 });
    return json(route, { ok: true, outcome: 'success', message: 'List mutation recovered' });
  };
  await dialog.locator('button:has-text("Confirm Adjustment")').scrollIntoViewIfNeeded();
  await dialog.locator('button:has-text("Confirm Adjustment")').click();
  await dialog.waitFor({ state: 'detached' });
  check('S3-C3-03', adjustPostLog[0]?.payload?.version === 10, `list mutation submitted with fresh version 10 (saw ${adjustPostLog[0]?.payload?.version})`);

  // =========================================================================
  // Scenario 5: Accessibility, Focus Trapping & Restoration
  // =========================================================================
  console.log('\n--- Scenario 5: Accessibility, Focus Trapping & Restoration ---');
  await page.goto(`${baseUrl}/ocs/balances/${TEST_IMSI}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.locator('.ocs-detail-grid').waitFor({ state: 'visible', timeout: 15_000 });

  const adjustBtn5 = page.locator('button:has-text("Adjust Balance")').first();
  await adjustBtn5.focus();
  await page.keyboard.press('Enter');
  await dialog.waitFor({ state: 'visible' });

  const role = await dialog.getAttribute('role');
  check('S5-01', role === 'dialog', `dialog role is 'dialog' (saw ${role})`);

  const ariaModal = await dialog.getAttribute('aria-modal');
  check('S5-02', ariaModal === 'true', `dialog aria-modal is 'true' (saw ${ariaModal})`);

  const labelledBy = await dialog.getAttribute('aria-labelledby');
  check('S5-03', labelledBy === 'balance-modal-title', `aria-labelledby points to 'balance-modal-title' (saw ${labelledBy})`);

  // Focus trap: Tab cycling within dialog
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press('Tab');
  }
  const isInsideDialogTab = await page.evaluate(() => {
    const active = document.activeElement;
    const dlg = document.querySelector('[role="dialog"]');
    return Boolean(dlg && dlg.contains(active));
  });
  check('S5-04', isInsideDialogTab === true, 'focus stays trapped inside dialog during forward Tab cycling');

  // Focus trap: Shift+Tab backwards cycling
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press('Shift+Tab');
  }
  const isInsideDialogShiftTab = await page.evaluate(() => {
    const active = document.activeElement;
    const dlg = document.querySelector('[role="dialog"]');
    return Boolean(dlg && dlg.contains(active));
  });
  check('S5-05', isInsideDialogShiftTab === true, 'focus stays trapped inside dialog during backward Shift+Tab cycling');

  // Focus restoration on Escape
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
  const restoredFocus = await page.evaluate(() => {
    const active = document.activeElement;
    return active?.tagName === 'BUTTON' && active?.textContent?.includes('Adjust Balance');
  });
  check('S5-06', restoredFocus === true, 'focus restored to trigger button on dialog dismissal');

  // =========================================================================
  // Scenario 6: Mobile Viewport (375x812) & Responsive Safety (Task E)
  // =========================================================================
  console.log('\n--- Scenario 6: Mobile Viewport (375x812) & Responsive Safety ---');
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(`${baseUrl}/ocs/balances/${TEST_IMSI}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.locator('.ocs-detail-grid').waitFor({ state: 'visible', timeout: 15_000 });

  const adjustBtnMobile = page.locator('button:has-text("Adjust Balance")').first();
  await adjustBtnMobile.click();
  await dialog.waitFor({ state: 'visible' });

  // Verify dialog bounding box fits within 375px mobile viewport
  const dialogBox = await dialog.boundingBox();
  check('S6-01', Boolean(dialogBox && dialogBox.width <= 375 && dialogBox.x >= 0), `dialog width fits mobile viewport (width=${dialogBox?.width}, x=${dialogBox?.x})`);

  // Verify no horizontal overflow on window
  const hasHorizontalScroll = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  check('S6-02', !hasHorizontalScroll, 'zero horizontal overflow on 375px mobile viewport');

  // Verify form can be filled, reviewed and canceled on mobile
  await dialog.locator('#adjust-amount').fill('1');
  await dialog.locator('#adjust-reason').fill('Mobile responsive test');
  await dialog.locator('button[type="submit"]').click();
  await dialog.locator('.ocs-review-workflow').waitFor({ state: 'visible' });

  const mobileConfirm = dialog.locator('button:has-text("Confirm Adjustment")');
  await mobileConfirm.scrollIntoViewIfNeeded();
  check('S6-03', await mobileConfirm.isVisible(), 'Confirm Adjustment button reachable and visible on mobile');

  await dialog.locator('button:has-text("Cancel")').click();
  await dialog.waitFor({ state: 'detached' });

  // Restore desktop viewport
  await page.setViewportSize(viewport);

  // Check console / page errors
  check('SYS-01', pageErrors.length === 0, `zero page runtime exceptions (${pageErrors.length})`);
  check('SYS-02', consoleErrors.length === 0, `zero console error messages (${consoleErrors.length})`);

  console.log(`\n=============================================================`);
  console.log(`[acceptance:ocs-balance] passed ${checks.filter((c) => c.ok).length}/${checks.length} assertions`);
  console.log(`=============================================================\n`);

  if (failures.length > 0) {
    console.error('Failures encountered:\n' + failures.join('\n'));
    process.exit(1);
  }
} catch (err) {
  console.error('[acceptance:ocs-balance] Unexpected test error:', err);
  process.exit(1);
} finally {
  await browser?.close().catch(() => {});
  ownedServer?.server.close();
  if (temporaryBuildDirectory) {
    await rm(temporaryBuildDirectory, { recursive: true, force: true }).catch(() => {});
  }
}
