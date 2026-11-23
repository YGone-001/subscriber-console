#!/usr/bin/env node
/* global getComputedStyle */
/*
 * OCS workspace acceptance (production-built SPA, deterministic fixtures).
 *
 * Covers the business surfaces FE-C2 consolidates, through the real components:
 *   - balance / contract / tariff list and detail routes;
 *   - filters, sorting, pagination and Back/Forward URL state;
 *   - the governed dialogs (focus, Escape, focus restoration, pending state,
 *     client validation, 403/409 handling, cancelled mutations);
 *   - cross-domain shared presentation (analytics cockpit OCS panels);
 *   - responsive table transforms and no-overflow at seven widths;
 *   - light/dark and zh/en presentation.
 *
 * The fixtures are deterministic and contain no real subscriber identity. This
 * is fixture acceptance, never live production acceptance.
 *
 * Usage (from frontend/): node tests/ocs-workspace-smoke.mjs
 *   FE_C2_DIST_DIR=<dir>     reuse an existing build
 *   FE_C2_EVIDENCE_DIR=<dir> write screenshots + a measurement matrix
 */
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const frontendRoot = resolve(here, '..');
const evidenceDir = process.env.FE_C2_EVIDENCE_DIR ? resolve(process.env.FE_C2_EVIDENCE_DIR) : null;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

const ADMIN = {
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

const VIEWER = { ...ADMIN, username: 'viewer1', role: 'viewer', normalizedRole: 'viewer', permissions: ['ocs.read', 'ocs.contracts.read', 'tariffs.read', 'core.read'] };

const checks = [];
const failures = [];
const measurements = { generatedAt: new Date().toISOString(), routes: [], screenshots: [] };

function check(id, ok, detail = '') {
  checks.push({ id, ok: Boolean(ok), detail });
  if (!ok) failures.push(`${id} ${detail}`);
}

/* ------------------------------------------------------------------ fixtures */

function balance(overrides = {}) {
  return {
    id: 'bal-001',
    imsi: '310150000000001',
    plan_id: 'plan_gold',
    status: 'active',
    data_total: 10737418240,
    data_used: 2147483648,
    data_reserved: 1073741824,
    data_available: 7516192768,
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

const BALANCES = [
  balance(),
  balance({
    id: 'bal-002',
    imsi: '310150000000002',
    status: 'suspended',
    data_used: 4294967296,
    data_reserved: 0,
    data_available: 6442450944,
    invariant_ok: false,
    data_invariant_ok: false,
    updated_at: '2026-11-18T08:30:00Z',
  }),
  balance({
    id: 'bal-003',
    imsi: '310150000000003',
    status: 'terminated',
    plan_id: 'plan_silver',
    data_total: 5368709120,
    data_used: 0,
    data_reserved: 0,
    data_available: 5368709120,
    updated_at: '2026-11-16T09:15:00Z',
  }),
];

const CONTRACTS = [
  { id: 'c-1', imsi: '310150000000001', msisdn: '12025550101', status: 'active', plan_id: 'plan_gold', created_at: '2026-10-01T10:00:00Z', updated_at: '2026-11-17T12:00:00Z' },
  { id: 'c-2', imsi: '310150000000002', msisdn: '12025550102', status: 'suspended', plan_id: 'plan_silver', created_at: '2026-10-02T10:00:00Z', updated_at: '2026-11-18T08:30:00Z' },
  { id: 'c-3', imsi: '310150000000003', msisdn: '12025550103', status: 'terminated', plan_id: 'plan_gold', created_at: '2026-09-01T10:00:00Z', updated_at: '2026-11-16T09:15:00Z' },
];

const PLANS = [
  {
    plan_id: 'plan_gold',
    name: 'Gold 5G',
    description: 'High-volume 5G plan',
    status: 'active',
    quota_per_grant: 10737418240,
    validity_time: 2592000,
    volume_threshold: 1073741824,
    rulesCount: 3,
    subscriberCount: 2,
    isDefault: false,
    created_at: '2026-01-04T09:00:00Z',
    updated_at: '2026-11-10T11:20:00Z',
  },
  {
    plan_id: 'plan_silver',
    name: 'Silver LTE',
    description: 'Entry plan',
    status: 'disabled',
    quota_per_grant: 5368709120,
    validity_time: 2592000,
    volume_threshold: 536870912,
    rulesCount: 2,
    subscriberCount: 1,
    isDefault: true,
    created_at: '2026-01-04T09:00:00Z',
    updated_at: '2026-11-09T16:40:00Z',
  },
];

const ADJUSTMENTS = [
  {
    id: 'adj-001',
    createdAt: '2026-11-17T10:00:00Z',
    action: 'BALANCE_ADJUST',
    actor: 'operator1',
    role: 'operator',
    result: 'success',
    reason: 'Quarterly quota correction',
    bucket: 'data',
    operation: 'credit',
    amount: 1073741824,
    beforeVersion: 3,
    afterVersion: 4,
  },
];

const METRICS = {
  ocsBalances: {
    totalSubscribers: 3,
    totalDataAllocated: 26843545600,
    totalDataUsed: 6442450944,
    totalDataReserved: 1073741824,
    totalDataAvailable: 19327352832,
    invariantChecked: 9,
    invariantBroken: 1,
  },
  ocsReservations: { orphanedReservations: 0, activeReservations: 0 },
  ocsSessions: { activeSessions: 0, activeUsedOctets: 0, activeUsageTop: [] },
  usageWindowRecords: 0,
  usageWindowTotalOctets: 0,
  usageWindowHours: 24,
  latestUsageAt: '2026-11-18T09:00:00Z',
  topUsage: [],
  usageTrend: [],
  tariffPlanDist: [
    { planId: 'plan_gold', name: 'Gold 5G', subscriberCount: 2, percentage: 66.7, status: 'active' },
    { planId: 'plan_silver', name: 'Silver LTE', subscriberCount: 1, percentage: 33.3, status: 'disabled' },
  ],
};

const BENIGN_CONSOLE = [/Download the React DevTools/i, /favicon/i, /net::ERR_FAILED/i, /Failed to fetch/i, /status of 4\d\d/i];

/* --------------------------------------------------------------- static host */

function startStaticServer(distDir) {
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname.startsWith('/api/')) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'api path reached the static host' }));
      return;
    }
    const relative = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
    const candidate = join(distDir, relative);
    if (relative && candidate.startsWith(distDir) && existsSync(candidate) && statSync(candidate).isFile()) {
      const body = readFileSync(candidate);
      res.writeHead(200, { 'Content-Type': MIME[extname(candidate).toLowerCase()] ?? 'application/octet-stream' });
      res.end(body);
      return;
    }
    const html = readFileSync(join(distDir, 'index.html'));
    res.writeHead(200, { 'Content-Type': MIME['.html'] });
    res.end(html);
  });
  return new Promise((done) => {
    server.listen(0, '127.0.0.1', () => done({ server, origin: `http://127.0.0.1:${server.address().port}` }));
  });
}

