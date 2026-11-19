#!/usr/bin/env node
/* global Request, URLSearchParams, requestAnimationFrame, setTimeout */
/*
 * Subscribers state, URL and navigation acceptance.
 *
 * The suite owns its production build, static server and deterministic API
 * fixtures. Each asynchronous completion is proven through an observed request,
 * a settled response or a rendered business row; the only time acceleration is
 * Playwright's explicit clock for the 300 ms search debounce.
 *
 * Scenarios:
 *   S1  valid deep link
 *   S2  invalid URL canonical recovery (no unauthorized request)
 *   S3  filter change is atomic with the page reset
 *   S4  sort field / direction
 *   S5  detail return and browser Back/Forward
 *   S6  rapid search, invalid draft and out-of-order responses
 *   S7  selection invalidation and stale-action guards
 *   S8  governed single delete
 *   S9  import in-flight dismissal protection
 *   S10 desktop / mobile responsive navigation
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
      const filePath = await stat(safeCandidate)
        .then((entry) => (entry.isFile() ? safeCandidate : path.join(distDirectory, 'index.html')))
        .catch(() => path.join(distDirectory, 'index.html'));
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

const ADMIN_USER = {
  username: 'admin',
  role: 'admin',
  normalizedRole: 'admin',
  status: 'active',
  permissions: [
    'subscribers.read',
    'subscribers.write',
    'subscribers.delete',
    'ocs.read',
    'ocs.balance.adjust',
    'profiles.read',
  ],
};

const TOTAL_SUBSCRIBERS = 120;
const subscribers = Array.from({ length: TOTAL_SUBSCRIBERS }, (_, index) => {
  const sequence = index + 1;
  const access = sequence % 5 === 0 ? 'restricted' : 'active';
  const contractStatus = sequence % 7 === 0 ? 'suspended' : 'active';
  const provisioning = {
    contract: sequence % 6 !== 0,
    balance: sequence % 8 !== 0,
    tariffPlan: sequence % 9 !== 0,
  };
  const balanceState = sequence % 4 === 0
    ? 'exhausted'
    : sequence % 3 === 0
      ? 'low'
      : 'normal';
  return {
    imsi: `4600200000${String(sequence).padStart(5, '0')}`,
    msisdn: `1880000${String(sequence).padStart(5, '0')}`,
    access,
    status: access === 'active' ? 'Active' : 'Partial Restricted',
    contractStatus,
    balanceState,
    policy: sequence % 3 === 0 ? 'plan-a' : 'plan-b',
    policyName: sequence % 3 === 0 ? 'Plan A' : 'Plan B',
    policyStatus: 'active',
    provisioning,
    profile: sequence % 2 === 0 ? 'tpl-a' : 'tpl-b',
    lastActive: new Date(Date.UTC(2026, 0, 1, 0, sequence)).toISOString(),
    traffic: {
      used: (TOTAL_SUBSCRIBERS - sequence) * 1024 * 1024,
      total: TOTAL_SUBSCRIBERS * 1024 * 1024,
      balance: sequence * 1024 * 1024,
    },
  };
});

const rowSummary = (rows) => ({
  total: rows.length,
  active: rows.filter((row) => row.access === 'active').length,
  restricted: rows.filter((row) => row.access === 'restricted').length,
  lowTraffic: 0,
  lowBalance: rows.filter((row) => row.balanceState === 'low').length,
  unprovisioned: rows.filter((row) => !row.provisioning.contract || !row.provisioning.balance || !row.provisioning.tariffPlan).length,
});

function filteredRows(params) {
  let rows = subscribers.slice();
  const q = params.get('q') || '';
  if (q) rows = rows.filter((row) => row.imsi.startsWith(q) || row.msisdn === q);
  const access = params.get('status') || 'all';
  if (access !== 'all') rows = rows.filter((row) => row.access === access);
  const contract = params.get('contractStatus') || 'all';
  if (contract !== 'all') rows = rows.filter((row) => row.contractStatus === contract);
  const provisioning = params.get('provisioning') || 'all';
  if (provisioning !== 'all') {
    rows = rows.filter((row) => {
      if (provisioning === 'incomplete') return !row.provisioning.contract || !row.provisioning.balance || !row.provisioning.tariffPlan;
      if (provisioning === 'missing_contract') return !row.provisioning.contract;
      if (provisioning === 'missing_balance') return !row.provisioning.balance;
      if (provisioning === 'missing_plan') return !row.provisioning.tariffPlan;
      return true;
    });
  }
  const planId = params.get('planId') || '';
  if (planId) rows = rows.filter((row) => row.policy === planId);
  const balance = params.get('balanceStatus') || 'all';
  if (balance !== 'all') {
    rows = rows.filter((row) => {
      if (balance === 'available') return row.balanceState === 'low' || row.balanceState === 'normal';
      return row.balanceState === balance;
    });
  }
  const profile = params.get('profile') || '';
  if (profile) rows = rows.filter((row) => row.profile === profile);

  const sortField = params.get('sortField') || 'imsi';
  const direction = params.get('sortDirection') === 'desc' ? -1 : 1;
  const compare = (left, right) => {
    let result = 0;
    if (sortField === 'usage') result = left.traffic.used - right.traffic.used;
    else if (sortField === 'lastActive') result = left.lastActive.localeCompare(right.lastActive);
    else if (sortField === 'policy') result = left.policyName.localeCompare(right.policyName);
    else if (sortField === 'status') result = left.access.localeCompare(right.access);
    else result = left.imsi.localeCompare(right.imsi);
    if (result === 0) result = left.imsi.localeCompare(right.imsi);
    return result * direction;
  };
  return rows.sort(compare);
}

const paginate = (rows, params) => {
  const page = Math.max(1, Number(params.get('page')) || 1);
  const limit = Math.max(1, Number(params.get('limit')) || 50);
  const start = (page - 1) * limit;
  return { page, limit, rows: rows.slice(start, start + limit) };
};

const output = await mkdtemp(path.join(tmpdir(), 'xcloud-subscriber-state-'));
await build({ root: frontendRoot, build: { outDir: output, emptyOutDir: true } });
const { server, baseUrl } = await startStaticServer(output);
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
const page = await context.newPage();
const pageErrors = [];
const consoleErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text());
});

await page.addInitScript((user) => {
  localStorage.setItem('XCLOUD_LANGUAGE_PREFERENCE', 'en');
  localStorage.setItem('XCLOUD_THEME_PREFERENCE', 'light');
  localStorage.setItem('xcloud_auth_token', 'state-acceptance-token');
  localStorage.setItem('xcloud_user', JSON.stringify(user));
  Object.defineProperty(window, 'EventSource', { configurable: true, value: undefined });

  const calls = [];
  const realFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
    const call = { url, method: (init && init.method) || 'GET', settled: false, status: null };
    calls.push(call);
    const result = realFetch(input, init);
    result.then(
      (response) => { call.settled = true; call.status = response.status; },
      () => { call.settled = true; },
    );
    return result;
  };
  window.__subscriberFetch = calls;

  const historyLog = [];
  for (const method of ['pushState', 'replaceState']) {
    const real = window.history[method].bind(window.history);
    window.history[method] = (...args) => {
      const result = real(...args);
      historyLog.push({ method, search: window.location.search });
      return result;
    };
  }
  window.__subscriberHistory = historyLog;
}, ADMIN_USER);

await page.clock.install();

const checks = [];
const failures = [];
function check(id, condition, description) {
  checks.push({ id, description });
  if (condition) {
    console.log(`  ok ${id} - ${description}`);
  } else {
    failures.push({ id, description });
    console.error(`  not ok ${id} - ${description}`);
  }
}

const json = (route, body, status = 200) => route.fulfill({
  status,
  contentType: 'application/json; charset=utf-8',
  body: JSON.stringify(body),
});

const listRequests = [];
const mutationRequests = [];
const held = [];
let holdPredicate = null;
let importHoldPredicate = null;
const importRequests = [];

function maybeHold(kind, params) {
  if (holdPredicate && holdPredicate({ kind, params })) {
    return new Promise((resolve) => held.push({ kind, params, resolve }));
  }
  return Promise.resolve();
}

function releaseHeld(predicate) {
  const index = held.findIndex((entry) => predicate(entry));
  if (index < 0) throw new Error('no held request matches the release predicate');
  const [entry] = held.splice(index, 1);
  entry.resolve();
  return entry;
}

async function waitUntil(predicate, label, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

const paramsOf = (request) => Object.fromEntries(new URL(request.url, baseUrl).searchParams.entries());

async function waitForList(predicate, label) {
  await waitUntil(() => listRequests.some(predicate), label);
}

async function dispatchList(params) {
  await maybeHold('list', params);
  const rows = filteredRows(params);
  const { page: currentPage, limit, rows: pageRows } = paginate(rows, params);
  return {
    subscribers: pageRows,
    total: rows.length,
    page: currentPage,
    limit,
    summary: rowSummary(rows),
  };
}

await page.route('**/data/mcc-mnc-table.json', (route) => json(route, []));
await page.route('**/api/**', async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  const method = request.method();
  const pathname = url.pathname;

  if (pathname === '/api/auth/me') return json(route, ADMIN_USER);
  if (pathname === '/api/auth/permissions') return json(route, { permissions: ADMIN_USER.permissions });
  if (pathname === '/api/profiles') return json(route, { profiles: [{ name: 'tpl-a', title: 'Template A' }, { name: 'tpl-b', title: 'Template B' }] });
  if (pathname === '/api/tariff-plans') {
    return json(route, {
      plans: [
        { id: 'plan-a', plan_id: 'plan-a', name: 'Plan A', enabled: true },
        { id: 'plan-b', plan_id: 'plan-b', name: 'Plan B', enabled: true },
      ],
    });
  }

  if (pathname === '/api/subscribers' && method === 'GET') {
    const params = url.searchParams;
    listRequests.push({ url: request.url(), method, params: Object.fromEntries(params.entries()) });
    const payload = await dispatchList(params);
    return json(route, payload);
  }
  if (pathname === '/api/subscribers' && method === 'POST') {
    mutationRequests.push({ url: request.url(), method });
    return json(route, {});
  }
  if (pathname === '/api/subscribers/bulk-delete' && method === 'POST') {
    mutationRequests.push({ url: request.url(), method });
    return json(route, { deletedCount: 1 });
  }
  if (pathname === '/api/subscribers/import') {
    importRequests.push({ url: request.url(), method });
    if (importHoldPredicate && importHoldPredicate({ pathname, mode: url.searchParams.get('mode') })) {
      await new Promise((resolve) => held.push({ kind: 'import', resolve }));
    }
    return json(route, { result: { requested: 1, imported: 1, skipped: 0, failed: 0 } });
  }
  if (/^\/api\/subscribers\/[^/]+$/.test(pathname)) {
    if (method === 'DELETE') {
      mutationRequests.push({ url: request.url(), method });
      return json(route, {});
    }
    const imsi = decodeURIComponent(pathname.split('/').pop() || '');
    const row = subscribers.find((item) => item.imsi === imsi);
    return json(route, row || {});
  }
  return json(route, {});
});

