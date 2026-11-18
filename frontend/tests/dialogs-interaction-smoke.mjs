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
 *   D6  subscriber import dismissal safety: in-flight import POST refuses
 *       Escape, backdrop, header close and footer Cancel dismissal
 *   D7  responsive: 1440x900 and 375x812
 *   D8  nested notification channel removal: topmost child alertdialog receives
 *       focus, inerts parent, wraps Tab, Escape closes only child
 *   D9  in-flight notification removal: pending DELETE blocks dismissal
 *   D10 other nested confirmation surfaces: escalation removal and delivery
 *       retry confirmation interactively isolated without inert inheritance
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

const BENIGN_CONSOLE = [/Download the React DevTools/i, /favicon/i, /status of 409/i, /net::ERR_FAILED/i, /Failed to fetch/i];

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

const NOTIFY_CHANNELS = [
  { id: 'ch-1', name: 'Ops webhook', kind: 'webhook', enabled: true, url: 'https://hooks.example.com/alert', revision: 1, createdAt: '2026-10-01T08:00:00Z', updatedAt: '2026-10-01T08:00:00Z' },
];

const NOTIFY_ESCALATIONS = [
  { id: 'esc-1', name: 'Critical to ops', enabled: true, severities: ['critical'], channelIds: ['ch-1'], escalateAfterSeconds: 300, escalateChannelIds: ['ch-1'], revision: 1, createdAt: '2026-10-01T08:00:00Z', updatedAt: '2026-10-01T08:00:00Z' },
];

