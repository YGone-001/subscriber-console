#!/usr/bin/env node
/*
 * Topology workspace browser acceptance.
 *
 * Drives the REAL production SPA build in real Chromium against the deterministic
 * Topology fixture server and asserts browser-observable behaviour for the
 * workspace: the three-mode navigation, the graph evidence sources, the ledger
 * filters, the cursor walk, an out-of-order read, the three governed mutations,
 * read-only permissions, resource identity, reconciliation evidence, freshness,
 * graph interactions, and responsive/localized rendering.
 *
 * Scope note, stated so the evidence is never overstated: these checks prove
 * frontend behaviour against replay fixtures. They are not evidence that a live
 * inventory, a real configured topology or a running network were observed.
 *
 * Asynchronous completion is proven with request/response barriers and rendered
 * business identities, never with arbitrary sleeps.
 *
 * Usage (from frontend/): node tests/topology-workspace-smoke.mjs
 */
/* global HTMLSelectElement */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';
import { build } from 'vite';

import { EDGE_IDS, RESOURCE_IDS, SESSIONS, startFixtureServer } from './topology-fixtures.mjs';

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

const EDGE_READ = '/api/topology/edges';

/* ------------------------------------------------------------------ pages -- */

async function openPage(browser, { locale = 'en', theme = 'light', width = 1440, height = 900 }) {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
    locale: locale === 'zh' ? 'zh-CN' : 'en-US',
    timezoneId: 'UTC',
    reducedMotion: 'reduce',
    colorScheme: theme === 'dark' ? 'dark' : 'light',
  });
  await context.addInitScript(({ localeValue, themeValue }) => {
    try {
      localStorage.setItem('XCLOUD_LANGUAGE_PREFERENCE', localeValue);
      localStorage.setItem('XCLOUD_THEME_PREFERENCE', themeValue);
    } catch {
      /* Storage unavailable: a wrong locale or theme fails the assertion. */
    }
  }, { localeValue: locale, themeValue: theme });

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

async function gotoTopology(page, origin, search = '') {
  await page.goto(`${origin}/topology${search}`);
  await page.waitForSelector('[data-topology-view]', { state: 'visible', timeout: 30000 });
}

function edgeCalls(apiCalls, predicate = () => true) {
  return apiCalls.filter((call) => call.url.includes(EDGE_READ) && call.method === 'GET' && predicate(new URL(call.url)));
}

function noBrowserErrors(id, pageErrors, consoleErrors) {
  return check(id, pageErrors.length === 0 && consoleErrors.length === 0, `no browser errors (${pageErrors.concat(consoleErrors).join(' | ')})`);
}

async function ledgerRows(page) {
  return page.locator('[data-surface="ledger"] tbody tr').evaluateAll((nodes) => nodes.map((node) => ({
    edgeId: node.getAttribute('data-edge-id'),
    text: node.textContent ?? '',
    relationships: Array.from(node.querySelectorAll('[data-relationship]')).map((badge) => badge.getAttribute('data-relationship')),
  })));
}

async function bodyText(page) {
  return page.locator('body').innerText();
}

/* Selects a ledger filter value and waits until the control itself reports it,
 * which is the point at which the URL transition has been committed. */
async function selectFilter(page, label, value) {
  await page.getByLabel(label, { exact: true }).selectOption(value);
  await page.waitForFunction(
    ({ labelText, expected }) => {
      const control = document.querySelector(`select[aria-label="${labelText}"]`);
      return control instanceof HTMLSelectElement && control.value === expected;
    },
    { labelText: label, expected: value },
    { timeout: 15000 },
  );
}

/* A deterministic live projection carrying every reconciliation shape at once:
 * one agreeing pair, one interface disagreement, one partial coverage, one
 * undeclared configured link, one unevidenced declaration, an incomplete config
 * and an unresolved peer. */