const rowLocator = (imsi) => page.locator(`[data-subscriber-imsi="${imsi}"]`);
const tableRows = () => page.locator('.subscribers-table tbody tr[data-subscriber-imsi]');
const waitForSettledTable = () => page.waitForFunction(
  () => Boolean(document.querySelector('.table-wrapper'))
    && !document.querySelector('[data-subscriber-list-stale="true"]'),
  undefined,
  { timeout: 15_000 },
);
const goto = async (search = '') => {
  await page.goto(`${baseUrl}/subscribers${search}`, { waitUntil: 'domcontentloaded' });
  await tableRows().first().waitFor({ state: 'visible', timeout: 15_000 });
  await waitForSettledTable();
};
async function openRowMenu(imsi) {
  const trigger = rowLocator(imsi).locator('button[aria-haspopup="menu"]');
  const menu = page.locator('body > #subscriber-row-action-menu');
  /* The list may replace the row during a late revalidation. Retry the trigger
   * and wait on the menu as a business element instead of a detached portal. */
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await trigger.scrollIntoViewIfNeeded();
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    if ((await trigger.getAttribute('aria-expanded')) !== 'true') await trigger.click();
    try {
      await menu.waitFor({ state: 'visible', timeout: 2500 });
      return menu;
    } catch {
      await page.keyboard.press('Escape');
    }
  }
  throw new Error('subscriber row action menu did not stay open');
}
const selectFilter = (label, value) => page.locator('.subscriber-filter-field').filter({ hasText: label }).locator('select').selectOption(value);
const currentUrl = () => new URL(page.url());
const expectSearch = (expected) => {
  const search = currentUrl().search;
  assert.equal(search, expected, `expected URL search ${expected}, got ${search}`);
};