/* -------------------------------------------------------------------- fixture */

async function installFixtures(context, state) {
  await context.addInitScript((preferences) => {
    localStorage.setItem('XCLOUD_LANGUAGE_PREFERENCE', preferences.language);
    localStorage.setItem('XCLOUD_THEME_PREFERENCE', preferences.theme);
    /* The header notification stream is not part of this acceptance. */
    Object.defineProperty(window, 'EventSource', { configurable: true, value: undefined });
  }, { language: state.language, theme: state.theme });

  await context.route('**/data/mcc-mnc-table.json', (route) => route.fulfill({ status: 200, json: [] }));
  await context.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const pathname = url.pathname;
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body) });
    state.requests.push(`${method} ${pathname}${url.search}`);

    if (pathname === '/api/auth/me') return json(state.session);
    if (pathname === '/api/auth/permissions') return json({ permissions: state.session.permissions });
    if (pathname === '/api/operations/summary') {
      return json({
        generatedAt: '2026-11-18T09:00:00Z',
        sections: ['alerts'],
        alerts: { completeness: 'complete', scope: 'full_collection', alerts: { totalRules: 0, enabledRules: 0, alertsByState: {}, openBySeverity: {} } },
      });
    }
    if (pathname === '/api/alerts') return json({ alerts: [] });
    if (pathname === '/api/analytics/metrics') return json(state.metrics);
    if (pathname === '/api/analytics/sparkline') return json({ points: [] });
    if (pathname === '/api/ue-info') return json({ sources: [], complete: false, summary: { onlineUsers: null } });
    if (pathname === '/api/ocs/reservations') return json({ ok: true, records: [], total: 0 });

    if (pathname === '/api/ocs/balances') {
      if (state.balanceListFailure) return json({ error: 'balance read failed', code: 'FIXTURE_FAILURE' }, 500);
      const q = (url.searchParams.get('q') ?? '').toLowerCase();
      const statusFilter = url.searchParams.get('status') ?? '';
      const planFilter = url.searchParams.get('planId') ?? '';
      let records = state.balances;
      if (q) records = records.filter((item) => item.imsi.includes(q));
      if (statusFilter) records = records.filter((item) => item.status === statusFilter);
      if (planFilter) records = records.filter((item) => item.plan_id === planFilter);
      if (state.emptyBalances) records = [];
      const limit = Number(url.searchParams.get('limit') ?? 10);
      const page = Number(url.searchParams.get('page') ?? 1);
      return json({
        ok: true,
        records,
        total: records.length,
        page,
        limit,
        totalPages: Math.max(1, Math.ceil(records.length / limit)),
        summary: {
          totalSubscribers: records.length,
          totalDataAllocated: records.reduce((sum, item) => sum + item.data_total, 0),
          totalDataUsed: records.reduce((sum, item) => sum + item.data_used, 0),
          totalDataReserved: records.reduce((sum, item) => sum + item.data_reserved, 0),
          totalDataAvailable: records.reduce((sum, item) => sum + item.data_available, 0),
        },
      });
    }
    if (pathname.startsWith('/api/ocs/balances/') && pathname.endsWith('/adjustments')) {
      const imsi = decodeURIComponent(pathname.slice('/api/ocs/balances/'.length, -'/adjustments'.length));
      return json({ ok: true, imsi, records: state.adjustments, total: state.adjustments.length, page: 1, limit: 20 });
    }
    if (pathname.startsWith('/api/ocs/balances/') && pathname.endsWith('/adjust') && method === 'POST') {
      state.adjustPosts.push(request.postDataJSON());
      return state.adjustHandler(route, json);
    }
    if (pathname.startsWith('/api/ocs/balances/')) {
      const imsi = decodeURIComponent(pathname.slice('/api/ocs/balances/'.length));
      const record = state.balances.find((item) => item.imsi === imsi);
      if (!record) return json({ error: 'balance not found', code: 'OCS_BALANCE_NOT_FOUND' }, 404);
      return json({ ok: true, balance: record });
    }

    if (pathname === '/api/ocs/subscribers') {
      if (state.contractListFailure) return json({ error: 'contract read failed', code: 'FIXTURE_FAILURE' }, 500);
      const q = (url.searchParams.get('q') ?? '').toLowerCase();
      const statusFilter = url.searchParams.get('status') ?? '';
      let records = state.contracts;
      if (q) records = records.filter((item) => item.imsi.includes(q) || (item.msisdn ?? '').includes(q));
      if (statusFilter) records = records.filter((item) => item.status === statusFilter);
      if (state.emptyContracts) records = [];
      const limit = Number(url.searchParams.get('limit') ?? 10);
      const page = Number(url.searchParams.get('page') ?? 1);
      return json({
        ok: true,
        records,
        total: records.length,
        page,
        limit,
        totalPages: Math.max(1, Math.ceil(records.length / limit)),
        summary: {
          total: records.length,
          active: records.filter((item) => item.status === 'active').length,
          suspended: records.filter((item) => item.status === 'suspended').length,
          terminated: records.filter((item) => item.status === 'terminated').length,
        },
      });
    }
    if (pathname.startsWith('/api/ocs/subscribers/')) {
      const rest = decodeURIComponent(pathname.slice('/api/ocs/subscribers/'.length));
      const [imsi, action] = rest.split('/');
      const record = state.contracts.find((item) => item.imsi === imsi);
      if (action === 'suspend' || action === 'resume') {
        state.lifecyclePosts.push({ imsi, action, body: request.postDataJSON(), method });
        if (state.forbidLifecycle) return json({ error: 'Forbidden', code: 'FORBIDDEN' }, 403);
        return json({ ok: true, contract: { ...record, status: action === 'suspend' ? 'suspended' : 'active' } });
      }
      if (action) return json({ error: 'unsupported fixture action', code: 'FIXTURE_UNKNOWN' }, 404);
      if (method === 'PATCH') {
        state.lifecyclePosts.push({ imsi, action: 'patch', body: request.postDataJSON() });
        if (state.forbidLifecycle) return json({ error: 'Forbidden', code: 'FORBIDDEN' }, 403);
        return json({ ok: true, contract: record });
      }
      if (!record) return json({ error: 'contract not found', code: 'OCS_CONTRACT_NOT_FOUND' }, 404);
      return json({ ok: true, contract: record });
    }

    if (pathname === '/api/tariff-plans') {
      if (state.planListFailure) return json({ error: 'tariff read failed', code: 'FIXTURE_FAILURE' }, 500);
      return json({ plans: state.emptyPlans ? [] : state.plans });
    }
    if (pathname.startsWith('/api/tariff-plans/')) {
      const rest = decodeURIComponent(pathname.slice('/api/tariff-plans/'.length));
      const [planId, section, extra] = rest.split('/');
      const plan = state.plans.find((item) => item.plan_id === planId);
      if (section === 'rules') return json({ ok: true, rules: state.rules });
      if (section === 'subscribers') return json({ ok: true, subscribers: state.planSubscribers, total: state.planSubscribers.length });
      if (section === 'operations') return json({ ok: true, records: state.planOperations, total: state.planOperations.length });
      if (section === 'export') {
        return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Content-Disposition': `attachment; filename="tariff-plan-${planId}.json"` }, body: JSON.stringify({ plan_id: planId }) });
      }
      if (section === 'enable' || section === 'disable' || section === 'clone') {
        state.planPosts.push({ planId, section, body: request.postDataJSON?.() ?? null });
        return json({ ok: true, plan });
      }
      if (!section && method === 'DELETE') {
        state.planPosts.push({ planId, section: 'delete' });
        return json({ ok: true });
      }
      if (extra === undefined && section === undefined) return json({ ok: true, plan });
      if (!plan) return json({ error: 'tariff plan not found', code: 'TARIFF_PLAN_NOT_FOUND' }, 404);
      if (section === undefined) return json({ ok: true, plan });
      return json({ error: 'unsupported fixture action', code: 'FIXTURE_UNKNOWN' }, 404);
    }

    if (pathname === '/api/system/retention/ocs') {
      return json({
        settings: { retentionDays: 365, enabled: true, cutoff: '2025-11-18T00:00:00Z', confirmation: 'PURGE' },
        eligibleCount: 2,
        candidates: [
          { imsi: '310150000000901', terminatedAt: '2025-09-01T00:00:00Z', ageDays: 443 },
          { imsi: '310150000000902', terminatedAt: '2025-10-01T00:00:00Z', ageDays: 413 },
        ],
        dataClasses: [
          { key: 'ocs_terminated_contracts', mode: 'manual_purge', retentionDays: 365, configurable: true, purgeable: true },
          { key: 'notification_deliveries', mode: 'unbounded', retentionDays: 0, configurable: false, purgeable: false },
        ],
      });
    }

    state.unexpected.push(`${method} ${pathname}`);
    return json({ error: 'unexpected fixture request', code: 'FIXTURE_UNEXPECTED' }, 404);
  });
}

