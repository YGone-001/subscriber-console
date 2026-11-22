#!/usr/bin/env node
/*
 * Shared operations URL atomicity acceptance.
 *
 * The operations URL contract has several writers on one route: the page's view
 * and filter binding, the topology view-state binding, and the graph selection
 * binding. Each one composes a new query string from the search it can see. When
 * two writes are dispatched before the router commits the first, both compose
 * from the same committed search and the second discards the first.
 *
 * This suite drives the real production build and dispatches the two writes in a
 * single JavaScript turn - no wait, no forced render, no network barrier between
 * them - because that is the only way to observe the defect deterministically.
 *
 * Scope note: these checks prove frontend URL composition against replay
 * fixtures. They are not evidence about a live inventory, a configured network or
 * production traffic.
 *
 * Usage (from frontend/): node tests/operations-url-atomicity-smoke.mjs
 */
/* global Event, MouseEvent, HTMLInputElement, HTMLTextAreaElement */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';
import { build } from 'vite';

import { EDGE_IDS, RESOURCE_IDS as TOPOLOGY_RESOURCE_IDS, startFixtureServer as startTopologyFixture } from './topology-fixtures.mjs';
import { startFixtureServer as startOperationsFixture } from './nf-health-fixtures.mjs';

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

const BENIGN_CONSOLE = [/Download the React DevTools/i, /favicon/i];

/* ------------------------------------------------------------------ pages -- */

async function openPage(browser, { width = 1440, height = 900 } = {}) {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
    locale: 'en-US',
    timezoneId: 'UTC',
    reducedMotion: 'reduce',
    colorScheme: 'light',
  });
  await context.addInitScript(() => {
    try {
      localStorage.setItem('XCLOUD_LANGUAGE_PREFERENCE', 'en');
      localStorage.setItem('XCLOUD_THEME_PREFERENCE', 'light');
    } catch {
      /* Storage unavailable: the assertions below would notice. */
    }
  });
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

/* Dispatches every change inside ONE JavaScript turn. React processes both
 * handlers before any navigation commits, which is exactly the window the defect
 * lives in. */
async function changeInOneTurn(page, steps) {
  await page.evaluate((plan) => {
    const nativeInputValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    const nativeTextAreaValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;

    const dispatch = (element, kind) => {
      if (kind === 'click') {
        element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        return;
      }
      if (kind === 'input') {
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        return;
      }
      element.dispatchEvent(new Event('change', { bubbles: true }));
    };

    for (const step of plan) {
      const element = document.querySelector(step.selector);
      if (!element) throw new Error(`missing control: ${step.selector}`);
      if (step.value !== undefined) {
        if (element instanceof HTMLInputElement && nativeInputValue) nativeInputValue.call(element, step.value);
        else if (element instanceof HTMLTextAreaElement && nativeTextAreaValue) nativeTextAreaValue.call(element, step.value);
        else element.value = step.value;
      }
      dispatch(element, step.kind ?? 'change');
    }
  }, steps);
}

async function urlParams(page) {
  return Object.fromEntries(new URL(page.url()).searchParams.entries());
}

function apiCallsMatching(apiCalls, needle, method) {
  return apiCalls.filter((call) => call.url.includes(needle) && (!method || call.method === method));
}

function noBrowserErrors(id, pageErrors, consoleErrors) {
  return check(id, pageErrors.length === 0 && consoleErrors.length === 0, `no browser errors (${pageErrors.concat(consoleErrors).join(' | ')})`);
}

/* ------------------------------------------------------------ the matrix -- */