const RECONCILIATION_LIVE = {
  generatedAt: '2026-10-09T12:00:00Z',
  host: { hostId: 'fixture-host', hostName: 'agent-fixture' },
  runtime: { total: 3, running: 3, stopped: 0, unverified: 0, permissionDenied: 0, unknown: 0, stale: 0, notDetected: 0, expected: 0 },
  config: { manifestConfigured: true, sourceCount: 1, availableSources: 1, complete: false },
  nodes: [
    { componentId: 'smf', displayName: 'SMF', processName: 'smfd', role: 'smf', nfType: 'SMF', domain: '5gc', runtimeStatus: 'running' },
    { componentId: 'upf', displayName: 'UPF', processName: 'upfd', role: 'upf', nfType: 'UPF', domain: '5gc', runtimeStatus: 'running' },
    { componentId: 'pcf', displayName: 'PCF', processName: 'pcfd', role: 'pcf', nfType: 'PCF', domain: '5gc', runtimeStatus: 'running' },
  ],
  edges: [
    {
      edgeId: 'live-n4',
      fromComponentId: 'smf',
      toComponentId: 'upf',
      relationshipType: 'connects_to',
      interfaceNames: ['N4'],
      protocol: 'pfcp',
      evidence: 'configured',
      state: 'active',
      sourceFiles: ['/etc/open5gs/smf.yaml'],
    },
  ],
  unresolvedPeers: [{ componentId: 'smf', peer: '10.10.0.250', reason: 'unknown_peer' }],
  reconciliation: {
    available: true,
    complete: false,
    rulesVersion: 'rules-2026-10',
    configuredLinks: 3,
    declaredEdges: 3,
    matchedCount: 2,
    matched: [
      {
        fromResourceId: RESOURCE_IDS.smf,
        toResourceId: RESOURCE_IDS.upf,
        fromComponentId: 'smf',
        toComponentId: 'upf',
        edgeId: EDGE_IDS.uses,
        relationshipType: 'uses',
        interfaceVerdict: 'agrees',
        interfaceMatch: 'agrees',
        interfaceCoverage: [{ interface: 'N4', status: 'matched' }],
        declaredClaims: [{ interface: 'N4' }],
      },
      {
        fromResourceId: RESOURCE_IDS.smf,
        toResourceId: RESOURCE_IDS.pcf,
        fromComponentId: 'smf',
        toComponentId: 'pcf',
        edgeId: EDGE_IDS.depends,
        relationshipType: 'depends_on',
        interfaceVerdict: 'differs',
        interfaceMatch: 'differs',
        interfaceCoverage: [
          { interface: 'N7', status: 'declaration_only' },
          { interface: 'N15', status: 'evidence_only' },
        ],
        declaredClaims: [{ interface: 'N7' }],
      },
      {
        fromResourceId: RESOURCE_IDS.amf,
        toResourceId: RESOURCE_IDS.smf,
        fromComponentId: 'amf',
        toComponentId: 'smf',
        edgeId: EDGE_IDS.connects,
        relationshipType: 'connects_to',
        interfaceVerdict: 'partial',
        interfaceMatch: 'agrees',
        interfaceCoverage: [{ interface: 'N11', status: 'matched' }],
        declaredClaims: [{ interface: 'N11' }, { interface: 'N12' }],
      },
    ],
    undeclaredEvidence: [
      {
        fromResourceId: RESOURCE_IDS.upf,
        toResourceId: RESOURCE_IDS.pcf,
        fromComponentId: 'upf',
        toComponentId: 'pcf',
        configuredEdgeId: 'live-n6',
        relationshipType: 'connects_to',
        interfaceNames: ['N6'],
      },
    ],
    unevidencedDeclarations: [
      {
        fromResourceId: RESOURCE_IDS.nrf,
        toResourceId: RESOURCE_IDS.amf,
        edgeId: EDGE_IDS.registers,
        relationshipType: 'registers_with',
        interfaceNames: ['Nnrf'],
      },
    ],
  },
  summary: { nodeCount: 3, edgeCount: 1, configuredEdgeCount: 1, unresolvedPeerCount: 1 },
};

/* ------------------------------------------------------------ the matrix -- */