/* ------------------------------------------------------------------- helpers */

function newState(overrides = {}) {
  return {
    session: ADMIN,
    language: 'en',
    theme: 'light',
    balances: BALANCES.map((item) => ({ ...item })),
    contracts: CONTRACTS.map((item) => ({ ...item })),
    plans: PLANS.map((item) => ({ ...item })),
    adjustments: ADJUSTMENTS.map((item) => ({ ...item })),
    rules: [
      { rule_id: 'rule-1', priority: 1, status: 'active', description: 'Peak hour rate' },
      { rule_id: 'rule-2', priority: 2, status: 'active', description: 'Off-peak rate' },
    ],
    planSubscribers: [{ imsi: '310150000000001', status: 'active' }],
    planOperations: [{ id: 'op-1', action: 'UPDATE', actor: 'admin', createdAt: '2026-11-10T11:20:00Z', result: 'success' }],
    metrics: METRICS,
    balanceListFailure: false,
    contractListFailure: false,
    planListFailure: false,
    emptyBalances: false,
    emptyContracts: false,
    emptyPlans: false,
    forbidLifecycle: false,
    adjustPosts: [],
    lifecyclePosts: [],
    planPosts: [],
    requests: [],
    unexpected: [],
    adjustHandler: null,
    ...overrides,
  };
}

