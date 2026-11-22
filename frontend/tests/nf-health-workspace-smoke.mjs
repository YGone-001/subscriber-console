#!/usr/bin/env node
/*
 * NF Health workspace browser acceptance.
 *
 * Renders the REAL production SPA build in real Chromium against the
 * deterministic NF Health fixture server and asserts browser-observable
 * behaviour for the list workspace: the card queue, the audit table, the
 * interface matrix, URL state, the rapid-search race, the 30s polling lifecycle,
 * full-population KPI semantics, failure isolation, permissions and governed
 * collection, the metric-assurance detail panels, and responsive/accessibility
 * behaviour.
 *
 * Scope note, stated so the evidence is never overstated: these checks prove
 * frontend behaviour against replay fixtures. They are not evidence that a live
 * exporter was deployed, that the aggregate pipeline ran, or that a week of
 * production data was accurate. Those acceptance records live elsewhere and are
 * unaffected by this suite.
 *
 * Asynchronous completion is proven with request/response barriers and rendered
 * business identities. The 30s polling policy is proven with a captured-timer
 * fixture, never by waiting wall-clock seconds.
 *
 * Usage (from frontend/): node tests/nf-health-workspace-smoke.mjs
 */
/* global Event, Document, getComputedStyle */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';
import { build } from 'vite';

import { SESSIONS, TARGET_IDS, startFixtureServer } from './nf-health-fixtures.mjs';

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const checks = [];
const failures = [];

function check(id, ok, detail = '') {
  const passed = Boolean(ok);
  checks.push({ id, ok: passed, detail });
  if (passed) {
    console.log(`  ok ${id} - ${detail}`);
  } else {
    failures.push(`${id}: ${detail}`);
    console.error(`  not ok ${id} - ${detail}`);
    if (process.env.GITHUB_ACTIONS) console.log(`::error title=${id}::${detail.replace(/\s+/g, ' ')}`);
  }
  return passed;
}

const BENIGN_CONSOLE = [
  /Download the React DevTools/i,
  /favicon/i,
];

const IDS = { amf: TARGET_IDS.amf, smf: TARGET_IDS.smf, upf: TARGET_IDS.upf };
const LIST_READ = '/api/nf-health/targets?';
const KPI_LABEL = 'NF Health summary';
const STATE_FILTER = 'Collection state';
const SORT_FILTER = 'Order';

/* ------------------------------------------------------------------ pages -- */

function initScript({ locale, theme, hidden }) {
  try {
    localStorage.setItem('XCLOUD_LANGUAGE_PREFERENCE', locale);
    localStorage.setItem('XCLOUD_THEME_PREFERENCE', theme);
  } catch {
    /* Storage unavailable: a wrong locale would fail the localization check. */
  }

  /* Deterministic timer fixture. Long-lived intervals (the 30s NF Health poll)
   * are captured instead of scheduled and fire only when the suite asks, exactly
   * like the accepted performance harness does. */
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
  window.__nfTimers = {
    list: () => longTimers.map((entry) => ({ id: entry.id, delay: entry.delay, active: entry.active })),
    fireAll: () => { [...longTimers].forEach((entry) => entry.callback(...entry.args)); },
  };

  /* Visibility is a policy input, so it is driven explicitly. */
  window.__nfHidden = hidden === true;
  Object.defineProperty(Document.prototype, 'hidden', {
    configurable: true,
    get() { return window.__nfHidden === true; },
  });
  Object.defineProperty(Document.prototype, 'visibilityState', {
    configurable: true,
    get() { return window.__nfHidden === true ? 'hidden' : 'visible'; },
  });
}

async function openPage(browser, { locale = 'en', theme = 'light', width = 1440, height = 900, hidden = false }) {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
    locale: locale === 'zh' ? 'zh-CN' : 'en-US',
    timezoneId: 'UTC',
    reducedMotion: 'reduce',
    colorScheme: theme === 'dark' ? 'dark' : 'light',
  });
  await context.addInitScript(initScript, { locale, theme, hidden });
  const page = await context.newPage();
  const apiCalls = [];
  const pageErrors = [];
  const consoleErrors = [];
  page.on('request', (request) => {
    const url = request.url();
    if (url.includes('/api/')) apiCalls.push({ method: request.method(), url });
  });
  page.on('pageerror', (error) => pageErrors.push(String(error?.message ?? error)));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    if (BENIGN_CONSOLE.some((pattern) => pattern.test(text))) return;
    consoleErrors.push(text);
  });
  return { context, page, apiCalls, pageErrors, consoleErrors };
}

async function gotoWorkspace(page, origin, search = '') {
  await page.goto(`${origin}/nf-health${search}`);
  await page.waitForSelector('[data-nf-health-panel]', { state: 'visible', timeout: 30000 });
}

function apiCallsMatching(apiCalls, needle, method) {
  return apiCalls.filter((call) => call.url.includes(needle) && (!method || call.method === method));
}

async function cardIds(page) {
  return page.locator('[data-nf-health-card]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-nf-health-card')));
}

async function bodyText(page) {
  return page.locator('body').innerText();
}

