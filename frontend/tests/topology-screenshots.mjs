#!/usr/bin/env node
/*
 * Stage 2 browser-rendered UI acceptance.
 *
 * Builds nothing itself: it renders the ALREADY BUILT production SPA
 * (`frontend/dist`) in real Chromium through a deterministic, test-only API
 * fixture adapter, asserts browser-observable behaviour, captures the mandated
 * PNG matrix, verifies screenshot integrity and writes a checksummed manifest.
 *
 * The screenshots demonstrate frontend rendering against deterministic API
 * fixtures - not a live core-network deployment.
 *
 * Usage (from frontend/): node tests/topology-screenshots.mjs
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { RESOURCE_IDS, startFixtureServer } from './topology-fixtures.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const frontendRoot = resolve(here, '..');
const repoRoot = resolve(frontendRoot, '..');
const distDir = resolve(frontendRoot, 'dist');
const outDir = resolve(repoRoot, 'reports', 'ops', 'topology-ui-screenshots');

const EXPECTED_SCREENSHOT_COUNT = 24;
const MIN_PNG_BYTES = 8192;

const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  tablet: { width: 768, height: 1024 },
  mobile: { width: 390, height: 844 },
};

/* Console messages that are benign and explicitly documented. */
const BENIGN_CONSOLE = [
  /Download the React DevTools/i,
  /favicon/i,
];

const checks = [];
const screenshots = [];
const failures = [];
const consoleErrors = [];
const pageErrors = [];
const unexpectedApi = [];

function check(id, ok, detail = '') {
  checks.push({ id, ok: Boolean(ok), detail });
  if (!ok) failures.push(`${id} ${detail}`);
}

function sourceCommit() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
  } catch {
    try {
      const head = readFileSync(join(repoRoot, '.git', 'HEAD'), 'utf8').trim();
      if (head.startsWith('ref: ')) {
        return readFileSync(join(repoRoot, '.git', head.slice(5).trim()), 'utf8').trim();
      }
      return head;
    } catch {
      return 'unknown';
    }
  }
}

const COMMIT = sourceCommit();

/* ---------------------------------------------------------------- helpers -- */

async function newSession(browser, { width, height, theme, locale, session }) {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
    locale: locale === 'zh' ? 'zh-CN' : 'en-US',
    timezoneId: 'UTC',
    reducedMotion: 'reduce',
    colorScheme: theme === 'dark' ? 'dark' : 'light',
  });
  await context.addInitScript(([themeValue, localeValue]) => {
    try {
      localStorage.setItem('XCLOUD_THEME_PREFERENCE', themeValue);
      localStorage.setItem('XCLOUD_LANGUAGE_PREFERENCE', localeValue);
    } catch {
      /* Storage unavailable: the defaults apply and the assertion will notice. */
    }
  }, [theme, locale]);

  const page = await context.newPage();
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    if (BENIGN_CONSOLE.some((pattern) => pattern.test(text))) return;
    consoleErrors.push(`[${session}] ${text}`);
  });
  page.on('pageerror', (error) => {
    pageErrors.push(`[${session}] ${error?.message ?? String(error)}`);
  });
  return { context, page };
}

async function settle(page, expectedText) {
  await page.waitForSelector('.layout-root', { state: 'visible', timeout: 30000 });
  await page.waitForFunction(
    () => document.fonts === undefined || document.fonts.status === 'loaded',
    null,
    { timeout: 30000 },
  );
  if (expectedText) {
    await page.getByText(expectedText, { exact: false }).first().waitFor({ state: 'visible', timeout: 30000 });
  }
}

async function assertNoHorizontalOverflow(page, label) {
  const metrics = await page.evaluate(() => ({
    docScroll: document.documentElement.scrollWidth,
    bodyScroll: document.body.scrollWidth,
    inner: window.innerWidth,
  }));
  check(
    `no_horizontal_overflow:${label}`,
    metrics.docScroll <= metrics.inner + 1 && metrics.bodyScroll <= metrics.inner + 1,
    `docScroll=${metrics.docScroll} bodyScroll=${metrics.bodyScroll} inner=${metrics.inner}`,
  );
}

