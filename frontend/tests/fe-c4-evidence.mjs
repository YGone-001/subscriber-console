#!/usr/bin/env node
/*
 * FE-C4 Gate E supplementary evidence.
 *
 * Captures representative critical screens in both themes/locales and measures
 * the two scaling modes Gate E calls out (200% text scaling, 400% browser zoom)
 * plus pointer-coarse touch targets. This is deliberately a REPRESENTATIVE
 * sample, not every route: the complete 59-route contract is covered by
 * tests/cross-route-ux-acceptance.mjs.
 *
 * Usage (headed under xvfb in a sandbox whose headless shell does not tick rAF):
 *   xvfb-run -a env XCLOUD_ACCEPTANCE_HEADED=1 node tests/fe-c4-evidence.mjs
 */
/* global getComputedStyle */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';
import { ADMIN_SESSION, startCrossRouteFixtureServer } from './cross-route-fixtures.mjs';

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const evidenceDir = path.resolve(frontendRoot, '..', 'reports', 'FE-C4-EVIDENCE');
const distDir = path.join(frontendRoot, 'dist');

const SCREENSHOT_ROUTES = [
  ['dashboard', '/'],
  ['subscribers', '/subscribers'],
  ['subscriber-detail', '/subscribers/460020000000400'],
  ['ocs-balances', '/ocs/balances'],
  ['ocs-contracts', '/ocs/contracts/460020000000400'],
  ['ocs-tariffs', '/ocs/tariffs/default_plan'],
  ['inventory', '/inventory'],
  ['topology', '/topology'],
  ['nf-health', '/nf-health'],
  ['logs', '/logs'],
  ['users', '/users'],
  ['profile', '/profile/default'],
];

const SCALING_ROUTES = ['/', '/subscribers', '/ocs/balances', '/nf-health', '/logs', '/inventory'];

const results = { screenshots: [], scaling: [], touchTargets: [], failures: [] };

function fail(message) {
  results.failures.push(message);
  console.error(`  not ok ${message}`);
}

async function openPage(browser, { locale = 'en', theme = 'light', width = 1440, height = 900, touch = false } = {}) {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
    locale: locale === 'zh' ? 'zh-CN' : 'en-US',
    timezoneId: 'UTC',
    reducedMotion: 'reduce',
    colorScheme: theme === 'dark' ? 'dark' : 'light',
    hasTouch: touch,
    isMobile: touch,
  });
  await context.addInitScript(({ localeValue, themeValue }) => {
    try {
      localStorage.setItem('XCLOUD_LANGUAGE_PREFERENCE', localeValue);
      localStorage.setItem('XCLOUD_THEME_PREFERENCE', themeValue);
    } catch {
      /* The assertion fails if preferences do not apply. */
    }
  }, { localeValue: locale, themeValue: theme });
  const page = await context.newPage();
  return { context, page };
}

async function settle(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('#main-content', { timeout: 30000 });
  await page.waitForFunction(() => (document.querySelector('#main-content')?.textContent ?? '').trim().length > 0, undefined, { timeout: 30000 });
  await page.waitForTimeout(150);
}

async function documentOverflow(page) {
  return page.evaluate(() => {
    const root = document.documentElement;
    return root.scrollWidth - root.clientWidth;
  });
}

let browser = null;
let fixture = null;

