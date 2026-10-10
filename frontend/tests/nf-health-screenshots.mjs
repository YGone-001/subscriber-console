#!/usr/bin/env node
/*
 * NF Health browser-rendered UI acceptance.
 *
 * Builds nothing itself: it renders the ALREADY BUILT production SPA
 * (`frontend/dist`) in real Chromium through a deterministic, test-only API
 * fixture adapter, asserts browser-observable behaviour, captures the mandated
 * PNG matrix, verifies screenshot integrity and writes a checksummed manifest.
 *
 * The screenshots demonstrate frontend rendering against deterministic API
 * fixtures - not a live core-network deployment.
 *
 * Usage (from frontend/): node tests/nf-health-screenshots.mjs
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import {
  TARGET_IDS,
  startFixtureServer,
} from './nf-health-fixtures.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const frontendRoot = resolve(here, '..');
const repoRoot = resolve(frontendRoot, '..');
const distDir = resolve(frontendRoot, 'dist');
const outDir = resolve(repoRoot, 'reports', 'ops', 'nf-health-screenshots');

const EXPECTED_SCREENSHOT_COUNT = 26;
const MIN_PNG_BYTES = 8192;

const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  tablet: { width: 768, height: 1024 },
  mobile: { width: 390, height: 844 },
};

const BENIGN_CONSOLE = [
  /Download the React DevTools/i,
  /favicon/i,
];

const checks = [];
const screenshots = [];
const failures = [];
const consoleErrors = [];
const pageErrors = [];

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
    !/\b(?:nf_health|nav_nf_health|eyebrow|inventory)_[a-z0-9_]{2,}\b/.test(text),
    'untranslated key leaked into rendered text',
  );
}

/*
 * Layer-state disclosure contract.
 *
 * Unsupported layers must stay visually and textually distinct from measured
 * healthy layers. The assertion looks for explicit non-healthy vocabulary
 * rather than inferring health from colour alone.
 */
async function assertLayerDisclosure(page, label) {
  const text = await page.locator('body').innerText();
  check(
    `layer_states_present:${label}`,
    /Measured|Degraded|Unhealthy|Stale|Healthy/i.test(text) &&
      /Not configured|Unknown|unsupported|Missing metrics|not zeros|no process claim|no reachability claim|no KPI claim/i.test(text),
    'measured and unmeasured layer evidence vocabulary both rendered',
  );
  check(
    `semantic_separation_copy:${label}`,
    /not (operational |protocol |process )?health|does not mean|不等于|不代表/i.test(text) ||
      /HTTP 200|process active|missing metric/i.test(text),
    'hard semantic separations disclosed',
  );
}