function noBrowserErrors(id, pageErrors, consoleErrors) {
  return check(id, pageErrors.length === 0 && consoleErrors.length === 0, `no browser errors (${pageErrors.concat(consoleErrors).join(' | ')})`);
}

/* ------------------------------------------------------------ the matrix -- */

async function main() {
  console.log('[acceptance:nf-health-workspace] Building the production SPA...');
  const tmpDist = await mkdtemp(path.join(tmpdir(), 'xcloud-nf-health-workspace-'));
  let browser;
  const servers = [];

  try {
    const buildResult = await build({
      root: frontendRoot,
      logLevel: 'warn',
      build: { outDir: tmpDist, emptyOutDir: true },
    });
    const output = (Array.isArray(buildResult) ? buildResult[0] : buildResult).output;
    check(
      'H0-A',
      output.filter((item) => item.type === 'chunk').length > 0,
      'the production build emitted JavaScript chunks',
    );

    const operatorServer = await startFixtureServer({ distDir: tmpDist, sessionKey: 'operator' });
    servers.push(operatorServer);
    const viewerServer = await startFixtureServer({ distDir: tmpDist, sessionKey: 'viewer' });
    servers.push(viewerServer);
    const wideServer = await startFixtureServer({ distDir: tmpDist, sessionKey: 'operator', population: 'wide' });
    servers.push(wideServer);
    const partialServer = await startFixtureServer({
      distDir: tmpDist,
      sessionKey: 'operator',
      population: 'wide',
      healthCompleteness: 'partial',
    });
    servers.push(partialServer);

    browser = await chromium.launch({ headless: true });

    /* ================================================== H1 default cards == */
    {
      const { context, page, apiCalls, pageErrors, consoleErrors } = await openPage(browser, { origin: operatorServer.origin });
      await gotoWorkspace(page, operatorServer.origin);

      check('H1-A', await page.locator('[data-nf-health-panel="cards"]').count() === 1, 'the default view is the card queue');
      check(
        'H1-B',
        await page.locator('[data-nf-health-view="cards"][aria-pressed="true"]').count() === 1,
        'the cards option is the pressed view switch',
      );

      await page.waitForSelector('[data-nf-health-card]', { state: 'visible' });
      const ids = await cardIds(page);
      check(
        'H1-C',
        ids.length === 3 && ids[0] === IDS.amf && ids[1] === IDS.smf && ids[2] === IDS.upf,
        `the server risk order is preserved: ${ids.join(',')}`,
      );

      /* Domain is a server-derived projection. The legacy candidate-only target
       * has none, so the card wall renders the honest unknown bucket beside the
       * known domain instead of inventing a domain for it. */
      const groups = (await page.locator('[data-nf-health-panel="cards"] h3').allInnerTexts())
        .map((text) => text.trim().toUpperCase());
      check(
        'H1-D',
        groups.length === 2 && groups[0] === '5GC' && groups[1] === 'UNKNOWN DOMAIN',
        `the server-derived domain groups render in order: ${groups.join('|')}`,
      );

      const firstCard = page.locator(`[data-nf-health-card="${IDS.amf}"]`);
      const firstText = await firstCard.innerText();
      check('H1-E', /L1 · /.test(firstText) && /L2 · /.test(firstText) && /L3 · /.test(firstText), 'L1/L2/L3 evidence badges render');
      check('H1-F', firstText.includes('AMF core-01 metrics') && firstText.includes('AMF'), 'the card shows the target identity and NF type');

      await firstCard.click();
      const drawer = page.getByRole('dialog');
      await drawer.waitFor({ state: 'visible' });
      check('H1-G', (await drawer.innerText()).includes('AMF core-01 metrics'), 'clicking a card opens its evidence drawer');
      await drawer.getByRole('button', { name: 'Close' }).click();
      await drawer.waitFor({ state: 'detached' });
      check('H1-G2', await page.getByRole('dialog').count() === 0, 'the drawer closes on request');

      const detailLink = page.locator(`[data-nf-health-card="${IDS.amf}"]`).locator('xpath=ancestor::article').locator('a');
      const href = await detailLink.getAttribute('href');
      check(
        'H1-H',
        Boolean(href && href.startsWith(`/nf-health/${IDS.amf}`) && href.includes('returnTo=')),
        `the card detail link carries the list context: ${href}`,
      );
      await detailLink.click();
      await page.waitForURL((url) => url.pathname === `/nf-health/${IDS.amf}`);
      check('H1-I', page.url().includes('returnTo='), 'detail navigation preserves the list URL');

      noBrowserErrors('H1-J', pageErrors, consoleErrors);
      check('H1-K', operatorServer.unexpected.length === 0, `no unexpected API request: ${operatorServer.unexpected.join(',')}`);
      check(
        'H1-L',
        apiCallsMatching(apiCalls, LIST_READ).length === 1,
        `the card queue issued exactly one list read (${apiCallsMatching(apiCalls, LIST_READ).length})`,
      );
      await context.close();
    }

    /* ================================================== H2 audit table ==== */
    {
      const { context, page, pageErrors, consoleErrors } = await openPage(browser, { origin: operatorServer.origin });
      await gotoWorkspace(page, operatorServer.origin, '?view=table');
      await page.waitForSelector('[data-nf-health-panel="table"] table', { state: 'visible' });

      check('H2-A', await page.locator('[data-nf-health-card]').count() === 0, 'the card queue is not rendered behind the table');
      check('H2-B', await page.locator('[data-nf-health-panel="cards"]').count() === 0, 'only one representation renders at a time');

      const headers = await page.locator('[data-nf-health-panel="table"] thead th').allInnerTexts();
      check('H2-C', headers.length === 10, `the accepted column inventory is intact (${headers.length} columns)`);

      const rows = await page.locator('[data-nf-health-panel="table"] tbody tr').evaluateAll((nodes) => nodes.map((node) => node.textContent ?? ''));
      check(
        'H2-D',
        rows.length === 3 && rows[0].includes('AMF core-01 metrics') && rows[1].includes('SMF core-01 metrics') && rows[2].includes('UPF core-01 metrics'),
        'the table keeps the backend order',
      );
      check('H2-E', /legacy/i.test(rows[2]), 'a legacy identity is labelled in the audit table');

      const firstRow = page.locator('[data-nf-health-panel="table"] tbody tr').first();
      const collect = firstRow.getByRole('button', { name: 'Collect Now' });
      check('H2-F', await collect.count() === 1 && await collect.isEnabled(), 'an operator sees an enabled collection action');

      await firstRow.getByRole('link', { name: 'AMF core-01 metrics' }).click();
      await page.waitForURL((url) => url.pathname === `/nf-health/${IDS.amf}`);
      check('H2-G', true, 'the audit table links to the target detail');

      noBrowserErrors('H2-H', pageErrors, consoleErrors);
      check('H2-I', operatorServer.unexpected.length === 0, 'no unexpected API request from the table view');
      await context.close();
    }

    /* ============================================== H3 interface matrix === */
    {
      const { context, page, pageErrors, consoleErrors } = await openPage(browser, { origin: operatorServer.origin });
      await gotoWorkspace(page, operatorServer.origin, '?view=interfaces');
      await page.waitForSelector('[data-nf-health-matrix]', { state: 'visible' });

      check('H3-A', await page.locator('[data-nf-health-card]').count() === 0, 'the matrix does not render cards');
      check(
        'H3-B',
        await page.locator('[data-nf-health-panel="table"] table:not([data-nf-health-matrix])').count() === 0,
        'the matrix does not render the audit table',
      );

      // The matrix headings are uppercased by the stylesheet, so the column
      // vocabulary is compared case-insensitively.
      const headers = (await page.locator('[data-nf-health-matrix] thead th').allInnerTexts())
        .map((text) => text.trim().toUpperCase());
      check(
        'H3-C',
        headers.length === 8
          && ['METRICS', 'SBI', 'OAM', 'HEALTH'].every((family) => headers.includes(family)),
        `the matrix renders the server-provided interface columns: ${headers.join('|')}`,
      );

      const oamText = (await page.locator(`[data-nf-health-cell="${IDS.amf}:oam"]`).innerText()).trim();
      check('H3-D', oamText === 'Not configured', `an undeclared interface family is not configured, not healthy: ${oamText}`);
      check(
        'H3-E',
        (await page.locator(`[data-nf-health-cell="${IDS.amf}:sbi"]`).innerText()).trim() === 'Healthy',
        'a measured interface family renders its own state',
      );
      check(
        'H3-F',
        await page.locator(`[data-nf-health-matrix-row="${IDS.smf}"]`).count() === 1,
        'the matrix row is keyed by the target identity',
      );

      noBrowserErrors('H3-G', pageErrors, consoleErrors);
      check('H3-H', operatorServer.unexpected.length === 0, 'no unexpected API request from the matrix view');
      await context.close();
    }

    /* =================================================== H4 URL state ===== */
    {
      const { context, page, apiCalls, pageErrors, consoleErrors } = await openPage(browser, { origin: operatorServer.origin });

      await gotoWorkspace(page, operatorServer.origin, '?view=table&q=smf');
      await page.waitForSelector('[data-nf-health-panel="table"] tbody tr', { state: 'visible' });
      check(
        'H4-A',
        await page.locator('[data-nf-health-panel="table"] tbody tr').count() === 1,
        'a deep link restores the view and the search term',
      );
      check(
        'H4-B',
        (await page.getByRole('search').locator('input[type="search"]').inputValue()) === 'smf',
        'the search box reflects the deep-linked term',
      );
      const searchRequest = apiCallsMatching(apiCalls, LIST_READ).at(-1);
      check(
        'H4-C',
        Boolean(searchRequest && new URL(searchRequest.url).searchParams.get('q') === 'smf'),
        'the search term reached the request boundary',
      );

      await gotoWorkspace(page, operatorServer.origin, '?state=enabled');
      await page.waitForSelector('[data-nf-health-card]', { state: 'visible' });
      const legacyEnabled = new URL(apiCallsMatching(apiCalls, LIST_READ).at(-1).url);
      check(
        'H4-D',
        legacyEnabled.searchParams.get('enabled') === 'true' && legacyEnabled.searchParams.get('state') === null,
        'the legacy state=enabled alias still narrows the collection state',
      );
      check(
        'H4-E',
        (await page.getByLabel(STATE_FILTER).inputValue()) === 'true',
        'the legacy alias is reflected in the collection-state filter',
      );

      await gotoWorkspace(page, operatorServer.origin, '?state=disabled');
      const legacyDisabled = new URL(apiCallsMatching(apiCalls, LIST_READ).at(-1).url);
      check('H4-F', legacyDisabled.searchParams.get('enabled') === 'false', 'the legacy state=disabled alias still works');

      await page.goBack();
      await page.waitForURL((url) => url.search.includes('state=enabled'));
      await page.waitForSelector('[data-nf-health-card]', { state: 'visible' });
      check('H4-G', true, 'browser back restores the previous URL state');

      await gotoWorkspace(page, operatorServer.origin, '?view=table&sort=updated');
      await page.waitForSelector('[data-nf-health-panel="table"]', { state: 'visible' });
      await page.getByLabel(SORT_FILTER).selectOption('risk');
      await page.waitForURL((url) => url.searchParams.get('sort') === 'risk');
      await page.waitForTimeout(400);
      const afterUrl = new URL(page.url());
      check('H4-H', afterUrl.searchParams.get('cursor') === null, 'a filter change drops the obsolete cursor');

      noBrowserErrors('H4-I', pageErrors, consoleErrors);
      check('H4-J', operatorServer.unexpected.length === 0, 'no unexpected API request while navigating URL state');
      await context.close();
    }

    /* ==================================== H5 rapid search and data races === */
    {
      const { context, page, pageErrors, consoleErrors } = await openPage(browser, { origin: operatorServer.origin });

      let releaseOld;
      const oldGate = new Promise((resolve) => { releaseOld = resolve; });
      let oldRequested;
      const oldSeen = new Promise((resolve) => { oldRequested = resolve; });

      await page.route('**/api/nf-health/targets?**', async (route) => {
        const url = new URL(route.request().url());
        const term = url.searchParams.get('q') ?? '';
        const response = await route.fetch();
        if (term === 'amf') {
          oldRequested();
          await oldGate;
          await route.fulfill({ response });
          return;
        }
        await route.fulfill({ response });
      });

      await gotoWorkspace(page, operatorServer.origin);
      await page.waitForSelector('[data-nf-health-card]', { state: 'visible' });

      const search = page.getByRole('search').locator('input[type="search"]');
      const submit = page.getByRole('search').getByRole('button', { name: 'Search' });

      await search.fill('amf');
      await submit.click();
      await oldSeen;
      check('H5-A0', true, 'the older query reached the request boundary before it was replaced');

      await search.fill('smf');
      await submit.click();
      await page.waitForFunction(
        (expected) => document.querySelectorAll('[data-nf-health-card]').length === 1
          && document.querySelector('[data-nf-health-card]')?.getAttribute('data-nf-health-card') === expected,
        IDS.smf,
        { timeout: 20000 },
      );
      check('H5-A', true, 'the latest query result is rendered');

      releaseOld();
      await page.waitForTimeout(600);
      const afterRelease = await cardIds(page);
      check(
        'H5-B',
        afterRelease.length === 1 && afterRelease[0] === IDS.smf,
        `the older result cannot replace the newer dataset: ${afterRelease.join(',')}`,
      );
      check('H5-C', (await search.inputValue()) === 'smf', 'a late URL echo does not replace the search draft');
      check('H5-D', !/unreachable|could not reach/i.test(await bodyText(page)), 'a superseded read never surfaces a false service-unreachable error');
      noBrowserErrors('H5-E', pageErrors, consoleErrors);
      await context.close();
    }

    /* ====================================================== H6 polling ===== */
    {
      const { context, page, apiCalls, pageErrors, consoleErrors } = await openPage(browser, { origin: operatorServer.origin });
      await gotoWorkspace(page, operatorServer.origin);
      await page.waitForSelector('[data-nf-health-card]', { state: 'visible' });

      const timers = await page.evaluate(() => window.__nfTimers.list());
      check(
        'H6-A',
        timers.length === 1 && timers[0].delay === 30000,
        `exactly one 30s interval is registered: ${JSON.stringify(timers)}`,
      );

      const beforeTick = apiCallsMatching(apiCalls, LIST_READ).length;
      await page.evaluate(() => window.__nfTimers.fireAll());
      await page.waitForTimeout(600);
      const afterTick = apiCallsMatching(apiCalls, LIST_READ).length;
      check('H6-B', afterTick === beforeTick + 1, `one polling tick issues exactly one list read (${beforeTick} -> ${afterTick})`);

      await page.evaluate(() => { window.__nfHidden = true; });
      const beforeHidden = apiCallsMatching(apiCalls, LIST_READ).length;
      await page.evaluate(() => window.__nfTimers.fireAll());
      await page.waitForTimeout(500);
      check(
        'H6-C',
        apiCallsMatching(apiCalls, LIST_READ).length === beforeHidden,
        'a hidden tab issues no polling request',
      );

      await page.evaluate(() => { window.__nfHidden = false; });
      const beforeVisible = apiCallsMatching(apiCalls, LIST_READ).length;
      await page.evaluate(() => { document.dispatchEvent(new Event('visibilitychange')); });
      await page.waitForTimeout(600);
      check(
        'H6-D',
        apiCallsMatching(apiCalls, LIST_READ).length === beforeVisible + 1,
        'restoring visibility revalidates exactly once',
      );

      /* Route unmount is proven with an in-app navigation: a window marker
       * survives the transition only when the document was not reloaded, so the
       * cleared interval is the route teardown and not a fresh page load. */
      await page.evaluate(() => { window.__nfMarker = 'alive'; });
      await page.locator(`[data-nf-health-card="${IDS.amf}"]`).locator('xpath=ancestor::article').locator('a').click();
      await page.waitForURL((url) => url.pathname === `/nf-health/${IDS.amf}`);
      await page.waitForTimeout(500);
      const stillAlive = await page.evaluate(() => window.__nfMarker);
      const afterUnmount = await page.evaluate(() => window.__nfTimers.list());
      check('H6-E0', stillAlive === 'alive', 'the route change happened inside the SPA, without a document reload');
      check('H6-E', afterUnmount.length === 0, `route unmount clears the polling interval: ${JSON.stringify(afterUnmount)}`);
      noBrowserErrors('H6-F', pageErrors, consoleErrors);
      await context.close();
    }

    /* ============================================== H7 KPI accuracy ======== */
    {
      const { context, page, pageErrors, consoleErrors } = await openPage(browser, { origin: wideServer.origin });
      await gotoWorkspace(page, wideServer.origin);
      await page.waitForSelector('[data-nf-health-card]', { state: 'visible' });

      const visibleCards = await page.locator('[data-nf-health-card]').count();
      check('H7-A', visibleCards === 20, `the visible page holds one bounded page (${visibleCards})`);

      const kpiStrip = page.getByLabel(KPI_LABEL);
      const kpiText = await kpiStrip.innerText();
      check('H7-B', /\b24\b/.test(kpiText), `the KPI strip reports the full population, not the visible page: ${kpiText.replace(/\s+/g, ' ')}`);
      check('H7-B2', !/\b20\b/.test(kpiText), 'the page size never leaks into the KPI strip');

      const l3Card = page.locator('[data-nf-health-card="wide-0000-4000-8000-000000000003"]');
      check(
        'H7-F',
        (await l3Card.innerText()).includes('Not configured'),
        'an unsupported layer is reported as not configured rather than healthy',
      );

      const nextButton = page.getByRole('button', { name: 'Next', exact: true });
      check('H7-C', await nextButton.count() === 1 && await nextButton.isEnabled(), 'the cursor pager offers the next page');
      await nextButton.click();
      await page.waitForFunction(
        () => document.querySelectorAll('[data-nf-health-card]').length === 4,
        null,
        { timeout: 20000 },
      );
      check('H7-D', await page.locator('[data-nf-health-card]').count() === 4, 'the second page holds the remaining four targets');
      check(
        'H7-E',
        /\b24\b/.test(await kpiStrip.innerText()),
        'stepping the cursor does not change the full-population KPI strip',
      );

      noBrowserErrors('H7-G', pageErrors, consoleErrors);
      check('H7-H', wideServer.unexpected.length === 0, 'no unexpected API request on the wide population');
      await context.close();
    }
    {
      /* A partial summary must degrade the KPI strip to explicit unavailability
       * instead of a zero population. */
      const { context, page } = await openPage(browser, { origin: partialServer.origin });
      await gotoWorkspace(page, partialServer.origin);
      await page.waitForSelector('[data-nf-health-card]', { state: 'visible' });
      const kpiText = await page.getByLabel(KPI_LABEL).innerText();
      check('H7-I', kpiText.includes('-'), `a partial summary leaves the KPI values explicitly unavailable: ${kpiText.replace(/\s+/g, ' ')}`);
      check('H7-J', !/\b0\b/.test(kpiText), 'an unavailable KPI is never rendered as a zero count');
      check(
        'H7-K',
        await page.locator('[data-nf-health-card]').count() === 20,
        'the list itself still renders while the summary is partial',
      );
      await context.close();
    }

    /* ============================================ H8 failure isolation ===== */
    {
      const { context, page, pageErrors } = await openPage(browser, { origin: operatorServer.origin });
      await page.route('**/api/nf-health/targets?**', (route) => route.fulfill({ status: 503, json: { error: 'unavailable', code: 'UNAVAILABLE' } }));
      await gotoWorkspace(page, operatorServer.origin);
      await page.waitForTimeout(700);
      check('H8-A', await page.locator('[data-nf-health-card]').count() === 0, 'a failed target read renders no fabricated cards');
      check('H8-A2', /could not|unavailable|failed/i.test(await bodyText(page)), 'a failed target read surfaces an explicit error state');
      check('H8-A3', pageErrors.length === 0, 'a failed target read does not raise a page error');
      await context.close();
    }
    {
      const { context, page, pageErrors } = await openPage(browser, { origin: operatorServer.origin });
      await page.route('**/api/nf-health/interfaces?**', (route) => route.fulfill({ status: 503, json: { error: 'unavailable', code: 'UNAVAILABLE' } }));
      await gotoWorkspace(page, operatorServer.origin, '?view=interfaces');
      await page.waitForTimeout(700);
      check('H8-B', await page.locator('[data-nf-health-matrix]').count() === 0, 'a failed matrix read renders no fabricated matrix');
      check('H8-B2', /could not|unavailable|failed/i.test(await bodyText(page)), 'a failed matrix read surfaces an explicit error state');
      check('H8-B3', pageErrors.length === 0, 'a failed matrix read does not raise a page error');
      await context.close();
    }
    {
      const { context, page, pageErrors } = await openPage(browser, { origin: operatorServer.origin });
      await page.route('**/api/operations/summary?**', (route) => route.fulfill({ status: 503, json: { error: 'unavailable', code: 'UNAVAILABLE' } }));
      await gotoWorkspace(page, operatorServer.origin);
      await page.waitForSelector('[data-nf-health-card]', { state: 'visible' });
      const kpiText = await page.getByLabel(KPI_LABEL).innerText();
      check('H8-C', kpiText.includes('-'), 'a failed summary degrades only the KPI strip to unavailable');
      check('H8-C2', !/\b0\b/.test(kpiText), 'a failed summary never fabricates a zero population');
      check('H8-C3', await page.locator('[data-nf-health-card]').count() === 3, 'the queue still renders when the summary fails');
      check('H8-C4', pageErrors.length === 0, 'a failed summary does not raise a page error');
      await context.close();
    }
    {
      const { context, page, pageErrors } = await openPage(browser, { origin: operatorServer.origin });
      await page.route('**/api/nf-health/meta', (route) => route.fulfill({ status: 503, json: { error: 'unavailable', code: 'UNAVAILABLE' } }));
      await gotoWorkspace(page, operatorServer.origin);
      await page.waitForSelector('[data-nf-health-card]', { state: 'visible' });
      check('H8-D', await page.locator('[data-nf-health-card]').count() === 3, 'a failed metadata read does not blank the queue');
      check('H8-D2', pageErrors.length === 0, 'a failed metadata read does not raise a page error');
      await context.close();
    }

    /* ================================ H9 permissions and governed collect == */
    {
      const { context, page, apiCalls, pageErrors, consoleErrors } = await openPage(browser, { origin: viewerServer.origin });
      await gotoWorkspace(page, viewerServer.origin, '?view=table');
      await page.waitForSelector('[data-nf-health-panel="table"] tbody tr', { state: 'visible' });

      check('H9-A', await page.getByRole('button', { name: /add monitoring target/i }).count() === 0, 'a read-only session gets no create action');
      const collect = page.locator('[data-nf-health-panel="table"] tbody tr').first().getByRole('button', { name: 'Collect Now' });
      check('H9-B', await collect.isDisabled(), 'a read-only session cannot trigger a collection');
      check('H9-C', apiCallsMatching(apiCalls, '/collect', 'POST').length === 0, 'no unauthorized collection request is issued');
      noBrowserErrors('H9-D', pageErrors, consoleErrors);
      await context.close();
    }
    {
      const { context, page, apiCalls, pageErrors, consoleErrors } = await openPage(browser, { origin: operatorServer.origin });
      await gotoWorkspace(page, operatorServer.origin, '?view=table');
      await page.waitForSelector('[data-nf-health-panel="table"] tbody tr', { state: 'visible' });

      const createActions = await page.getByRole('button', { name: /add monitoring target/i }).count();
      check('H9-E', createActions === 1, `an operator gets exactly one create action (${createActions})`);
      const collect = page.locator('[data-nf-health-panel="table"] tbody tr').first().getByRole('button', { name: 'Collect Now' });
      await collect.click();
      await page.waitForTimeout(1500);
      const posts = apiCallsMatching(apiCalls, '/collect', 'POST');
      check('H9-F', posts.length === 1, `exactly one collection mutation is issued (${posts.length})`);
      check(
        'H9-G',
        posts.length === 1 && posts[0].url.endsWith(`/api/nf-health/targets/${IDS.amf}/collect`),
        'the mutation targets the intended target id',
      );
      check('H9-H', /Collection completed/i.test(await bodyText(page)), 'the collection outcome is reported to the operator');
      noBrowserErrors('H9-I', pageErrors, consoleErrors);
      await context.close();
    }

    /* ============================ H10 metric detail compatibility ========= */
    {
      const { context, page, apiCalls, pageErrors, consoleErrors } = await openPage(browser, { origin: operatorServer.origin });
      await page.goto(`${operatorServer.origin}/nf-health/${IDS.amf}`);
      await page.waitForSelector('.layout-root', { state: 'visible', timeout: 30000 });
      await page.waitForTimeout(900);
      check(
        'H10-A',
        await page.getByRole('region', { name: 'RSS history' }).count() === 0,
        'with the feature disabled no metric history panel is fabricated',
      );
      check(
        'H10-B',
        await page.getByRole('region', { name: 'Metric baseline deviation' }).count() === 0,
        'with the feature disabled no analysis panel is fabricated',
      );
      check(
        'H10-C',
        apiCallsMatching(apiCalls, '/metric-history').length === 0 && apiCallsMatching(apiCalls, '/metric-analysis').length === 0,
        'a disabled feature issues no aggregate read',
      );
      check(
        'H10-D',
        apiCallsMatching(apiCalls, '/collect', 'POST').length === 0,
        'a disabled feature triggers no automatic collection',
      );
      noBrowserErrors('H10-D2', pageErrors, consoleErrors);
      await context.close();
    }
    {
      const { context, page, apiCalls, pageErrors, consoleErrors } = await openPage(browser, { origin: operatorServer.origin });
      await page.route('**/api/nf-health/meta', async (route) => {
        const response = await route.fetch();
        const payload = await response.json();
        await route.fulfill({ json: { ...payload, metricHistory: { enabled: true, state: 'running', failures: 0 } } });
      });
      await page.route('**/api/nf-health/targets/*/metric-history?**', async (route) => {
        const url = new URL(route.request().url());
        const from = url.searchParams.get('from');
        const to = url.searchParams.get('to');
        const segment = {
          identityEpoch: 'a'.repeat(64),
          count: 30,
          sum: 3000,
          mean: 100,
          min: 50,
          max: 150,
          coveredSeconds: 3540,
          firstObservedAt: from,
          lastObservedAt: to,
        };
        await route.fulfill({
          json: {
            metricType: 'gauge',
            metric: 'process_resident_memory_bytes',
            series: 'unlabeled',
            resolution: '1h',
            unit: 'bytes',
            subject: 'exporter_process',
            algorithmVersion: 'rss-hour-v1',
            from,
            to,
            watermark: 'watermark-v1',
            complete: false,
            missingHours: 23,
            buckets: [{
              from,
              to: new Date(Date.parse(from) + 3600000).toISOString(),
              coveredSeconds: 3540,
              sourceComplete: true,
              quality: 'measured',
              generatedAt: to,
              revision: 1,
              excluded: {},
              segments: [segment],
            }],
            page: { limit: 200, nextCursor: null, hasMore: false },
          },
        });
      });
      await page.route('**/api/nf-health/targets/*/metric-analysis?**', async (route) => {
        const url = new URL(route.request().url());
        const kind = url.searchParams.get('kind') === 'trend' ? 'trend' : 'baseline';
        const item = kind === 'trend'
          ? {
            bucketStart: '2026-10-09T10:00:00Z',
            state: 'insufficient_data',
            reason: 'not_enough_eligible_buckets',
            revision: 1,
            eligibleBuckets: 3,
            windowHours: 6,
            confirmed: false,
          }
          : {
            bucketStart: '2026-10-09T10:00:00Z',
            state: 'anomaly',
            value: 120,
            median: 100,
            mad: 5,
            score: 4.5,
            absoluteChange: 20,
            baselineEligible: 20,
            baselineExpected: 24,
            revision: 1,
            evidenceExpired: true,
          };
        await route.fulfill({
          json: {
            kind,
            algorithmVersion: kind === 'trend' ? 'trend-v1' : 'baseline-v1',
            policyVersion: 'policy-v2',
            baselineHours: 24,
            scoreThreshold: 3.5,
            minAbsoluteChange: 10,
            windowHours: 6,
            minTrendChange: 25,
            minFit: 0.8,
            from: url.searchParams.get('from'),
            to: url.searchParams.get('to'),
            items: [item],
            page: { limit: 200, nextCursor: null, hasMore: false },
          },
        });
      });

      await page.goto(`${operatorServer.origin}/nf-health/${IDS.amf}`);
      await page.waitForSelector('.layout-root', { state: 'visible', timeout: 30000 });

      const history = page.getByRole('region', { name: 'RSS history' });
      await history.waitFor({ state: 'visible', timeout: 25000 });
      check('H10-E', true, 'the enabled feature renders the metric history panel');
      const historyText = await history.innerText();
      check('H10-F', /rss-hour-v1|watermark-v1|Read version/i.test(historyText), 'the history panel states its algorithm version');

      /* The evidence tables live in the shared collapsible ChartDataTable, so
       * they are opened before their cells are asserted. */
      for (const summary of await history.locator('summary').all()) await summary.click();
      const historyTableText = await history.innerText();
      check('H10-G', /98\.3%|3540s/.test(historyTableText), 'the observed coverage is reported from the server bucket');

      const baseline = page.getByRole('region', { name: 'Metric baseline deviation' });
      const trend = page.getByRole('region', { name: 'Metric sustained trend' });
      check('H10-H', await baseline.count() === 1 && await trend.count() === 1, 'baseline and trend sections stay distinct');
      for (const summary of await baseline.locator('summary').all()) await summary.click();
      for (const summary of await trend.locator('summary').all()) await summary.click();
      const baselineText = await baseline.innerText();
      check('H10-I', /baseline-v1/.test(baselineText) && /policy-v2/.test(baselineText), 'the analysis panel states its algorithm and policy versions');
      check('H10-J', /expired/i.test(baselineText), 'an expired evidence record is labelled');
      const trendText = await trend.innerText();
      check('H10-K', /insufficient|not enough/i.test(trendText), 'an unconfirmed trend states its insufficient-data reason');
      check('H10-L', !/probability/i.test(trendText), 'a trend fit is never represented as a failure probability');

      const investigate = trend.getByRole('link', { name: /investigat/i });
      check('H10-M', await investigate.count() === 1, 'the trend offers an investigation entry');
      const investigateHref = await investigate.getAttribute('href');
      check(
        'H10-N',
        Boolean(investigateHref && investigateHref.includes(encodeURIComponent('1a2b3c40-0001-4a01-8c01-00000000f001'))),
        `the investigation link preserves the resource identity: ${investigateHref}`,
      );

      check(
        'H10-O',
        apiCallsMatching(apiCalls, '/metric-history').length >= 1 && apiCallsMatching(apiCalls, '/metric-analysis').length >= 2,
        'the enabled panels issue their own bounded reads',
      );
      check(
        'H10-P',
        apiCallsMatching(apiCalls, '/collect', 'POST').length === 0,
        'opening the metric panels never triggers an automatic collection',
      );
      noBrowserErrors('H10-Q', pageErrors, consoleErrors);
      await context.close();
    }

    /* ================================ H11 responsive and accessibility ===== */
    for (const viewport of [
      { name: 'desktop', width: 1440, height: 900 },
      { name: 'mobile', width: 375, height: 812 },
    ]) {
      const { context, page, pageErrors, consoleErrors } = await openPage(browser, {
        origin: operatorServer.origin,
        width: viewport.width,
        height: viewport.height,
      });
      await gotoWorkspace(page, operatorServer.origin);
      await page.waitForSelector('[data-nf-health-card]', { state: 'visible' });

      check(`H11-A:${viewport.name}`, await page.getByRole('search').isVisible(), 'the filter toolbar stays usable');
      check(`H11-B:${viewport.name}`, (await cardIds(page))[0] === IDS.amf, 'the card reading order is unchanged');

      if (viewport.name === 'desktop') {
        const createActions = page.getByRole('button', { name: /add monitoring target/i });
        check(`H11-E0:${viewport.name}`, await createActions.count() === 1, 'the create action is reachable from the card queue');
        await createActions.click();
        await page.getByRole('dialog').waitFor({ state: 'visible' });
        const focusInside = await page.evaluate(() => Boolean(document.querySelector('[role="dialog"]')?.contains(document.activeElement)));
        check(`H11-E:${viewport.name}`, focusInside, 'the dialog takes focus inside itself');
        await page.keyboard.press('Escape');
        await page.getByRole('dialog').waitFor({ state: 'detached' });
      }

      await page.locator('[data-nf-health-view="table"]').click();
      await page.waitForSelector('[data-nf-health-panel="table"] table', { state: 'visible' });
      const overflow = await page.locator('[data-nf-health-panel="table"] table').evaluate((node) => {
        const container = node.parentElement;
        return container ? getComputedStyle(container).overflowX : 'no-container';
      });
      check(`H11-C:${viewport.name}`, overflow === 'auto' || overflow === 'scroll', `the table scrolls inside its own container (${overflow})`);

      await page.locator('[data-nf-health-view="cards"]').focus();
      const focused = await page.evaluate(() => document.activeElement?.getAttribute('data-nf-health-view') ?? '');
      check(`H11-D:${viewport.name}`, focused === 'cards', 'the view switch is keyboard focusable');

      noBrowserErrors(`H11-F:${viewport.name}`, pageErrors, consoleErrors);
      await context.close();
    }
    {
      const { context, page, pageErrors, consoleErrors } = await openPage(browser, { origin: operatorServer.origin, locale: 'zh' });
      await gotoWorkspace(page, operatorServer.origin);
      await page.waitForSelector('[data-nf-health-card]', { state: 'visible' });
      check('H11-G', /[\u4e00-\u9fa5]/.test(await bodyText(page)), 'the Chinese localization renders');
      noBrowserErrors('H11-H', pageErrors, consoleErrors);
      await context.close();
    }

    /* ================================================ session identities === */
    check(
      'SYS-A',
      SESSIONS.viewer.permissions.includes('core.read') && !SESSIONS.viewer.permissions.includes('core.configure'),
      'the read-only fixture session really lacks core.configure',
    );
    check('SYS-B', operatorServer.unexpected.length === 0, `operator fixture saw no unexpected API request: ${operatorServer.unexpected.join(',')}`);
    check('SYS-C', viewerServer.unexpected.length === 0, `viewer fixture saw no unexpected API request: ${viewerServer.unexpected.join(',')}`);
  } finally {
    if (browser) await browser.close();
    for (const server of servers) await server.close();
    await rm(tmpDist, { recursive: true, force: true });
  }

  console.log('');
  console.log('=============================================================');
  if (failures.length > 0) {
    console.error(`[acceptance:nf-health-workspace] FAILED ${failures.length} check(s) of ${checks.length}`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log(`[acceptance:nf-health-workspace] passed ${checks.length}/${checks.length} assertions`);
}

await main();
