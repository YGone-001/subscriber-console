#!/usr/bin/env node
/*
 * NF Discovery auxiliary-failure boundary acceptance.
 *
 * Renders the ALREADY BUILT production SPA (`frontend/dist`) in real Chromium
 * against a fixture server that fails exactly one read family at a time, and
 * asserts the browser-observable consequence:
 *
 *   - the KPI strip degrades to explicit "unavailable" without touching the queue;
 *   - a failed source selector keeps the loaded candidate rows;
 *   - a failed candidate read keeps the source selector usable;
 *   - a failed runtime plane disables onboarding only, never candidate reads;
 *   - an unresolved monitoring association is never rendered as "not monitored".
 *
 * These are asynchronous, request-sequence assertions: they cannot be made from
 * a static render or a source-string match, which is why this suite drives a
 * real browser instead of a component renderer.
 *
 * Usage (from frontend/): node tests/discovery-resilience.mjs
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startFixtureServer } from './nf-discovery-fixtures.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const frontendRoot = resolve(here, '..');
const distDir = process.env.XCLOUD_DISCOVERY_DIST_DIR
  ? resolve(process.env.XCLOUD_DISCOVERY_DIST_DIR)
  : resolve(frontendRoot, 'dist');

const VIEWPORT = { width: 1440, height: 900 };

/* Copy comes from the locale file so a label change fails this suite instead of
 * silently weakening it. */
const TEXT = {
  kpiUnavailable: 'unavailable',
  selectorError: 'Source list failed to load; candidates remain readable.',
  onboardingUnavailable: 'Local runtime observation is unavailable; candidate reads are unaffected.',
  unresolvedNote: 'The monitoring association lookup failed; unresolved is not unmonitored.',
  unmonitored: 'Not monitored',
  identity: 'Candidate identity',
  monitoring: 'Monitoring association',
};

const checks = [];
const failures = [];

function check(id, ok, detail = '') {
  checks.push({ id, ok: Boolean(ok), detail });
  if (!ok) failures.push(`${id} ${detail}`);
}

async function settle(page, expectedText) {
  await page.waitForSelector('.layout-root', { state: 'visible', timeout: 30000 });
  if (expectedText) {
    await page.getByText(expectedText, { exact: false }).first().waitFor({ state: 'visible', timeout: 30000 });
  }
}

async function bodyText(page) {
  return page.locator('body').innerText();
}

/* The drawer is the only surface that may claim an identity or a monitoring
 * association, so those assertions are scoped to it when it is addressable. */
async function drawerText(page) {
  const dialog = page.getByRole('dialog').first();
  if ((await dialog.count()) > 0) return dialog.innerText();
  return bodyText(page);
}

async function withPage(browser, origin, route, run) {
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
    locale: 'en-US',
    timezoneId: 'UTC',
    reducedMotion: 'reduce',
    colorScheme: 'light',
  });
  await context.addInitScript(() => {
    try {
      localStorage.setItem('XCLOUD_THEME_PREFERENCE', 'light');
      localStorage.setItem('XCLOUD_LANGUAGE_PREFERENCE', 'en');
    } catch {
      /* Storage unavailable: defaults apply. */
    }
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error?.message ?? String(error)));
  try {
    await page.goto(`${origin}${route}`, { waitUntil: 'domcontentloaded' });
    await run(page);
    check(`no_uncaught_page_error`, pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
  } finally {
    await context.close();
  }
}

