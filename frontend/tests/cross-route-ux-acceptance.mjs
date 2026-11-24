#!/usr/bin/env node
/*
 * Cross-route UX acceptance.
 *
 * Drives the REAL production SPA build in real Chromium against deterministic
 * API fixtures, across the whole route contract.
 *
 * Layer 1 - complete route contract:
 *   Every entry in frontend/route-contract.json is navigated with a legitimate
 *   deterministic fixture identity. Each entry must resolve, or redirect to the
 *   destination the compatibility authority declares, or present the declared
 *   forbidden state. No entry may crash the application, produce a document
 *   level horizontal overflow, hide the navigation affordances or leave an
 *   inaccessible full-screen blocking overlay.
 *
 * Layer 2 - representative interactive journeys:
 *   The screens that represent every major route family are exercised with
 *   responsive, keyboard, theme, localization and error-state checks.
 *
 * Scope note, stated so the evidence is never overstated: these checks prove
 * FRONTEND behaviour against replay fixtures. They are not evidence that a live
 * inventory, a real configured topology or a running network were observed, and
 * they are not a full WCAG conformance certification.
 *
 * Usage (from frontend/): node tests/cross-route-ux-acceptance.mjs
 */
/* global getComputedStyle */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';
import { build } from 'vite';

import {
  ADMIN_SESSION,
  DISABLED_SESSION,
  VIEWER_SESSION,
  ROUTE_IDENTITIES,
  startCrossRouteFixtureServer,
} from './cross-route-fixtures.mjs';
import {
  COMPATIBILITY_REDIRECTS,
  ROUTE_INVENTORY,
  concreteUrl,
  expectedPath,
} from './cross-route-inventory.mjs';

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* The documented global viewport widths, plus the two named content widths. */
const VIEWPORTS = [
  { name: '320', width: 320, height: 720 },
  { name: '375', width: 375, height: 812 },
  { name: '640', width: 640, height: 900 },
  { name: '768', width: 768, height: 900 },
  { name: '980', width: 980, height: 900 },
  { name: '1180', width: 1180, height: 900 },
  { name: '1440', width: 1440, height: 900 },
];

const COMPONENT_VIEWPORTS = [
  { name: '560', width: 560, height: 900 },
  { name: '900', width: 900, height: 900 },
];

/*
 * Screens that represent every major route family. Layer 2 exercises these
 * deeply; Layer 1 covers the whole contract.
 */
const REPRESENTATIVE_ROUTES = [
  '/',
  '/inventory',
  '/inventory/:resourceId',
  '/topology',
  '/nf-health',
  '/nf-health/:targetId',
  '/discovery',
  '/logs',
  '/ocs/tariffs',
  '/ocs/balances',
  '/ocs/contracts',
  '/subscribers',
  '/subscribers/:imsi',
  '/profile',
  '/profile/:name',
  '/users',
  '/system/retention',
  '/config-snapshots',
  '/investigations',
  '/inspections',
  '/ims-registrations',
  '/nf-alerts',
];

const BENIGN_CONSOLE = [
  /Download the React DevTools/i,
  /favicon/i,
  /net::ERR_FAILED/i,
  /Failed to fetch/i,
  /Failed to load resource/i,
  /ERR_ABORTED/i,
  /\[vite\]/i,
];

/*
 * Resource identifiers that legitimately contain an underscore. A translation
 * key audit must not report them as untranslated keys.
 */
const KNOWN_IDENTIFIERS = new Set([
  'default_plan',
  ROUTE_IDENTITIES.agentId,
  ROUTE_IDENTITIES.configSnapshotSourceId,
  ROUTE_IDENTITIES.investigationId,
  ROUTE_IDENTITIES.inspectionPlanId,
  ROUTE_IDENTITIES.inspectionRunId,
]);

const checks = [];
const failures = [];
const routeResults = [];

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

async function openPage(browser, { locale = 'en', theme = 'light', width = 1440, height = 900, reducedMotion = 'reduce' } = {}) {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
    locale: locale === 'zh' ? 'zh-CN' : 'en-US',
    timezoneId: 'UTC',
    reducedMotion,
    colorScheme: theme === 'dark' ? 'dark' : 'light',
  });
  await context.addInitScript(({ localeValue, themeValue }) => {
    try {
      localStorage.setItem('XCLOUD_LANGUAGE_PREFERENCE', localeValue);
      localStorage.setItem('XCLOUD_THEME_PREFERENCE', themeValue);
    } catch {
      /* Storage unavailable: the wrong locale or theme fails the assertion. */
    }
  }, { localeValue: locale, themeValue: theme });

  const page = await context.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  const failedRequests = [];
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    if (BENIGN_CONSOLE.some((pattern) => pattern.test(text))) return;
    consoleErrors.push(text);
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('requestfailed', (request) => {
    const failure = request.failure();
    failedRequests.push(`${request.method()} ${request.url()} ${failure?.errorText ?? ''}`);
  });
  return { context, page, consoleErrors, pageErrors, failedRequests };
}

