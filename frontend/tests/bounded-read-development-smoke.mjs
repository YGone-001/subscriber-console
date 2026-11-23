#!/usr/bin/env node
/* global setTimeout */
/*
 * Bounded read cancellation acceptance.
 *
 * Runs the real useBoundedRead hook inside StrictMode against a development
 * Vite server. Every assertion is driven by observed request records or by the
 * rendered consumer state; no fixed sleep is used to prove that a read settled.
 */
import { createServer } from 'node:http';
import { clearTimeout } from 'node:timers';
import { setTimeout as delay } from 'node:timers/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer as createViteServer } from 'vite';
import { chromium } from 'playwright';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, '../output/playwright/bounded-read-development');
const requests = [];
const errors = [];
let nextRequestId = 1;

const checks = [];
const failures = [];
function check(id, condition, description) {
  const result = { id, condition: Boolean(condition), description };
  checks.push(result);
  if (!result.condition) {
    failures.push(`${id}: ${description}`);
    console.error(`  not ok ${id} - ${description}`);
    if (process.env.GITHUB_ACTIONS) console.log(`::error title=${id}::${description.replace(/\s+/g, ' ')}`);
  } else {
    console.log(`  ok ${id} - ${description}`);
  }
}

const vite = await createViteServer({ root, server: { middlewareMode: true, hmr: false }, appType: 'custom' });
const html = '<!doctype html><html><head><title>Bounded read development fixture</title></head><body><div id="root"></div><script type="module" src="/tests/fixtures/bounded-read-development.tsx"></script></body></html>';
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://fixture.local');
  if (url.pathname === '/api/bounded-read-fixture') {
    const scope = url.searchParams.get('scope');
    const entry = { id: nextRequestId++, scope, started: true, completed: false, aborted: false };
    requests.push(entry);
    let settled = false;
    const settle = () => {
      if (settled || res.destroyed) return;
      settled = true;
      if (scope === 'will-fail') {
        entry.completed = true;
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'fixture failure' }));
        return;
      }
      entry.completed = true;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ scope }));
    };
    const timer = setTimeout(settle, scope === 'slow' ? 1500 : scope === 'will-fail' ? 60 : 500);
    res.on('close', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      entry.aborted = true;
    });
    return;
  }
  if (url.pathname === '/') {
    res.setHeader('Content-Type', 'text/html');
    res.end(await vite.transformIndexHtml(req.url, html));
    return;
  }
  vite.middlewares(req, res, () => { res.statusCode = 404; res.end(); });
});

async function waitUntil(predicate, label, timeout = 15000) {
  const start = Date.now();
  for (;;) {
    if (predicate()) return;
    if (Date.now() - start > timeout) throw new Error(`Timed out waiting for ${label}`);
    await delay(20);
  }
}

async function waitState(page, id, state, timeout = 15000) {
  await page.waitForFunction(
    ([selectorId, expected]) => document.getElementById(selectorId)?.getAttribute('data-state') === expected,
    [id, state],
    { timeout },
  );
}

async function waitData(page, id, scope, timeout = 15000) {
  await page.waitForFunction(
    ([selectorId, expected]) => {
      const node = document.getElementById(selectorId);
      return node?.getAttribute('data-state') === 'data' && node.textContent === expected;
    },
    [id, scope],
    { timeout },
  );
}

async function waitSettled(page, id, timeout = 15000) {
  await page.waitForFunction(
    (selectorId) => document.getElementById(selectorId)?.getAttribute('data-validating') === 'false',
    id,
    { timeout },
  );
}