async function capture(page, filename, meta) {
  const path = join(outDir, filename);
  await page.screenshot({ path, animations: 'disabled', caret: 'hide', scale: 'css' });
  screenshots.push({ filename, path, ...meta });
}

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
  const listRoute = '/nf-health';
  const detailRoute = `/nf-health/${TARGET_IDS.amf}`;

  try {
    /* ======================== A. NF Health list page ======================= */
    for (const [sizeName, viewport] of Object.entries(VIEWPORTS)) {
      for (const theme of ['light', 'dark']) {
        const { context, page } = await newSession(browser, { ...viewport, theme, locale: 'en', session: 'operator' });
        await page.goto(`${origin}${listRoute}`, { waitUntil: 'domcontentloaded' });
        await settle(page, 'Add Monitoring Target');

        check(`auth_gate_allows_session:${sizeName}-${theme}`, !page.url().includes('/login'), `url=${page.url()}`);
        check(`app_shell_visible:${sizeName}-${theme}`, await page.locator('#xcloud-primary-sidebar').isVisible(), 'sidebar');
        check(`nf_health_title_visible:${sizeName}-${theme}`, await page.locator('h1').first().isVisible(), 'page title');
        const bodyText = await page.locator('body').innerText();
        check(`fixture_targets_render:${sizeName}-${theme}`, /AMF core-01 metrics/.test(bodyText) && /SMF core-01 metrics/.test(bodyText), 'target names');
        check(`collection_mode_render:${sizeName}-${theme}`, /scheduled/i.test(bodyText) && /manual/i.test(bodyText), 'collection modes');
        check(`freshness_render:${sizeName}-${theme}`, /last measured|Last measured/i.test(bodyText), 'freshness column');
        check(`theme_applied:${sizeName}-${theme}`, (await page.evaluate(() => document.documentElement.dataset.theme)) === theme, theme);
        await assertNoRawKeys(page, `${sizeName}-${theme}`);
        await assertNoHorizontalOverflow(page, `${sizeName}-${theme}`);
        await assertLayerDisclosure(page, `list-${sizeName}-${theme}`);

        await capture(page, `nf-health-list-${sizeName}-${theme}.png`, {
          route: listRoute,
          viewportWidth: viewport.width,
          viewportHeight: viewport.height,
          theme,
          locale: 'en',
          fixtureScenario: 'nf-health-list-overview',
          session: 'operator',
        });
        await context.close();
      }
    }

    /* ===================== B. NF Health target detail ====================== */
    for (const [sizeName, viewport] of Object.entries(VIEWPORTS)) {
      for (const theme of ['light', 'dark']) {
        const { context, page } = await newSession(browser, { ...viewport, theme, locale: 'en', session: 'operator' });
        await page.goto(`${origin}${detailRoute}`, { waitUntil: 'domcontentloaded' });
        await settle(page, 'AMF core-01 metrics');

        const text = await page.locator('body').innerText();
        check(`detail_target_profile:${sizeName}-${theme}`, /AMF core-01 metrics/.test(text), 'target name');
        check(`detail_layers_section:${sizeName}-${theme}`, /L1|Process/i.test(text) && /L2|Interface/i.test(text) && /L3|KPI|Service/i.test(text), 'three layers');
        check(`detail_metrics_section:${sizeName}-${theme}`, /amf_session_active|ran_ue_active/i.test(text), 'supported metrics');
        check(`detail_collect_action:${sizeName}-${theme}`, /Collect Now/i.test(text), 'manual collection trigger');
        await assertNoRawKeys(page, `detail-${sizeName}-${theme}`);
        await assertNoHorizontalOverflow(page, `detail-${sizeName}-${theme}`);
        await assertLayerDisclosure(page, `detail-${sizeName}-${theme}`);

        await capture(page, `nf-health-detail-${sizeName}-${theme}.png`, {
          route: detailRoute,
          viewportWidth: viewport.width,
          viewportHeight: viewport.height,
          theme,
          locale: 'en',
          fixtureScenario: 'nf-health-target-detail',
          session: 'operator',
        });
        await context.close();
      }
    }

    /* ========================= C. interactive dialogs ====================== */
    /*
     * Required acceptance matrix for the create dialog: Desktop light,
     * Desktop dark, Mobile light, Mobile dark, Tablet light. Geometry checks
     * assert the actual dialog heading, not only the outer container.
     */
    const dialogCases = [
      { name: 'create', sizeName: 'desktop', viewport: VIEWPORTS.desktop, theme: 'light', route: listRoute, trigger: /Add Monitoring Target/i },
      { name: 'create', sizeName: 'desktop', viewport: VIEWPORTS.desktop, theme: 'dark', route: listRoute, trigger: /Add Monitoring Target/i },
      { name: 'create', sizeName: 'mobile', viewport: VIEWPORTS.mobile, theme: 'light', route: listRoute, trigger: /Add Monitoring Target/i },
      { name: 'create', sizeName: 'mobile', viewport: VIEWPORTS.mobile, theme: 'dark', route: listRoute, trigger: /Add Monitoring Target/i },
      { name: 'create', sizeName: 'tablet', viewport: VIEWPORTS.tablet, theme: 'light', route: listRoute, trigger: /Add Monitoring Target/i },
      { name: 'collect', sizeName: 'desktop', viewport: VIEWPORTS.desktop, theme: 'light', route: detailRoute, trigger: /Collect Now/i },
      { name: 'collect', sizeName: 'desktop', viewport: VIEWPORTS.desktop, theme: 'dark', route: detailRoute, trigger: /Collect Now/i },
      { name: 'collect', sizeName: 'mobile', viewport: VIEWPORTS.mobile, theme: 'light', route: detailRoute, trigger: /Collect Now/i },
    ];

    for (const testCase of dialogCases) {
      const { context, page } = await newSession(browser, {
        ...testCase.viewport,
        theme: testCase.theme,
        locale: 'en',
        session: 'operator',
      });
      await page.goto(`${origin}${testCase.route}`, { waitUntil: 'domcontentloaded' });
      await settle(page, testCase.name === 'create' ? 'Add Monitoring Target' : 'AMF core-01 metrics');

      await page.getByRole('button', { name: testCase.trigger }).first().click();

      if (testCase.name === 'create') {
        await page.getByRole('dialog').waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
        const dialogText = await page.locator('body').innerText();
        check(
          `create_dialog_fields:${testCase.sizeName}-${testCase.theme}`,
          /candidate/i.test(dialogText) && /metrics endpoint|Metrics endpoint/i.test(dialogText) && /service unit|Service unit/i.test(dialogText),
          'candidate, metrics endpoint and service unit fields',
        );
        check(
          `create_dialog_boundary:${testCase.sizeName}-${testCase.theme}`,
          /does not create|never auto|Discovery candidate|not operational health|http_metrics/i.test(dialogText),
          'target references an existing candidate only',
        );

        /*
         * Heading-level geometry: the actual dialog heading must start below
         * the shell chrome region, remain fully inside the viewport, and the
         * dialog description must stay reachable below it.
         */
        const geometry = await page.evaluate(() => {
          const chrome = document.querySelector('.nav-breadcrumbs-bar') || document.querySelector('.app-header');
          const dialog = document.querySelector('.modal-content') || document.querySelector('[role="dialog"]');
          const heading = dialog ? dialog.querySelector('h2, [role="heading"]') : null;
          const intro = dialog ? dialog.querySelector('p') : null;
          const actions = dialog ? Array.from(dialog.querySelectorAll('button')) : [];
          const rect = (el) => (el ? el.getBoundingClientRect() : null);
          const headingRect = rect(heading);
          const dialogRect = rect(dialog);
          const introRect = rect(intro);
          const actionRects = actions.map((el) => el.getBoundingClientRect());
          return {
            chromeBottom: chrome ? Math.round(chrome.getBoundingClientRect().bottom) : 0,
            headingTop: headingRect ? Math.round(headingRect.top) : null,
            headingBottom: headingRect ? Math.round(headingRect.bottom) : null,
            headingText: heading ? heading.textContent.trim() : '',
            introTop: introRect ? Math.round(introRect.top) : null,
            dialogTop: dialogRect ? Math.round(dialogRect.top) : null,
            dialogBottom: dialogRect ? Math.round(dialogRect.bottom) : null,
            actionReachable: actionRects.some((r) => r.bottom > 0 && r.top < window.innerHeight),
            docScroll: document.documentElement.scrollWidth,
            bodyScroll: document.body.scrollWidth,
            inner: window.innerWidth,
            viewport: window.innerHeight,
          };
        });

        check(
          `dialog_heading_visible:${testCase.sizeName}-${testCase.theme}`,
          geometry.headingTop !== null && geometry.headingText.length > 0 && geometry.headingTop >= geometry.chromeBottom - 1,
          JSON.stringify(geometry),
        );
        check(
          `dialog_fits_viewport:${testCase.name}-${testCase.sizeName}-${testCase.theme}`,
          geometry.dialogTop !== null && geometry.dialogTop >= 0 && geometry.dialogBottom <= geometry.viewport + 1 && geometry.headingBottom <= geometry.viewport + 1,
          JSON.stringify(geometry),
        );
        check(
          `dialog_description_accessible:${testCase.sizeName}-${testCase.theme}`,
          geometry.introTop !== null && geometry.introTop >= geometry.chromeBottom - 1,
          JSON.stringify(geometry),
        );
        check(
          `dialog_actions_reachable:${testCase.sizeName}-${testCase.theme}`,
          geometry.actionReachable === true,
          JSON.stringify(geometry),
        );
        check(
          `dialog_no_horizontal_overflow:${testCase.sizeName}-${testCase.theme}`,
          geometry.docScroll <= geometry.inner + 1 && geometry.bodyScroll <= geometry.inner + 1,
          JSON.stringify(geometry),
        );
      } else {
        /*
         * Collect Now is an immediate bounded read-only action, not a modal
         * workflow. The acceptance asserts the safety disclosure stays on the
         * page and that the page itself does not overflow after the action.
         */
        await page.waitForTimeout(250);
        const pageText = await page.locator('body').innerText();
        check(
          `collect_dialog_boundary:${testCase.sizeName}-${testCase.theme}`,
          /read-only|does not restart|no process control|never auto-retr/i.test(pageText),
          'collection is read-only and never auto-retries',
        );
        const geometry = await page.evaluate(() => ({
          docScroll: document.documentElement.scrollWidth,
          bodyScroll: document.body.scrollWidth,
          inner: window.innerWidth,
          viewport: window.innerHeight,
        }));
        check(
          `dialog_fits_viewport:${testCase.name}-${testCase.sizeName}-${testCase.theme}`,
          geometry.docScroll <= geometry.inner + 1 && geometry.bodyScroll <= geometry.inner + 1,
          JSON.stringify(geometry),
        );
      }

      await assertNoHorizontalOverflow(page, `dialog-${testCase.name}-${testCase.sizeName}-${testCase.theme}`);
      await capture(page, `nf-health-${testCase.name}-${testCase.sizeName}-${testCase.theme}.png`, {
        route: testCase.route,
        viewportWidth: testCase.viewport.width,
        viewportHeight: testCase.viewport.height,
        theme: testCase.theme,
        locale: 'en',
        fixtureScenario: testCase.name === 'create' ? 'create-target-dialog' : 'collect-now-dialog',
        session: 'operator',
      });
      await context.close();
    }

    /* ==================== D. locale and read-only sessions ================= */
    {
      const { context, page } = await newSession(browser, { ...VIEWPORTS.desktop, theme: 'light', locale: 'zh', session: 'operator' });
      await page.goto(`${origin}${listRoute}`, { waitUntil: 'domcontentloaded' });
      await settle(page);
      const text = await page.locator('body').innerText();
      check('chinese_locale_labels', /[一-鿿]/.test(text), 'zh labels');
      check('chinese_locale_html_lang', (await page.evaluate(() => document.documentElement.lang)) === 'zh-CN', 'html lang');
      await assertNoRawKeys(page, 'zh-list');
      await assertNoHorizontalOverflow(page, 'zh-list');
      await capture(page, 'nf-health-list-zh-desktop-light.png', {
        route: listRoute,
        viewportWidth: VIEWPORTS.desktop.width,
        viewportHeight: VIEWPORTS.desktop.height,
        theme: 'light',
        locale: 'zh',
        fixtureScenario: 'nf-health-list-locale-zh',
        session: 'operator',
      });
      await context.close();
    }

    {
      const { context, page } = await newSession(browser, { ...VIEWPORTS.desktop, theme: 'dark', locale: 'zh', session: 'operator' });
      await page.goto(`${origin}${detailRoute}`, { waitUntil: 'domcontentloaded' });
      await settle(page);
      await assertNoRawKeys(page, 'zh-detail');
      await assertNoHorizontalOverflow(page, 'zh-detail');
      await capture(page, 'nf-health-detail-zh-desktop-dark.png', {
        route: detailRoute,
        viewportWidth: VIEWPORTS.desktop.width,
        viewportHeight: VIEWPORTS.desktop.height,
        theme: 'dark',
        locale: 'zh',
        fixtureScenario: 'nf-health-detail-locale-zh',
        session: 'operator',
      });
      await context.close();
    }

    {
      const { context, page } = await newSession(browser, { ...VIEWPORTS.desktop, theme: 'light', locale: 'en', session: 'viewer' });
      await page.goto(`${viewerServer.origin}${listRoute}`, { waitUntil: 'domcontentloaded' });
      await settle(page);
      const text = await page.locator('body').innerText();
      check('viewer_read_only_controls', !/Add Monitoring Target/i.test(text), 'no mutation controls');
      check('viewer_sees_targets', /AMF core-01 metrics/.test(text), 'readable targets');
      await assertNoHorizontalOverflow(page, 'viewer-list');
      await capture(page, 'nf-health-viewer-list-desktop-light.png', {
        route: listRoute,
        viewportWidth: VIEWPORTS.desktop.width,
        viewportHeight: VIEWPORTS.desktop.height,
        theme: 'light',
        locale: 'en',
        fixtureScenario: 'nf-health-viewer-readonly',
        session: 'viewer',
      });
      await context.close();
    }

    /* ============ E. sidebar navigation and comparison pages ============== */
    {
      const { context, page } = await newSession(browser, { ...VIEWPORTS.desktop, theme: 'light', locale: 'en', session: 'operator' });
      await page.goto(`${origin}/inventory`, { waitUntil: 'domcontentloaded' });
      await settle(page);
      await page.locator('#xcloud-primary-sidebar').getByRole('link', { name: /NF Health/i }).first().click();
      await page.waitForURL(/\/nf-health$/, { timeout: 15000 });
      await settle(page, 'Add Monitoring Target');
      check('sidebar_nf_health_navigation', page.url().endsWith('/nf-health'), `url=${page.url()}`);
      await context.close();
    }

    const comparisonCases = [
      { route: '/inventory', slug: 'inventory-list', scenario: 'inventory-list', theme: 'light' },
      { route: '/topology', slug: 'topology-list', scenario: 'topology-list', theme: 'dark' },
      { route: '/discovery', slug: 'discovery-list', scenario: 'discovery-list', theme: 'light' },
    ];

    for (const comparison of comparisonCases) {
      const { context, page } = await newSession(browser, {
        ...VIEWPORTS.desktop,
        theme: comparison.theme,
        locale: 'en',
        session: 'operator',
      });
      await page.goto(`${origin}${comparison.route}`, { waitUntil: 'domcontentloaded' });
      await settle(page);

      check(
        `comparison_page_rendered:${comparison.slug}`,
        (await page.locator('.layout-root').isVisible()) && !page.url().includes('/login'),
        comparison.route,
      );
      await assertNoRawKeys(page, comparison.slug);
      await assertNoHorizontalOverflow(page, comparison.slug);

      await capture(page, `${comparison.slug}-desktop-${comparison.theme}.png`, {
        route: comparison.route,
        viewportWidth: VIEWPORTS.desktop.width,
        viewportHeight: VIEWPORTS.desktop.height,
        theme: comparison.theme,
        locale: 'en',
        fixtureScenario: comparison.scenario,
        session: 'operator',
      });
      await context.close();
    }

    /* ============================ F. integrity ============================ */
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
        session: shot.session,
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
    check('screenshot_matrix_naming', seen.size === EXPECTED_SCREENSHOT_COUNT, `names=${seen.size}`);
    check('browser_console_errors', consoleErrors.length === 0, consoleErrors.slice(0, 5).join(' | '));
    check('browser_page_errors', pageErrors.length === 0, pageErrors.slice(0, 5).join(' | '));

    const unexpected = [...operatorServer.unexpected, ...viewerServer.unexpected];
    check('no_unexpected_api_requests', unexpected.length === 0, unexpected.slice(0, 5).join(' | '));

    writeFileSync(
      join(outDir, 'manifest.json'),
      `${JSON.stringify({
        kind: 'browser-screenshot-manifest',
        module: 'nf-health',
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

    const failed = failures.length;
    for (const item of checks) {
      console.log(`${item.ok ? 'PASS' : 'FAIL'} ${item.id}${item.detail ? ` ${item.detail}` : ''}`);
    }
    console.log(`\nnf_health_screenshot_expected=${EXPECTED_SCREENSHOT_COUNT}`);
    console.log(`nf_health_screenshot_generated=${screenshots.length}`);
    console.log(`nf_health_screenshot_invalid=${invalid}`);
    console.log(`nf_health_screenshot_manifest=${join(outDir, 'manifest.json')}`);
    console.log(`NF Health screenshot acceptance: ${failed === 0 ? 'PASS' : 'FAIL'} (${checks.length - failed}/${checks.length})`);

    if (failed > 0) process.exitCode = 1;
  } finally {
    await browser.close();
    await operatorServer.close();
    await viewerServer.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