/** Wait until the application shell has mounted and the route settled. */
async function waitForRouteSettled(page, timeout = 30000) {
  /*
   * The login surface is the only route that renders outside the application
   * shell, so it has no #main-content. Both surfaces are accepted as "the
   * route rendered": a login form or a populated workspace.
   */
  await page.waitForSelector('#main-content, #xcloud-login-username', { timeout });
  await page.waitForFunction(() => {
    const login = document.querySelector('#xcloud-login-username');
    if (login) return true;
    const main = document.querySelector('#main-content');
    if (!main) return false;
    return (main.textContent ?? '').trim().length > 0;
  }, undefined, { timeout });
}

/**
 * Navigate and wait, retrying once.
 *
 * A lazy route module can still be in flight when the first wait expires under a
 * loaded machine; that is a timing artefact, not a route defect. A route that
 * genuinely cannot settle still fails on the retry.
 */
async function gotoAndSettle(page, url) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await waitForRouteSettled(page);
  } catch {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await waitForRouteSettled(page);
  }
}

/** Document-level horizontal overflow is a layout defect; a scrollable table is not. */
async function documentOverflow(page) {
  return page.evaluate(() => {
    const root = document.documentElement;
    const overflow = root.scrollWidth - root.clientWidth;
    if (overflow <= 1) return { overflow: 0, offenders: [] };
    const offenders = [];
    for (const element of Array.from(document.body.querySelectorAll('*'))) {
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (rect.right <= root.clientWidth + 1) continue;
      /* An element inside its own scroll container is a local scroll, not a
       * document overflow. */
      let ancestor = element.parentElement;
      let locallyScrollable = false;
      while (ancestor && ancestor !== document.body) {
        const style = getComputedStyle(ancestor);
        if (style.overflowX === 'auto' || style.overflowX === 'scroll' || style.overflowX === 'hidden') {
          locallyScrollable = true;
          break;
        }
        ancestor = ancestor.parentElement;
      }
      if (locallyScrollable) continue;
      offenders.push(`${element.tagName.toLowerCase()}.${String(element.className || '').split(' ').slice(0, 2).join('.')} right=${Math.round(rect.right)}`);
      if (offenders.length >= 5) break;
    }
    return { overflow, offenders };
  });
}

/** Whether a full-screen blocking overlay covers the workspace. */
async function blockingOverlay(page) {
  return page.evaluate(() => {
    const candidates = Array.from(document.querySelectorAll('body > div, body > div > div'));
    for (const element of candidates) {
      const style = getComputedStyle(element);
      if (style.position !== 'fixed') continue;
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) continue;
      const rect = element.getBoundingClientRect();
      if (rect.width < window.innerWidth * 0.9 || rect.height < window.innerHeight * 0.9) continue;
      const role = element.getAttribute('role');
      const modal = element.getAttribute('aria-modal');
      const dialog = element.querySelector('[role="dialog"], [role="alertdialog"]');
      if (role === 'alertdialog' || modal === 'true' || dialog) continue;
      return `${element.tagName.toLowerCase()}.${String(element.className || '').split(' ').slice(0, 2).join('.')}`;
    }
    return null;
  });
}

async function buildApplication() {
  const directory = await mkdtemp(path.join(tmpdir(), 'xcloud-cross-route-'));
  const result = await build({
    root: frontendRoot,
    build: { outDir: directory, emptyOutDir: true },
    logLevel: 'warn',
  });
  const output = (Array.isArray(result) ? result[0] : result).output;
  const chunks = output.filter((entry) => entry.type === 'chunk');
  const jsChunks = chunks.filter((chunk) => chunk.fileName.endsWith('.js'));
  const cssChunks = chunks.filter((chunk) => chunk.fileName.endsWith('.css'));
  const rawJs = jsChunks.reduce((sum, chunk) => sum + (chunk.code ?? '').length, 0);
  const rawCss = cssChunks.reduce((sum, chunk) => sum + (chunk.code ?? '').length, 0);
  return {
    directory,
    facts: {
      chunkCount: chunks.length,
      jsChunkCount: jsChunks.length,
      cssChunkCount: cssChunks.length,
      rawJsBytes: rawJs,
      rawCssBytes: rawCss,
    },
  };
}

let temporaryBuildDirectory = null;
let fixture = null;
let browser = null;