async function main() {
  console.log('[acceptance:topology-workspace] Building the production SPA...');
  const tmpDist = await mkdtemp(path.join(tmpdir(), 'xcloud-topology-workspace-'));
  let browser;
  const servers = [];

  try {
    const buildResult = await build({
      root: frontendRoot,
      logLevel: 'warn',
      build: { outDir: tmpDist, emptyOutDir: true },
    });
    const output = (Array.isArray(buildResult) ? buildResult[0] : buildResult).output;
    check('T0-A', output.filter((item) => item.type === 'chunk').length > 0, 'the production build emitted JavaScript chunks');

    const operatorServer = await startFixtureServer({ distDir: tmpDist, sessionKey: 'operator' });
    servers.push(operatorServer);
    const pagedServer = await startFixtureServer({ distDir: tmpDist, sessionKey: 'operator', edgePageSize: 2 });
    servers.push(pagedServer);
    const viewerServer = await startFixtureServer({ distDir: tmpDist, sessionKey: 'viewer' });
    servers.push(viewerServer);

    browser = await chromium.launch({ headless: true });

    /* ================================================== T1 main navigation == */
    {
      const { context, page, pageErrors, consoleErrors } = await openPage(browser, {});
      await gotoTopology(page, operatorServer.origin);

      check('T1-A', await page.locator('[data-topology-view="graph"][aria-pressed="true"]').count() === 1, 'the workspace opens on the graph mode');
      check('T1-B', await page.locator('[data-topology-source-bar="declared"]').count() === 1, 'the declared evidence layer is the default source');
      await page.locator('[data-actual-canvas]').first().waitFor({ state: 'visible', timeout: 25000 });
      check('T1-C', true, 'the declared canvas renders');

      await page.locator('[data-topology-view="ledger"]').click();
      await page.waitForSelector('[data-ledger-advanced-filters]', { state: 'visible' });
      check('T1-D', await page.locator('[data-topology-view="ledger"][aria-pressed="true"]').count() === 1, 'the ledger mode can be selected');
      check('T1-E', await page.locator('[data-actual-canvas]').count() === 0, 'the graph does not render behind the ledger');
      check('T1-F', await page.locator('[data-surface="ledger"]').count() === 1, 'the ledger renders its own table');

      await page.locator('[data-topology-view="architecture"]').click();
      await page.waitForFunction(
        () => document.querySelector('[data-topology-view="architecture"]')?.getAttribute('aria-pressed') === 'true',
        null,
        { timeout: 20000 },
      );
      await page.waitForSelector('#architecture-title', { state: 'attached', timeout: 20000 });
      check('T1-G', await page.locator('[data-surface="ledger"]').count() === 0, 'the ledger does not render behind the architecture reference');
      check('T1-H', await page.locator('[data-topology-source-bar]').count() === 0, 'the reference architecture has no graph evidence bar');

      await page.goBack();
      await page.waitForSelector('[data-ledger-advanced-filters]', { state: 'visible' });
      check('T1-I', await page.locator('[data-topology-view="ledger"][aria-pressed="true"]').count() === 1, 'browser back restores the ledger');
      await page.goBack();
      await page.locator('[data-actual-canvas]').first().waitFor({ state: 'visible', timeout: 20000 });
      check('T1-J', await page.locator('[data-topology-view="graph"][aria-pressed="true"]').count() === 1, 'browser back restores the graph');

      noBrowserErrors('T1-K', pageErrors, consoleErrors);
      check('T1-L', operatorServer.unexpected.length === 0, `no unexpected API request: ${operatorServer.unexpected.join(',')}`);
      await context.close();
    }

    /* =================================================== T2 evidence source == */
    {
      const { context, page, pageErrors, consoleErrors } = await openPage(browser, {});
      await gotoTopology(page, operatorServer.origin, '?view=graph&source=declared');
      await page.locator('[data-actual-canvas]').first().waitFor({ state: 'visible', timeout: 25000 });
      const declaredBadge = await page.locator('[data-evidence-badge]').innerText();
      check('T2-A', (await page.locator('[data-evidence-badge="declared"]').count()) === 1, 'the declared source states its own evidence');

      await page.locator('[data-topology-source="runtime"]').click();
      await page.waitForSelector('[data-topology-source-bar="runtime"]', { state: 'visible' });
      const runtimeBadge = await page.locator('[data-evidence-badge]').innerText();
      check('T2-B', (await page.locator('[data-evidence-badge="runtime"]').count()) === 1, 'the runtime source states its own evidence');
      check('T2-C', declaredBadge !== runtimeBadge, `the two sources never share one evidence label (${declaredBadge} / ${runtimeBadge})`);
      /* The live view reuses the same canvas component, so the canvas element
       * proves nothing about the source. The declared view's own title id is the
       * discriminator: it must be gone, and the live projection must be mounted. */
      await page.waitForSelector('[data-live-canvas]', { state: 'visible', timeout: 20000 });
      check(
        'T2-D',
        await page.locator('#actual-topology-title').count() === 0
          && await page.locator('[data-live-canvas]').count() > 0,
        'the declared view is replaced by the live projection, not layered behind it',
      );

      await page.locator('[data-runtime-scope="hierarchy"]').click();
      await page.waitForSelector('[data-runtime-scope-view="hierarchy"]', { state: 'visible' });
      check('T2-E', true, 'the runtime hierarchy scope is its own sub-view');
      await page.locator('[data-runtime-scope="config"]').click();
      await page.locator('[data-live-canvas]').first().waitFor({ state: 'visible', timeout: 20000 });
      check('T2-F', true, 'the configured projection renders the live canvas');

      await page.goto(`${operatorServer.origin}/topology?source=reference`);
      await page.waitForSelector('#architecture-title', { state: 'attached', timeout: 20000 });
      check('T2-G', await page.locator('[data-topology-source-bar]').count() === 0, 'a legacy reference link opens the reference architecture, never a measured graph');
      check('T2-H', page.url().includes('view=architecture'), `the legacy alias is canonicalized: ${page.url()}`);

      noBrowserErrors('T2-I', pageErrors, consoleErrors);
      check('T2-J', operatorServer.unexpected.length === 0, 'no unexpected API request while switching sources');
      await context.close();
    }

    /* ===================================================== T3 ledger filters == */
    {
      const { context, page, apiCalls, pageErrors, consoleErrors } = await openPage(browser, {});
      await gotoTopology(page, operatorServer.origin, '?view=ledger');
      await page.waitForSelector('[data-surface="ledger"] tbody tr', { state: 'visible' });

      const allRows = await ledgerRows(page);
      check('T3-A', allRows.length === 5, `the active ledger page holds the active relationships only (${allRows.length})`);
      check('T3-B', allRows.every((row) => row.relationships.length === 1), 'every row states exactly one relationship type');

      /* Each step waits for the response that carries its own query, then for the
       * identity that response implies. A bare "one row" wait would be satisfied
       * by the row the previous step left on screen. */
      const readFor = (params) => page.waitForResponse((response) => {
        if (!response.url().includes('/api/topology/edges')) return false;
        const url = new URL(response.url());
        return Object.entries(params).every(([key, value]) => url.searchParams.get(key) === value);
      }, { timeout: 20000 });

      const beforeRelationship = edgeCalls(apiCalls).length;
      const dependsRead = readFor({ relationshipType: 'depends_on' });
      await selectFilter(page, 'Relationship', 'depends_on');
      await page.waitForURL((url) => url.searchParams.get('relationship') === 'depends_on');
      const dependsResponse = await dependsRead;
      await page.waitForFunction(
        () => document.querySelectorAll('[data-surface="ledger"] tbody tr').length === 1
          && document.querySelector('[data-surface="ledger"] [data-relationship="depends_on"]') !== null,
        null,
        { timeout: 15000 },
      );
      check('T3-C', edgeCalls(apiCalls).length === beforeRelationship + 1, `one filter change issues exactly one read (${beforeRelationship} -> ${edgeCalls(apiCalls).length})`);
      check(
        'T3-D',
        new URL(dependsResponse.url()).searchParams.get('relationshipType') === 'depends_on',
        'the relationship filter reached the request boundary',
      );

      const clearedRead = readFor({ lifecycleState: 'active' });
      await selectFilter(page, 'Relationship', '');
      await page.waitForURL((url) => !url.searchParams.has('relationship'));
      await clearedRead;
      const retiredRead = readFor({ lifecycleState: 'retired' });
      await selectFilter(page, 'Lifecycle', 'retired');
      await page.waitForURL((url) => url.searchParams.get('state') === 'retired');
      await retiredRead;
      await page.waitForFunction(
        () => document.querySelectorAll('[data-surface="ledger"] [data-relationship="exposes"]').length === 1,
        null,
        { timeout: 15000 },
      );
      const retiredRow = await ledgerRows(page);
      check('T3-E', retiredRow.length === 1 && retiredRow[0].relationships.includes('exposes'), 'the retired lifecycle filter returns the retired relationship');
      check('T3-F', retiredRow[0].text.includes('Retired'), 'a retired relationship is labelled retired');

      const activeRead = readFor({ lifecycleState: 'active' });
      await selectFilter(page, 'Lifecycle', 'active');
      await page.waitForURL((url) => !url.searchParams.has('state'));
      await activeRead;
      await page.locator('details[data-ledger-advanced-filters] summary').click();
      const fromRead = readFor({ fromResourceId: RESOURCE_IDS.smf, lifecycleState: 'active' });
      await page.locator('#topology-filter-from').fill('smf');
      await page.locator('#topology-filter-from-results [role="option"]').first().waitFor({ state: 'visible' });
      await page.locator('#topology-filter-from-results [role="option"]').first().click();
      await page.waitForURL((url) => url.searchParams.get('from') === RESOURCE_IDS.smf);
      const fromResponse = await fromRead;
      await page.waitForFunction(
        () => document.querySelectorAll('[data-surface="ledger"] tbody tr').length === 2,
        null,
        { timeout: 15000 },
      );
      check('T3-G', true, 'the source-endpoint filter narrows the ledger to the declared source');
      check(
        'T3-H',
        new URL(fromResponse.url()).searchParams.get('fromResourceId') === RESOURCE_IDS.smf,
        'the endpoint filter is a resource identifier, not a name',
      );
      check(
        'T3-I',
        (await bodyText(page)).includes('Filter: from resource'),
        'the applied endpoint filter is visible as an active filter',
      );

      const finalClearedRead = readFor({});
      await page.getByRole('button', { name: 'Clear filters' }).click();
      await page.waitForURL((url) => !url.searchParams.has('from') && !url.searchParams.has('relationship'));
      await finalClearedRead;
      check('T3-J', true, 'clearing filters drops every ledger query parameter');

      noBrowserErrors('T3-K', pageErrors, consoleErrors);
      check('T3-L', operatorServer.unexpected.length === 0, 'no unexpected API request while filtering');
      await context.close();
    }

    /* ==================================================== T4 cursor navigation == */
    {
      const { context, page, apiCalls, pageErrors, consoleErrors } = await openPage(browser, {});
      await gotoTopology(page, pagedServer.origin, '?view=ledger');
      await page.waitForSelector('[data-surface="ledger"] tbody tr', { state: 'visible' });

      const pager = page.locator('nav').filter({ hasText: 'Previous' });
      check('T4-A', (await ledgerRows(page)).length === 2, 'the first bounded page holds the fixture page size');
      check('T4-B', (await pager.innerText()).includes('Page 1'), 'the pager states the first page');

      await pager.getByRole('button', { name: 'Next', exact: true }).click();
      await page.waitForURL((url) => Boolean(url.searchParams.get('cursor')));
      const cursorOne = new URL(page.url()).searchParams.get('cursor');
      await page.waitForFunction(
        () => document.body.innerText.includes('Page 2'),
        null,
        { timeout: 15000 },
      );
      check('T4-C', (await ledgerRows(page)).length === 2, 'the second page holds the next slice');

      const lastPageRead = page.waitForResponse((response) => {
        if (!response.url().includes('/api/topology/edges')) return false;
        return new URL(response.url()).searchParams.get('cursor') === 'o:4';
      }, { timeout: 20000 });
      await pager.getByRole('button', { name: 'Next', exact: true }).click();
      await lastPageRead;
      await page.waitForFunction(() => document.body.innerText.includes('Page 3'), null, { timeout: 15000 });
      check('T4-D', (await ledgerRows(page)).length === 1, 'the last page holds the remainder');

      await pager.getByRole('button', { name: 'Previous', exact: true }).click();
      await page.waitForFunction(() => document.body.innerText.includes('Page 2'), null, { timeout: 15000 });
      const cursorBackTo = new URL(page.url()).searchParams.get('cursor');
      check('T4-E', cursorBackTo === cursorOne, `going back re-requests the cursor the page came from (${cursorBackTo})`);

      const beforeFilter = edgeCalls(apiCalls).length;
      await page.getByLabel('Relationship', { exact: true }).selectOption('connects_to');
      await page.waitForURL((url) => url.searchParams.get('relationship') === 'connects_to');
      check(
        'T4-F',
        new URL(page.url()).searchParams.get('cursor') === null,
        'a filter change drops the incompatible cursor',
      );
      await page.waitForTimeout(400);
      check(
        'T4-G',
        new URL(edgeCalls(apiCalls).at(-1).url).searchParams.get('cursor') === null,
        'the read after a filter change never reuses the old cursor',
      );
      check('T4-H', edgeCalls(apiCalls).length > beforeFilter, 'the filtered query was actually read');

      noBrowserErrors('T4-I', pageErrors, consoleErrors);
      check('T4-J', pagedServer.unexpected.length === 0, 'no unexpected API request while paging');
      await context.close();
    }

    /* ============================================ T5 out-of-order responses == */
    {
      const { context, page, pageErrors, consoleErrors } = await openPage(browser, {});
      let releaseOld;
      const oldGate = new Promise((resolve) => { releaseOld = resolve; });
      let oldSeen;
      const oldRequested = new Promise((resolve) => { oldSeen = resolve; });

      await page.route('**/api/topology/edges?**', async (route) => {
        const url = new URL(route.request().url());
        const type = url.searchParams.get('relationshipType') ?? '';
        const response = await route.fetch();
        if (type === 'depends_on') {
          oldSeen();
          await oldGate;
          await route.fulfill({ response });
          return;
        }
        await route.fulfill({ response });
      });

      await gotoTopology(page, operatorServer.origin, '?view=ledger');
      await page.waitForSelector('[data-surface="ledger"] tbody tr', { state: 'visible' });

      await page.getByLabel('Relationship', { exact: true }).selectOption('depends_on');
      await oldRequested;
      check('T5-A', true, 'the older query reached the request boundary before it was replaced');

      await page.getByLabel('Relationship', { exact: true }).selectOption('connects_to');
      await page.waitForFunction(
        () => document.querySelectorAll('[data-surface="ledger"] tbody tr').length === 1,
        null,
        { timeout: 15000 },
      );
      const newer = await ledgerRows(page);
      check('T5-B', newer[0].relationships.includes('connects_to'), 'the newer filtered dataset is rendered');

      releaseOld();
      await page.waitForTimeout(600);
      const afterRelease = await ledgerRows(page);
      check(
        'T5-C',
        afterRelease.length === 1 && afterRelease[0].relationships.includes('connects_to'),
        `the older response cannot replace the newer dataset (${afterRelease.map((row) => row.relationships.join('+')).join(',')})`,
      );
      check(
        'T5-D',
        (await page.getByLabel('Relationship', { exact: true }).inputValue()) === 'connects_to',
        'the newest filter stays selected after the stale completion',
      );
      noBrowserErrors('T5-E', pageErrors, consoleErrors);
      await context.close();
    }

    /* ======================================================= T6 create workflow == */
    {
      const { context, page, pageErrors, consoleErrors } = await openPage(browser, {});
      await gotoTopology(page, operatorServer.origin, '?view=ledger');
      await page.waitForSelector('[data-surface="ledger"] tbody tr', { state: 'visible' });

      await page.getByRole('button', { name: 'Create Relationship' }).click();
      await page.locator('#topology-create-title').waitFor({ state: 'visible' });

      await page.locator('#topology-from-resource').fill('smf');
      await page.locator('#topology-from-resource-results [role="option"]').first().click();
      await page.locator('#topology-relationship').selectOption('connects_to');
      await page.locator('#topology-to-resource').fill('upf');
      await page.locator('#topology-to-resource-results [role="option"]').first().click();

      const postRequest = page.waitForRequest((request) => request.method() === 'POST' && request.url().endsWith('/api/topology/edges'));
      await page.getByRole('button', { name: 'Create relationship' }).click();
      const posted = await postRequest;
      const payload = posted.postDataJSON();

      check('T6-A', payload.relationshipType === 'connects_to', `the submitted relationship type is the selected one (${payload.relationshipType})`);
      check('T6-B', payload.fromResourceId === RESOURCE_IDS.smf, 'the source is the selected Inventory resource identifier');
      check('T6-C', payload.toResourceId === RESOURCE_IDS.upf, 'the target is the selected Inventory resource identifier');
      check('T6-D', !('edgeId' in payload) && !('revision' in payload), 'no server-owned field is submitted');

      await page.waitForURL((url) => url.pathname === `/topology/${RESOURCE_IDS.smf}`, { timeout: 20000 });
      check('T6-E', page.url().includes('returnTo='), 'the established post-create navigation keeps the list context');
      check('T6-F', await page.locator('#topology-create-title').count() === 0, 'the dialog closes only after the mutation succeeded');

      noBrowserErrors('T6-G', pageErrors, consoleErrors);
      check(
        'T6-H',
        operatorServer.unexpected.length === 0,
        `no unexpected API request during create: ${operatorServer.unexpected.join(',')}`,
      );
      await context.close();
    }

    /* ========================================================= T7 edit workflow == */
    {
      const { context, page, apiCalls, pageErrors, consoleErrors } = await openPage(browser, {});
      await gotoTopology(page, operatorServer.origin, '?view=ledger');
      await page.waitForSelector('[data-surface="ledger"] tbody tr', { state: 'visible' });

      const target = page.locator(`[data-edge-id="${EDGE_IDS.depends}"]`);
      await target.getByRole('button', { name: 'Edit', exact: true }).click();
      await page.locator('#topology-edit-title').waitFor({ state: 'visible' });
      const dialogText = await page.locator('#topology-edit-title').locator('xpath=ancestor::div[contains(@class,"modal")]').first().innerText();
      check('T7-A', /depends on/i.test(dialogText), 'the edit dialog states the immutable relationship');
      check('T7-B', /r1\b/.test(dialogText), 'the edit dialog states the revision it was opened with');
      check('T7-C', await page.locator('#topology-relationship').count() === 0, 'the relationship type is not editable');

      await page.locator('#topology-description').fill('SMF depends on PCF (edited)');
      const putRequest = page.waitForRequest((request) => request.method() === 'PUT' && request.url().includes(`/api/topology/edges/${EDGE_IDS.depends}`));
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      const put = await putRequest;
      const body = put.postDataJSON();
      check('T7-D', body.expectedRevision === 1, `the update carries the revision the dialog was opened with (${body.expectedRevision})`);
      check('T7-E', body.edge?.description === 'SMF depends on PCF (edited)', 'only the mutable metadata is submitted');
      check('T7-F', !('relationshipType' in (body.edge ?? {})) && !('fromResourceId' in (body.edge ?? {})), 'the immutable identity is never resubmitted');
      await page.waitForFunction(() => !document.querySelector('#topology-edit-title'), null, { timeout: 15000 });
      check('T7-G', true, 'a successful update closes the dialog');

      /* A stale revision is surfaced, never retried. */
      let conflictPuts = 0;
      await page.route(`**/api/topology/edges/${EDGE_IDS.depends}`, async (route) => {
        if (route.request().method() !== 'PUT') return route.fallback();
        conflictPuts += 1;
        await route.fulfill({ status: 409, json: { error: 'conflict', code: 'TOPOLOGY_REVISION_CONFLICT' } });
      });
      await page.locator(`[data-edge-id="${EDGE_IDS.depends}"]`).getByRole('button', { name: 'Edit', exact: true }).click();
      await page.locator('#topology-edit-title').waitFor({ state: 'visible' });
      await page.locator('#topology-description').fill('SMF depends on PCF (conflict)');
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await page.waitForSelector('[role="alert"]', { state: 'visible', timeout: 15000 });
      const alertText = await page.locator('[role="alert"]').first().innerText();
      check('T7-H', /changed since it was loaded/i.test(alertText), `the conflict is stated in the dialog (${alertText.slice(0, 60)})`);
      check('T7-I', await page.locator('#topology-edit-title').count() === 1, 'the draft stays open after a conflict');
      await page.waitForTimeout(600);
      check('T7-J', conflictPuts === 1, `a conflict is never retried automatically (${conflictPuts} attempt(s))`);
      const bannerText = await bodyText(page);
      check('T7-K', bannerText.includes('Reload'), 'the conflict offers an explicit reload path');
      check('T7-L', apiCalls.filter((call) => call.method === 'PUT').length === 2, 'exactly the two submitted updates were issued');

      /* The 409 is this scenario's own stimulus: the browser logs the failed
       * response, and that line is the only console output allowed here. */
      const expectedConflictNoise = /Failed to load resource: the server responded with a status of 409/i;
      const unexpectedConsole = consoleErrors.filter((text) => !expectedConflictNoise.test(text));
      check(
        'T7-M',
        pageErrors.length === 0 && unexpectedConsole.length === 0,
        `no unexpected browser errors (${pageErrors.concat(unexpectedConsole).join(' | ')})`,
      );
      await context.close();
    }

    /* ======================================================= T8 retire workflow == */
    {
      const { context, page, apiCalls, pageErrors, consoleErrors } = await openPage(browser, {});
      await gotoTopology(page, operatorServer.origin, '?view=ledger');
      await page.waitForSelector('[data-surface="ledger"] tbody tr', { state: 'visible' });

      const target = page.locator(`[data-edge-id="${EDGE_IDS.uses}"]`);
      await target.getByRole('button', { name: 'Retire', exact: true }).click();
      await page.locator('#topology-retire-title').waitFor({ state: 'visible' });
      const confirm = page.getByRole('button', { name: 'Retire relationship' });
      check('T8-A', await confirm.isDisabled(), 'a retirement cannot be confirmed without a reason');
      check('T8-B', (await bodyText(page)).includes('r2'), 'the retire dialog states the revision it was opened with');

      await page.locator('#topology-retire-reason').fill('superseded by N4 plan');
      check('T8-C', await confirm.isEnabled(), 'a reason enables the confirmation');

      const retireRequest = page.waitForRequest((request) => request.method() === 'POST' && request.url().endsWith('/retire'));
      await confirm.click();
      const retired = await retireRequest;
      const payload = retired.postDataJSON();
      check('T8-D', payload.expectedRevision === 2, `the retirement carries the opened revision (${payload.expectedRevision})`);
      check('T8-E', payload.reason === 'superseded by N4 plan', 'the reason is submitted');
      check('T8-F', retired.url().endsWith(`/api/topology/edges/${EDGE_IDS.uses}/retire`), 'the retirement targets the intended edge');

      await page.waitForFunction(() => !document.querySelector('#topology-retire-title'), null, { timeout: 15000 });
      check('T8-G', true, 'a successful retirement closes the dialog');
      await page.waitForTimeout(500);
      check(
        'T8-H',
        apiCalls.filter((call) => call.method === 'POST' && call.url.endsWith('/retire')).length === 1,
        'exactly one retirement request is issued',
      );

      await page.getByLabel('Lifecycle', { exact: true }).selectOption('retired');
      await page.waitForFunction(
        () => document.querySelectorAll('[data-surface="ledger"] tbody tr').length === 2,
        null,
        { timeout: 15000 },
      );
      const retiredRows = await ledgerRows(page);
      check(
        'T8-I',
        retiredRows.some((row) => row.edgeId === EDGE_IDS.uses && row.text.includes('Retired')),
        'the retired relationship is readable as retired',
      );

      noBrowserErrors('T8-J', pageErrors, consoleErrors);
      await context.close();
    }

    /* ==================================================== T9 read-only session == */
    {
      const { context, page, apiCalls, pageErrors, consoleErrors } = await openPage(browser, {});
      await gotoTopology(page, viewerServer.origin, '?view=ledger');
      await page.waitForSelector('[data-surface="ledger"] tbody tr', { state: 'visible' });

      const text = await bodyText(page);
      check('T9-A', (await ledgerRows(page)).length === 5, 'a read-only session reads the whole ledger');
      check('T9-B', !text.includes('Create Relationship'), 'no create action is offered');
      check('T9-C', await page.getByRole('button', { name: 'Edit', exact: true }).count() === 0, 'no edit action is offered');
      check('T9-D', await page.getByRole('button', { name: 'Retire', exact: true }).count() === 0, 'no retire action is offered');
      check(
        'T9-E',
        apiCalls.filter((call) => call.method !== 'GET').length === 0,
        'a read-only session issues no mutation request',
      );
      check('T9-F', SESSIONS.viewer.permissions.includes('core.read') && !SESSIONS.viewer.permissions.includes('core.configure'), 'the read-only fixture session really lacks core.configure');

      noBrowserErrors('T9-G', pageErrors, consoleErrors);
      await context.close();
    }

    /* =================================================== T10 resource identity == */
    {
      const { context, page, pageErrors, consoleErrors } = await openPage(browser, {});
      await page.route('**/api/topology/edges?**', async (route) => {
        const response = await route.fetch();
        const payload = await response.json();
        const rows = (payload.edges ?? []).map((edge, index) => (
          index === 0 ? { ...edge, toResourceId: 'ffffffff-0000-4000-8000-0000000000ff' } : edge
        ));
        await route.fulfill({ json: { ...payload, edges: rows } });
      });
      await gotoTopology(page, operatorServer.origin, '?view=ledger');
      await page.waitForSelector('[data-surface="ledger"] tbody tr', { state: 'visible' });
      const text = await bodyText(page);
      check('T10-A', text.includes('Unresolved resource'), 'an endpoint with no Inventory projection is labelled unresolved');
      check('T10-B', !text.includes('ffffffff-0000-4000-8000-0000000000ff</strong>'), 'no name is invented for it');

      await page.getByRole('button', { name: 'Create Relationship' }).click();
      await page.locator('#topology-create-title').waitFor({ state: 'visible' });
      await page.locator('#topology-from-resource').fill('mme');
      await page.locator('#topology-from-resource-results [role="option"]').first().waitFor({ state: 'visible' });
      const retiredOption = page.locator('#topology-from-resource-results [role="option"]').first();
      check('T10-C', await retiredOption.isDisabled(), 'a retired Inventory resource cannot be selected as a new endpoint');
      check('T10-D', (await page.locator('#topology-from-resource-results').innerText()).toLowerCase().includes('retired'), 'the retired state is stated on the option');

      noBrowserErrors('T10-E', pageErrors, consoleErrors);
      await context.close();
    }

    /* ================================================ T11 reconciliation evidence == */
    {
      const { context, page, pageErrors, consoleErrors } = await openPage(browser, {});
      await page.route('**/api/topology/live', (route) => route.fulfill({ json: RECONCILIATION_LIVE }));
      await gotoTopology(page, operatorServer.origin, '?view=graph&source=declared');
      await page.locator('[data-reconciliation="true"]').waitFor({ state: 'visible', timeout: 25000 });

      const panel = page.locator('[data-reconciliation="true"]');
      check('T11-A', (await panel.locator('[data-recon-count="agreed"]').innerText()).includes('1'), 'the agreeing pair is counted once');
      check('T11-B', (await panel.locator('[data-recon-count="undeclared"]').innerText()).includes('1'), 'configured evidence with no declaration is counted');
      check('T11-C', (await panel.locator('[data-recon-count="unevidenced"]').innerText()).includes('1'), 'a declaration with no evidence is counted');
      check('T11-D', (await panel.locator('[data-recon-count="disagreed"]').innerText()).includes('2'), 'both non-agreeing pairs are counted as disagreement');
      check('T11-E', await panel.locator('[data-recon-group="undeclared"]').count() === 1, 'undeclared evidence has its own group');
      check('T11-F', await panel.locator('[data-recon-group="unevidenced"]').count() === 1, 'unevidenced declarations have their own group');
      check('T11-G', await panel.locator('[data-recon-group="disagreed"]').count() === 1, 'interface disagreement has its own group');
      check(
        'T11-H',
        await panel.locator('[data-interface-status="declaration_only"]').count() >= 1
          && await panel.locator('[data-interface-status="evidence_only"]').count() >= 1,
        'a per-interface disagreement states which side each interface came from',
      );
      check('T11-I', await panel.getAttribute('data-recon-complete') === 'false', 'an incomplete configured projection is stated as incomplete');
      check(
        'T11-H2',
        await panel.locator('[data-recon-rules]').first().getAttribute('data-recon-rules') === 'rules-2026-10',
        'the comparison rules version is stated',
      );
      check('T11-J', await panel.locator('[data-recon-verdict="partial"]').count() === 1, 'a partially covered pair is not presented as agreement');

      await page.locator('[data-topology-source="runtime"]').click();
      await page.locator('[data-unresolved-peer-count]').waitFor({ state: 'visible', timeout: 20000 });
      check('T11-K', (await page.locator('[data-unresolved-peer-count]').innerText()).includes('1'), 'an unresolved configured peer is stated separately');

      noBrowserErrors('T11-L', pageErrors, consoleErrors);
      await context.close();
    }

    /* ========================================================== T12 freshness == */
    {
      const { context, page, pageErrors, consoleErrors } = await openPage(browser, {});
      await gotoTopology(page, operatorServer.origin, '?view=ledger');
      await page.waitForSelector('[data-surface="ledger"] tbody tr', { state: 'visible' });
      const readChip = page.locator('[data-freshness-mode="read"]');
      check('T12-A', await readChip.count() === 1, 'the ledger states when it was read');
      check('T12-B', await readChip.getAttribute('data-freshness') === 'fresh', 'a just-completed read is fresh');
      const readChipText = await readChip.innerText();
      check(
        'T12-C',
        /Read time/i.test(readChipText) && !/Source time/i.test(readChipText),
        `a read time is labelled as a read, never as server evidence (${readChipText.replace(/\s+/g, ' ')})`,
      );

      await page.route('**/api/topology/live', async (route) => {
        const response = await route.fetch();
        const payload = await response.json();
        await route.fulfill({ json: { ...payload, generatedAt: '2020-01-01T00:00:00Z' } });
      });
      await gotoTopology(page, operatorServer.origin, '?view=graph&source=runtime');
      const staleChip = page.locator('[data-freshness-mode="source"]');
      await staleChip.waitFor({ state: 'visible', timeout: 25000 });
      check('T12-D', await staleChip.getAttribute('data-freshness') === 'stale', 'an old server timestamp is stale evidence');
      check('T12-E', await staleChip.getAttribute('data-source-time') === '2020-01-01T00:00:00Z', 'the chip repeats the server timestamp verbatim');

      await page.unroute('**/api/topology/live');
      await page.route('**/api/topology/live', async (route) => {
        const response = await route.fetch();
        const payload = await response.json();
        const withoutTimestamp = { ...payload };
        delete withoutTimestamp.generatedAt;
        await route.fulfill({ json: withoutTimestamp });
      });
      await page.reload();
      const unknownChip = page.locator('[data-freshness-mode="source"]');
      await unknownChip.waitFor({ state: 'visible', timeout: 25000 });
      check('T12-F', await unknownChip.getAttribute('data-freshness') === 'unknown', 'a missing timestamp claims no freshness');

      noBrowserErrors('T12-G', pageErrors, consoleErrors);
      await context.close();
    }

    /* ================================================== T13 graph interactions == */
    {
      const { context, page, pageErrors, consoleErrors } = await openPage(browser, {});
      await gotoTopology(page, operatorServer.origin, '?view=graph&source=declared');
      await page.locator('[data-actual-canvas]').first().waitFor({ state: 'visible', timeout: 25000 });

      const node = page.locator(`[data-actual-canvas] [data-resource-id="${RESOURCE_IDS.smf}"]`).first();
      check('T13-A', await node.count() === 1, 'a declared node is rendered for the Inventory resource');
      await node.click();
      await page.locator('[data-topology-inspector="true"]').waitFor({ state: 'visible' });
      check('T13-B', true, 'selecting a node opens the shared inspector');
      check('T13-C', await node.getAttribute('aria-pressed') === 'true', 'the selected node states its selection');

      await page.keyboard.press('Escape');
      await page.locator('[data-topology-inspector="true"]').waitFor({ state: 'detached' });
      const focusBack = await page.evaluate(() => document.activeElement?.getAttribute('data-resource-id') ?? '');
      check('T13-D', focusBack === RESOURCE_IDS.smf, `closing the inspector restores focus to the node (${focusBack})`);

      const scale = page.locator('[data-actual-canvas]').first();
      const beforeZoom = await scale.evaluate((node_) => node_.parentElement?.getAttribute('style') ?? '');
      await page.locator('[data-action="zoom-in"]').first().click();
      await page.waitForTimeout(200);
      const afterZoom = await scale.evaluate((node_) => node_.parentElement?.getAttribute('style') ?? '');
      check('T13-E', beforeZoom !== afterZoom, 'the zoom control changes the canvas scale');

      await page.locator('[data-topology-view="ledger"]').click();
      await page.waitForSelector('[data-surface="ledger"] tbody tr', { state: 'visible' });
      check(
        'T13-F',
        await page.locator(`[data-surface="ledger"] [data-edge-id="${EDGE_IDS.connects}"]`).count() === 1,
        'the same relationship is reachable through the accessible table',
      );

      noBrowserErrors('T13-G', pageErrors, consoleErrors);
      await context.close();
    }

    /* ============================================= T14 responsive and locales == */
    for (const viewport of [
      { name: 'desktop', width: 1440, height: 900 },
      { name: 'mobile', width: 375, height: 812 },
    ]) {
      for (const theme of ['light', 'dark']) {
        const { context, page, pageErrors, consoleErrors } = await openPage(browser, {
          width: viewport.width,
          height: viewport.height,
          theme,
        });
        await gotoTopology(page, operatorServer.origin, '?view=ledger');
        await page.waitForSelector('[data-surface="ledger"] tbody tr', { state: 'visible' });

        check(
          `T14-A:${viewport.name}-${theme}`,
          await page.getByLabel('Relationship', { exact: true }).isVisible(),
          'the ledger filters stay usable',
        );
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        check(`T14-B:${viewport.name}-${theme}`, overflow <= 2, `the page does not overflow horizontally (${overflow}px)`);
        check(
          `T14-C:${viewport.name}-${theme}`,
          await page.getByRole('button', { name: 'Retire', exact: true }).first().isVisible(),
          'the relationship actions remain reachable',
        );
        noBrowserErrors(`T14-D:${viewport.name}-${theme}`, pageErrors, consoleErrors);
        await context.close();
      }
    }
    {
      const { context, page, pageErrors, consoleErrors } = await openPage(browser, { locale: 'zh' });
      await gotoTopology(page, operatorServer.origin, '?view=ledger');
      await page.waitForSelector('[data-surface="ledger"] tbody tr', { state: 'visible' });
      const text = await bodyText(page);
      check('T14-E', /[\u4e00-\u9fa5]/.test(text), 'the Chinese localization renders');
      check('T14-F', !/topology_[a-z_]+/.test(text), 'no raw localization key leaks into the Chinese surface');
      noBrowserErrors('T14-G', pageErrors, consoleErrors);
      await context.close();
    }
    {
      const { context, page, pageErrors, consoleErrors } = await openPage(browser, {});
      await gotoTopology(page, operatorServer.origin, '?view=ledger');
      await page.waitForSelector('[data-surface="ledger"] tbody tr', { state: 'visible' });
      const text = await bodyText(page);
      check('T14-H', !/topology_[a-z_]+/.test(text), 'no raw localization key leaks into the English surface');
      noBrowserErrors('T14-I', pageErrors, consoleErrors);
      await context.close();
    }

    check('SYS-A', operatorServer.unexpected.length === 0, `operator fixture saw no unexpected API request: ${operatorServer.unexpected.join(',')}`);
    check('SYS-B', viewerServer.unexpected.length === 0, `viewer fixture saw no unexpected API request: ${viewerServer.unexpected.join(',')}`);
  } finally {
    if (browser) await browser.close();
    for (const server of servers) await server.close();
    await rm(tmpDist, { recursive: true, force: true });
  }

  console.log('');
  console.log('=============================================================');
  if (failures.length > 0) {
    console.error(`[acceptance:topology-workspace] FAILED ${failures.length} check(s) of ${checks.length}`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log(`[acceptance:topology-workspace] passed ${checks.length}/${checks.length} assertions`);
}

await main();