const CASES = [
  {
    id: 'summary_unavailable',
    fail: ['summary'],
    route: '/discovery',
    async run(page) {
      await settle(page, 'AMF');
      const text = await bodyText(page);
      check('summary_unavailable_kpi_label', text.includes(TEXT.kpiUnavailable), 'the KPI strip must say unavailable');
      check('summary_unavailable_queue_intact', /AMF/.test(text) && /UDM/.test(text), 'the queue keeps rendering');
      check('summary_unavailable_no_scope_claim', !/full collection/i.test(text), 'an unavailable section must not claim full-collection scope');
      check(
        'summary_unavailable_rows_present',
        (await page.locator('section[data-discovery-view="candidates"] tbody tr').count()) >= 3,
        'candidate rows stay readable',
      );
    },
  },
  {
    id: 'sources_unavailable',
    fail: ['sources'],
    route: '/discovery',
    async run(page) {
      await settle(page, 'AMF');
      const text = await bodyText(page);
      check('sources_failure_note', text.includes(TEXT.selectorError), 'the selector reports its own failure');
      check('sources_failure_queue_intact', /AMF/.test(text) && /UDM/.test(text), 'the queue is not blanked by the selector');
      check(
        'sources_failure_rows_present',
        (await page.locator('section[data-discovery-view="candidates"] tbody tr').count()) >= 3,
        'candidate rows survive the auxiliary failure',
      );
    },
  },
  {
    id: 'candidates_unavailable',
    fail: ['candidates'],
    route: '/discovery',
    async run(page) {
      await settle(page, 'Candidate queue');
      const text = await bodyText(page);
      check('candidates_failure_error_state', /Error|failed/i.test(text), 'the queue reports its own failure');
      check(
        'candidates_failure_selector_intact',
        text.includes('lab-registry'),
        'the source selector stays usable when the queue fails',
      );
      check(
        'candidates_failure_no_empty_claim',
        !text.includes('No NF candidates'),
        'a failed read must not be presented as an empty population',
      );
    },
  },
  {
    id: 'runtime_unavailable',
    fail: ['runtime', 'runtime-stream'],
    route: '/discovery',
    async run(page) {
      await settle(page, 'AMF');
      await page.getByRole('button', { name: 'AMF' }).first().click();
      await page.locator('#candidate-detail-title').waitFor({ state: 'visible', timeout: 20000 });
      const text = await drawerText(page);
      check('runtime_failure_onboarding_note', text.includes(TEXT.onboardingUnavailable), 'onboarding states why it is disabled');
      check(
        'runtime_failure_identity_intact',
        new RegExp(TEXT.identity, 'i').test(text),
        'candidate identity survives runtime failure',
      );
      check(
        'runtime_failure_monitoring_intact',
        new RegExp(TEXT.monitoring, 'i').test(text),
        'the monitoring projection survives runtime failure',
      );
      check(
        'runtime_failure_candidate_actions_intact',
        (await page.locator('#candidate-detail-title').isVisible()) && text.length > 200,
        'the drawer stays usable',
      );
    },
  },
  {
    id: 'monitoring_unresolved',
    fail: [],
    monitoringVariant: 'unresolved',
    route: '/discovery',
    async run(page) {
      await settle(page, 'AMF');
      await page.getByRole('button', { name: 'AMF' }).first().click();
      await page.locator('#candidate-detail-title').waitFor({ state: 'visible', timeout: 20000 });
      const text = await drawerText(page);
      check('unresolved_reason_visible', text.includes(TEXT.unresolvedNote), 'unresolved explains itself');
      check(
        'unresolved_never_unmonitored',
        !new RegExp(`^${TEXT.unmonitored}$`, 'im').test(text),
        'unresolved must never borrow the unmonitored label',
      );
      const queue = await bodyText(page);
      check(
        'unresolved_queue_row_label',
        /monitoring unknown/i.test(queue),
        'the queue row reports the unknown association',
      );
    },
  },
  {
    id: 'runs_unavailable',
    fail: ['runs'],
    route: '/discovery?view=runs',
    async run(page) {
      await settle(page, 'Scan history');
      const text = await bodyText(page);
      check('runs_failure_error_state', /Error|failed/i.test(text), 'the run history reports its own failure');
      check(
        'runs_failure_queue_hidden',
        (await page.locator('section[data-discovery-view="candidates"]').count()) === 0,
        'the queue stays behind its own view',
      );
    },
  },
];

async function main() {
  if (!existsSync(resolve(distDir, 'index.html'))) {
    throw new Error(`built SPA not found at ${distDir}; run "npm run build" first`);
  }

  const servers = [];
  let browser;
  try {
    browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  } catch (error) {
    throw new Error(`chromium launch failed: ${error?.message ?? error}`);
  }

  try {
    for (const testCase of CASES) {
      const server = await startFixtureServer({
        distDir,
        fail: testCase.fail ?? [],
        monitoringVariant: testCase.monitoringVariant ?? 'normal',
      });
      servers.push(server);
      try {
        await withPage(browser, server.origin, testCase.route, testCase.run);
      } catch (error) {
        check(`${testCase.id}_completed`, false, error?.message ?? String(error));
      }
      await server.close();
    }
  } finally {
    await browser.close();
    for (const server of servers) {
      try {
        await server.close();
      } catch {
        /* already closed */
      }
    }
  }

  const failed = failures.length;
  for (const item of checks) {
    console.log(`${item.ok ? 'PASS' : 'FAIL'} ${item.id}${item.detail ? ` ${item.detail}` : ''}`);
  }
  console.log(`\nNF Discovery resilience acceptance: ${failed === 0 ? 'PASS' : 'FAIL'} (${checks.length - failed}/${checks.length})`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