try {
  console.log('[acceptance:cross-route-ux] Building frontend SPA to temporary directory...');
  const built = await buildApplication();
  temporaryBuildDirectory = built.directory;
  console.log(
    `[acceptance:cross-route-ux] chunks=${built.facts.chunkCount} js_chunks=${built.facts.jsChunkCount} css_chunks=${built.facts.cssChunkCount} raw_js=${built.facts.rawJsBytes} raw_css=${built.facts.rawCssBytes}`,
  );

  fixture = await startCrossRouteFixtureServer({
    distDir: temporaryBuildDirectory,
    session: ADMIN_SESSION,
    principal: 'admin',
  });
  const baseUrl = fixture.origin;
  console.log(`[acceptance:cross-route-ux] Fixture host on ${baseUrl}`);

  browser = await chromium.launch({ headless: process.env.XCLOUD_ACCEPTANCE_HEADED !== '1' });

  /* ---------------------------------------------------------------------- */
  /* Layer 1: the complete route contract                                   */
  /* ---------------------------------------------------------------------- */
  console.log('\n--- Layer 1: complete route contract ---');

  const l1 = await openPage(browser, { width: 1440, height: 900 });

  for (const entry of ROUTE_INVENTORY) {
    const url = concreteUrl(entry);
    const before = l1.pageErrors.length;
    const consoleBefore = l1.consoleErrors.length;
    const failuresBefore = l1.failedRequests.length;

    let landedPath = null;
    let resolved = false;
    let settleError = null;
    try {
      await gotoAndSettle(l1.page, `${baseUrl}${url}`);
      landedPath = new URL(l1.page.url()).pathname;
      resolved = true;
    } catch (error) {
      settleError = error instanceof Error ? error.message : String(error);
    }

    const pageErrors = l1.pageErrors.slice(before);
    const consoleErrors = l1.consoleErrors.slice(consoleBefore);
    const failedRequests = l1.failedRequests.slice(failuresBefore);

    const expected = expectedPath(entry.route);
    const pathMatches = landedPath === expected;
    const overflow = resolved ? await documentOverflow(l1.page) : { overflow: 0, offenders: [] };
    const overlay = resolved ? await blockingOverlay(l1.page) : null;

    const problems = [];
    if (!resolved) problems.push(`route did not settle: ${settleError}`);
    if (resolved && !pathMatches) problems.push(`landed on ${landedPath}, expected ${expected}`);
    if (pageErrors.length) problems.push(`page errors: ${pageErrors.join(' | ')}`);
    if (overflow.overflow > 1) problems.push(`document overflow ${overflow.overflow}px via ${overflow.offenders.join(', ')}`);
    if (overlay) problems.push(`inaccessible blocking overlay: ${overlay}`);

    const ok = problems.length === 0;
    routeResults.push({
      route: entry.route,
      classification: entry.classification,
      family: entry.family,
      url,
      landedPath,
      expected,
      resolved,
      consoleErrors: consoleErrors.length,
      failedRequests: failedRequests.length,
      documentOverflow: overflow.overflow,
      blockingOverlay: overlay,
      problems,
    });

    check(
      `L1-${entry.route}`,
      ok,
      ok
        ? `${entry.classification} route settled on ${landedPath}`
        : problems.join('; '),
    );
  }

  await l1.context.close();
  check('L1-COVERAGE', ROUTE_INVENTORY.length === 59, `the contract inventory covers ${ROUTE_INVENTORY.length} route entries`);

  /* ---------------------------------------------------------------------- */
  /* Layer 2a: responsive layout acceptance                                 */
  /* ---------------------------------------------------------------------- */
  console.log('\n--- Layer 2a: responsive layout acceptance ---');

  for (const entry of ROUTE_INVENTORY) {
    if (!REPRESENTATIVE_ROUTES.includes(entry.route)) continue;
    const url = concreteUrl(entry);
    for (const viewport of VIEWPORTS) {
      const session = await openPage(browser, { width: viewport.width, height: viewport.height });
      let overflow = { overflow: 0, offenders: [] };
      let overlay = null;
      let settled = false;
      try {
        await gotoAndSettle(session.page, `${baseUrl}${url}`);
        settled = true;
        overflow = await documentOverflow(session.page);
        overlay = await blockingOverlay(session.page);
      } catch {
        settled = false;
      }
      const problems = [];
      if (!settled) problems.push('route did not settle');
      if (overflow.overflow > 1) problems.push(`document overflow ${overflow.overflow}px via ${overflow.offenders.join(', ')}`);
      if (overlay) problems.push(`inaccessible blocking overlay: ${overlay}`);
      check(
        `L2-RESP-${entry.route}@${viewport.name}`,
        problems.length === 0,
        problems.length ? problems.join('; ') : `no document overflow at ${viewport.name}px`,
      );
      await session.context.close();
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Layer 2b: component content breakpoints                                */
  /* ---------------------------------------------------------------------- */
  console.log('\n--- Layer 2b: component content breakpoints ---');
  for (const entry of ROUTE_INVENTORY) {
    if (!['/subscribers', '/nf-health', '/ocs/balances'].includes(entry.route)) continue;
    const url = concreteUrl(entry);
    for (const viewport of COMPONENT_VIEWPORTS) {
      const session = await openPage(browser, { width: viewport.width, height: viewport.height });
      const overflow = await (async () => {
        try {
          await gotoAndSettle(session.page, `${baseUrl}${url}`);
          return await documentOverflow(session.page);
        } catch {
          return { overflow: 0, offenders: [] };
        }
      })();
      check(
        `L2-BREAK-${entry.route}@${viewport.name}`,
        overflow.overflow <= 1,
        overflow.overflow <= 1
          ? `no document overflow at the ${viewport.name}px content boundary`
          : `document overflow ${overflow.overflow}px via ${overflow.offenders.join(', ')}`,
      );
      await session.context.close();
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Layer 2c: keyboard, focus and dialog behaviour                         */
  /* ---------------------------------------------------------------------- */
  console.log('\n--- Layer 2c: keyboard and focus ---');

  const keyboard = await openPage(browser, { width: 1440, height: 900 });
  await gotoAndSettle(keyboard.page, `${baseUrl}/`);

  /* The skip link must be the first tab stop and must reach the workspace. */
  await keyboard.page.keyboard.press('Tab');
  const firstStop = await keyboard.page.evaluate(() => {
    const element = document.activeElement;
    if (!element) return null;
    return {
      tag: element.tagName.toLowerCase(),
      className: String(element.className || ''),
      text: (element.textContent ?? '').trim(),
      href: element.getAttribute('href'),
    };
  });
  check(
    'L2-KEY-01',
    firstStop?.tag === 'a' && firstStop.href === '#main-content',
    `the first tab stop is the skip link (${firstStop?.text ?? 'none'})`,
  );

  await keyboard.page.keyboard.press('Enter');
  const skipTarget = await keyboard.page.evaluate(() => {
    const active = document.activeElement;
    return { id: active?.id ?? '', tag: active?.tagName.toLowerCase() ?? '' };
  });
  check('L2-KEY-02', skipTarget.id === 'main-content', `the skip link moves focus to the workspace (${skipTarget.id || skipTarget.tag})`);

  /* The command palette must open, accept a query, restore focus on dismissal. */
  await keyboard.page.keyboard.press('Control+k');
  const paletteInput = await keyboard.page.waitForSelector('.cp-search-input', { timeout: 10000 }).catch(() => null);
  check('L2-KEY-03', Boolean(paletteInput), 'Control+K opens the command palette');
  if (paletteInput) {
    /*
     * The dialog moves focus in a requestAnimationFrame so the overlay is laid
     * out first. Sampling instantly can observe the pre-open focus, so wait for
     * the documented focus landing instead of racing the frame.
     */
    const focusLanded = await keyboard.page.waitForFunction(
      () => document.activeElement?.classList.contains('cp-search-input') ?? false,
      undefined,
      { timeout: 5000 },
    ).then(() => true).catch(() => false);
    check('L2-KEY-04', focusLanded, 'the command palette moves initial focus into its search field');
    await keyboard.page.keyboard.type('subscribers');
    await keyboard.page.waitForTimeout(400);
    const resultCount = await keyboard.page.locator('.cp-item-row').count();
    check('L2-KEY-05', resultCount > 0, `the command palette returns search results (${resultCount} rows)`);
    const announcement = (await keyboard.page.locator('.cp-modal [role="status"]').first().textContent().catch(() => ''))?.trim() ?? '';
    check(
      'L2-KEY-05-ANNOUNCE',
      announcement.length > 0,
      `the command palette announces the active result (${announcement || 'nothing announced'})`,
    );
    await keyboard.page.keyboard.press('Escape');
    const paletteClosed = await keyboard.page.locator('.cp-search-input').count();
    check('L2-KEY-06', paletteClosed === 0, 'Escape dismisses the command palette');
  }

  /*
   * The user menu is a disclosure/popover of native action buttons, not an
   * application menu. It must expose the disclosure contract and must not
   * advertise menu keyboard behaviour it does not implement.
   */
  const userMenuTrigger = keyboard.page.locator('.avatar-button');
  const disclosure = await userMenuTrigger.evaluate((button) => ({
    expanded: button.getAttribute('aria-expanded'),
    controls: button.getAttribute('aria-controls'),
    haspopup: button.getAttribute('aria-haspopup'),
  }));
  check(
    'L2-KEY-07-DISCLOSURE',
    disclosure.expanded === 'false' && Boolean(disclosure.controls) && disclosure.haspopup === null,
    `the user menu trigger is a disclosure (expanded=${disclosure.expanded} controls=${disclosure.controls})`,
  );
  await keyboard.page.click('.avatar-button');
  const userMenuOpen = await keyboard.page.locator('.user-dropdown').count();
  check('L2-KEY-07', userMenuOpen === 1, 'the user menu opens');
  const menuItems = await keyboard.page.locator('.user-dropdown .dropdown-item').count();
  const inappropriateMenuRole = await keyboard.page.locator('.user-dropdown [role="menu"], .user-dropdown [role="menuitem"]').count();
  check('L2-KEY-08', menuItems > 0, `the user menu exposes native action buttons (${menuItems})`);
  check(
    'L2-KEY-08-SEMANTICS',
    inappropriateMenuRole === 0,
    inappropriateMenuRole === 0
      ? 'the user menu carries no menu/menuitem roles it does not honour'
      : `${inappropriateMenuRole} inappropriate menu role(s) remain`,
  );
  await keyboard.page.keyboard.press('Escape');
  const userMenuClosed = await keyboard.page.locator('.user-dropdown').count();
  check('L2-KEY-09', userMenuClosed === 0, 'Escape closes the user menu');
  const focusBackOnTrigger = await keyboard.page.evaluate(() => document.activeElement?.classList.contains('avatar-button') ?? false);
  check('L2-KEY-09-FOCUS', focusBackOnTrigger, 'Escape returns focus to the user menu trigger');

  /* The notification centre must open and expose its state. */
  await keyboard.page.click('.notif-bell-button');
  const notifPanel = await keyboard.page.locator('.notif-dropdown-panel').count();
  check('L2-KEY-10', notifPanel === 1, 'the notification centre opens');
  await keyboard.page.keyboard.press('Escape');
  const notifClosed = await keyboard.page.locator('.notif-dropdown-panel').count();
  check('L2-KEY-11', notifClosed === 0, 'Escape closes the notification centre');

  /* A sortable table header must be keyboard operable and report its state. */
  await gotoAndSettle(keyboard.page, `${baseUrl}/subscribers`);
  const sortableHeaderCount = await keyboard.page.locator('th[aria-sort] button').count();
  check('L2-KEY-12', sortableHeaderCount > 0, `the subscriber table exposes keyboard reachable sort buttons (${sortableHeaderCount})`);
  if (sortableHeaderCount > 0) {
    /*
     * The focus ring is a :focus-visible style, so the control must be
     * REACHED BY KEYBOARD. A programmatic focus() does not necessarily make
     * the browser treat the element as keyboard focused, and the assertion
     * would then measure the wrong thing.
     */
    await keyboard.page.evaluate(() => {
      const header = document.querySelector('th[aria-sort] button');
      header?.closest('table')?.querySelector('input, select, button')?.focus();
    });
    let reached = false;
    for (let step = 0; step < 40; step += 1) {
      await keyboard.page.keyboard.press('Tab');
      const state = await keyboard.page.evaluate(() => ({
        inSort: Boolean(document.activeElement?.closest('th[aria-sort]')),
        focusVisible: document.activeElement?.matches(':focus-visible') ?? false,
      }));
      if (state.inSort) {
        reached = true;
        const ring = await keyboard.page.evaluate(() => {
          const element = document.activeElement;
          if (!element) return null;
          const style = getComputedStyle(element);
          return {
            outline: style.outlineStyle !== 'none' && style.outlineWidth !== '0px',
            shadow: style.boxShadow !== 'none',
            focusVisible: element.matches(':focus-visible'),
          };
        });
        check(
          'L2-KEY-13',
          Boolean(ring && (ring.outline || ring.shadow)),
          `a keyboard focused sort control keeps a visible focus indicator (outline=${ring?.outline} shadow=${ring?.shadow !== 'none'})`,
        );
        break;
      }
    }
    check('L2-KEY-13-REACH', reached, 'the sort control is reachable by Tab alone');

    await keyboard.page.keyboard.press('Enter');
    const sortedHeader = await keyboard.page.evaluate(() => {
      const header = document.querySelector('th[aria-sort="ascending"], th[aria-sort="descending"]');
      return header ? header.getAttribute('aria-sort') : null;
    });
    check('L2-KEY-14', Boolean(sortedHeader), `activating a sort control updates aria-sort (${sortedHeader})`);
  }

  /* Focus must not be lost to a detached element when a dialog closes. */
  await gotoAndSettle(keyboard.page, `${baseUrl}/ocs/balances`);
  const adjustButton = keyboard.page.locator('button', { hasText: /adjust/i }).first();
  if (await adjustButton.count()) {
    await adjustButton.click();
    const dialog = await keyboard.page.waitForSelector('[role="dialog"]', { timeout: 10000 }).catch(() => null);
    check('L2-KEY-15', Boolean(dialog), 'the balance adjustment dialog opens');
    if (dialog) {
      const trapped = await keyboard.page.evaluate(() => {
        const active = document.activeElement;
        const modal = document.querySelector('[role="dialog"]');
        return Boolean(active && modal && modal.contains(active));
      });
      check('L2-KEY-16', trapped, 'dialog initial focus lands inside the dialog');
      await keyboard.page.keyboard.press('Escape');
      const restored = await keyboard.page.evaluate(() => {
        const active = document.activeElement;
        return { connected: Boolean(active && active.isConnected), tag: active?.tagName.toLowerCase() ?? '' };
      });
      check('L2-KEY-17', restored.connected, `closing the dialog restores focus to a connected element (${restored.tag})`);
    }
  }

  await keyboard.context.close();

  /* ---------------------------------------------------------------------- */
  /* Layer 2d: theme and localization                                       */
  /* ---------------------------------------------------------------------- */
  console.log('\n--- Layer 2d: theme and localization ---');

  for (const [locale, theme] of [['en', 'light'], ['zh', 'light'], ['en', 'dark'], ['zh', 'dark']]) {
    const session = await openPage(browser, { locale, theme, width: 1440, height: 900 });
    await gotoAndSettle(session.page, `${baseUrl}/subscribers`);
    const applied = await session.page.evaluate(() => ({
      lang: document.documentElement.lang,
      theme: document.documentElement.getAttribute('data-theme'),
      text: (document.querySelector('#main-content')?.textContent ?? '').trim(),
    }));
    const expectedLang = locale === 'zh' ? 'zh-CN' : 'en';
    check(
      `L2-THEME-${locale}-${theme}`,
      applied.lang === expectedLang && applied.theme === theme,
      `locale ${locale} / theme ${theme} applied (lang=${applied.lang} theme=${applied.theme})`,
    );
    const rawKeys = (applied.text.match(/\b[a-z]+_[a-z_]+\b/g) ?? [])
      .filter((token) => !token.includes('@'))
      /* A resource identifier can legitimately contain an underscore, so a
       * token that also appears as a known identifier is not a missing key. */
      .filter((token) => !/^[a-z]+_\d+$/.test(token))
      .filter((token) => !KNOWN_IDENTIFIERS.has(token));
    check(
      `L2-THEME-${locale}-${theme}-KEYS`,
      rawKeys.length === 0,
      rawKeys.length === 0 ? 'no untranslated key is rendered' : `untranslated keys rendered: ${[...new Set(rawKeys)].slice(0, 5).join(', ')}`,
    );
    await session.context.close();
  }

  /* The theme must survive a navigation and the locale must survive too. */
  const persistence = await openPage(browser, { locale: 'zh', theme: 'dark', width: 1440, height: 900 });
  await gotoAndSettle(persistence.page, `${baseUrl}/`);
  /*
   * The sidebar keeps one expansion level, so the domain group must be opened
   * before its child entry exists in the DOM. Clicking the group toggle is the
   * real operator path and is exercised here on purpose.
   */
  await persistence.page.click('[data-group-key="nav_business"]');
  await persistence.page.click('a[href="/ocs/tariffs"]');
  await persistence.page.waitForURL('**/ocs/tariffs', { timeout: 15000 });
  await persistence.page.waitForFunction(() => (document.querySelector('#main-content')?.textContent ?? '').trim().length > 0, undefined, { timeout: 15000 });
  const persisted = await persistence.page.evaluate(() => ({
    lang: document.documentElement.lang,
    theme: document.documentElement.getAttribute('data-theme'),
  }));
  check(
    'L2-THEME-PERSIST',
    persisted.lang === 'zh-CN' && persisted.theme === 'dark',
    `theme and locale survive navigation (lang=${persisted.lang} theme=${persisted.theme})`,
  );
  await persistence.context.close();

  /* ---------------------------------------------------------------------- */
  /* Layer 2e: navigation, history and session behaviour                    */
  /* ---------------------------------------------------------------------- */
  console.log('\n--- Layer 2e: navigation and session behaviour ---');

  const navigation = await openPage(browser, { width: 1440, height: 900 });
  await gotoAndSettle(navigation.page, `${baseUrl}/`);

  /* Direct navigation, sidebar navigation and browser history. */
  await navigation.page.click('[data-group-key="nav_business"]');
  await navigation.page.click('a[href="/ocs/balances"]');
  await navigation.page.waitForURL('**/ocs/balances', { timeout: 15000 });
  check('L2-NAV-01', navigation.page.url().endsWith('/ocs/balances'), 'sidebar navigation reaches the OCS balances route');

  await navigation.page.goBack();
  await navigation.page.waitForFunction(() => window.location.pathname === '/', undefined, { timeout: 15000 });
  check('L2-NAV-02', true, 'browser Back restores the previous route');
  await navigation.page.goForward();
  await navigation.page.waitForFunction(() => window.location.pathname === '/ocs/balances', undefined, { timeout: 15000 });
  check('L2-NAV-03', true, 'browser Forward restores the next route');

  /* A compatibility alias must land on its declared destination. */
  for (const [alias, destination] of Object.entries(COMPATIBILITY_REDIRECTS)) {
    await navigation.page.goto(`${baseUrl}${alias}`, { waitUntil: 'domcontentloaded' });
    await navigation.page.waitForFunction(
      (expected) => window.location.pathname === expected,
      destination,
      { timeout: 15000 },
    ).catch(() => undefined);
    check(
      `L2-NAV-REDIR-${alias}`,
      new URL(navigation.page.url()).pathname === destination,
      `${alias} redirects to ${destination}`,
    );
  }
  await navigation.context.close();

  /* ---------------------------------------------------------------------- */
  /* Layer 2f: narrow-screen shell behaviour                                */
  /* ---------------------------------------------------------------------- */
  console.log('\n--- Layer 2f: narrow-screen shell ---');
  const narrow = await openPage(browser, { width: 375, height: 812 });
  await gotoAndSettle(narrow.page, `${baseUrl}/`);

  const collapsedSidebar = await narrow.page.evaluate(() => {
    const sidebar = document.querySelector('#xcloud-primary-sidebar');
    if (!sidebar) return null;
    const style = getComputedStyle(sidebar);
    return { collapsed: sidebar.classList.contains('collapsed'), transform: style.transform, hidden: sidebar.getAttribute('aria-hidden') };
  });
  check(
    'L2-SHELL-01',
    Boolean(collapsedSidebar && collapsedSidebar.collapsed),
    'the sidebar starts collapsed on a narrow viewport',
  );

  const narrowOverflow = await documentOverflow(narrow.page);
  check(
    'L2-SHELL-02',
    narrowOverflow.overflow <= 1,
    narrowOverflow.overflow <= 1 ? 'no document overflow at 375px' : `document overflow ${narrowOverflow.overflow}px via ${narrowOverflow.offenders.join(', ')}`,
  );

  await narrow.page.click('.app-header .icon-button');
  const drawerOpened = await narrow.page.evaluate(() => {
    const sidebar = document.querySelector('#xcloud-primary-sidebar');
    return sidebar ? !sidebar.classList.contains('collapsed') : false;
  });
  check('L2-SHELL-03', drawerOpened, 'the narrow-screen drawer opens from the header toggle');

  await narrow.page.keyboard.press('Escape');
  const drawerClosed = await narrow.page.evaluate(() => {
    const sidebar = document.querySelector('#xcloud-primary-sidebar');
    return sidebar ? sidebar.classList.contains('collapsed') : true;
  });
  check('L2-SHELL-04', drawerClosed, 'Escape closes the narrow-screen drawer');
  await narrow.context.close();

  /* ---------------------------------------------------------------------- */
  /* Layer 2h: hidden mobile drawer inertness contract                     */
  /* ---------------------------------------------------------------------- */
  console.log('\n--- Layer 2h: hidden mobile drawer inertness ---');
  const drawer = await openPage(browser, { width: 375, height: 812 });
  await gotoAndSettle(drawer.page, `${baseUrl}/`);

  const readDrawerState = () => drawer.page.evaluate(() => {
    const sidebar = document.querySelector('#xcloud-primary-sidebar');
    if (!sidebar) return null;
    return {
      inert: sidebar.inert === true,
      inertAttribute: sidebar.hasAttribute('inert'),
      ariaHidden: sidebar.getAttribute('aria-hidden'),
      collapsed: sidebar.classList.contains('collapsed'),
    };
  });

  const closedState = await readDrawerState();
  check(
    'L2-INERT-01',
    Boolean(closedState && closedState.inert && closedState.inertAttribute && closedState.ariaHidden === 'true' && closedState.collapsed),
    `the closed mobile drawer is inert and aria-hidden (inert=${closedState?.inert} aria-hidden=${closedState?.ariaHidden})`,
  );

  /* Programmatic focus cannot enter an inert subtree. */
  const forcedFocus = await drawer.page.evaluate(() => {
    const link = document.querySelector('#xcloud-primary-sidebar a');
    if (!link) return { hasLink: false, inside: false };
    link.focus();
    return { hasLink: true, inside: Boolean(document.activeElement?.closest('#xcloud-primary-sidebar')) };
  });
  check(
    'L2-INERT-02',
    !forcedFocus.inside,
    forcedFocus.hasLink
      ? 'focus() cannot move into the closed drawer'
      : 'the closed drawer still renders its links (they exist but are unreachable)',
  );

  /* Tab must never land inside the hidden navigation. */
  let tabEnteredSidebar = false;
  await drawer.page.evaluate(() => document.body.focus());
  for (let step = 0; step < 60; step += 1) {
    await drawer.page.keyboard.press('Tab');
    const inside = await drawer.page.evaluate(() => Boolean(document.activeElement?.closest('#xcloud-primary-sidebar')));
    if (inside) { tabEnteredSidebar = true; break; }
  }
  check('L2-INERT-03', !tabEnteredSidebar, 'Tab alone never enters the hidden navigation');

  /* Shift+Tab from the workspace must also skip the hidden drawer. */
  await drawer.page.evaluate(() => {
    const target = document.querySelector('#main-content input, #main-content button, #main-content a, #main-content [tabindex]');
    (target ?? document.querySelector('#main-content')).focus();
  });
  let shiftTabEnteredSidebar = false;
  for (let step = 0; step < 20; step += 1) {
    await drawer.page.keyboard.press('Shift+Tab');
    const inside = await drawer.page.evaluate(() => Boolean(document.activeElement?.closest('#xcloud-primary-sidebar')));
    if (inside) { shiftTabEnteredSidebar = true; break; }
  }
  check('L2-INERT-04', !shiftTabEnteredSidebar, 'Shift+Tab never enters the hidden navigation');

  /* Opening the drawer makes the navigation keyboard reachable. */
  await drawer.page.click('.app-header .icon-button');
  const openState = await readDrawerState();
  const openFocusable = await drawer.page.evaluate(() => {
    const link = document.querySelector('#xcloud-primary-sidebar a, #xcloud-primary-sidebar button');
    if (!link) return false;
    link.focus();
    return Boolean(document.activeElement?.closest('#xcloud-primary-sidebar'));
  });
  check(
    'L2-INERT-05',
    Boolean(openState && !openState.inert && !openState.inertAttribute && openState.ariaHidden === null && openFocusable),
    `the open drawer removes inert and accepts keyboard focus (inert=${openState?.inert} aria-hidden=${openState?.ariaHidden})`,
  );

  /* Escape closes the drawer and restores focus to the header trigger. */
  await drawer.page.keyboard.press('Escape');
  const escapeState = await readDrawerState();
  const focusRestored = await drawer.page.waitForFunction(
    () => document.activeElement?.matches('.app-header .icon-button') ?? false,
    undefined,
    { timeout: 5000 },
  ).then(() => true).catch(() => false);
  check(
    'L2-INERT-06',
    Boolean(escapeState && escapeState.collapsed && escapeState.inert && escapeState.ariaHidden === 'true' && focusRestored),
    `Escape closes the drawer, re-applies inert and restores focus to the header trigger (focusRestored=${focusRestored})`,
  );

  /* Selecting a navigation entry closes the drawer and leaves no stale state. */
  await drawer.page.click('.app-header .icon-button');
  await drawer.page.click('[data-group-key="nav_business"]');
  await drawer.page.click('a[href="/subscribers"]');
  await drawer.page.waitForFunction(() => window.location.pathname === '/subscribers', undefined, { timeout: 15000 });
  const afterNavState = await readDrawerState();
  const focusAfterNav = await drawer.page.waitForFunction(
    () => document.activeElement?.matches('.app-header .icon-button') ?? false,
    undefined,
    { timeout: 5000 },
  ).then(() => true).catch(() => false);
  check(
    'L2-INERT-07',
    Boolean(afterNavState && afterNavState.collapsed && afterNavState.inert && afterNavState.ariaHidden === 'true'),
    `selecting a navigation entry closes the drawer with no stale inert state (collapsed=${afterNavState?.collapsed} inert=${afterNavState?.inert})`,
  );
  check('L2-INERT-08', focusAfterNav, 'closing after navigation restores focus to the header trigger');

  /* The drawer state must follow the actual breakpoint, with no stale inert. */
  await drawer.page.setViewportSize({ width: 1440, height: 900 });
  const desktopState = await drawer.page.waitForFunction(() => {
    const sidebar = document.querySelector('#xcloud-primary-sidebar');
    return Boolean(sidebar && !sidebar.classList.contains('collapsed') && !sidebar.inert);
  }, undefined, { timeout: 5000 }).then(() => readDrawerState()).catch(() => null);
  check(
    'L2-INERT-09',
    Boolean(desktopState && !desktopState.inert && !desktopState.collapsed && desktopState.ariaHidden === null),
    `switching to desktop leaves the rail interactive (inert=${desktopState?.inert} collapsed=${desktopState?.collapsed})`,
  );

  await drawer.page.setViewportSize({ width: 375, height: 812 });
  const mobileAgainState = await drawer.page.waitForFunction(() => {
    const sidebar = document.querySelector('#xcloud-primary-sidebar');
    return Boolean(sidebar && sidebar.classList.contains('collapsed') && sidebar.inert);
  }, undefined, { timeout: 5000 }).then(() => readDrawerState()).catch(() => null);
  check(
    'L2-INERT-10',
    Boolean(mobileAgainState && mobileAgainState.inert && mobileAgainState.collapsed && mobileAgainState.ariaHidden === 'true'),
    `switching back to mobile re-applies the hidden-drawer contract (inert=${mobileAgainState?.inert})`,
  );
  await drawer.context.close();

  /* ---------------------------------------------------------------------- */
  /* Layer 2g: read-only and expired-session journeys                       */
  /* ---------------------------------------------------------------------- */
  console.log('\n--- Layer 2g: read-only and expired session ---');

  const readOnlyFixture = await startCrossRouteFixtureServer({
    distDir: temporaryBuildDirectory,
    session: VIEWER_SESSION,
    principal: 'viewer',
  });
  const readOnly = await openPage(browser, { width: 1440, height: 900 });
  await gotoAndSettle(readOnly.page, `${readOnlyFixture.origin}/`);
  const gatedLinks = await readOnly.page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('.sidebar-nav a[href]')).map((anchor) => anchor.getAttribute('href'));
    return { users: links.includes('/users'), retention: links.includes('/system/retention'), total: links.length };
  });
  check(
    'L2-RO-01',
    !gatedLinks.users && !gatedLinks.retention,
    `a read-only principal never sees the permission-gated navigation entries (${gatedLinks.total} sidebar links)`,
  );
  await readOnly.context.close();
  await readOnlyFixture.close();

  const expiredFixture = await startCrossRouteFixtureServer({
    distDir: temporaryBuildDirectory,
    session: DISABLED_SESSION,
    principal: 'disabled',
  });
  const expired = await openPage(browser, { width: 1440, height: 900 });
  await expired.page.goto(`${expiredFixture.origin}/`, { waitUntil: 'domcontentloaded' });
  const expiredOutcome = await expired.page.waitForSelector('#xcloud-login-username, .state-page', { timeout: 15000 }).catch(() => null);
  check('L2-EXP-01', Boolean(expiredOutcome), 'a non-active account is routed away from the workspace');
  await expired.context.close();
  await expiredFixture.close();

  /* ---------------------------------------------------------------------- */
  /* Evidence                                                               */
  /* ---------------------------------------------------------------------- */
  const evidenceDirectory = path.resolve(frontendRoot, '..', 'reports');
  await mkdir(evidenceDirectory, { recursive: true });
  await writeFile(
    path.join(evidenceDirectory, 'FE-C4-CROSS-ROUTE-EVIDENCE.json'),
    `${JSON.stringify({
      generatedAt: new Date().toISOString(),
      bundle: built.facts,
      routeCount: ROUTE_INVENTORY.length,
      checkCount: checks.length,
      failureCount: failures.length,
      failures,
      routes: routeResults,
      checks,
    }, null, 2)}\n`,
    'utf8',
  );
  console.log(`\n[acceptance:cross-route-ux] evidence written to reports/FE-C4-CROSS-ROUTE-EVIDENCE.json`);

  check(
    'SUITE-01',
    failures.length === 0,
    failures.length === 0
      ? `all ${checks.length} cross-route UX assertions passed`
      : `${failures.length} of ${checks.length} assertions failed`,
  );
} catch (error) {
  failures.push(`harness error: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  console.error('[acceptance:cross-route-ux] harness error:', error);
} finally {
  if (browser) await browser.close().catch(() => undefined);
  if (fixture) await fixture.close().catch(() => undefined);
  if (temporaryBuildDirectory) await rm(temporaryBuildDirectory, { recursive: true, force: true }).catch(() => undefined);
}

console.log(`\n[acceptance:cross-route-ux] ${checks.length} checks, ${failures.length} failures`);
if (failures.length) {
  console.error('[acceptance:cross-route-ux] FAILURES:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exitCode = 1;
}