let browser;
const result = { result: 'FAIL', checks, requests, errors };
try {
  await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveListen); });
  browser = await chromium.launch({ headless: true });
  const origin = `http://127.0.0.1:${server.address().port}`;

  const openPage = async () => {
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    page.on('pageerror', (error) => errors.push(error.message));
    const base = requests.length;
    await page.goto(origin);
    await waitData(page, 'primary', 'first');
    await waitData(page, 'secondary', 'first');
    return { page, base };
  };

  /* StrictMode runs the consumer effect twice; one request must still serve two
   * consumers, and no cancellation may be reported for a shared read. */
  {
    const { page, base } = await openPage();
    const issued = requests.slice(base);
    check('BR-01', issued.filter((item) => item.scope === 'first').length === 1, 'StrictMode replay keeps one shared request for two consumers');
    check('BR-02', issued.every((item) => !item.aborted), 'no consumer cancelled a request it still needs');
    check('BR-03', await page.locator('#primary').getAttribute('data-state') === 'data', 'a shared consumer receives data, not a permanent loading state');
    await page.close();
  }

  /* One consumer unmounting must not cancel the request the remaining consumer
   * still depends on; unmounting the last consumer releases the request. */
  {
    const { page, base } = await openPage();
    await page.click('#slow');
    await waitState(page, 'primary', 'loading');
    await waitUntil(() => requests.slice(base).some((item) => item.scope === 'slow'), 'slow request to start');
    await page.click('#peer');
    await waitData(page, 'primary', 'slow');
    const slowAfterPeer = requests.slice(base).find((item) => item.scope === 'slow');
    check('BR-04', slowAfterPeer && slowAfterPeer.aborted === false, 'removing one consumer does not cancel the shared read');
    check('BR-05', await page.locator('#primary').getAttribute('data-state') === 'data', 'the remaining consumer still settles with data');

    await page.click('#reload');
    await waitUntil(() => requests.slice(base).filter((item) => item.scope === 'slow').length === 2, 'second slow request to start');
    await page.click('#toggle');
    await page.click('#peer');
    await waitUntil(() => requests.slice(base).filter((item) => item.scope === 'slow')[1]?.aborted === true, 'last consumer to release the request');
    check('BR-06', true, 'unmounting the final consumer aborts the obsolete request');
    check('BR-07', await page.locator('#primary').count() === 0, 'the final consumer is unmounted instead of being held loading');

    await page.click('#toggle');
    await page.click('#peer');
    const beforeRemountReload = requests.slice(base).filter((item) => item.scope === 'slow').length;
    await page.click('#reload');
    await waitUntil(() => requests.slice(base).filter((item) => item.scope === 'slow').length > beforeRemountReload, 'remounted read to start');
    await waitUntil(
      () => Boolean(requests.slice(base).filter((item) => item.scope === 'slow').at(-1)?.completed || requests.slice(base).filter((item) => item.scope === 'slow').at(-1)?.aborted),
      'remounted read to settle',
    );
    await waitData(page, 'primary', 'slow');
    const latestSlow = requests.slice(base).filter((item) => item.scope === 'slow').at(-1);
    check(
      'BR-08',
      latestSlow?.completed === true && latestSlow?.aborted === false,
      'a remounted consumer completes a new read for the same key after cancellation',
    );
    await page.close();
  }

  /* Aborted read followed by a valid read: the aborted response must never
   * replace the newer data. */
  {
    const { page, base } = await openPage();
    await page.click('#slow');
    await waitUntil(() => requests.slice(base).some((item) => item.scope === 'slow'), 'slow request to start');
    await page.click('#next');
    await waitData(page, 'primary', 'next');
    await waitData(page, 'secondary', 'next');
    check('BR-09', await page.locator('#primary').textContent() === 'next' && await page.locator('#secondary').textContent() === 'next', 'an aborted response never becomes visible data');
    await waitUntil(() => requests.slice(base).find((item) => item.scope === 'slow')?.aborted === true, 'aborted slow response');
    check('BR-10', await page.locator('#primary').getAttribute('data-state') === 'data', 'the valid newer response settles instead of the aborted one');
    check('BR-11', await page.locator('#primary').getAttribute('data-validating') === 'false', 'SWR validating state settles after cancellation');
    await page.close();
  }

  /* Rapid A -> B -> A transitions under a shared key. */
  {
    const { page, base } = await openPage();
    await page.click('#slow');
    await waitUntil(() => requests.slice(base).some((item) => item.scope === 'slow'), 'slow request to start');
    const firstReadsBeforeReturn = requests.slice(base).filter((item) => item.scope === 'first').length;
    await page.click('#next');
    await page.click('#first');
    await waitData(page, 'primary', 'first');
    await waitData(page, 'secondary', 'first');
    check('BR-12', await page.locator('#primary').getAttribute('data-state') === 'data', 'rapid A -> B -> A keeps the final key readable');
    await waitUntil(() => requests.slice(base).find((item) => item.scope === 'slow')?.aborted === true, 'superseded slow request');
    /* Returning to a key that is already cached renders the cached value with
     * isValidating=false before SWR registers the revalidation, so a settled
     * predicate can sample that window and prove nothing about the final read.
     * The final key's own request is the only evidence that it has settled: wait
     * for that read to start and cross a boundary before trusting the state. */
    await waitUntil(
      () => requests.slice(base).filter((item) => item.scope === 'first').length > firstReadsBeforeReturn,
      'final key revalidation to start',
    );
    await waitUntil(
      () => {
        const lastFirstRead = requests.slice(base).filter((item) => item.scope === 'first').at(-1);
        return Boolean(lastFirstRead && (lastFirstRead.completed || lastFirstRead.aborted));
      },
      'final key revalidation to settle',
    );
    await waitSettled(page, 'primary');
    check('BR-13', await page.locator('#primary').getAttribute('data-validating') === 'false', 'rapid key transitions settle without a retained pending read');
    await page.close();
  }

  /* An aborted request followed by a real HTTP failure must show the failure. */
  {
    const { page, base } = await openPage();
    await page.click('#slow');
    await waitUntil(() => requests.slice(base).some((item) => item.scope === 'slow'), 'slow request to start');
    await page.click('#will-fail');
    await waitState(page, 'primary', 'error');
    check('BR-14', await page.locator('#primary').getAttribute('data-state') === 'error', 'a real HTTP failure remains visible after an abort');
    await waitUntil(() => requests.slice(base).find((item) => item.scope === 'slow')?.aborted === true, 'aborted slow request');
    check('BR-15', await page.locator('#primary').getAttribute('data-state') !== 'data', 'the cancelled read is not reported as successful data');
    await page.click('#first');
    await waitData(page, 'primary', 'first');
    check('BR-16', await page.locator('#primary').getAttribute('data-state') === 'data', 'recovery after an aborted and failed read succeeds');
    await page.close();
  }

  /* Same-key explicit refetch after an abort settles and re-validates once. */
  {
    const { page, base } = await openPage();
    await page.click('#slow');
    await waitUntil(() => requests.slice(base).some((item) => item.scope === 'slow'), 'slow request to start');
    await page.click('#toggle');
    await page.click('#peer');
    await waitUntil(() => requests.slice(base).find((item) => item.scope === 'slow')?.aborted === true, 'slow request release');
    await page.click('#toggle');
    await page.click('#peer');
    await waitData(page, 'primary', 'slow');
    const beforeReload = requests.slice(base).filter((item) => item.scope === 'slow').length;
    await page.click('#reload');
    await waitUntil(() => requests.slice(base).filter((item) => item.scope === 'slow').length > beforeReload, 'refetch request to start');
    await waitUntil(
      () => Boolean(requests.slice(base).filter((item) => item.scope === 'slow').at(-1)?.completed || requests.slice(base).filter((item) => item.scope === 'slow').at(-1)?.aborted),
      'refetch request to settle',
    );
    await waitData(page, 'primary', 'slow');
    await waitSettled(page, 'primary');
    const latestRefetch = requests.slice(base).filter((item) => item.scope === 'slow').at(-1);
    check('BR-17', Boolean(latestRefetch && latestRefetch.completed && !latestRefetch.aborted), 'the explicit refetch after an abort completes successfully');
    check('BR-18', await page.locator('#primary').getAttribute('data-validating') === 'false', 'refetch after abort settles its validating state');
    await page.close();
  }

  check('BR-19', errors.length === 0, `zero uncaught page exceptions (${errors.length})`);

  await mkdir(output, { recursive: true });
  result.result = failures.length === 0 ? 'PASS' : 'FAIL';
  result.checks = checks;
  result.requests = requests;
  result.errors = errors;
  console.log(JSON.stringify(result, null, 2));
  if (failures.length > 0) {
    console.error(`[acceptance:bounded-read] FAILED ${failures.length} check(s) of ${checks.length}`);
    process.exitCode = 1;
  } else {
    console.log(`[acceptance:bounded-read] passed ${checks.length}/${checks.length} assertions`);
  }
} catch (error) {
  result.result = 'FAIL';
  result.error = String(error);
  errors.push(String(error));
  console.error('[acceptance:bounded-read] Fatal error during test execution:', error);
  if (process.env.GITHUB_ACTIONS) console.log(`::error title=BR-FATAL::${String(error).replace(/\s+/g, ' ')}`);
  process.exitCode = 1;
} finally {
  await mkdir(output, { recursive: true });
  await writeFile(join(output, 'results.json'), JSON.stringify(result, null, 2));
  if (browser) await browser.close();
  await vite.close();
  await new Promise((resolveClose) => server.close(resolveClose));
}