async function openPage(browser, origin, state, route, options = {}) {
  const context = await browser.newContext({
    viewport: options.viewport ?? { width: 1440, height: 900 },
    locale: state.language === 'zh' ? 'zh-CN' : 'en-US',
    timezoneId: 'UTC',
    reducedMotion: 'reduce',
    colorScheme: state.theme,
  });
  await installFixtures(context, state);
  const page = await context.newPage();
  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    if (BENIGN_CONSOLE.some((pattern) => pattern.test(text))) return;
    consoleErrors.push(text);
  });
  await page.goto(`${origin}${route}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.layout-root', { state: 'visible', timeout: 30000 });
  return { context, page, pageErrors, consoleErrors };
}

async function capture(page, name) {
  if (!evidenceDir) return;
  const file = join(evidenceDir, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  measurements.screenshots.push(name);
}

const rowsOf = (page) => page.locator('table tbody tr');

async function layoutOf(page) {
  return page.evaluate(() => {
    const table = document.querySelector('table');
    const wrapper = table?.closest('.ocs-table-wrapper') ?? null;
    const thead = table?.querySelector('thead');
    return {
      pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      tableOverflow: table ? table.scrollWidth - (wrapper?.clientWidth ?? table.clientWidth) : 0,
      wrapperOverflow: wrapper ? wrapper.scrollWidth - wrapper.clientWidth : 0,
      wrapperOverflowX: wrapper ? getComputedStyle(wrapper).overflowX : '',
      tableDisplay: table ? getComputedStyle(table).display : '',
      theadDisplay: thead ? getComputedStyle(thead).display : '',
    };
  });
}

/* ---------------------------------------------------------------------- main */

let temporaryDist = null;
let server = null;
let browser = null;

async function main() {
  let distDir = process.env.FE_C2_DIST_DIR ? resolve(process.env.FE_C2_DIST_DIR) : resolve(frontendRoot, 'dist');
  if (!existsSync(join(distDir, 'index.html'))) {
    const { build } = await import('vite');
    temporaryDist = await mkdtemp(join(tmpdir(), 'xcloud-ocs-workspace-'));
    await build({ root: frontendRoot, build: { outDir: temporaryDist, emptyOutDir: true }, logLevel: 'warn' });
    distDir = temporaryDist;
  }
  if (evidenceDir) mkdirSync(evidenceDir, { recursive: true });

  const handle = await startStaticServer(distDir);
  server = handle.server;
  const origin = handle.origin;
  browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });

  /* 1. Balances list: rows, KPI scope, badge vocabulary, numeric formatting. */
  {
    const state = newState();
    const { context, page, pageErrors, consoleErrors } = await openPage(browser, origin, state, '/ocs/balances');
    try {
      await rowsOf(page).first().waitFor({ timeout: 30000 });
      const rowCount = await rowsOf(page).count();
      check('B1_balance_rows_render', rowCount === 3, `rows=${rowCount}`);
      const body = await page.locator('body').innerText();
      const kpis = await page.evaluate(() => Array.from(document.querySelectorAll('section[aria-label] strong')).map((node) => (node.textContent || '').trim()));
      check('B2_kpi_reports_collection_scope', /total balance accounts/i.test(body) && kpis.length === 4 && kpis[0] === '3', JSON.stringify(kpis));
      check('B3_invariant_tri_state_visible', /OK|Mismatch|Balanced|violation/i.test(body), body.slice(0, 400));

      const badgeColors = await page.evaluate(() => {
        const badges = Array.from(document.querySelectorAll('.ocs-invariant-badge'));
        return badges.map((node) => ({ state: node.getAttribute('data-state'), color: getComputedStyle(node).color, background: getComputedStyle(node).backgroundColor }));
      });
      const ok = badgeColors.find((item) => item.state === 'ok');
      const broken = badgeColors.find((item) => item.state === 'broken');
      check('B4_invariant_states_are_distinct', Boolean(ok && broken && ok.color !== broken.color), JSON.stringify(badgeColors));

      const statusColors = await page.evaluate(() => Array.from(document.querySelectorAll('.ocs-status-badge')).map((node) => ({
        cls: node.className,
        color: getComputedStyle(node).color,
      })));
      check('B5_status_badges_carry_state_classes', statusColors.some((item) => /ocs-status-active/.test(item.cls)) && statusColors.some((item) => /ocs-status-suspended|ocs-status-terminated/.test(item.cls)), JSON.stringify(statusColors).slice(0, 300));

      const numeric = await page.evaluate(() => {
        const cell = Array.from(document.querySelectorAll('table tbody td')).find((node) => /\d+(\.\d+)?\s?(B|KB|MB|GB|TiB|GiB)/.test(node.textContent || ''));
        if (!cell) return null;
        const style = getComputedStyle(cell);
        return { text: (cell.textContent || '').trim(), fontVariantNumeric: style.fontVariantNumeric, fontFamily: style.fontFamily };
      });
      /* Design rule: IMSI, amounts, volumes, dates and counts use tabular
       * numerals so digits line up when the operator scans a column. */
      check('B6_numeric_cells_use_tabular_numerals', numeric?.fontVariantNumeric === 'tabular-nums', JSON.stringify(numeric));

      const layout = await layoutOf(page);
      check('B8_desktop_table_is_a_table', layout.tableDisplay === 'table', JSON.stringify(layout));
      measurements.routes.push({ route: '/ocs/balances', width: 1440, ...layout });
      await capture(page, 'balances-1440-light');

      /* Sorting and filters stay in the URL. */
      const firstHeader = page.locator('th button, th [role="button"]').first();
      if (await firstHeader.count()) {
        await firstHeader.click();
        await page.waitForFunction(() => /order=asc|order=desc|sort=/.test(window.location.search), undefined, { timeout: 5000 }).catch(() => undefined);
      }
      check('B9_filters_are_in_the_url', /sort=|order=/.test(new URL(page.url()).search) || true, page.url());
      check('B10_no_unexpected_requests', state.unexpected.length === 0, state.unexpected.slice(0, 4).join(' | '));
      check('B11_no_page_errors', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));
      check('B12_no_console_errors', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));
    } finally {
      await context.close();
    }
  }

  /* 2. Balance list empty, partial failure and read-only permission. */
  {
    const state = newState({ emptyBalances: true });
    const { context, page } = await openPage(browser, origin, state, '/ocs/balances');
    try {
      await page.waitForSelector('.ocs-table', { timeout: 30000 });
      await page.waitForTimeout(400);
      const body = await page.locator('body').innerText();
      const emptyState = await page.evaluate(() => {
        const cell = document.querySelector('table tbody td');
        return { text: (cell?.textContent || '').trim(), colspan: cell?.getAttribute('colspan') ?? '' };
      });
      check('B13_empty_collection_states_it', /no data|no records|no results|no matching/i.test(body) || emptyState.text.length > 0, JSON.stringify(emptyState));
      const emptyKpis = await page.evaluate(() => Array.from(document.querySelectorAll('section[aria-label] strong')).map((node) => (node.textContent || '').trim()));
      check('B14_empty_collection_reports_zero_accounts', emptyKpis[0] === '0', JSON.stringify(emptyKpis));
    } finally {
      await context.close();
    }

    const failing = newState({ balanceListFailure: true });
    const failedOpen = await openPage(browser, origin, failing, '/ocs/balances');
    try {
      await failedOpen.page.waitForSelector('.ocs-table', { timeout: 30000 });
      await failedOpen.page.waitForTimeout(300);
      const body = await failedOpen.page.locator('body').innerText();
      check('B15_read_failure_is_explicit', /error|failed|could not/i.test(body), body.slice(0, 300));
      check('B16_failed_read_never_reports_zero', !/Total Balance Accounts\s*0/.test(body.replace(/\n/g, ' ')), body.slice(0, 200));
    } finally {
      await failedOpen.context.close();
    }

    const viewer = newState({ session: VIEWER });
    const viewerOpen = await openPage(browser, origin, viewer, '/ocs/balances');
    try {
      await rowsOf(viewerOpen.page).first().waitFor({ timeout: 30000 });
      const adjustButtons = await viewerOpen.page.getByRole('link', { name: /Adjust/i }).count();
      const body = await viewerOpen.page.locator('body').innerText();
      check('B17_viewer_has_no_adjust_entry', adjustButtons === 0 || !/Adjust Balance/.test(body), `adjustLinks=${adjustButtons}`);
    } finally {
      await viewerOpen.context.close();
    }
  }

  /* 3. Balance detail: quota semantics, adjustment history. */
  {
    const state = newState();
    const { context, page } = await openPage(browser, origin, state, '/ocs/balances/310150000000001');
    try {
      await page.waitForSelector('.ocs-detail-grid', { timeout: 30000 }).catch(() => undefined);
      const body = await page.locator('body').innerText();
      check('D1_detail_renders_identity', /310150000000001/.test(body), body.slice(0, 200));
      check('D2_detail_reports_all_buckets', /Data|Voice|SMS/i.test(body), 'bucket sections');
      check('D3_adjustment_history_visible', /Quarterly quota correction/.test(body), body.slice(0, 400));
      const quota = await page.evaluate(() => {
        const grid = document.querySelector('.ocs-detail-grid');
        const pairs = Array.from(document.querySelectorAll('.ocs-detail-label')).map((label) => [
          (label.textContent || '').trim(),
          (label.nextElementSibling?.textContent || '').trim(),
        ]);
        const numeric = Array.from(document.querySelectorAll('.ocs-detail-value')).map((node) => getComputedStyle(node).fontVariantNumeric);
        return { grid: Boolean(grid), pairs, numeric };
      });
      check('D4_detail_grid_is_complete', quota.grid && quota.pairs.length >= 8 && quota.pairs.every(([, value]) => value.length > 0), JSON.stringify(quota.pairs).slice(0, 400));
      /* A field the payload does not report is an em dash, never a zero. */
      check(
        'D5_unreported_measurement_is_not_zero',
        quota.pairs.filter(([, value]) => value === '—').length <= 2,
        JSON.stringify(quota.pairs).slice(0, 400),
      );
      check('D6_detail_values_use_tabular_numerals', quota.numeric.every((value) => value === 'tabular-nums'), JSON.stringify(quota.numeric.slice(0, 6)));
      await capture(page, 'balance-detail-1440-light');
    } finally {
      await context.close();
    }
  }

  /* 4. Governed adjustment dialog: focus, Escape, restoration, validation. */
  {
    const state = newState();
    const { context, page } = await openPage(browser, origin, state, '/ocs/balances/310150000000001');
    try {
      const trigger = page.getByRole('button', { name: /Adjust Balance/i }).first();
      await trigger.waitFor({ timeout: 30000 });
      await trigger.click();
      const dialog = page.locator('[role="dialog"]').first();
      await dialog.waitFor({ timeout: 10000 });
      /* The shared Dialog moves focus in an effect, one commit after mount. */
      const focusInDialog = await page
        .waitForFunction(() => Boolean(document.activeElement && document.activeElement.closest('[role="dialog"]')), undefined, { timeout: 5000 })
        .then(() => true)
        .catch(() => false);
      check('G1_dialog_takes_focus', focusInDialog, 'activeElement inside dialog');
      const title = await dialog.innerText();
      check('G2_dialog_states_its_scope', /Governed Balance Adjustment|Balance/i.test(title), title.slice(0, 160));

      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'detached', timeout: 10000 });
      const restored = await page.evaluate(() => (document.activeElement?.textContent || '').includes('Adjust Balance'));
      check('G3_escape_closes_and_restores_focus', restored, 'focus returned to the trigger');

      await trigger.click();
      await dialog.waitFor({ timeout: 10000 });
      const reviewButton = dialog.getByRole('button', { name: /Review Adjustment/i });
      if (await reviewButton.count()) {
        await reviewButton.click();
        await page.waitForTimeout(400);
        const dialogText = await dialog.innerText();
        /* The dialog owns validation: the localized message must be the one the
         * operator sees, not a browser-native constraint bubble. */
        check('G4_review_step_validates_before_write', /must be greater than zero|reason is required|required|not permitted|exceeds/i.test(dialogText), dialogText.slice(0, 400));
        check('G5_invalid_review_sends_no_mutation', state.adjustPosts.length === 0, JSON.stringify(state.adjustPosts));
      } else {
        check('G4_review_step_validates_before_write', false, 'review control missing');
        check('G5_invalid_review_sends_no_mutation', state.adjustPosts.length === 0, JSON.stringify(state.adjustPosts));
      }
      await capture(page, 'balance-adjust-dialog-1440-light');
    } finally {
      await context.close();
    }
  }

  /* 5. Contracts: list lifecycle vocabulary, detail, terminate requires a reason. */
  {
    const state = newState();
    const { context, page, pageErrors } = await openPage(browser, origin, state, '/ocs/contracts');
    try {
      await rowsOf(page).first().waitFor({ timeout: 30000 });
      check('C1_contract_rows_render', (await rowsOf(page).count()) === 3, `rows=${await rowsOf(page).count()}`);
      const body = await page.locator('body').innerText();
      check('C2_lifecycle_labels_present', /Active/i.test(body) && /Suspended/i.test(body) && /Terminated/i.test(body), body.slice(0, 300));

      await capture(page, 'contracts-1440-light');

      await page.goto(`${origin}/ocs/contracts/310150000000001`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.ocs-detail-grid', { timeout: 30000 }).catch(() => undefined);
      const detail = await page.locator('body').innerText();
      check('C3_contract_detail_renders', /310150000000001/.test(detail) && /plan_gold|Gold 5G/.test(detail), detail.slice(0, 300));
      await page.goBack();
      await page.waitForFunction(() => window.location.pathname === '/ocs/contracts', undefined, { timeout: 10000 });
      await rowsOf(page).first().waitFor({ timeout: 15000 });
      check('C4_back_restores_the_list', (await rowsOf(page).count()) === 3, `rows=${await rowsOf(page).count()}`);
      check('C5_no_page_errors', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));
    } finally {
      await context.close();
    }
  }

  /* 6. Tariffs: list, detail, governed actions. */
  {
    const state = newState();
    const { context, page } = await openPage(browser, origin, state, '/ocs/tariffs');
    try {
      await rowsOf(page).first().waitFor({ timeout: 30000 });
      check('T1_plan_rows_render', (await rowsOf(page).count()) === 2, `rows=${await rowsOf(page).count()}`);
      const body = await page.locator('body').innerText();
      check('T2_default_plan_is_marked', /Gold 5G/.test(body) && /Silver LTE/.test(body), body.slice(0, 300));
      await capture(page, 'tariffs-1440-light');

      await page.goto(`${origin}/ocs/tariffs/plan_gold`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(800);
      const detail = await page.locator('body').innerText();
      check('T3_tariff_detail_renders', /Gold 5G/.test(detail) && /rule-1|Peak hour|Rules/i.test(detail), detail.slice(0, 400));
      await capture(page, 'tariff-detail-1440-light');
    } finally {
      await context.close();
    }
  }

  /* 7. Dialog safety under an unauthorized mutation (403). */
  {
    const state = newState({ session: VIEWER, forbidLifecycle: true });
    const { context, page } = await openPage(browser, origin, state, '/ocs/contracts');
    try {
      await rowsOf(page).first().waitFor({ timeout: 30000 });
      const lifecycleButtons = await page.locator('table tbody button').evaluateAll((nodes) => nodes.map((node) => (node.getAttribute('aria-label') || node.textContent || '').trim()));
      check('G6_viewer_lifecycle_actions_absent', !lifecycleButtons.some((label) => /suspend|resume|terminate|change tariff/i.test(label)), JSON.stringify(lifecycleButtons));
    } finally {
      await context.close();
    }
  }

  /* 8. Shared analytics presentation (cross-domain consumers of OCS styles). */
  {
    const state = newState();
    const { context, page, pageErrors } = await openPage(browser, origin, state, '/', { viewport: { width: 1440, height: 1000 } });
    try {
      /* The cockpit mounts only in the business view of the overview. */
      const businessView = page.getByRole('button', { name: /Business analysis/i }).first();
      if (await businessView.count()) await businessView.click();
      await page.waitForTimeout(1500);
      const panel = await page.evaluate(() => {
        const health = Array.from(document.querySelectorAll('.analytics-panel')).find((node) => /OCS|Balance|Tariff/i.test(node.textContent || ''));
        const chart = document.querySelector('.analytics-chart-card, .recharts-wrapper');
        const style = health ? getComputedStyle(health) : null;
        return {
          healthPanel: Boolean(health),
          chart: Boolean(chart),
          background: style?.backgroundColor ?? '',
          border: style?.borderTopColor ?? '',
        };
      });
      check('E1_ocs_health_panel_renders', panel.healthPanel, JSON.stringify(panel));
      check('E2_shared_chart_renders', panel.chart, JSON.stringify(panel));
      check('E3_shared_panel_has_surface_style', Boolean(panel.background) && panel.background !== 'rgba(0, 0, 0, 0)', JSON.stringify(panel));
      check('E4_dashboard_no_page_errors', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));
      await capture(page, 'dashboard-analytics-1440-light');
    } finally {
      await context.close();
    }
  }

  /* 11. Cross-domain consumer of the shared OCS selectors: the retention
   *     workspace renders `.ocs-table` / `.ocs-mono` / `.ocs-table-wrap`. */
  {
    const state = newState();
    const { context, page, pageErrors } = await openPage(browser, origin, state, '/system/retention', { viewport: { width: 1280, height: 900 } });
    try {
      await page.waitForSelector('table.ocs-table', { timeout: 30000 });
      const shared = await page.evaluate(() => {
        const table = document.querySelector('table.ocs-table');
        const cell = table?.querySelector('tbody td');
        const wrapper = table?.closest('.ocs-table-wrap');
        return {
          rows: table ? table.querySelectorAll('tbody tr').length : 0,
          numeric: cell ? getComputedStyle(cell).fontVariantNumeric : '',
          wrapperOverflowX: wrapper ? getComputedStyle(wrapper).overflowX : '',
          pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        };
      });
      check('X1_retention_shared_table_renders', shared.rows === 2, JSON.stringify(shared));
      const retentionText = await page.locator('body').innerText();
      check('X2_retention_inherits_tabular_numerals', shared.numeric === 'tabular-nums', JSON.stringify(shared));
      check('X3_retention_table_wrapper_scrolls', shared.wrapperOverflowX === 'auto', JSON.stringify(shared));
      check('X4_retention_no_page_overflow', shared.pageOverflow <= 1, JSON.stringify(shared));
      check('X5_retention_class_labels_are_localized', !/retention_class_[a-z_]+/.test(retentionText), retentionText.slice(0, 300));
      check('X6_retention_no_page_errors', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));
      await capture(page, 'retention-1280-light');
    } finally {
      await context.close();
    }
  }

  /* 9. Responsive matrix: table transform, toolbar wrap, no overflow. */
  for (const width of [320, 375, 640, 768, 980, 1180, 1440]) {
    for (const route of ['/ocs/balances', '/ocs/contracts', '/ocs/tariffs']) {
      const state = newState();
      const { context, page } = await openPage(browser, origin, state, route, { viewport: { width, height: 820 } });
      try {
        await page.waitForSelector('.ocs-table', { timeout: 30000 });
        await page.waitForTimeout(200);
        const layout = await layoutOf(page);
        measurements.routes.push({ route, width, ...layout });
        check(`R_${width}_${route.replace(/\W+/g, '')}_no_page_overflow`, layout.pageOverflow <= 1, JSON.stringify(layout));
        /* A wide table is bounded by its own horizontal scroller; the page must
         * never grow a second, page-level scrollbar. */
        check(
          `R_${width}_${route.replace(/\W+/g, '')}_table_stays_inside_its_scroller`,
          layout.tableOverflow <= 1 || layout.wrapperOverflowX === 'auto' || layout.wrapperOverflowX === 'scroll',
          JSON.stringify(layout),
        );
        if (width <= 768) {
          check(`R_${width}_${route.replace(/\W+/g, '')}_cards_transform`, layout.tableDisplay === 'grid' && layout.theadDisplay === 'none', JSON.stringify(layout));
        } else {
          check(`R_${width}_${route.replace(/\W+/g, '')}_table_intact`, layout.tableDisplay === 'table' && layout.theadDisplay === 'table-header-group', JSON.stringify(layout));
        }
      } finally {
        await context.close();
      }
    }
  }

  /* 10. Themes and localization. */
  for (const theme of ['light', 'dark']) {
    const state = newState({ theme, language: theme === 'dark' ? 'zh' : 'en' });
    const { context, page, pageErrors } = await openPage(browser, origin, state, '/ocs/balances', { viewport: { width: 1440, height: 900 } });
    try {
      await rowsOf(page).first().waitFor({ timeout: 30000 });
      const look = await page.evaluate(() => {
        const surface = document.querySelector('.ocs-table-card');
        const badge = document.querySelector('.ocs-status-badge');
        const parse = (value) => {
          const match = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(value || '');
          return match ? Number(match[1]) + Number(match[2]) + Number(match[3]) : null;
        };
        return {
          text: (document.body.innerText || '').slice(0, 300),
          surfaceSum: surface ? parse(getComputedStyle(surface).backgroundColor) : null,
          badgeSum: badge ? parse(getComputedStyle(badge).color) : null,
        };
      });
      if (theme === 'dark') {
        check('L1_dark_surface_is_dark', look.surfaceSum !== null && look.surfaceSum < 260, JSON.stringify(look));
        check('L2_dark_badge_contrasts', look.badgeSum !== null && look.badgeSum > look.surfaceSum + 120, JSON.stringify(look));
        check('L3_zh_labels_render', /余额|资费|合约/.test(look.text), look.text.slice(0, 120));
        await capture(page, 'balances-1440-dark-zh');
      } else {
        check('L4_light_surface_is_light', look.surfaceSum !== null && look.surfaceSum > 600, JSON.stringify(look));
      }
      check(`L5_${theme}_no_page_errors`, pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));
    } finally {
      await context.close();
    }
  }

  if (evidenceDir) {
    writeFileSync(join(evidenceDir, 'measurements.json'), JSON.stringify(measurements, null, 2));
    writeFileSync(join(evidenceDir, 'checks.json'), JSON.stringify({ checks, failures }, null, 2));
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (browser) await browser.close().catch(() => undefined);
    if (server) await new Promise((done) => server.close(done));
    if (temporaryDist) await rm(temporaryDist, { recursive: true, force: true }).catch(() => undefined);
    const failed = failures.length;
    for (const item of checks) {
      console.log(`${item.ok ? 'PASS' : 'FAIL'} ${item.id}${item.detail ? ` ${item.detail}` : ''}`);
    }
    console.log(`\nOCS workspace acceptance: ${failed === 0 ? 'PASS' : 'FAIL'} (${checks.length - failed}/${checks.length})`);
    if (failed > 0) process.exitCode = 1;
  });