async function assertNoRawKeys(page, label) {
  const text = await page.locator('body').innerText();
  check(
    `no_raw_translation_keys:${label}`,
    !/\b(?:topology|nav|eyebrow|inventory)_[a-z0-9_]{2,}\b/.test(text),
    'untranslated key leaked into rendered text',
  );
}

async function capture(page, filename, meta) {
  const path = join(outDir, filename);
  await page.screenshot({ path, animations: 'disabled', caret: 'hide', scale: 'css' });
  screenshots.push({ filename, path, ...meta });
}

/* ------------------------------------------------------------------- main -- */

async function main() {
  if (!existsSync(join(distDir, 'index.html'))) {
    throw new Error(`built SPA not found at ${distDir}; run "npm run build" first`);
  }

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const operatorServer = await startFixtureServer({ distDir, sessionKey: 'operator' });
  const viewerServer = await startFixtureServer({ distDir, sessionKey: 'viewer' });

  let browser;
  try {
    browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  } catch (error) {
    await operatorServer.close();
    await viewerServer.close();
    throw new Error(`chromium launch failed: ${error?.message ?? error}`);
  }

  const { origin } = operatorServer;
  const topologyList = '/topology';
  const topologyGraph = `/topology/${RESOURCE_IDS.smf}`;

  try {
    /* ============================ A. main Topology pages ==================== */
    for (const [sizeName, viewport] of Object.entries(VIEWPORTS)) {
      for (const theme of ['light', 'dark']) {
        const { context, page } = await newSession(browser, { ...viewport, theme, locale: 'en', session: 'operator' });
        await page.goto(`${origin}${topologyList}`, { waitUntil: 'domcontentloaded' });
        await settle(page, 'Create Relationship');

        check(`auth_gate_allows_session:${sizeName}-${theme}`, !page.url().includes('/login'), `url=${page.url()}`);
        check(`app_shell_visible:${sizeName}-${theme}`, await page.locator('#xcloud-primary-sidebar').isVisible(), 'sidebar');
        check(`topology_title_visible:${sizeName}-${theme}`, await page.locator('h1').first().isVisible(), 'page title');
        const rowCount = await page.locator('table tbody tr').count();
        check(`fixture_relationships_render:${sizeName}-${theme}`, rowCount >= 4, `rows=${rowCount}`);
        check(`relationship_names_match_fixture:${sizeName}-${theme}`, await page.getByText('PCF-01', { exact: false }).first().isVisible(), 'PCF-01');
        check(`theme_applied:${sizeName}-${theme}`, (await page.evaluate(() => document.documentElement.dataset.theme)) === theme, theme);
        await assertNoRawKeys(page, `${sizeName}-${theme}`);
        await assertNoHorizontalOverflow(page, `${sizeName}-${theme}`);

        await capture(page, `topology-list-${sizeName}-${theme}.png`, {
          route: topologyList,
          viewportWidth: viewport.width,
          viewportHeight: viewport.height,
          theme,
          locale: 'en',
          fixtureScenario: 'topology-list-active',
          session: 'operator',
        });
        await context.close();
      }
    }

    /* Deep-link graph page across the same matrix. */
    for (const [sizeName, viewport] of Object.entries(VIEWPORTS)) {
      for (const theme of ['light', 'dark']) {
        const { context, page } = await newSession(browser, { ...viewport, theme, locale: 'en', session: 'operator' });
        await page.goto(`${origin}${topologyGraph}`, { waitUntil: 'domcontentloaded' });
        await settle(page, 'SMF-01');

        const svgNodes = await page.locator('svg g[role="button"]').count();
        check(`graph_nodes_render:${sizeName}-${theme}`, svgNodes >= 4, `nodes=${svgNodes}`);
        const directionText = await page.locator('body').innerText();
        check(
          `graph_directions_represented:${sizeName}-${theme}`,
          /Outbound/.test(directionText) && /Inbound/.test(directionText),
          'inbound/outbound labels',
        );
        check(
          `graph_neighbours_match_fixture:${sizeName}-${theme}`,
          /PCF-01/.test(directionText) && /UPF-01/.test(directionText) && /AMF-01/.test(directionText),
          'fixture neighbours',
        );
        check(`graph_table_visible:${sizeName}-${theme}`, (await page.locator('table tbody tr').count()) >= 3, 'rows');
        await assertNoRawKeys(page, `graph-${sizeName}-${theme}`);
        await assertNoHorizontalOverflow(page, `graph-${sizeName}-${theme}`);

        await capture(page, `topology-graph-${sizeName}-${theme}.png`, {
          route: topologyGraph,
          viewportWidth: viewport.width,
          viewportHeight: viewport.height,
          theme,
          locale: 'en',
          fixtureScenario: 'smf-01-one-hop',
          session: 'operator',
        });
        await context.close();
      }
    }

    /* ========================= B. interactive dialogs ======================= */
    const dialogCases = [
      { name: 'create', sizeName: 'desktop', viewport: VIEWPORTS.desktop, theme: 'light' },
      { name: 'create', sizeName: 'desktop', viewport: VIEWPORTS.desktop, theme: 'dark' },
      { name: 'create', sizeName: 'mobile', viewport: VIEWPORTS.mobile, theme: 'light' },
      { name: 'retire', sizeName: 'desktop', viewport: VIEWPORTS.desktop, theme: 'light' },
      { name: 'retire', sizeName: 'desktop', viewport: VIEWPORTS.desktop, theme: 'dark' },
      { name: 'retire', sizeName: 'mobile', viewport: VIEWPORTS.mobile, theme: 'light' },
    ];

    for (const testCase of dialogCases) {
      const { context, page } = await newSession(browser, {
        ...testCase.viewport,
        theme: testCase.theme,
        locale: 'en',
        session: 'operator',
      });
      await page.goto(`${origin}${topologyList}`, { waitUntil: 'domcontentloaded' });
      await settle(page, 'Create Relationship');

      if (testCase.name === 'create') {
        await page.getByRole('button', { name: /Create Relationship/i }).first().click();
        await page.locator('#topology-create-title').waitFor({ state: 'visible', timeout: 15000 });
        check(`create_dialog_opens:${testCase.sizeName}-${testCase.theme}`, await page.locator('#topology-create-title').isVisible(), 'title');
        check(
          `create_dialog_resource_selectors:${testCase.sizeName}-${testCase.theme}`,
          (await page.locator('#topology-from-resource').isVisible()) && (await page.locator('#topology-to-resource').isVisible()),
          'from/to selectors',
        );
      } else {
        await page.getByRole('button', { name: /^Retire$/i }).first().click();
        await page.locator('#topology-retire-title').waitFor({ state: 'visible', timeout: 15000 });
        check(`retire_dialog_opens:${testCase.sizeName}-${testCase.theme}`, await page.locator('#topology-retire-title').isVisible(), 'title');
        check(
          `retire_dialog_identity_visible:${testCase.sizeName}-${testCase.theme}`,
          await page.getByText(RESOURCE_IDS.smf, { exact: false }).first().isVisible(),
          'from identity',
        );
      }

      const titleSelector = testCase.name === 'create' ? '#topology-create-title' : '#topology-retire-title';
      const geometry = await page.evaluate((selector) => {
        const title = document.querySelector(selector);
        const chrome = document.querySelector('.nav-breadcrumbs-bar');
        const content = document.querySelector('.modal-content');
        const rect = (el) => (el ? el.getBoundingClientRect() : null);
        const contentRect = rect(content);
        const titleRect = rect(title);
        return {
          titleTop: titleRect ? Math.round(titleRect.top) : null,
          titleBottom: titleRect ? Math.round(titleRect.bottom) : null,
          chromeBottom: chrome ? Math.round(chrome.getBoundingClientRect().bottom) : 0,
          contentTop: contentRect ? Math.round(contentRect.top) : null,
          contentBottom: contentRect ? Math.round(contentRect.bottom) : null,
          viewport: window.innerHeight,
        };
      }, titleSelector);

      check(
        `dialog_fits_viewport:${testCase.name}-${testCase.sizeName}-${testCase.theme}`,
        geometry.contentTop !== null && geometry.contentTop >= 0 && geometry.contentBottom <= geometry.viewport + 1,
        JSON.stringify(geometry),
      );
      check(
        `dialog_header_clear_of_shell:${testCase.name}-${testCase.sizeName}-${testCase.theme}`,
        geometry.titleTop !== null && geometry.titleTop >= geometry.chromeBottom,
        `titleTop=${geometry.titleTop} chromeBottom=${geometry.chromeBottom}`,
      );

      await assertNoHorizontalOverflow(page, `dialog-${testCase.name}-${testCase.sizeName}-${testCase.theme}`);
      await capture(page, `topology-${testCase.name}-${testCase.sizeName}-${testCase.theme}.png`, {
        route: topologyList,
        viewportWidth: testCase.viewport.width,
        viewportHeight: testCase.viewport.height,
        theme: testCase.theme,
        locale: 'en',
        fixtureScenario: testCase.name === 'create' ? 'create-relationship-dialog' : 'retire-relationship-dialog',
        session: 'operator',
      });
      await context.close();
    }

    /* ==================== C. existing xCloud comparison pages ============== */
    const comparisonCases = [
      { route: '/inventory', slug: 'inventory-list', scenario: 'inventory-list' },
      { route: `/inventory/${RESOURCE_IDS.smf}`, slug: 'inventory-detail', scenario: 'inventory-detail' },
      { route: '/system-health', slug: 'system-health', scenario: 'system-health' },
    ];

    for (const comparison of comparisonCases) {
      for (const theme of ['light', 'dark']) {
        const { context, page } = await newSession(browser, {
          ...VIEWPORTS.desktop,
          theme,
          locale: 'en',
          session: 'operator',
        });
        await page.goto(`${origin}${comparison.route}`, { waitUntil: 'domcontentloaded' });
        await settle(page);

        check(
          `comparison_page_rendered:${comparison.slug}-${theme}`,
          (await page.locator('.layout-root').isVisible()) && !page.url().includes('/login'),
          comparison.route,
        );
        check(
          `comparison_theme_applied:${comparison.slug}-${theme}`,
          (await page.evaluate(() => document.documentElement.dataset.theme)) === theme,
          theme,
        );
        await assertNoRawKeys(page, `${comparison.slug}-${theme}`);
        await assertNoHorizontalOverflow(page, `${comparison.slug}-${theme}`);

        await capture(page, `${comparison.slug}-desktop-${theme}.png`, {
          route: comparison.route,
          viewportWidth: VIEWPORTS.desktop.width,
          viewportHeight: VIEWPORTS.desktop.height,
          theme,
          locale: 'en',
          fixtureScenario: comparison.scenario,
          session: 'operator',
        });
        await context.close();
      }
    }

    /* ================= D. non-screenshot interaction assertions ============ */

    /* Sidebar navigation reaches Topology. */
    {
      const { context, page } = await newSession(browser, { ...VIEWPORTS.desktop, theme: 'light', locale: 'en', session: 'operator' });
      await page.goto(`${origin}/inventory`, { waitUntil: 'domcontentloaded' });
      await settle(page);
      await page.locator('#xcloud-primary-sidebar').getByRole('link', { name: /Topology/i }).first().click();
      await page.waitForURL(/\/topology$/, { timeout: 15000 });
      await settle(page, 'Create Relationship');
      check('sidebar_topology_navigation', page.url().endsWith('/topology'), `url=${page.url()}`);
      await context.close();
    }

    /* Chinese locale renders Chinese labels. */
    {
      const { context, page } = await newSession(browser, { ...VIEWPORTS.desktop, theme: 'light', locale: 'zh', session: 'operator' });
      await page.goto(`${origin}${topologyList}`, { waitUntil: 'domcontentloaded' });
      await settle(page, '创建关系');
      const text = await page.locator('body').innerText();
      check('chinese_locale_labels', /[\u4e00-\u9fff]/.test(text) && /创建关系/.test(text), 'zh labels');
      check('chinese_locale_html_lang', (await page.evaluate(() => document.documentElement.lang)) === 'zh-CN', 'html lang');
      await assertNoRawKeys(page, 'zh');
      await context.close();
    }

    /* Viewer session is read-only. */
    {
      const { context, page } = await newSession(browser, { ...VIEWPORTS.desktop, theme: 'light', locale: 'en', session: 'viewer' });
      await page.goto(`${viewerServer.origin}${topologyList}`, { waitUntil: 'domcontentloaded' });
      await settle(page);
      const text = await page.locator('body').innerText();
      check('viewer_read_only_controls', !/Create Relationship/.test(text) && !/^\s*Retire\s*$/m.test(text), 'no mutation controls');
      check('viewer_sees_relationships', (await page.locator('table tbody tr').count()) >= 4, 'rows');
      await context.close();
    }

    /* Retired relationships are readable when explicitly requested. */
    {
      const { context, page } = await newSession(browser, { ...VIEWPORTS.desktop, theme: 'light', locale: 'en', session: 'operator' });
      await page.goto(`${origin}${topologyList}`, { waitUntil: 'domcontentloaded' });
      await settle(page, 'Create Relationship');
      await page.getByLabel(/Lifecycle/i).selectOption('retired');
      await page.locator('table tbody tr').first().waitFor({ state: 'visible', timeout: 15000 });
      const retiredRows = await page.locator('table tbody tr').count();
      /* The status badge is uppercased by the shared badge stylesheet, so the
       * rendered text is "RETIRED"; match case-insensitively. */
      const retiredText = await page.locator('table tbody').innerText();
      check('retired_relationship_readable', retiredRows >= 1 && /retired/i.test(retiredText), `rows=${retiredRows}`);
      await context.close();
    }

    /* Write interactions return contract-valid responses. */
    {
      const { context, page } = await newSession(browser, { ...VIEWPORTS.desktop, theme: 'light', locale: 'en', session: 'operator' });
      await page.goto(`${origin}${topologyList}`, { waitUntil: 'domcontentloaded' });
      await settle(page, 'Create Relationship');
      await page.getByRole('button', { name: /Create Relationship/i }).first().click();
      await page.locator('#topology-create-title').waitFor({ state: 'visible', timeout: 15000 });

      await page.locator('#topology-from-resource').fill('smf-01');
      await page.getByRole('option', { name: /SMF-01/i }).first().click();
      await page.locator('#topology-to-resource').fill('pcf-01');
      await page.getByRole('option', { name: /PCF-01/i }).first().click();
      /* Submit through the dialog form itself; the PageHeader also carries a
       * "Create Relationship" button that would only re-open the dialog. */
      await page.locator('form button[type="submit"]').first().click();
      await page.waitForURL(/\/topology\//, { timeout: 20000 });
      check('create_workflow_completes', /\/topology\//.test(page.url()), `url=${page.url()}`);
      await context.close();
    }

    /* ============================ E. integrity ============================ */
    check('screenshot_count', screenshots.length === EXPECTED_SCREENSHOT_COUNT, `generated=${screenshots.length}`);

    const seen = new Set();
    const manifest = [];
    let invalid = 0;
    let missing = 0;

    for (const shot of screenshots) {
      if (seen.has(shot.filename)) invalid += 1;
      seen.add(shot.filename);
      if (!existsSync(shot.path)) {
        missing += 1;
        continue;
      }
      const bytes = readFileSync(shot.path);
      const signatureOk = bytes.length > 8
        && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
        && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a;
      const width = bytes.length > 24 ? bytes.readUInt32BE(16) : 0;
      const height = bytes.length > 24 ? bytes.readUInt32BE(20) : 0;
      const sizeOk = bytes.length >= MIN_PNG_BYTES;
      const dimensionsOk = width === shot.viewportWidth && height === shot.viewportHeight;
      const ok = signatureOk && sizeOk && dimensionsOk;
      if (!ok) invalid += 1;
      manifest.push({
        filename: shot.filename,
        route: shot.route,
        viewportWidth: shot.viewportWidth,
        viewportHeight: shot.viewportHeight,
        theme: shot.theme,
        locale: shot.locale,
        fixtureScenario: shot.fixtureScenario,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        sourceCommit: COMMIT,
        captureResult: ok ? 'PASS' : 'FAIL',
        sizeBytes: statSync(shot.path).size,
        imageWidth: width,
        imageHeight: height,
      });
    }

    check('screenshot_png_signature', manifest.every((entry) => entry.captureResult === 'PASS'), 'signature/size/dimensions');
    check('screenshot_unique_filenames', seen.size === screenshots.length, `unique=${seen.size}`);
    check('screenshot_no_missing_files', missing === 0, `missing=${missing}`);

    const expectedNames = new Set(screenshots.map((shot) => shot.filename));
    check('screenshot_matrix_naming', expectedNames.size === EXPECTED_SCREENSHOT_COUNT, `names=${expectedNames.size}`);

    check('browser_console_errors', consoleErrors.length === 0, consoleErrors.slice(0, 5).join(' | '));
    check('browser_page_errors', pageErrors.length === 0, pageErrors.slice(0, 5).join(' | '));

    const unexpected = [...operatorServer.unexpected, ...viewerServer.unexpected];
    unexpectedApi.push(...unexpected);
    check('no_unexpected_api_requests', unexpected.length === 0, unexpected.slice(0, 5).join(' | '));

    writeFileSync(
      join(outDir, 'manifest.json'),
      `${JSON.stringify({
        kind: 'browser-screenshot-manifest',
        browser: 'chromium',
        sourceCommit: COMMIT,
        generatedAt: 'deterministic-fixtures',
        note: 'Rendered against deterministic API fixtures; not a live core-network deployment.',
        expected: EXPECTED_SCREENSHOT_COUNT,
        generated: screenshots.length,
        invalid,
        missing,
        screenshots: manifest,
      }, null, 2)}\n`,
      'utf8',
    );

    console.log(`topology_screenshot_expected=${EXPECTED_SCREENSHOT_COUNT}`);
    console.log(`topology_screenshot_generated=${screenshots.length}`);
    console.log(`topology_screenshot_invalid=${invalid}`);
    console.log(`topology_screenshot_missing=${missing}`);
    console.log('topology_browser_runtime=chromium');
    console.log(`topology_browser_assertions=${checks.length}`);
    console.log(`topology_browser_assertion_failures=${failures.length}`);
    console.log(`topology_browser_console_errors=${consoleErrors.length}`);
    console.log(`topology_browser_page_errors=${pageErrors.length}`);
    console.log(`topology_screenshot_manifest=${join(outDir, 'manifest.json')}`);
    console.log(`topology_visual_screenshot_result=${failures.length === 0 && invalid === 0 && missing === 0 ? 'PASS' : 'FAIL'}`);
  } finally {
    if (browser) await browser.close().catch(() => {});
    await operatorServer.close().catch(() => {});
    await viewerServer.close().catch(() => {});
  }

  if (failures.length > 0) {
    console.error('\nBrowser acceptance failures:');
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log('Stage 2 browser-rendered UI acceptance: PASS');
}

main().catch((error) => {
  console.error('Fatal error in browser acceptance:', error);
  process.exit(1);
});
