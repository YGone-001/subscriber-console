#!/usr/bin/env node
/*
 * Dialog and overlay interaction acceptance.
 *
 * Runs against a real production Vite build in real Chromium and covers the
 * shared overlay contract:
 *
 *   D1  basic modal: open, initial focus, Tab/Shift+Tab trapping, Escape,
 *       backdrop dismissal, focus restoration
 *   D2  blocked dismissal: an in-flight mutation rejects Escape and backdrop
 *       interaction, the close callback is not invoked, and the permitted
 *       closure still works after the request settles
 *   D3  nested overlays: the child is topmost, the background is inert,
 *       Escape affects only the child, focus returns to the parent control,
 *       and every lock is released after both close
 *   D4  route transition: a client-side navigation while a dialog is open
 *       restores body scroll and inert state, with no detached-focus error
 *   D5  portal behaviour: one owned portal host, deterministic stacking above
 *       the parent drawer, inherited theme/localisation, no duplicate hosts
 *   D7  responsive: 1440x900 and 375x812
 *
 * Usage: node frontend/tests/dialogs-interaction-smoke.mjs
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { build } from 'vite';
import { startFixtureServer } from './nf-discovery-fixtures.mjs';

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 375, height: 812 };
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

const BENIGN_CONSOLE = [/Download the React DevTools/i, /favicon/i, /net::ERR_FAILED/i, /Failed to fetch/i];

const BOOTSTRAP_PLAN = {
  planId: 'plan-fixture-0001',
  hostId: 'host-0123456789abcdef',
  template: 'auto',
  generatedAt: '2026-10-01T08:00:00Z',
  entries: [
    {
      componentId: 'amf',
      displayName: 'AMF',
      processName: 'amfd',
      domain: '5gc',
      role: 'amf',
      nfType: 'AMF',
      category: '5gc',
      runtimeStatus: 'running',
      verified: true,
      workerCount: 1,
      primaryPid: 4211,
      action: 'create_resource',
      reason: 'verified_process_without_resource',
      proposedResource: {
        kind: 'network_function',
        name: 'AMF',
        displayName: 'AMF',
        domain: '5gc',
        role: 'amf',
        lifecycleState: 'planned',
        externalId: 'amf.fixture',
      },
      proposedTarget: {
        collectorProfile: 'cnms_compat',
        serviceUnit: 'xcloud-amfd.service',
        serviceKind: 'systemd',
        collectionMode: 'http_metrics',
        intervalSeconds: 120,
      },
      conflicts: [],
    },
  ],
  counts: { total: 1, create: 1, reuse: 0, skipped: 0, conflicts: 0, targetCreate: 1, targetReuse: 0 },
};

const BOOTSTRAP_RESULT = {
  planId: BOOTSTRAP_PLAN.planId,
  hostId: BOOTSTRAP_PLAN.hostId,
  appliedAt: '2026-10-01T08:02:00Z',
  entries: [
    {
      componentId: 'amf',
      action: 'created',
      resourceId: '7c3e1d50-0031-4d31-9f31-000000000031',
      resourceCreated: true,
      targetId: '7c3e1d50-0031-4d31-9f31-000000000032',
      targetCreated: true,
      bindingInstalled: true,
      conflicts: [],
    },
  ],
  counts: BOOTSTRAP_PLAN.counts,
};

function balanceRecord(overrides = {}) {
  return {
    id: 'bal-001',
    imsi: TEST_IMSI,
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
    ...overrides,
  };
}

let temporaryBuildDirectory = null;
let fixture = null;
let browser = null;

try {
  console.log('[acceptance:dialogs] Building frontend SPA to temporary directory...');
  temporaryBuildDirectory = await mkdtemp(path.join(tmpdir(), 'xcloud-dialogs-'));
  await build({
    root: frontendRoot,
    build: { outDir: temporaryBuildDirectory, emptyOutDir: true },
    logLevel: 'warn',
  });

  fixture = await startFixtureServer({ distDir: temporaryBuildDirectory, sessionKey: 'operator' });
  const baseUrl = fixture.origin;

  console.log(`[acceptance:dialogs] Launching browser against ${baseUrl}...`);
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: DESKTOP, reducedMotion: 'reduce' });
  const page = await context.newPage();

  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    if (BENIGN_CONSOLE.some((pattern) => pattern.test(text))) return;
    consoleErrors.push(text);
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.addInitScript(() => {
    localStorage.setItem('XCLOUD_LANGUAGE_PREFERENCE', 'en');
    localStorage.setItem('XCLOUD_THEME_PREFERENCE', 'light');
    Object.defineProperty(window, 'EventSource', { configurable: true, value: undefined });
  });

  await page.route('**/data/mcc-mnc-table.json', (route) => json(route, []));

  /* OCS and bootstrap endpoints are owned by this suite; everything else falls
   * through to the deterministic fixture server so the "no unexpected request"
   * gate keeps its meaning. */
  let currentBalance = balanceRecord();
  let adjustPosts = 0;
  let adjustHandler = null;
  let applyHandler = null;

  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const pathname = url.pathname;
    const method = route.request().method();

    if (pathname === '/api/auth/me') return json(route, ADMIN_USER);
    if (pathname === '/api/auth/permissions') return json(route, { permissions: ADMIN_USER.permissions });

    if (pathname === '/api/runtime/bootstrap/preview' && method === 'POST') {
      return json(route, BOOTSTRAP_PLAN);
    }
    if (pathname === '/api/runtime/bootstrap/apply' && method === 'POST') {
      if (applyHandler) return applyHandler(route);
      return json(route, BOOTSTRAP_RESULT);
    }

    if (pathname.startsWith('/api/ocs/balances/') && pathname.endsWith('/adjust') && method === 'POST') {
      adjustPosts += 1;
      if (adjustHandler) return adjustHandler(route);
      return json(route, { ok: true, outcome: 'success', message: 'Balance adjusted successfully' });
    }
    if (pathname.startsWith('/api/ocs/balances/') && pathname.endsWith('/adjustments')) {
      const imsi = decodeURIComponent(pathname.slice('/api/ocs/balances/'.length, -'/adjustments'.length));
      return json(route, { ok: true, imsi, records: [], total: 0, page: 1, limit: 20 });
    }
    if (pathname.startsWith('/api/ocs/balances/')) {
      const imsi = decodeURIComponent(pathname.slice('/api/ocs/balances/'.length));
      return json(route, { ok: true, balance: { ...currentBalance, imsi } });
    }
    if (pathname === '/api/ocs/balances') {
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
    if (pathname === '/api/tariff-plans') {
      return json(route, { plans: [{ id: 'default_plan', name: 'Standard 5G Plan' }] });
    }

    return route.fallback();
  });

  /* ------------------------------------------------------------------ */
  /* Shared helpers                                                      */
  /* ------------------------------------------------------------------ */
  const ocsDialog = page.locator('.ocs-dialog');
  const adjustTrigger = page.locator('button:has-text("Adjust Balance")').first();

  const openBalanceDetail = async () => {
    await page.goto(`${baseUrl}/ocs/balances/${TEST_IMSI}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.locator('.ocs-detail-grid').waitFor({ state: 'visible', timeout: 15_000 });
  };

  const readEnvironment = () =>
    page.evaluate(() => {
      const sidebar = document.querySelector('.sidebar-nav');
      return {
        overflow: document.body.style.overflow,
        inertRoot: Boolean(document.getElementById('root')?.inert),
        /* Inline overlays inert the shell by sibling isolation, not by marking
         * the whole application root; the sidebar proves the shell is covered. */
        backgroundInert: Boolean(sidebar && sidebar.closest('[inert]')),
        inertCount: document.querySelectorAll('[inert]').length,
        ariaHiddenRoot: document.getElementById('root')?.getAttribute('aria-hidden'),
        portalHosts: document.querySelectorAll('[data-xcloud-overlay-portal]').length,
      };
    });

  /* ------------------------------------------------------------------ */
  /* D1: basic modal, focus trap and dismissal                          */
  /* ------------------------------------------------------------------ */
  console.log('\n--- D1: basic modal, focus trap and dismissal ---');
  await openBalanceDetail();
  await adjustTrigger.focus();
  await page.keyboard.press('Enter');
  await ocsDialog.waitFor({ state: 'visible', timeout: 10_000 });

  check('D1-01', (await ocsDialog.getAttribute('role')) === 'dialog', 'the modal exposes role=dialog');
  check('D1-02', (await ocsDialog.getAttribute('aria-modal')) === 'true', 'the modal exposes aria-modal=true');
  check(
    'D1-03',
    (await ocsDialog.getAttribute('aria-labelledby')) === 'balance-modal-title',
    'the modal is labelled by its title element',
  );

  const initialFocus = await page.evaluate(() => {
    const dialog = document.querySelector('.ocs-dialog');
    const active = document.activeElement;
    return { inside: Boolean(dialog && active && dialog.contains(active)), tag: active?.tagName ?? '' };
  });
  check('D1-04', initialFocus.inside, `initial focus enters the dialog (${initialFocus.tag})`);

  for (let index = 0; index < 10; index += 1) await page.keyboard.press('Tab');
  const afterTab = await page.evaluate(() => {
    const dialog = document.querySelector('.ocs-dialog');
    return Boolean(dialog && dialog.contains(document.activeElement));
  });
  check('D1-05', afterTab, 'forward Tab stays inside the topmost dialog');

  for (let index = 0; index < 6; index += 1) await page.keyboard.press('Shift+Tab');
  const afterShiftTab = await page.evaluate(() => {
    const dialog = document.querySelector('.ocs-dialog');
    return Boolean(dialog && dialog.contains(document.activeElement));
  });
  check('D1-06', afterShiftTab, 'backward Shift+Tab stays inside the topmost dialog');

  const openEnvironment = await readEnvironment();
  check('D1-07', openEnvironment.backgroundInert, 'the application shell is inert while a dialog is open');
  check('D1-08', openEnvironment.overflow === 'hidden', 'body scroll is locked while a dialog is open');

  await page.keyboard.press('Escape');
  await ocsDialog.waitFor({ state: 'detached', timeout: 10_000 });
  const restored = await page.evaluate(() => document.activeElement?.textContent ?? '');
  check('D1-09', restored.includes('Adjust Balance'), `Escape restores focus to the trigger (saw "${restored.trim()}")`);

  const closedEnvironment = await readEnvironment();
  check('D1-10', !closedEnvironment.inertRoot && closedEnvironment.inertCount === 0, 'closing restores the inert state');
  check('D1-11', closedEnvironment.overflow === '', `closing restores the original body overflow (saw "${closedEnvironment.overflow}")`);

  await adjustTrigger.click();
  await ocsDialog.waitFor({ state: 'visible', timeout: 10_000 });
  await page.mouse.click(4, 4);
  await ocsDialog.waitFor({ state: 'detached', timeout: 10_000 });
  check('D1-12', (await ocsDialog.count()) === 0, 'backdrop interaction dismisses the modal when allowed');

  /* ------------------------------------------------------------------ */
  /* D2: blocked dismissal during an in-flight mutation                 */
  /* ------------------------------------------------------------------ */
  console.log('\n--- D2: blocked dismissal during an in-flight mutation ---');
  let releaseAdjust;
  const adjustGate = new Promise((resolve) => {
    releaseAdjust = resolve;
  });
  let resolveAdjustRequested;
  const adjustRequested = new Promise((resolve) => {
    resolveAdjustRequested = resolve;
  });
  adjustPosts = 0;
  adjustHandler = async (route) => {
    resolveAdjustRequested();
    await adjustGate;
    currentBalance = balanceRecord({ version: 5 });
    return json(route, { ok: true, outcome: 'success', message: 'Balance adjusted successfully' });
  };

  await adjustTrigger.click();
  await ocsDialog.waitFor({ state: 'visible', timeout: 10_000 });
  await ocsDialog.locator('#adjust-amount').fill('1');
  await ocsDialog.locator('#adjust-reason').fill('In-flight dismissal guard');
  await ocsDialog.locator('button[type="submit"]').click();
  await ocsDialog.locator('.ocs-review-workflow').waitFor({ state: 'visible', timeout: 10_000 });
  await ocsDialog.locator('button:has-text("Confirm Adjustment")').click();
  await adjustRequested;

  check('D2-01', (await ocsDialog.locator('button[aria-label="Close"]').isDisabled()) === true, 'the close control is disabled in flight');
  await page.keyboard.press('Escape');
  await page.mouse.click(4, 4);
  await page.keyboard.press('Escape');
  check('D2-02', (await ocsDialog.count()) === 1, 'Escape and backdrop cannot dismiss a blocked dialog');
  check('D2-03', adjustPosts === 1, `exactly one mutation was dispatched (${adjustPosts})`);

  releaseAdjust();
  await ocsDialog.waitFor({ state: 'detached', timeout: 10_000 });
  check('D2-04', true, 'the permitted closure works once the mutation settles');
  const settled = await readEnvironment();
  check('D2-05', settled.overflow === '' && !settled.inertRoot, 'locks are released after the settled mutation');
  adjustHandler = null;

  /* ------------------------------------------------------------------ */
  /* D3/D5: nested overlays, portal ownership and stacking              */
  /* ------------------------------------------------------------------ */
  console.log('\n--- D3/D5: nested overlays and portal behaviour ---');
  await page.goto(`${baseUrl}/discovery?view=candidates`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  const candidateRow = page.locator('[data-discovery-view="candidates"] tbody tr').first();
  await candidateRow.waitFor({ state: 'visible', timeout: 20_000 });
  await candidateRow.locator('button').first().click();

  const drawer = page.locator('[role="dialog"]').filter({ hasText: 'Local runtime onboarding' });
  await drawer.waitFor({ state: 'visible', timeout: 15_000 });
  check('D3-01', (await page.locator('[role="dialog"]').count()) === 1, 'the parent drawer is the only overlay');

  const drawerEnvironment = await readEnvironment();
  check('D3-02', drawerEnvironment.backgroundInert, 'the background is inert while the parent drawer is open');

  const previewButton = drawer.locator('button:has-text("Preview onboarding")');
  await previewButton.waitFor({ state: 'visible', timeout: 15_000 });
  await previewButton.click();

  const child = page.locator('.modal-card');
  await child.waitFor({ state: 'visible', timeout: 15_000 });
  check('D3-03', (await child.locator('h2').textContent())?.trim() === 'Governed monitoring bootstrap', 'the child dialog is rendered');
  check('D3-04', (await previewButton.isVisible()) === true, 'the parent drawer stays mounted under the child');

  const nested = await page.evaluate(() => {
    const drawerElement = Array.from(document.querySelectorAll('[role="dialog"]')).find((element) =>
      (element.textContent ?? '').includes('Local runtime onboarding'),
    );
    const modal = document.querySelector('.modal-card');
    return {
      drawerInert: Boolean(drawerElement?.closest('[inert]')),
      rootInert: Boolean(document.getElementById('root')?.inert),
      portalHosts: document.querySelectorAll('[data-xcloud-overlay-portal]').length,
      portalUnderBody: Boolean(document.querySelector('[data-xcloud-overlay-portal]')?.parentElement === document.body),
      portalInsideRoot: Boolean(document.querySelector('[data-xcloud-overlay-portal]')?.closest('#root')),
      modalZ: Number(window.getComputedStyle(modal?.parentElement ?? modal).zIndex),
      drawerZ: Number(window.getComputedStyle(drawerElement?.parentElement ?? drawerElement).zIndex),
      theme: document.documentElement.getAttribute('data-theme'),
    };
  });
  check('D3-05', nested.drawerInert, 'the parent drawer is non-interactive while the child is topmost');
  check('D3-06', nested.rootInert, 'the application root stays inert for the nested overlay');
  check('D5-01', nested.portalHosts === 1, `exactly one portal host owns the overlay (${nested.portalHosts})`);
  check('D5-02', nested.portalUnderBody && !nested.portalInsideRoot, 'the portal is a body-level boundary, not a second app root');
  check('D5-03', nested.modalZ > nested.drawerZ, `the child stacks above the parent (child=${nested.modalZ}, parent=${nested.drawerZ})`);
  check('D5-04', nested.theme === 'light', `theme remains inherited through the portal (${nested.theme})`);

  for (let index = 0; index < 12; index += 1) await page.keyboard.press('Tab');
  const tabInChild = await page.evaluate(() => Boolean(document.querySelector('.modal-card')?.contains(document.activeElement)));
  check('D3-07', tabInChild, 'keyboard focus cannot leave the topmost child dialog');

  await page.keyboard.press('Escape');
  await child.waitFor({ state: 'detached', timeout: 10_000 });
  check('D3-08', (await drawer.count()) === 1, 'Escape closes only the topmost overlay');
  const focusBack = await page.evaluate(() => document.activeElement?.textContent ?? '');
  check('D3-09', focusBack.includes('Preview onboarding'), `focus returns to the parent control (saw "${focusBack.trim()}")`);
  check('D5-05', (await page.locator('[data-xcloud-overlay-portal]').count()) === 0, 'the portal host is removed with its last overlay');

  /* G2: an in-flight governed apply cannot be dismissed */
  await previewButton.click();
  await child.waitFor({ state: 'visible', timeout: 15_000 });
  let releaseApply;
  const applyGate = new Promise((resolve) => {
    releaseApply = resolve;
  });
  let resolveApplyRequested;
  const applyRequested = new Promise((resolve) => {
    resolveApplyRequested = resolve;
  });
  applyHandler = async (route) => {
    resolveApplyRequested();
    await applyGate;
    return json(route, BOOTSTRAP_RESULT);
  };
  await child.locator('button:has-text("Approve and apply")').click();
  await applyRequested;
  await page.keyboard.press('Escape');
  await page.mouse.click(4, 4);
  check('D3-10', (await child.count()) === 1, 'an in-flight apply blocks Escape and backdrop dismissal');
  check(
    'D3-11',
    (await child.locator('button:has-text("Close")').isDisabled()) === true,
    'the explicit close action is disabled while the apply is in flight',
  );
  releaseApply();
  await child.locator('button:has-text("Close")').click();
  await child.waitFor({ state: 'detached', timeout: 10_000 });
  check('D3-12', (await drawer.count()) === 1, 'the parent drawer survives the child closure');
  applyHandler = null;

  await page.keyboard.press('Escape');
  await drawer.waitFor({ state: 'detached', timeout: 10_000 });
  const afterBoth = await readEnvironment();
  check('D3-13', !afterBoth.inertRoot && afterBoth.inertCount === 0, 'closing both overlays releases every inert lock');
  check('D3-14', afterBoth.overflow === '', 'closing both overlays restores body scroll');

  /* ------------------------------------------------------------------ */
  /* D4: client-side route transition while a dialog is open            */
  /* ------------------------------------------------------------------ */
  console.log('\n--- D4: route transition while a dialog is open ---');
  await openBalanceDetail();
  await adjustTrigger.click();
  await ocsDialog.waitFor({ state: 'visible', timeout: 10_000 });

  await page.evaluate(() => {
    window.history.pushState({}, '', '/ocs/balances');
    window.dispatchEvent(new window.PopStateEvent('popstate'));
  });
  await page.locator('.ocs-table').waitFor({ state: 'visible', timeout: 15_000 });
  const afterNavigation = await readEnvironment();
  check('D4-01', (await ocsDialog.count()) === 0, 'the dialog unmounts with its route');
  check('D4-02', afterNavigation.overflow === '' && !afterNavigation.inertRoot, 'the route transition releases body and inert locks');
  check('D4-03', afterNavigation.ariaHiddenRoot === null, 'the route transition restores the original aria-hidden state');

  const rowAdjust = page.locator(`button[aria-label="Adjust Balance ${TEST_IMSI}"]`).first();
  await rowAdjust.click();
  await ocsDialog.waitFor({ state: 'visible', timeout: 10_000 });
  check('D4-04', true, 'the shell stays interactive after the transition');
  await page.keyboard.press('Escape');
  await ocsDialog.waitFor({ state: 'detached', timeout: 10_000 });

  /* ------------------------------------------------------------------ */
  /* D7: responsive geometry                                            */
  /* ------------------------------------------------------------------ */
  console.log('\n--- D7: responsive geometry ---');
  await page.setViewportSize(MOBILE);
  await openBalanceDetail();
  await adjustTrigger.click();
  await ocsDialog.waitFor({ state: 'visible', timeout: 10_000 });

  const mobile = await page.evaluate(() => {
    const box = document.querySelector('.ocs-dialog')?.getBoundingClientRect();
    return {
      width: box?.width ?? 0,
      left: box?.left ?? -1,
      overflow: document.documentElement.scrollWidth > window.innerWidth,
    };
  });
  check('D7-01', mobile.width <= MOBILE.width && mobile.left >= 0, `the dialog fits the mobile viewport (width=${mobile.width})`);
  check('D7-02', mobile.overflow === false, 'no horizontal overflow at 375x812');
  await ocsDialog.locator('#adjust-amount').fill('1');
  await ocsDialog.locator('#adjust-reason').fill('Mobile dialog acceptance');
  await ocsDialog.locator('button[type="submit"]').click();
  await ocsDialog.locator('.ocs-review-workflow').waitFor({ state: 'visible', timeout: 10_000 });
  const confirmVisible = await ocsDialog.locator('button:has-text("Confirm Adjustment")').isVisible();
  check('D7-03', confirmVisible, 'important actions remain reachable on mobile');
  await ocsDialog.locator('button:has-text("Cancel")').click();
  await ocsDialog.waitFor({ state: 'detached', timeout: 10_000 });
  await page.setViewportSize(DESKTOP);

  /* ------------------------------------------------------------------ */
  /* Global gates                                                       */
  /* ------------------------------------------------------------------ */
  check('SYS-01', pageErrors.length === 0, `zero uncaught page exceptions (${pageErrors.length})`);
  check('SYS-02', consoleErrors.length === 0, `zero unexpected console errors (${consoleErrors.length})`);
  check('SYS-03', fixture.unexpected.length === 0, `no unexpected API request (${fixture.unexpected.join(', ')})`);
} catch (error) {
  console.error('[acceptance:dialogs] Unexpected test error:', error);
  failures.push(`unexpected: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  if (browser) await browser.close().catch(() => {});
  if (fixture) await fixture.close().catch(() => {});
  if (temporaryBuildDirectory) await rm(temporaryBuildDirectory, { recursive: true, force: true }).catch(() => {});
}

console.log('\n=============================================================');
if (failures.length > 0) {
  console.error(`[acceptance:dialogs] FAILED ${failures.length} check(s) of ${checks.length}`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`[acceptance:dialogs] passed ${checks.length}/${checks.length} assertions`);