try {
  await mkdir(evidenceDir, { recursive: true });
  fixture = await startCrossRouteFixtureServer({ distDir, session: ADMIN_SESSION, principal: 'admin' });
  const baseUrl = fixture.origin;
  browser = await chromium.launch({ headless: process.env.XCLOUD_ACCEPTANCE_HEADED !== '1' });

  /* Representative screenshots: light/en and dark/zh at desktop width. */
  for (const [name, route] of SCREENSHOT_ROUTES) {
    for (const theme of ['light', 'dark']) {
      const locale = theme === 'dark' ? 'zh' : 'en';
      const { context, page } = await openPage(browser, { theme, locale });
      try {
        await settle(page, `${baseUrl}${route}`);
        const file = `${name}-${theme}-${locale}.png`;
        await page.screenshot({ path: path.join(evidenceDir, file), fullPage: false });
        results.screenshots.push({ route, theme, locale, file });
      } catch (error) {
        fail(`screenshot ${name}/${theme}: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        await context.close();
      }
    }
  }

  /* 200% text scaling: double the root font size, representative routes. */
  for (const route of SCALING_ROUTES) {
    const { context, page } = await openPage(browser);
    try {
      await settle(page, `${baseUrl}${route}`);
      await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
      await page.waitForTimeout(200);
      const overflow = await documentOverflow(page);
      results.scaling.push({ route, mode: 'text-200', overflow });
      if (overflow > 1) fail(`200% text scaling overflows ${route} by ${overflow}px`);
    } catch (error) {
      fail(`text scaling ${route}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      await context.close();
    }
  }

  /* 400% browser zoom: a 1440x900 display becomes a 360x225 CSS viewport. */
  for (const route of SCALING_ROUTES) {
    const { context, page } = await openPage(browser, { width: 360, height: 225 });
    try {
      await settle(page, `${baseUrl}${route}`);
      const overflow = await documentOverflow(page);
      results.scaling.push({ route, mode: 'zoom-400', overflow });
      if (overflow > 1) fail(`400% zoom overflows ${route} by ${overflow}px`);
    } catch (error) {
      fail(`zoom ${route}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      await context.close();
    }
  }

  /* Pointer-coarse: the header controls must expose >=44px touch targets. */
  {
    const { context, page } = await openPage(browser, { width: 375, height: 812, touch: true });
    try {
      await settle(page, `${baseUrl}/`);
      const targets = await page.evaluate(() => {
        const selectors = ['.app-header .icon-button', '.avatar-button', '.notif-bell-button', '.theme-switcher-btn', '#lang-switcher-btn'];
        return selectors.map((selector) => {
          const element = document.querySelector(selector);
          if (!element) return { selector, present: false };
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          const rendered = typeof element.checkVisibility === 'function'
            ? element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
            : style.display !== 'none' && style.visibility !== 'hidden';
          return {
            selector,
            present: true,
            hidden: !rendered,
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          };
        });
      });
      for (const target of targets) {
        results.touchTargets.push(target);
        if (!target.present) { fail(`touch target missing: ${target.selector}`); continue; }
        /* A control intentionally collapsed at this width is not a target. */
        if (target.hidden) continue;
        if (target.width < 44 || target.height < 44) fail(`touch target under 44px: ${target.selector} (${target.width}x${target.height})`);
      }

      /* Visible header controls must not overlap one another. */
      const overlaps = await page.evaluate(() => {
        const selectors = ['.app-header .icon-button', '.command-button', '.notif-bell-button', '#lang-switcher-btn', '.theme-switcher', '.avatar-button'];
        const boxes = selectors.map((selector) => {
          const element = document.querySelector(selector);
          if (!element) return null;
          const style = getComputedStyle(element);
          if (style.display === 'none' || style.visibility === 'hidden') return null;
          const rect = element.getBoundingClientRect();
          return { selector, left: rect.left, right: rect.right };
        }).filter(Boolean);
        const pairs = [];
        for (let i = 0; i < boxes.length; i += 1) {
          for (let j = i + 1; j < boxes.length; j += 1) {
            const a = boxes[i];
            const b = boxes[j];
            if (a.left < b.right - 1 && b.left < a.right - 1) pairs.push(`${a.selector}<->${b.selector}`);
          }
        }
        return pairs;
      });
      results.touchTargets.push({ selector: 'header-overlap', overlaps });
      for (const pair of overlaps) fail(`header controls overlap: ${pair}`);
    } catch (error) {
      fail(`pointer-coarse: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      await context.close();
    }
  }

  await writeFile(path.join(evidenceDir, 'fe-c4-gate-e-evidence.json'), `${JSON.stringify({ generatedAt: new Date().toISOString(), ...results }, null, 2)}\n`, 'utf8');
  console.log(`[fe-c4-evidence] screenshots=${results.screenshots.length} scaling=${results.scaling.length} touchTargets=${results.touchTargets.length} failures=${results.failures.length}`);
} catch (error) {
  fail(`harness: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
} finally {
  if (browser) await browser.close().catch(() => undefined);
  if (fixture) await fixture.close().catch(() => undefined);
}

if (results.failures.length) process.exitCode = 1;
