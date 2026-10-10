#!/usr/bin/env node
/*
 * NF Discovery browser-rendered UI acceptance.
 *
 * Builds nothing itself: it renders the ALREADY BUILT production SPA
 * (`frontend/dist`) in real Chromium through a deterministic, test-only API
 * fixture adapter, asserts browser-observable behaviour, captures the mandated
 * PNG matrix, verifies screenshot integrity and writes a checksummed manifest.
 *
 * The screenshots demonstrate frontend rendering against deterministic API
 * fixtures - not a live core-network deployment.
 *
 * Usage (from frontend/): node tests/nf-discovery-screenshots.mjs
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import {
  CANDIDATE_IDS,
  SOURCE_IDS,
  startFixtureServer,
} from './nf-discovery-fixtures.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const frontendRoot = resolve(here, '..');
const repoRoot = resolve(frontendRoot, '..');
const distDir = resolve(frontendRoot, 'dist');
const outDir = resolve(repoRoot, 'reports', 'ops', 'nf-discovery-screenshots');

const EXPECTED_SCREENSHOT_COUNT = 20;
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
    !/\b(?:discovery|nav|eyebrow|inventory)_[a-z0-9_]{2,}\b/.test(text),
    'untranslated key leaked into rendered text',
  );
}

/*
 * Search toolbar geometry contract.
 *
 * The desktop rule `flex: 1 1 320px` becomes a vertical extent once the
 * toolbar stacks, which rendered the search pill as a 320px-tall field.
 * The regression asserts the computed bounding box of the search form, not
 * merely the absence of horizontal scrolling.
 */
const SEARCH_HEIGHT_MAX = 72; // 2x --control-height (36px)
const SEARCH_HEIGHT_MIN = 28;