try {
  /* S1: valid deep link restores page, size, sort, filters and profile. */
  await goto('?page=2&size=20&sort=usage&order=desc&access=active&contract=active&profile=tpl-a');
  await waitForList((request) => request.params.page === '2' && request.params.limit === '20', 'deep-link page request');
  const s1Params = paramsOf(listRequests.at(-1));
  check('STATE-S1-1', s1Params.detail === 'true' && s1Params.searchBy === 'auto', 'deep link uses the row-list request mode');
  check('STATE-S1-2', s1Params.page === '2' && s1Params.limit === '20', 'deep link sends the requested page and size');
  check('STATE-S1-3', s1Params.sortField === 'usage' && s1Params.sortDirection === 'desc', 'deep link sends sort field and direction');
  check('STATE-S1-4', s1Params.status === 'active' && s1Params.contractStatus === 'active' && s1Params.profile === 'tpl-a', 'deep link sends filters and profile drill-down');
  const s1Expected = paginate(filteredRows(new URLSearchParams({
    page: '2', limit: '20', sortField: 'usage', sortDirection: 'desc', status: 'active', contractStatus: 'active', profile: 'tpl-a',
  })), new URLSearchParams({ page: '2', limit: '20' })).rows;
  check('STATE-S1-5', await tableRows().count() === s1Expected.length, 'deep link renders the matching page rows');
  check('STATE-S1-6', (await tableRows().first().getAttribute('data-subscriber-imsi')) === s1Expected[0].imsi, 'deep link renders the expected first business row');
  check('STATE-S1-7', (await page.locator('.subscriber-filter-field').filter({ hasText: 'Access Status' }).locator('select').inputValue()) === 'active', 'deep link restores the access control');
  expectSearch('?page=2&size=20&sort=usage&order=desc&access=active&contract=active&profile=tpl-a');

  /* S2: invalid deep link is canonicalized without a history entry or bad API query. */
  const invalidUrl = '?page=0&size=999&sort=secret&order=sideways&access=root&contract=%00&provisioning=almost&plan=%00bad&balance=platinum&q=460020000000001';
  await page.goto(`${baseUrl}/subscribers${invalidUrl}`, { waitUntil: 'domcontentloaded' });
  await tableRows().first().waitFor({ state: 'visible', timeout: 15_000 });
  await waitUntil(() => currentUrl().search === '', 'canonical URL recovery');
  const s2Request = listRequests.at(-1);
  const s2Params = paramsOf(s2Request);
  check('STATE-S2-1', currentUrl().search === '', 'invalid list state degrades to the canonical default URL');
  check('STATE-S2-2', s2Params.page === '1' && s2Params.limit === '10' && s2Params.sortField === 'imsi' && s2Params.sortDirection === 'asc', 'invalid values never reach the API');
  check('STATE-S2-3', s2Params.q === undefined && s2Params.status === undefined && s2Params.contractStatus === undefined, 'unknown URL parameters and search terms are dropped');
  const s2History = await page.evaluate(() => window.__subscriberHistory);
  const s2Entries = s2History.filter((entry) => entry.search === '' || entry.search.includes('page=0'));
  check('STATE-S2-4', s2Entries.every((entry) => entry.method === 'replaceState'), 'canonical recovery uses replaceState only');
  check('STATE-S2-5', (await page.locator('.subscriber-filter-field').filter({ hasText: 'Access Status' }).locator('select').inputValue()) === 'all', 'recovered controls show the safe defaults');

  /* S3: a filter change resets the page atomically in one request/transition. */
  await goto('?page=3&size=10');
  await waitForList((request) => request.params.page === '3', 'page-three request');
  const historyBeforeFilter = await page.evaluate(() => window.__subscriberHistory.length);
  const requestsBeforeFilter = listRequests.length;
  await selectFilter('Access Status', 'active');
  await waitUntil(
    () => listRequests.slice(requestsBeforeFilter).some((request) => request.params.status === 'active'),
    'filtered request',
  );
  await waitForSettledTable();
  const s3Params = paramsOf(listRequests.slice(requestsBeforeFilter).find((request) => request.params.status === 'active'));
  check('STATE-S3-1', s3Params.page === '1' && s3Params.status === 'active', 'filter change resets to page 1 with the new filter');
  check('STATE-S3-2', currentUrl().search === '?access=active', 'filter transition produces one canonical URL');
  check('STATE-S3-3', listRequests.slice(requestsBeforeFilter).every((request) => request.params.page !== '3' || request.params.status !== 'active'), 'no page-3 request is issued with the new filter');
  const s3History = await page.evaluate(() => window.__subscriberHistory);
  const s3NewEntries = s3History.slice(historyBeforeFilter);
  check('STATE-S3-4', s3NewEntries.length === 1 && s3NewEntries[0].method === 'pushState', 'filter change adds exactly one history entry');
  const s3Expected = paginate(filteredRows(new URLSearchParams({ status: 'active' })), new URLSearchParams({ page: '1', limit: '10' })).rows;
  await rowLocator(s3Expected[0].imsi).waitFor({ state: 'visible', timeout: 15_000 });
  check('STATE-S3-5', (await tableRows().first().getAttribute('data-subscriber-imsi')) === s3Expected[0].imsi, 'filtered rows are the new dataset page');

  /* S4: sort field and direction, with page reset and visible order. */
  await goto('?page=2');
  await waitForList((request) => request.params.page === '2', 'page-two request for sort');
  await page.locator('.subscribers-table thead button', { hasText: 'Traffic Usage' }).click();
  await waitForList((request) => request.params.sortField === 'usage' && request.params.sortDirection === 'asc', 'usage ascending request');
  check('STATE-S4-1', paramsOf(listRequests.at(-1)).page === '1', 'sort change resets pagination');
  check('STATE-S4-2', currentUrl().search === '?sort=usage', 'sort field is canonicalized into the URL');
  await page.locator('.subscribers-table thead button', { hasText: 'Traffic Usage' }).click();
  await waitForList((request) => request.params.sortField === 'usage' && request.params.sortDirection === 'desc', 'usage descending request');
  await waitForSettledTable();
  check('STATE-S4-3', currentUrl().search === '?sort=usage&order=desc', 'sort direction is canonicalized into the URL');
  const s4Expected = paginate(filteredRows(new URLSearchParams({ sortField: 'usage', sortDirection: 'desc' })), new URLSearchParams({ page: '1', limit: '10' })).rows;
  await rowLocator(s4Expected[0].imsi).waitFor({ state: 'visible', timeout: 15_000 });
  check('STATE-S4-4', (await tableRows().first().getAttribute('data-subscriber-imsi')) === s4Expected[0].imsi, 'descending usage order is rendered from the new query');
  check('STATE-S4-5', (await page.locator('.subscribers-table thead th[aria-sort="descending"]').count()) === 1, 'the active header exposes descending aria-sort');

  /* S5: detail return context and browser Back/Forward. */
  await goto('?access=active&page=2');
  await waitForList((request) => request.params.page === '2' && request.params.status === 'active', 'page-two active request');
  const s5Rows = await tableRows().count();
  const s5First = await tableRows().first().getAttribute('data-subscriber-imsi');
  await rowLocator(s5First).locator('.imsi-link').first().click();
  await waitUntil(() => currentUrl().pathname === `/subscribers/${s5First}`, 'subscriber detail navigation');
    check('STATE-S5-1', currentUrl().searchParams.get('returnTo') === '/subscribers?page=2&access=active', 'detail link carries the exact list context');
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await waitUntil(() => currentUrl().pathname === '/subscribers' && currentUrl().search === '?page=2&access=active', 'return to list');
  await waitForList((request) => request.params.page === '2' && request.params.status === 'active', 'list reload after return');
  await waitForSettledTable();
  await waitUntil(async () => (await tableRows().count()) === s5Rows, 'returned page row count');
  check('STATE-S5-2', (await tableRows().count()) === s5Rows, 'return restores the same visible page');
  await page.locator('nav button', { hasText: 'Next' }).click();
  await waitUntil(() => currentUrl().searchParams.get('page') === '3', 'next page navigation');
  await page.goBack();
  await waitUntil(() => currentUrl().searchParams.get('page') === '2', 'browser back to page 2');
  await page.goForward();
  await waitUntil(() => currentUrl().searchParams.get('page') === '3', 'browser forward to page 3');
  await waitForList((request) => request.params.page === '3', 'page-three data after forward');
  await waitForSettledTable();
  check('STATE-S5-3', currentUrl().search === '?page=3&access=active', 'Back/Forward restores the intended list URL');
  check('STATE-S5-4', (await rowLocator(s5First).count()) === 0, 'page 3 does not silently reuse page 2 rows');

  /* S6: rapid search, invalid draft and out-of-order responses. */
  await goto('');
  const searchInput = page.locator('form[role="search"] input, input[type="search"]').first();
  const termA = subscribers[0].imsi;
  const termB = subscribers[1].imsi;
  holdPredicate = ({ kind, params }) => kind === 'list' && params.get('q') === termA;
  await searchInput.fill(termA);
  await page.clock.runFor(350);
  await waitUntil(() => held.some((entry) => entry.params?.get('q') === termA), 'held search A response');
  holdPredicate = ({ kind, params }) => kind === 'list' && params.get('q') === termB;
  await searchInput.fill(termB);
  await page.clock.runFor(350);
  await waitUntil(() => held.some((entry) => entry.params?.get('q') === termB), 'held search B response');
  releaseHeld((entry) => entry.params?.get('q') === termB);
  await rowLocator(termB).waitFor({ state: 'visible', timeout: 15_000 });
  releaseHeld((entry) => entry.params?.get('q') === termA);
  await waitUntil(async () => page.evaluate((query) => window.__subscriberFetch.some((call) => call.url.includes(`q=${query}`) && call.settled), termA), 'settled older search A');
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  holdPredicate = null;
  check('STATE-S6-1', (await rowLocator(termB).count()) === 1 && (await rowLocator(termA).count()) === 0, 'the newer search result remains authoritative after the older response settles');
  check('STATE-S6-2', currentUrl().search === '', 'search terms never enter the browser URL');
  await searchInput.fill('abc');
  await page.clock.runFor(350);
  check('STATE-S6-3', (await page.getByRole('alert').filter({ hasText: 'digits' }).count()) === 1, 'invalid search input shows the existing validation warning');
  check('STATE-S6-4', listRequests.every((request) => request.params.q !== 'abc'), 'invalid drafts never issue an API search');
  check('STATE-S6-5', (await rowLocator(termB).count()) === 1, 'the last valid search remains visible while the draft is invalid');
  await searchInput.fill('');
  await page.clock.runFor(350);
  await waitForSettledTable();
  await tableRows().first().waitFor({ state: 'visible' });
  check('STATE-S6-6', (await tableRows().count()) === 10, 'clearing search restores the unfiltered first page');
  const searchClearBaseline = listRequests.length;
  await page.locator('nav button', { hasText: 'Next' }).click();
  await waitUntil(
    () => listRequests.slice(searchClearBaseline).some((request) => request.params.q === undefined && request.params.page === '2'),
    'clear-search pagination request',
  );
  check('STATE-S6-7', paramsOf(listRequests.at(-1)).q === undefined, 'the effective API query has no search term after clearing');

  /* S7: selection invalidation, stale guards, select-all and partial selection. */
  await goto('');
  const firstTwo = await tableRows().locator('input[type="checkbox"]');
  await firstTwo.nth(0).check();
  await firstTwo.nth(1).check();
  check('STATE-S7-1', (await page.locator('.bulk-actions-count').textContent())?.includes('2') === true, 'partial selection reports two IMSIs');
  check('STATE-S7-2', await page.locator('.mobile-select-all input').evaluate((input) => input.indeterminate === true), 'partial selection exposes an indeterminate select-all');
  await selectFilter('Access Status', 'restricted');
  await waitForList((request) => request.params.status === 'restricted', 'restricted filter request');
  check('STATE-S7-3', (await page.locator('.bulk-actions-count').count()) === 0, 'filter change clears the incompatible selection');
  check('STATE-S7-4', (await page.locator('.bulk-actions-buttons').count()) === 0, 'bulk mutation buttons cannot target the stale selection');
  holdPredicate = ({ kind, params }) => kind === 'list' && params.get('contractStatus') === 'active';
  await selectFilter('Contract Status', 'active');
  await waitUntil(() => held.some((entry) => entry.params?.get('contractStatus') === 'active'), 'held stale filter response');
  const staleRowCheckbox = page.locator('.subscribers-table tbody input[type="checkbox"]').first();
  await staleRowCheckbox.click();
  const staleHeaderCheckbox = page.locator('.subscribers-table thead input[type="checkbox"]');
  await staleHeaderCheckbox.click();
  check('STATE-S7-5', (await staleRowCheckbox.isChecked()) === false, 'a provisional row cannot be selected');
  check('STATE-S7-6', (await page.locator('.bulk-actions-count').count()) === 0, 'provisional selection never produces a bulk target');
  releaseHeld((entry) => entry.params?.get('contractStatus') === 'active');
  holdPredicate = null;
  await waitForList((request) => request.params.contractStatus === 'active' && request.params.status === 'restricted', 'settled filtered page');
  await waitForSettledTable();
  await tableRows().first().waitFor({ state: 'visible' });
  const headerCheckbox = page.locator('.subscribers-table thead input[type="checkbox"]');
  await headerCheckbox.check();
  const pageCount = await tableRows().count();
  check('STATE-S7-7', (await page.locator('.bulk-actions-count').textContent())?.includes(String(pageCount)) === true, 'select-all is scoped to the current page');
  await tableRows().first().locator('input[type="checkbox"]').uncheck();
  check('STATE-S7-8', await headerCheckbox.evaluate((input) => input.indeterminate === true), 'unchecking one row produces a partial selection');

  /* S8: governed single delete keeps the active query stable and never duplicates. */
  await goto('?access=active&sort=usage');
  await waitForList((request) => request.params.sortField === 'usage', 'query before delete');
  const deleteTarget = await tableRows().first().getAttribute('data-subscriber-imsi');
  const deleteRequestsBefore = mutationRequests.length;
  const listRequestsBeforeDelete = listRequests.length;
  const rowMenu = await openRowMenu(deleteTarget);
  const deleteMenuItem = rowMenu.locator('.dropdown-menu-item.danger');
  await deleteMenuItem.evaluate((button) => button.click());
  const deleteDialog = page.getByRole('alertdialog');
  await deleteDialog.waitFor({ state: 'visible' });
  await deleteDialog.getByRole('button', { name: 'Delete', exact: true }).click();
  await waitUntil(() => mutationRequests.some((request) => request.method === 'DELETE'), 'DELETE request');
  await waitForList(() => listRequests.length > listRequestsBeforeDelete, 'post-delete list refresh');
  const s8Deletes = mutationRequests.slice(deleteRequestsBefore).filter((request) => request.method === 'DELETE');
  check('STATE-S8-1', s8Deletes.length === 1, 'delete is issued exactly once');
  check('STATE-S8-2', new URL(s8Deletes[0].url).pathname === `/api/subscribers/${deleteTarget}`, 'delete targets the selected IMSI');
  check('STATE-S8-3', currentUrl().search === '?sort=usage&access=active', 'the query survives the mutation refresh');
  check('STATE-S8-4', paramsOf(listRequests.at(-1)).status === 'active' && paramsOf(listRequests.at(-1)).sortField === 'usage', 'the refresh reuses the governed query');

  /* S9: import dismissal protection while the request is in flight. */
  await goto('');
  const importRequestsBefore = importRequests.length;
  await page.getByRole('button', { name: 'Import subscribers' }).first().click();
  const importDialog = page.getByRole('dialog').last();
  await importDialog.waitFor({ state: 'visible' });
  await page.locator('#subscriber-import-file').setInputFiles({
    name: 'subscribers.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify([{ imsi: '460020000000999' }])),
  });
  importHoldPredicate = ({ mode }) => mode === 'import';
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await waitUntil(() => importRequests.length > importRequestsBefore, 'import POST request');
  await waitUntil(() => held.some((entry) => entry.kind === 'import'), 'held import request');
  await page.keyboard.press('Escape');
  check('STATE-S9-1', await importDialog.isVisible(), 'Escape cannot dismiss an in-flight import');
  check('STATE-S9-2', await importDialog.getByRole('button', { name: 'Close' }).isDisabled(), 'the close control is disabled during an in-flight import');
  check('STATE-S9-2B', await importDialog.isVisible(), 'the in-flight import remains mounted');
  const s9Imports = importRequests.slice(importRequestsBefore).filter((request) => request.url.includes('mode=import'));
  check('STATE-S9-3', s9Imports.length === 1, 'the import mutation is issued exactly once');
  const heldImport = held.find((entry) => entry.kind === 'import');
  if (heldImport) heldImport.resolve();
  importHoldPredicate = null;
  await importDialog.getByText(/Import finished/).waitFor({ state: 'visible', timeout: 15_000 });
  await importDialog.locator('button.btn-icon[aria-label="Close"]').click();
  await importDialog.waitFor({ state: 'detached' });

  /* S10: desktop and mobile controls remain available and functional. */
  await page.setViewportSize({ width: 1440, height: 900 });
  await goto('?access=active');
  check('STATE-S10-1', await page.locator('input[type="search"]').isVisible(), 'desktop search control is visible');
  check('STATE-S10-2', await page.locator('.subscriber-filter-field').first().isVisible(), 'desktop filters are visible');
  check('STATE-S10-3', await page.locator('.subscribers-table thead button').first().isVisible(), 'desktop table sorting remains usable');
  await page.setViewportSize({ width: 375, height: 812 });
  await page.locator('input[type="search"]').waitFor({ state: 'visible' });
  check('STATE-S10-4', await page.locator('.mobile-sort-strip').isVisible(), 'mobile sort strip is visible');
  check('STATE-S10-5', await page.locator('.subscriber-filter-field').first().isVisible(), 'mobile filters remain visible');
  check('STATE-S10-6', await page.locator('nav button', { hasText: 'Next' }).isEnabled(), 'mobile pagination remains usable');
  const mobileListBefore = listRequests.length;
  await page.locator('nav button', { hasText: 'Next' }).click();
  await waitUntil(() => currentUrl().searchParams.get('page') === '2', 'mobile pagination navigation');
  await waitForList(() => listRequests.length > mobileListBefore, 'mobile page-two request');
  check('STATE-S10-7', currentUrl().search === '?page=2&access=active', 'mobile pagination preserves filters in the URL');

  check('STATE-SYS-1', pageErrors.length === 0, `zero uncaught page exceptions (${pageErrors.length})`);
  check('STATE-SYS-2', consoleErrors.length === 0, `zero unexpected console errors (${consoleErrors.length})`);
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(output, { recursive: true, force: true }).catch(() => undefined);
}

console.log('=============================================================');
if (failures.length > 0) {
  console.error(`[acceptance:subscriber-state] FAILED ${failures.length} check(s) of ${checks.length}`);
  for (const failure of failures) console.error(`  - ${failure.id}: ${failure.description}`);
  process.exitCode = 1;
} else {
  console.log(`[acceptance:subscriber-state] passed ${checks.length}/${checks.length} assertions`);
}