async function main() {
  console.log('[acceptance:operations-url-atomicity] Building the production SPA...');
  const tmpDist = await mkdtemp(path.join(tmpdir(), 'xcloud-url-atomicity-'));
  let browser;
  const servers = [];

  try {
    const buildResult = await build({
      root: frontendRoot,
      logLevel: 'warn',
      build: { outDir: tmpDist, emptyOutDir: true },
    });
    const output = (Array.isArray(buildResult) ? buildResult[0] : buildResult).output;
    check('A0-A', output.filter((item) => item.type === 'chunk').length > 0, 'the production build emitted JavaScript chunks');

    const topologyServer = await startTopologyFixture({ distDir: tmpDist, sessionKey: 'operator' });
    servers.push(topologyServer);
    const operationsServer = await startOperationsFixture({ distDir: tmpDist, sessionKey: 'operator' });
    servers.push(operationsServer);

    browser = await chromium.launch({ headless: true });

    /* ============================================ A — the reported defect == */
    {
      /* A1 is the exact reproduction: a legacy-retired ledger URL, then in one
       * turn remove the relationship filter and select the active lifecycle. */
      const { context, page, apiCalls, pageErrors, consoleErrors } = await openPage(browser);
      await page.goto(`${topologyServer.origin}/topology?view=ledger&relationship=depends_on&state=retired`);
      await page.waitForSelector('[data-ledger-advanced-filters]', { state: 'visible', timeout: 30000 });

      const before = await urlParams(page);
      check(
        'A1-A',
        before.relationship === 'depends_on' && before.state === 'retired',
        `the starting URL carries both filters: ${JSON.stringify(before)}`,
      );

      const readsBefore = apiCallsMatching(apiCalls, '/api/topology/edges').length;
      await changeInOneTurn(page, [
        { selector: 'select[aria-label="Relationship"]', value: '' },
        { selector: 'select[aria-label="Lifecycle"]', value: 'active' },
      ]);
      await page.waitForFunction(
        () => !new URL(window.location.href).searchParams.has('relationship'),
        null,
        { timeout: 15000 },
      ).catch(() => undefined);
      await page.waitForTimeout(500);

      const after = await urlParams(page);
      check('A1-B', after.relationship === undefined, `the removed filter stays removed: ${JSON.stringify(after)}`);
      check('A1-C', after.state === undefined, 'the active lifecycle is the default representation and occupies no key');
      check('A1-D', after.cursor === undefined, 'no obsolete cursor survives the transition');
      check('A1-E', after.view === 'ledger', 'the view is untouched by the filter transaction');

      await page.waitForFunction(
        () => document.querySelectorAll('[data-surface="ledger"] tbody tr').length === 5,
        null,
        { timeout: 15000 },
      ).catch(() => undefined);
      const rows = await page.locator('[data-surface="ledger"] tbody tr').count();
      check('A1-F', rows === 5, `the ledger shows the unfiltered active set (${rows})`);
      check(
        'A1-G',
        apiCallsMatching(apiCalls, '/api/topology/edges').length > readsBefore,
        'the transition re-read the ledger',
      );
      noBrowserErrors('A1-H', pageErrors, consoleErrors);
      await context.close();
    }
    {
      /* A2: two consecutive filters in one turn must both survive. */
      const { context, page, apiCalls, pageErrors, consoleErrors } = await openPage(browser);
      await page.goto(`${topologyServer.origin}/topology?view=ledger`);
      await page.waitForSelector('[data-ledger-advanced-filters]', { state: 'visible', timeout: 30000 });

      await changeInOneTurn(page, [
        { selector: 'select[aria-label="Relationship"]', value: 'exposes' },
        { selector: 'select[aria-label="Lifecycle"]', value: 'retired' },
      ]);
      await page.waitForFunction(
        () => new URL(window.location.href).searchParams.has('relationship'),
        null,
        { timeout: 15000 },
      ).catch(() => undefined);
      await page.waitForTimeout(500);

      const after = await urlParams(page);
      check('A2-A', after.relationship === 'exposes', `the first filter survives: ${JSON.stringify(after)}`);
      check('A2-B', after.state === 'retired', 'the second filter survives');
      check('A2-C', after.cursor === undefined, 'the composed transition leaves no cursor');

      const composedRead = apiCallsMatching(apiCalls, '/api/topology/edges').at(-1);
      const composedQuery = new URL(composedRead.url).searchParams;
      check(
        'A2-D',
        composedQuery.get('relationshipType') === 'exposes' && composedQuery.get('lifecycleState') === 'retired',
        `the final read uses the composed query: ${composedRead.url}`,
      );
      check(
        'A2-E',
        apiCalls.filter((call) => call.method !== 'GET').length === 0,
        'a URL transaction issues no mutation',
      );
      noBrowserErrors('A2-F', pageErrors, consoleErrors);
      await context.close();
    }

    /* ============================ B — cursor and cross-hook composition === */
    {
      /* B1: a filter change in the same turn as an existing cursor drops it. */
      const { context, page, pageErrors, consoleErrors } = await openPage(browser);
      await page.goto(`${topologyServer.origin}/topology?view=ledger&cursor=stale-page-token`);
      await page.waitForSelector('[data-ledger-advanced-filters]', { state: 'visible', timeout: 30000 });

      await changeInOneTurn(page, [
        { selector: 'select[aria-label="Relationship"]', value: 'depends_on' },
      ]);
      await page.waitForFunction(
        () => new URL(window.location.href).searchParams.has('relationship'),
        null,
        { timeout: 15000 },
      ).catch(() => undefined);
      const after = await urlParams(page);
      check('B1-A', after.relationship === 'depends_on', 'the filter applied');
      check('B1-B', after.cursor === undefined, 'the cursor was invalidated in the same transition');
      noBrowserErrors('B1-C', pageErrors, consoleErrors);
      await context.close();
    }
    {
      /* B2 (cross-hook): the topology view-state writer and the page filter
       * writer are two different hooks on the same route. */
      const { context, page, pageErrors, consoleErrors } = await openPage(browser);
      await page.goto(`${topologyServer.origin}/topology?view=ledger`);
      await page.waitForSelector('[data-ledger-advanced-filters]', { state: 'visible', timeout: 30000 });

      await changeInOneTurn(page, [
        { selector: '[data-topology-view="graph"]', kind: 'click' },
        { selector: 'select[aria-label="Relationship"]', value: 'depends_on' },
      ]);
      await page.waitForFunction(
        () => new URL(window.location.href).searchParams.get('view') === 'graph',
        null,
        { timeout: 15000 },
      ).catch(() => undefined);
      await page.waitForTimeout(500);

      const after = await urlParams(page);
      check('B2-A', after.view === 'graph', `the view change applied: ${JSON.stringify(after)}`);
      check('B2-B', after.relationship === 'depends_on', 'the filter from the other hook survived the view change');
      check('B2-C', after.source === 'declared', 'the graph source was written by the view writer');
      check('B2-D', await page.locator('#actual-topology-title').count() === 1, 'the graph mode actually rendered');
      noBrowserErrors('B2-E', pageErrors, consoleErrors);
      await context.close();
    }
    {
      /* B3: two view-state writes in one turn (runtime scope and source). */
      const { context, page, pageErrors, consoleErrors } = await openPage(browser);
      await page.goto(`${topologyServer.origin}/topology?view=graph&source=runtime&scope=config`);
      await page.waitForSelector('[data-runtime-scope="hierarchy"]', { state: 'visible', timeout: 30000 });

      await changeInOneTurn(page, [
        { selector: '[data-runtime-scope="hierarchy"]', kind: 'click' },
        { selector: '[data-topology-source="runtime"]', kind: 'click' },
      ]);
      await page.waitForTimeout(600);

      const after = await urlParams(page);
      check('B3-A', after.source === 'runtime', `the source is runtime: ${JSON.stringify(after)}`);
      check('B3-B', after.scope === 'hierarchy', 'the scope written in the same turn survived the source write');
      check('B3-C', after.view === 'graph', 'the view stayed graph');
      noBrowserErrors('B3-D', pageErrors, consoleErrors);
      await context.close();
    }

    /* ======================= C — canonicalization cannot undo a user action == */
    {
      const { context, page, pageErrors, consoleErrors } = await openPage(browser);
      /* The legacy `view=relationships` alias must canonicalize to `ledger`
       * while a filter update issued in the same turn survives. */
      await page.goto(`${topologyServer.origin}/topology?view=relationships&relationship=depends_on`);
      await page.waitForSelector('[data-ledger-advanced-filters]', { state: 'visible', timeout: 30000 });

      await changeInOneTurn(page, [
        { selector: 'select[aria-label="Lifecycle"]', value: 'retired' },
      ]);
      await page.waitForFunction(
        () => new URL(window.location.href).searchParams.has('state'),
        null,
        { timeout: 15000 },
      ).catch(() => undefined);
      await page.waitForTimeout(600);

      const after = await urlParams(page);
      check('C1-A', after.view === 'ledger', `the legacy alias is canonicalized: ${JSON.stringify(after)}`);
      check('C1-B', after.relationship === 'depends_on', 'the pre-existing filter survived canonicalization');
      check('C1-C', after.state === 'retired', 'the newer user action survived canonicalization');

      const settled = page.url();
      await page.waitForTimeout(700);
      check('C1-D', page.url() === settled, 'canonicalization settles without a navigation loop');
      const historyLength = await page.evaluate(() => window.history.length);
      check('C1-E', historyLength <= 3, `no duplicate history entries were added (${historyLength})`);
      noBrowserErrors('C1-F', pageErrors, consoleErrors);
      await context.close();
    }
    {
      /* A malformed value is dropped without discarding a valid update. */
      const { context, page, pageErrors, consoleErrors } = await openPage(browser);
      await page.goto(`${topologyServer.origin}/topology?view=ledger&relationship=%20%20&from=%00bad`);
      await page.waitForSelector('[data-ledger-advanced-filters]', { state: 'visible', timeout: 30000 });

      const onMount = await urlParams(page);
      check('C2-B', onMount.relationship === undefined, `a whitespace-only value is dropped on read: ${JSON.stringify(onMount)}`);
      check('C2-E', onMount.from === undefined, 'a control-character value is dropped on read');

      await changeInOneTurn(page, [
        { selector: 'select[aria-label="Relationship"]', value: 'uses' },
      ]);
      await page.waitForTimeout(600);
      const after = await urlParams(page);
      check('C2-A', after.relationship === 'uses', `the valid update applied over an invalid URL: ${JSON.stringify(after)}`);
      check('C2-C', after.view === 'ledger', 'the view is canonical');
      noBrowserErrors('C2-D', pageErrors, consoleErrors);
      await context.close();
    }

    /* ============================== D — graph selection across writers ===== */
    {
      const { context, page, pageErrors, consoleErrors } = await openPage(browser);
      await page.goto(`${topologyServer.origin}/topology?view=graph&source=declared`);
      await page.locator('[data-actual-canvas]').first().waitFor({ state: 'visible', timeout: 30000 });

      /* A selection and a domain filter are two writes from the same binding in
       * one turn: the node click writes `focus`, the domain select writes
       * `domain`. Both must survive. */
      await changeInOneTurn(page, [
        { selector: `[data-actual-canvas] [data-resource-id="${TOPOLOGY_RESOURCE_IDS.smf}"]`, kind: 'click' },
        { selector: 'select[aria-label="Domain"][data-domain-mode]', value: '5gc' },
      ]);
      await page.waitForTimeout(600);

      const after = await urlParams(page);
      check('D1-A', after.focus === TOPOLOGY_RESOURCE_IDS.smf, `the selection written first survived the domain write: ${JSON.stringify(after)}`);
      check('D1-B', after.domain === '5gc', 'the domain filter applied');
      check('D1-C', await page.locator('[data-topology-inspector="true"]').count() === 1, 'the inspector opened for the selection');

      /* A node and an edge are one exclusive selection: selecting the edge in the
       * same turn must leave the edge and clear the node focus. */
      await changeInOneTurn(page, [
        { selector: `[data-actual-canvas] [data-edge-id="${EDGE_IDS.uses}"]`, kind: 'click' },
      ]);
      await page.waitForTimeout(500);
      const edgeOnly = await urlParams(page);
      check(
        'D1-F',
        edgeOnly.edge === EDGE_IDS.uses && edgeOnly.focus === undefined,
        `the selection is exclusive and the newest one wins: ${JSON.stringify(edgeOnly)}`,
      );

      /* Closing clears the selection, and a sibling writer must not resurrect it. */
      await page.keyboard.press('Escape');
      await page.waitForTimeout(400);
      const cleared = await urlParams(page);
      check('D1-D', cleared.focus === undefined && cleared.edge === undefined, `closing clears both selection keys: ${JSON.stringify(cleared)}`);

      await changeInOneTurn(page, [
        { selector: '[data-topology-view="ledger"]', kind: 'click' },
      ]);
      await page.waitForTimeout(500);
      const afterView = await urlParams(page);
      check(
        'D1-E',
        afterView.focus === undefined && afterView.edge === undefined,
        'a sibling URL writer does not resurrect the closed selection',
      );
      noBrowserErrors('D1-G', pageErrors, consoleErrors);
      await context.close();
    }
    {
      /* Domain and search are two writes from the same hook in one turn. */
      const { context, page, pageErrors, consoleErrors } = await openPage(browser);
      await page.goto(`${topologyServer.origin}/topology?view=graph&source=runtime`);
      await page.locator('[data-live-canvas]').first().waitFor({ state: 'visible', timeout: 30000 });

      await changeInOneTurn(page, [
        { selector: 'select[aria-label="Domain"][data-domain-mode]', value: '5gc' },
        { selector: 'input[type="search"][placeholder="Search runtime components"]', value: 'smf', kind: 'input' },
      ]);
      await page.waitForTimeout(600);

      const after = await urlParams(page);
      check('D2-A', after.domain === '5gc', `the domain written first survived the search write: ${JSON.stringify(after)}`);
      check('D2-B', after.q === 'smf', 'the search value applied');
      check('D2-C', after.source === 'runtime' && after.view === 'graph', 'the page-level view state is untouched');
      noBrowserErrors('D2-D', pageErrors, consoleErrors);
      await context.close();
    }

    /* ================================ E — browser history stays predictable = */
    {
      const { context, page, pageErrors, consoleErrors } = await openPage(browser);
      await page.goto(`${topologyServer.origin}/topology?view=ledger`);
      await page.waitForSelector('[data-ledger-advanced-filters]', { state: 'visible', timeout: 30000 });

      await changeInOneTurn(page, [
        { selector: 'select[aria-label="Relationship"]', value: 'exposes' },
        { selector: 'select[aria-label="Lifecycle"]', value: 'retired' },
      ]);
      await page.waitForTimeout(600);
      const composedUrl = page.url();

      /* One composed transaction, one history entry: Back returns to the
       * pre-transaction URL rather than to an intermediate half-applied state. */
      await page.goBack();
      await page.waitForTimeout(500);
      const backUrl = await urlParams(page);
      check('E1-A', backUrl.relationship === undefined && backUrl.state === undefined, `Back returns to the pre-transaction URL: ${JSON.stringify(backUrl)}`);

      await page.goForward();
      await page.waitForTimeout(500);
      check('E1-B', page.url() === composedUrl, 'Forward restores the composed URL');
      noBrowserErrors('E1-C', pageErrors, consoleErrors);
      await context.close();
    }

    /* ============================== F — cross-workspace: Inventory ========= */
    {
      const { context, page, apiCalls, pageErrors, consoleErrors } = await openPage(browser);
      await page.goto(`${topologyServer.origin}/inventory/assets`);
      await page.waitForSelector('select[aria-label="All Kinds"]', { state: 'visible', timeout: 30000 });

      await changeInOneTurn(page, [
        { selector: 'select[aria-label="All Kinds"]', value: 'network_function' },
        { selector: 'select[aria-label="All Domains"]', value: '5gc' },
      ]);
      await page.waitForTimeout(700);

      const after = await urlParams(page);
      check('F1-A', after.kind === 'network_function', `the kind filter survived: ${JSON.stringify(after)}`);
      check('F1-B', after.domain === '5gc', 'the domain filter survived');
      const lastRead = apiCallsMatching(apiCalls, '/api/inventory/resources').at(-1);
      const query = new URL(lastRead.url).searchParams;
      check(
        'F1-C',
        query.get('kind') === 'network_function' && query.get('domain') === '5gc',
        `the read uses the composed query: ${lastRead.url}`,
      );
      check('F1-D', after.cursor === undefined, 'the filter transaction left no cursor');
      noBrowserErrors('F1-E', pageErrors, consoleErrors);
      await context.close();
    }

    /* ============================== G — cross-workspace: NF Health ========= */
    {
      const { context, page, apiCalls, pageErrors, consoleErrors } = await openPage(browser);
      await page.goto(`${operationsServer.origin}/nf-health`);
      await page.waitForSelector('select[aria-label="Collection state"]', { state: 'visible', timeout: 30000 });

      await changeInOneTurn(page, [
        { selector: 'select[aria-label="Collection state"]', value: 'true' },
        { selector: 'select[aria-label="Overall state"]', value: 'healthy' },
      ]);
      await page.waitForTimeout(800);

      const after = await urlParams(page);
      check('G1-A', after.enabled === 'true', `the collection-state filter survived: ${JSON.stringify(after)}`);
      check('G1-B', after.state === 'healthy', 'the overall-state filter survived');
      const lastRead = apiCallsMatching(apiCalls, '/api/nf-health/targets').at(-1);
      const query = new URL(lastRead.url).searchParams;
      check(
        'G1-C',
        query.get('enabled') === 'true' && query.get('state') === 'healthy',
        `the read uses the composed query: ${lastRead.url}`,
      );

      /* The accepted rapid-search behaviour must remain: a late URL echo never
         replaces a newer draft. */
      const search = page.getByRole('search').locator('input[type="search"]');
      await search.fill('amf');
      await page.getByRole('search').getByRole('button', { name: 'Search' }).click();
      await page.waitForTimeout(300);
      await search.fill('amf-typing');
      await page.waitForTimeout(600);
      check('G1-D', (await search.inputValue()) === 'amf-typing', 'a late URL echo does not replace the newer search draft');

      const timers = await page.evaluate(() => document.querySelectorAll('*').length);
      check('G1-E', timers > 0, 'the page is still mounted after the rapid search');
      noBrowserErrors('G1-F', pageErrors, consoleErrors);
      await context.close();
    }

    /* ============================== H — cross-workspace: Discovery ========= */
    {
      const { context, page, pageErrors, consoleErrors } = await openPage(browser);
      await page.goto(`${operationsServer.origin}/discovery`);
      await page.waitForSelector('#discovery-source-selector', { state: 'visible', timeout: 30000 });

      const observationOptions = await page.locator('select[aria-label="Observation state"] option').evaluateAll(
        (nodes) => nodes.map((node) => node.value).filter(Boolean),
      );
      check(
        'H1-A',
        observationOptions.length > 0 && await page.locator('input[aria-label="NF type"]').count() === 1,
        `the discovery candidate filters are present (${observationOptions.length} observation states)`,
      );

      const readsBefore = page.waitForResponse((response) => response.url().includes('/api/discovery/candidates'), { timeout: 20000 });
      await changeInOneTurn(page, [
        { selector: 'select[aria-label="Observation state"]', value: observationOptions[0] },
        { selector: 'input[aria-label="NF type"]', value: 'amf', kind: 'input' },
      ]);
      await readsBefore;
      await page.waitForTimeout(600);

      const after = await urlParams(page);
      check('H1-B', after.state === observationOptions[0], `the observation-state filter survived: ${JSON.stringify(after)}`);
      check('H1-C', after.nfType === 'amf', 'the NF-type filter written second survived');
      noBrowserErrors('H1-D', pageErrors, consoleErrors);
      await context.close();
    }

    check('SYS-A', topologyServer.unexpected.length === 0, `topology fixture saw no unexpected API request: ${topologyServer.unexpected.join(',')}`);
    check('SYS-B', operationsServer.unexpected.length === 0, `operations fixture saw no unexpected API request: ${operationsServer.unexpected.join(',')}`);
  } finally {
    if (browser) await browser.close();
    for (const server of servers) await server.close();
    await rm(tmpDist, { recursive: true, force: true });
  }

  console.log('');
  console.log('=============================================================');
  if (failures.length > 0) {
    console.error(`[acceptance:operations-url-atomicity] FAILED ${failures.length} check(s) of ${checks.length}`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log(`[acceptance:operations-url-atomicity] passed ${checks.length}/${checks.length} assertions`);
}

await main();