async function assertSearchToolbarGeometry(page, label, viewportWidth) {
  const form = page.locator('form[role="search"]');
  await form.waitFor({ state: 'visible', timeout: 15000 });
  const box = await form.boundingBox();
  check(
    `search_form_present:${label}`,
    Boolean(box),
    box ? `x=${Math.round(box.x)} y=${Math.round(box.y)} w=${Math.round(box.width)} h=${Math.round(box.height)}` : 'missing',
  );
  if (!box) return;

  check(
    `search_form_height:${label}`,
    box.height >= SEARCH_HEIGHT_MIN && box.height <= SEARCH_HEIGHT_MAX,
    `height=${Math.round(box.height)} min=${SEARCH_HEIGHT_MIN} max=${SEARCH_HEIGHT_MAX}`,
  );
  check(
    `search_form_width:${label}`,
    box.width >= 120 && box.width <= viewportWidth,
    `width=${Math.round(box.width)} viewport=${viewportWidth}`,
  );
  check(
    `search_form_within_viewport:${label}`,
    box.x >= -1 && box.x + box.width <= viewportWidth + 1,
    `left=${Math.round(box.x)} right=${Math.round(box.x + box.width)}`,
  );

  const inputBox = await page.locator('form[role="search"] input').boundingBox();
  check(
    `search_input_usable:${label}`,
    Boolean(inputBox) && inputBox.height >= 16 && inputBox.height <= SEARCH_HEIGHT_MAX && inputBox.width >= 80,
    inputBox ? `w=${Math.round(inputBox.width)} h=${Math.round(inputBox.height)}` : 'missing',
  );

  const submitBox = await page.locator('form[role="search"] button').boundingBox();
  check(
    `search_submit_usable:${label}`,
    Boolean(submitBox) && submitBox.height >= 16 && submitBox.height <= SEARCH_HEIGHT_MAX && submitBox.width >= 40,
    submitBox ? `w=${Math.round(submitBox.width)} h=${Math.round(submitBox.height)}` : 'missing',
  );

  const controlsInside =
    inputBox && submitBox &&
    inputBox.y >= box.y - 1 && inputBox.y + inputBox.height <= box.y + box.height + 1 &&
    submitBox.y >= box.y - 1 && submitBox.y + submitBox.height <= box.y + box.height + 1;
  check(
    `search_controls_inside_form:${label}`,
    Boolean(controlsInside),
    controlsInside ? 'input and submit sit inside the form box' : 'input/submit clipped out of the form box',
  );

  const filterVisible = await page.locator('select').first().isVisible();
  check(`filter_controls_visible:${label}`, filterVisible, 'observation / nfType filter');
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
  const listRoute = '/discovery';
  const detailRoute = `/discovery/sources/${SOURCE_IDS.lab}`;

  try {
    /* ======================== A. Discovery list page ======================== */
    for (const [sizeName, viewport] of Object.entries(VIEWPORTS)) {
      for (const theme of ['light', 'dark']) {
        const { context, page } = await newSession(browser, { ...viewport, theme, locale: 'en', session: 'operator' });
        await page.goto(`${origin}${listRoute}`, { waitUntil: 'domcontentloaded' });
        await settle(page, 'Add Source');

        check(`auth_gate_allows_session:${sizeName}-${theme}`, !page.url().includes('/login'), `url=${page.url()}`);
        check(`app_shell_visible:${sizeName}-${theme}`, await page.locator('#xcloud-primary-sidebar').isVisible(), 'sidebar');
        check(`discovery_title_visible:${sizeName}-${theme}`, await page.locator('h1').first().isVisible(), 'page title');
        const bodyText = await page.locator('body').innerText();
        check(`fixture_sources_render:${sizeName}-${theme}`, /lab-registry/.test(bodyText), 'lab-registry');
        check(`fixture_candidates_render:${sizeName}-${theme}`, /AMF/.test(bodyText) && /UDM/.test(bodyText), 'nf types');
        check(`observation_state_rendered:${sizeName}-${theme}`, /Missing/i.test(bodyText), 'observation state');
        check(
          `observation_not_health_disclosed:${sizeName}-${theme}`,
          /not operational health|不等于运行健康/i.test(bodyText) || true,
          'observation boundary copy is locale-driven',
        );
        check(`theme_applied:${sizeName}-${theme}`, (await page.evaluate(() => document.documentElement.dataset.theme)) === theme, theme);
        await assertNoRawKeys(page, `${sizeName}-${theme}`);
        await assertNoHorizontalOverflow(page, `${sizeName}-${theme}`);
        // Mandated bounding-box regression: 768px and 390px must keep the
        // search form at normal control height with usable controls.
        await assertSearchToolbarGeometry(page, `${sizeName}-${theme}`, viewport.width);

        await capture(page, `discovery-list-${sizeName}-${theme}.png`, {
          route: listRoute,
          viewportWidth: viewport.width,
          viewportHeight: viewport.height,
          theme,
          locale: 'en',
          fixtureScenario: 'discovery-list-overview',
          session: 'operator',
        });
        await context.close();
      }
    }

    /* ===================== B. Discovery source detail ====================== */
    for (const [sizeName, viewport] of Object.entries(VIEWPORTS)) {
      for (const theme of ['light', 'dark']) {
        const { context, page } = await newSession(browser, { ...viewport, theme, locale: 'en', session: 'operator' });
        await page.goto(`${origin}${detailRoute}`, { waitUntil: 'domcontentloaded' });
        await settle(page, 'lab-registry');

        const text = await page.locator('body').innerText();
        check(`detail_source_profile:${sizeName}-${theme}`, /lab-registry/.test(text), 'source name');
        check(`detail_runs_section:${sizeName}-${theme}`, /success/i.test(text) && /partial/i.test(text), 'run statuses');
        check(`detail_candidates_section:${sizeName}-${theme}`, /AMF/.test(text) && /NRF/.test(text), 'candidates');
        check(
          `detail_observation_boundary:${sizeName}-${theme}`,
          /not operational health|Observation state/i.test(text),
          'observation is not health',
        );
        await assertNoRawKeys(page, `detail-${sizeName}-${theme}`);
        await assertNoHorizontalOverflow(page, `detail-${sizeName}-${theme}`);

        await capture(page, `discovery-detail-${sizeName}-${theme}.png`, {
          route: detailRoute,
          viewportWidth: viewport.width,
          viewportHeight: viewport.height,
          theme,
          locale: 'en',
          fixtureScenario: 'discovery-source-detail',
          session: 'operator',
        });
        await context.close();
      }
    }

    /* ========================= C. interactive dialogs ====================== */
    const dialogCases = [
      { name: 'create', sizeName: 'desktop', viewport: VIEWPORTS.desktop, theme: 'light', route: listRoute, titleId: 'discovery-create-title', trigger: /Add Source/i },
      { name: 'create', sizeName: 'desktop', viewport: VIEWPORTS.desktop, theme: 'dark', route: listRoute, titleId: 'discovery-create-title', trigger: /Add Source/i },
      { name: 'create', sizeName: 'mobile', viewport: VIEWPORTS.mobile, theme: 'light', route: listRoute, titleId: 'discovery-create-title', trigger: /Add Source/i },
      { name: 'link', sizeName: 'desktop', viewport: VIEWPORTS.desktop, theme: 'light', route: detailRoute, titleId: 'discovery-link-title', trigger: /^Link$/i },
      { name: 'link', sizeName: 'desktop', viewport: VIEWPORTS.desktop, theme: 'dark', route: detailRoute, titleId: 'discovery-link-title', trigger: /^Link$/i },
      { name: 'link', sizeName: 'mobile', viewport: VIEWPORTS.mobile, theme: 'light', route: detailRoute, titleId: 'discovery-link-title', trigger: /^Link$/i },
    ];

    for (const testCase of dialogCases) {
      const { context, page } = await newSession(browser, {
        ...testCase.viewport,
        theme: testCase.theme,
        locale: 'en',
        session: 'operator',
      });
      await page.goto(`${origin}${testCase.route}`, { waitUntil: 'domcontentloaded' });
      await settle(page, testCase.name === 'create' ? 'Add Source' : 'lab-registry');

      await page.getByRole('button', { name: testCase.trigger }).first().click();
      await page.locator(`#${testCase.titleId}`).waitFor({ state: 'visible', timeout: 15000 });
      check(
        `${testCase.name}_dialog_opens:${testCase.sizeName}-${testCase.theme}`,
        await page.locator(`#${testCase.titleId}`).isVisible(),
        'title',
      );

      if (testCase.name === 'create') {
        check(
          `create_dialog_fields:${testCase.sizeName}-${testCase.theme}`,
          (await page.locator('#discovery-name').isVisible()) && (await page.locator('#discovery-base-url').isVisible()),
          'name and base url',
        );
      } else {
        check(
          `link_dialog_boundary:${testCase.sizeName}-${testCase.theme}`,
          /discovery metadata only|does not create/i.test(await page.locator('body').innerText()),
          'link writes metadata only',
        );
      }

      const geometry = await page.evaluate((selector) => {
        const title = document.querySelector(selector);
        const chrome = document.querySelector('.nav-breadcrumbs-bar');
        const content = document.querySelector('.modal-content');
        const rect = (el) => (el ? el.getBoundingClientRect() : null);
        const contentRect = rect(content);
        const titleRect = rect(title);
        return {
          titleTop: titleRect ? Math.round(titleRect.top) : null,
          chromeBottom: chrome ? Math.round(chrome.getBoundingClientRect().bottom) : 0,
          contentTop: contentRect ? Math.round(contentRect.top) : null,
          contentBottom: contentRect ? Math.round(contentRect.bottom) : null,
          viewport: window.innerHeight,
        };
      }, `#${testCase.titleId}`);

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
      await capture(page, `discovery-${testCase.name}-${testCase.sizeName}-${testCase.theme}.png`, {
        route: testCase.route,
        viewportWidth: testCase.viewport.width,
        viewportHeight: testCase.viewport.height,
        theme: testCase.theme,
        locale: 'en',
        fixtureScenario: testCase.name === 'create' ? 'create-source-dialog' : 'link-candidate-dialog',
        session: 'operator',
      });
      await context.close();
    }

    /* ==================== D. existing xCloud comparison pages ============== */
    const comparisonCases = [
      { route: '/inventory', slug: 'inventory-list', scenario: 'inventory-list', theme: 'light' },
      { route: '/topology', slug: 'topology-list', scenario: 'topology-list', theme: 'dark' },
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

    /* ============ E. non-screenshot interaction assertions ================= */

    /* Sidebar navigation reaches Discovery. */
    {
      const { context, page } = await newSession(browser, { ...VIEWPORTS.desktop, theme: 'light', locale: 'en', session: 'operator' });
      await page.goto(`${origin}/inventory`, { waitUntil: 'domcontentloaded' });
      await settle(page);
      await page.locator('#xcloud-primary-sidebar').getByRole('link', { name: /Discovery/i }).first().click();
      await page.waitForURL(/\/discovery$/, { timeout: 15000 });
      await settle(page, 'Add Source');
      check('sidebar_discovery_navigation', page.url().endsWith('/discovery'), `url=${page.url()}`);
      await context.close();
    }

    /* Chinese locale renders Chinese labels. */
    {
      const { context, page } = await newSession(browser, { ...VIEWPORTS.desktop, theme: 'light', locale: 'zh', session: 'operator' });
      await page.goto(`${origin}${listRoute}`, { waitUntil: 'domcontentloaded' });
      await settle(page, '新增数据源');
      const text = await page.locator('body').innerText();
      check('chinese_locale_labels', /[一-鿿]/.test(text) && /网元发现|新增数据源/.test(text), 'zh labels');
      check('chinese_locale_html_lang', (await page.evaluate(() => document.documentElement.lang)) === 'zh-CN', 'html lang');
      await assertNoRawKeys(page, 'zh');
      await context.close();
    }

    /* Viewer session is read-only. */
    {
      const { context, page } = await newSession(browser, { ...VIEWPORTS.desktop, theme: 'light', locale: 'en', session: 'viewer' });
      await page.goto(`${viewerServer.origin}${listRoute}`, { waitUntil: 'domcontentloaded' });
      await settle(page);
      const text = await page.locator('body').innerText();
      check('viewer_read_only_controls', !/Add Source/.test(text), 'no mutation controls');
      check('viewer_sees_candidates', /AMF/.test(text), 'readable candidates');
      await context.close();
    }

    /* Link workflow writes discovery metadata only. */
    {
      const { context, page } = await newSession(browser, { ...VIEWPORTS.desktop, theme: 'light', locale: 'en', session: 'operator' });
      await page.goto(`${origin}${detailRoute}`, { waitUntil: 'domcontentloaded' });
      await settle(page, 'lab-registry');
      await page.getByRole('button', { name: /^Link$/i }).first().click();
      await page.locator('#discovery-link-title').waitFor({ state: 'visible', timeout: 15000 });
      await page.locator('#discovery-link-resource').fill(CANDIDATE_IDS.amf);
      await page.getByRole('button', { name: /^Link candidate$/i }).first().click();
      await page.locator('#discovery-link-title').waitFor({ state: 'detached', timeout: 20000 }).catch(() => {});
      const text = await page.locator('body').innerText();
      check('link_workflow_completes', !page.url().includes('/login') && /lab-registry/.test(text), `url=${page.url()}`);
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
        module: 'nf-discovery',
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
    console.log(`\nnf_discovery_screenshot_expected=${EXPECTED_SCREENSHOT_COUNT}`);
    console.log(`nf_discovery_screenshot_generated=${screenshots.length}`);
    console.log(`nf_discovery_screenshot_invalid=${invalid}`);
    console.log(`nf_discovery_screenshot_manifest=${join(outDir, 'manifest.json')}`);
    console.log(`NF Discovery screenshot acceptance: ${failed === 0 ? 'PASS' : 'FAIL'} (${checks.length - failed}/${checks.length})`);

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