const NOTIFY_DELIVERIES = [
  { id: 'd-1', deliveryKey: 'alert-critical-active:opened:ch-1', event: 'opened', alertId: 'alert-critical-active', ruleId: 'rule-1', ruleName: 'AMF process unhealthy', targetId: 'target-amf', targetName: 'amf-01', severity: 'critical', triggerCount: 1, occurredAt: '2026-10-01T08:00:00Z', channelId: 'ch-1', status: 'sent', attempts: 1, createdAt: '2026-10-01T08:00:00Z', completedAt: '2026-10-01T08:00:00Z' },
  { id: 'd-2', deliveryKey: 'alert-critical-active:opened:ch-2', event: 'opened', alertId: 'alert-critical-active', ruleId: 'rule-1', ruleName: 'AMF process unhealthy', targetId: 'target-amf', targetName: 'amf-01', severity: 'critical', triggerCount: 1, occurredAt: '2026-10-05T12:00:00Z', channelId: 'ch-1', status: 'failed', attempts: 3, lastError: 'connection refused', nextAttemptAt: '2026-10-05T12:05:00Z', createdAt: '2026-10-05T12:00:00Z' },
];

  let currentBalance = balanceRecord();
  let precheckPosts = 0;
  let importPosts = 0;
  let importHandler = null;
  let notifyChannels = [...NOTIFY_CHANNELS];
  let notifyEscalations = [...NOTIFY_ESCALATIONS];
  let notifyDeliveries = [...NOTIFY_DELIVERIES];
  let deleteChannelPosts = 0;
  let deleteChannelHandler = null;
  let deleteEscalationPosts = 0;
  let deleteEscalationHandler = null;
  let retryDeliveryPosts = 0;
  let retryDeliveryHandler = null;
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

    if (pathname === '/api/subscribers' && method === 'GET') {
      return json(route, {
        subscribers: [
          {
            imsi: TEST_IMSI,
            msisdn: '18800000001',
            status: 'active',
            contractStatus: 'active',
            balanceState: 'normal',
            policy: 'default_plan',
            policyName: 'Standard 5G Plan',
            traffic: { used: 2147483648, total: 10737418240, balance: 8589934592 },
          },
        ],
        total: 1,
        page: 1,
        pageSize: 10,
        totalPages: 1,
      });
    }
    if (pathname === '/api/subscribers/summary') {
      return json(route, { total: 1, active: 1, suspended: 0, terminated: 0 });
    }
    if (pathname === '/api/profiles') {
      return json(route, { profiles: [] });
    }
    if (pathname === '/api/subscribers/import') {
      const mode = url.searchParams.get('mode');
      if (mode === 'precheck' && method === 'POST') {
        precheckPosts += 1;
        return json(route, { total: 1, existing: 0, newCount: 1, conflicts: [] });
      }
      if (mode === 'import' && method === 'POST') {
        importPosts += 1;
        if (importHandler) return importHandler(route);
        return json(route, {
          result: { requested: 1, imported: 1, skipped: 0, failed: 0, failedImsis: [] },
        });
      }
    }

    if (pathname === '/api/nf-alerts/summary') {
      return json(route, { total: 1, critical: 1, warning: 0, info: 0, acknowledged: 0 });
    }
    if (pathname === '/api/nf-alerts/rules' && method === 'GET') {
      return json(route, {
        rules: [
          {
            ruleId: 'rule-1',
            name: 'AMF process unhealthy',
            enabled: true,
            severity: 'critical',
            conditionType: 'state',
            condition: { scope: 'process', state: 'unhealthy' },
            cooldownSeconds: 300,
            revision: 1,
            createdAt: '2026-10-01T08:00:00Z',
            updatedAt: '2026-10-01T08:00:00Z',
          },
        ],
        page: { total: 1, limit: 20, cursor: null, nextCursor: null, hasMore: false },
      });
    }
    if (pathname === '/api/nf-alerts/meta') {
      return json(route, {
        schemaVersion: 1,
        alertStates: ['active', 'acknowledged', 'resolved'],
        severities: ['critical', 'warning', 'info'],
        conditionTypes: ['state', 'run_failed'],
        conditionScopes: ['overall', 'process', 'interface', 'service'],
        stateConditionValues: ['unhealthy', 'degraded', 'unknown'],
        resolveReasons: ['recovery', 'manual', 'rule_deleted'],
        minCooldownSeconds: 60,
        maxCooldownSeconds: 86400,
        defaultCooldownSeconds: 300,
        runStatuses: ['success', 'partial', 'failed'],
      });
    }
    if (pathname === '/api/nf-alerts' && method === 'GET') {
      return json(route, { alerts: [], page: { total: 0, limit: 20, cursor: null, nextCursor: null, hasMore: false } });
    }
    if (pathname === '/api/nf-notifications/channels' && method === 'GET') {
      return json(route, { channels: notifyChannels });
    }
    if (pathname.startsWith('/api/nf-notifications/channels/') && method === 'DELETE') {
      deleteChannelPosts += 1;
      if (deleteChannelHandler) return deleteChannelHandler(route);
      const channelId = decodeURIComponent(pathname.slice('/api/nf-notifications/channels/'.length));
      notifyChannels = notifyChannels.filter((c) => c.id !== channelId);
      return json(route, { status: 'deleted' });
    }
    if (pathname === '/api/nf-notifications/escalations' && method === 'GET') {
      return json(route, { escalations: notifyEscalations });
    }
    if (pathname.startsWith('/api/nf-notifications/escalations/') && method === 'DELETE') {
      deleteEscalationPosts += 1;
      if (deleteEscalationHandler) return deleteEscalationHandler(route);
      const escId = decodeURIComponent(pathname.slice('/api/nf-notifications/escalations/'.length));
      notifyEscalations = notifyEscalations.filter((e) => e.id !== escId);
      return json(route, { status: 'deleted' });
    }
    if (pathname === '/api/nf-notifications/deliveries' && method === 'GET') {
      return json(route, {
        deliveries: notifyDeliveries,
        page: { limit: 50, nextCursor: null, hasMore: false },
      });
    }
    if (pathname.startsWith('/api/nf-notifications/deliveries/') && pathname.endsWith('/retry') && method === 'POST') {
      retryDeliveryPosts += 1;
      if (retryDeliveryHandler) return retryDeliveryHandler(route);
      const deliveryId = decodeURIComponent(pathname.slice('/api/nf-notifications/deliveries/'.length, -'/retry'.length));
      const existing = notifyDeliveries.find((d) => d.id === deliveryId) || notifyDeliveries[1];
      const updated = { ...existing, status: 'pending', attempts: 0, lastError: '' };
      notifyDeliveries = notifyDeliveries.map((d) => (d.id === deliveryId ? updated : d));
      return json(route, updated);
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
  const bootstrapInertAncestor = await child.evaluate((el) => {
    let cur = el;
    while (cur && cur !== document.body) {
      if (cur.inert) return cur.tagName;
      cur = cur.parentElement;
    }
    return null;
  });
  check('D3-15', bootstrapInertAncestor === null, 'portaled child dialog has no inert ancestor');
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
  /* D6: subscriber import dismissal safety during in-flight import POST */
  /* ------------------------------------------------------------------ */
  console.log('\n--- D6: subscriber import in-flight dismissal safety ---');
  await page.goto(`${baseUrl}/subscribers`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  const importTrigger = page.locator('button[title="Import subscribers"], button:has-text("Import subscribers")').first();
  await importTrigger.waitFor({ state: 'visible', timeout: 15_000 });
  await importTrigger.click();

  const importDialog = page.locator('[role="dialog"]').filter({ hasText: 'Import subscribers' });
  await importDialog.waitFor({ state: 'visible', timeout: 10_000 });
  check('D6-01', (await importDialog.isVisible()) === true, 'subscriber import dialog opened');

  const csvContent = 'imsi,plan_id\n460001234567891,default_plan\n';
  await page.locator('#subscriber-import-file').setInputFiles({
    name: 'subscribers.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(csvContent),
  });

  await importDialog.locator('text=1 rows: 1 valid').waitFor({ state: 'visible', timeout: 5000 });
  check('D6-02', true, 'valid import file parsed and summary rendered');

  await importDialog.locator('button:has-text("Precheck")').click();
  await importDialog.locator('text=Precheck: 0 IMSI already exist, 1 can be created').waitFor({ state: 'visible', timeout: 5000 });
  check('D6-03', precheckPosts === 1, 'precheck completed without blocking dismissal');

  let releaseImport;
  const importGate = new Promise((resolve) => { releaseImport = resolve; });
  let resolveImportRequested;
  const importRequested = new Promise((resolve) => { resolveImportRequested = resolve; });
  importPosts = 0;
  importHandler = async (route) => {
    resolveImportRequested();
    await importGate;
    return json(route, {
      result: { requested: 1, imported: 1, skipped: 0, failed: 0, failedImsis: [] },
    });
  };

  await importDialog.locator('button:has-text("Import")').click();
  await importRequested;

  check('D6-04', importPosts === 1, `exactly one import POST dispatched in-flight (${importPosts})`);
  check('D6-05', (await importDialog.locator('.workflow-header button.btn-icon').isDisabled()) === true, 'header close button is disabled in flight');
  check('D6-06', (await importDialog.locator('.workflow-footer-actions button:has-text("Cancel")').isDisabled()) === true, 'footer cancel button is disabled in flight');

  await importDialog.locator('.workflow-header button.btn-icon').click({ force: true }).catch(() => {});
  await importDialog.locator('.workflow-footer-actions button:has-text("Cancel")').click({ force: true }).catch(() => {});
  await page.keyboard.press('Escape');
  await page.mouse.click(4, 4);

  check('D6-07', (await importDialog.isVisible()) === true, 'modal remains open across header X, Cancel, Escape and backdrop attempts');
  check('D6-08', importPosts === 1, 'pending request remains intact and no duplicate POST was dispatched');

  releaseImport();
  await importDialog.locator('text=Import finished: 1 requested, 1 created, 0 failed').waitFor({ state: 'visible', timeout: 5000 });
  check('D6-09', true, 'returned import result is displayed');

  check('D6-10', (await importDialog.locator('.workflow-header button.btn-icon').isDisabled()) === false, 'header close button re-enabled after settlement');
  check('D6-11', (await importDialog.locator('.workflow-footer-actions button:has-text("Close")').isDisabled()) === false, 'footer close button enabled after settlement');

  await importDialog.locator('.workflow-footer-actions button:has-text("Close")').click();
  await importDialog.waitFor({ state: 'detached', timeout: 5000 });
  check('D6-12', (await importDialog.count()) === 0, 'modal dismissed through Close button after settlement');
  check('D6-13', importPosts === 1, 'overall import POST count remains exactly 1');
  importHandler = null;

  /* Documented failure flow */
  await importTrigger.click();
  await importDialog.waitFor({ state: 'visible', timeout: 10_000 });
  await page.locator('#subscriber-import-file').setInputFiles({
    name: 'subscribers.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(csvContent),
  });
  await importDialog.locator('text=1 rows: 1 valid').waitFor({ state: 'visible', timeout: 5000 });

  let releaseFail;
  const failGate = new Promise((resolve) => { releaseFail = resolve; });
  let resolveFailRequested;
  const failRequested = new Promise((resolve) => { resolveFailRequested = resolve; });
  importPosts = 0;
  importHandler = async (route) => {
    resolveFailRequested();
    await failGate;
    return json(route, { error: 'Import conflict: IMSI already provisioned', code: 'IMPORT_CONFLICT' }, 409);
  };

  await importDialog.locator('button:has-text("Import")').click();
  await failRequested;
  check('D6-14', (await importDialog.locator('.workflow-header button.btn-icon').isDisabled()) === true, 'header close disabled during failing import in-flight');
  await page.keyboard.press('Escape');
  await page.mouse.click(4, 4);
  check('D6-15', (await importDialog.isVisible()) === true, 'modal remains open while failing import is pending');

  releaseFail();
  await importDialog.locator('text=Import conflict: IMSI already provisioned').waitFor({ state: 'visible', timeout: 5000 });
  check('D6-16', true, 'documented failure error notice is displayed');

  await importDialog.locator('.workflow-header button.btn-icon').click();
  await importDialog.waitFor({ state: 'detached', timeout: 5000 });
  check('D6-17', (await importDialog.count()) === 0, 'modal closed after failure settlement');
  importHandler = null;

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
  /* D8: nested notification channel removal confirmation               */
  /* ------------------------------------------------------------------ */
  console.log('\n--- D8: nested notification channel removal confirmation ---');
  await page.goto(`${baseUrl}/nf-alerts?view=rules`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  const notifyBtn = page.locator('button[data-nf-notify-open="true"], button:has-text("Notification Settings")').first();
  await notifyBtn.waitFor({ state: 'visible', timeout: 15_000 });
  await notifyBtn.click();

  const notifyDialog = page.locator('[role="dialog"]').filter({ hasText: 'Notifications' });
  await notifyDialog.waitFor({ state: 'visible', timeout: 10_000 });
  check('D8-01', (await notifyDialog.isVisible()) === true, 'notification settings parent dialog opened');

  const channelRow = notifyDialog.locator('[data-notify-channel="ch-1"]');
  await channelRow.waitFor({ state: 'visible', timeout: 5000 });
  check('D8-02', (await channelRow.isVisible()) === true, 'fixture notification channel row is displayed');

  const removeChannelBtn = channelRow.locator('button[aria-label="Remove channel"], button:has-text("Remove channel")');
  await removeChannelBtn.click();

  const channelConfirm = page.locator('[role="alertdialog"]').filter({ hasText: 'Remove channel' });
  await channelConfirm.waitFor({ state: 'visible', timeout: 5000 });
  check('D8-03', (await channelConfirm.isVisible()) === true, 'channel removal confirmation dialog opened');

  const nestingInspection = await page.evaluate(() => {
    const parentDialog = Array.from(document.querySelectorAll('[role="dialog"]')).find((el) =>
      (el.textContent ?? '').includes('Notifications'),
    );
    const childDialog = Array.from(document.querySelectorAll('[role="alertdialog"]')).find((el) =>
      (el.textContent ?? '').includes('Remove channel'),
    );
    const childInertAncestor = (() => {
      let cur = childDialog;
      while (cur && cur !== document.body) {
        if (cur.inert) return cur.tagName + (cur.className ? '.' + cur.className : '');
        cur = cur.parentElement;
      }
      return null;
    })();
    const parentLayer = parentDialog?.parentElement;
    const childHost = childDialog?.closest('[data-xcloud-overlay-portal]');
    return {
      childInertAncestor,
      parentInert: Boolean(parentLayer?.inert || parentDialog?.closest('[inert]')),
      childInRoot: Boolean(childDialog?.closest('#root')),
      portalHostPresent: Boolean(childHost),
    };
  });

  check('D8-04', nestingInspection.portalHostPresent && !nestingInspection.childInRoot, 'child confirmation dialog mounts through independent body-level portal');
  check('D8-05', nestingInspection.childInertAncestor === null, `topmost child confirmation has no inert ancestor (saw ${nestingInspection.childInertAncestor})`);
  check('D8-06', nestingInspection.parentInert, 'parent notification settings dialog is inert while child confirmation is open');

  const initialChildFocus = await channelConfirm.evaluate((el) => el.contains(document.activeElement));
  check('D8-07', initialChildFocus, 'child confirmation dialog receives initial focus');

  for (let i = 0; i < 6; i++) await page.keyboard.press('Tab');
  const tabInChildConfirm = await channelConfirm.evaluate((el) => el.contains(document.activeElement));
  check('D8-08', tabInChildConfirm, 'Tab navigation wraps inside child confirmation dialog');

  for (let i = 0; i < 4; i++) await page.keyboard.press('Shift+Tab');
  const shiftTabInChildConfirm = await channelConfirm.evaluate((el) => el.contains(document.activeElement));
  check('D8-09', shiftTabInChildConfirm, 'Shift+Tab navigation wraps inside child confirmation dialog');

  await page.keyboard.press('Escape');
  await channelConfirm.waitFor({ state: 'detached', timeout: 5000 });
  check('D8-10', (await notifyDialog.isVisible()) === true, 'Escape closes only the child confirmation; parent dialog remains open');

  const focusRestoredTo = await page.evaluate(() => document.activeElement?.getAttribute('aria-label') || document.activeElement?.textContent?.trim());
  check('D8-11', focusRestoredTo === 'Remove channel' || (focusRestoredTo && focusRestoredTo.includes('Remove channel')), `focus restored to remove trigger (saw "${focusRestoredTo}")`);
  check('D8-12', deleteChannelPosts === 0, `no DELETE request dispatched on cancellation (${deleteChannelPosts})`);

  /* ------------------------------------------------------------------ */
  /* D9: in-flight notification removal dismissal blocking              */
  /* ------------------------------------------------------------------ */
  console.log('\n--- D9: in-flight notification removal dismissal blocking ---');
  await removeChannelBtn.click();
  await channelConfirm.waitFor({ state: 'visible', timeout: 5000 });

  let releaseDelete;
  const deleteGate = new Promise((resolve) => { releaseDelete = resolve; });
  let resolveDeleteRequested;
  const deleteRequested = new Promise((resolve) => { resolveDeleteRequested = resolve; });
  deleteChannelPosts = 0;
  deleteChannelHandler = async (route) => {
    resolveDeleteRequested();
    await deleteGate;
    return json(route, { status: 'deleted' });
  };

  await channelConfirm.locator('button:has-text("Delete")').click();
  await deleteRequested;

  check('D9-01', deleteChannelPosts === 1, `exactly one DELETE request dispatched in-flight (${deleteChannelPosts})`);
  check('D9-02', (await channelConfirm.locator('button:has-text("Cancel")').isDisabled()) === true, 'cancel button is disabled during in-flight removal');
  check('D9-03', (await channelConfirm.locator('button:has-text("Loading..."), button:has-text("Delete")').isDisabled()) === true, 'confirm button is disabled during in-flight removal');

  await page.keyboard.press('Escape');
  await page.mouse.click(4, 4);

  check('D9-04', (await channelConfirm.isVisible()) === true, 'child confirmation remains open across Escape and backdrop attempts while busy');
  check('D9-05', (await notifyDialog.isVisible()) === true, 'parent dialog remains open and untouched while child is busy');

  releaseDelete();
  await channelConfirm.waitFor({ state: 'detached', timeout: 5000 });
  check('D9-06', (await channelConfirm.count()) === 0, 'confirmation dialog detached upon settlement');

  const parentInteractiveAfterDelete = await notifyDialog.evaluate((el) => !el.closest('[inert]') && !el.inert);
  check('D9-07', parentInteractiveAfterDelete, 'parent dialog background locks released and interactive again after child closes');
  deleteChannelHandler = null;

  /* ------------------------------------------------------------------ */
  /* D10: other nested confirmation surfaces (escalation & delivery)    */
  /* ------------------------------------------------------------------ */
  console.log('\n--- D10: escalation removal and delivery retry confirmation surfaces ---');
  // Escalation removal
  await notifyDialog.locator('button[data-notify-tab="escalations"]').click();
  const escRow = notifyDialog.locator('[data-notify-escalation="esc-1"]');
  await escRow.waitFor({ state: 'visible', timeout: 5000 });
  check('D10-01', (await escRow.isVisible()) === true, 'escalation rule fixture row is displayed');

  const removeEscBtn = escRow.locator('button[aria-label="Remove escalation"], button:has-text("Remove escalation")');
  await removeEscBtn.click();

  const escConfirm = page.locator('[role="alertdialog"]').filter({ hasText: 'Remove escalation rule' });
  await escConfirm.waitFor({ state: 'visible', timeout: 5000 });
  check('D10-02', (await escConfirm.isVisible()) === true, 'escalation removal confirmation dialog opened');

  const escInertAncestor = await escConfirm.evaluate((el) => {
    let cur = el;
    while (cur && cur !== document.body) {
      if (cur.inert) return cur.tagName;
      cur = cur.parentElement;
    }
    return null;
  });
  check('D10-03', escInertAncestor === null, 'escalation confirmation dialog has no inert ancestor');

  const escFocusInside = await escConfirm.evaluate((el) => el.contains(document.activeElement));
  check('D10-04', escFocusInside, 'initial focus enters escalation confirmation dialog');

  await page.keyboard.press('Escape');
  await escConfirm.waitFor({ state: 'detached', timeout: 5000 });
  check('D10-05', (await notifyDialog.isVisible()) === true, 'Escape closes only escalation confirmation; parent dialog remains open');
  check('D10-05b', deleteEscalationPosts === 0, 'no DELETE escalation request dispatched on cancellation');

  // Delivery retry confirmation
  await notifyDialog.locator('button[data-notify-tab="deliveries"]').click();
  const deliveriesTable = notifyDialog.locator('table[data-notify-deliveries="true"]');
  await deliveriesTable.waitFor({ state: 'visible', timeout: 5000 });
  check('D10-06', (await deliveriesTable.isVisible()) === true, 'deliveries ledger table rendered');

  const retryRow = notifyDialog.locator('tr[data-notify-delivery="d-2"]');
  await retryRow.waitFor({ state: 'visible', timeout: 5000 });
  const retryBtn = retryRow.locator('button:has-text("Retry")');
  await retryBtn.click();

  const retryConfirm = page.locator('[role="alertdialog"]').filter({ hasText: 'Retry notification delivery' });
  await retryConfirm.waitFor({ state: 'visible', timeout: 5000 });
  check('D10-07', (await retryConfirm.isVisible()) === true, 'delivery retry confirmation dialog opened');

  const retryInertAncestor = await retryConfirm.evaluate((el) => {
    let cur = el;
    while (cur && cur !== document.body) {
      if (cur.inert) return cur.tagName;
      cur = cur.parentElement;
    }
    return null;
  });
  check('D10-08', retryInertAncestor === null, 'delivery retry confirmation dialog has no inert ancestor');

  const retryFocusInside = await retryConfirm.evaluate((el) => el.contains(document.activeElement));
  check('D10-09', retryFocusInside, 'initial focus enters delivery retry confirmation dialog');

  let releaseRetry;
  const retryGate = new Promise((resolve) => { releaseRetry = resolve; });
  let resolveRetryRequested;
  const retryRequested = new Promise((resolve) => { resolveRetryRequested = resolve; });
  retryDeliveryPosts = 0;
  retryDeliveryHandler = async (route) => {
    resolveRetryRequested();
    await retryGate;
    return json(route, { ...NOTIFY_DELIVERIES[1], status: 'pending', attempts: 0 });
  };

  await retryConfirm.locator('button:has-text("Retry")').click();
  await retryRequested;
  check('D10-10', retryDeliveryPosts === 1, `exactly one retry POST dispatched in-flight (${retryDeliveryPosts})`);

  await page.keyboard.press('Escape');
  await page.mouse.click(4, 4);
  check('D10-11', (await retryConfirm.isVisible()) === true, 'retry confirmation dialog remains open while retry POST is in flight');

  releaseRetry();
  await retryConfirm.waitFor({ state: 'detached', timeout: 5000 });
  check('D10-12', true, 'retry confirmation detached after settlement');
  retryDeliveryHandler = null;

  // Close parent notifyDialog and verify total cleanup
  await notifyDialog.locator('header button[aria-label="Close"], header button.btn-ghost').first().click();
  await notifyDialog.waitFor({ state: 'detached', timeout: 5000 });
  const finalNotifyEnv = await readEnvironment();
  check('D10-13', !finalNotifyEnv.inertRoot && finalNotifyEnv.inertCount === 0, 'closing all dialogs completely clears inert state');
  check('D10-14', finalNotifyEnv.overflow === '', 'closing all dialogs restores body overflow');
  check('D10-15', finalNotifyEnv.portalHosts === 0, 'all portal hosts removed upon closing nested dialogs');


  /* ------------------------------------------------------------------ */
  /* Global gates                                                       */
  /* ------------------------------------------------------------------ */
  check('SYS-01', pageErrors.length === 0, `zero uncaught page exceptions (${pageErrors.length})`);
  check('SYS-02', consoleErrors.length === 0, `zero unexpected console errors (${consoleErrors.length}: ${consoleErrors.join(' | ')})`);
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
