/*
 * The production SPA runs against the opt-in Go inspection fixture and its
 * owned MongoDB. No production credentials, ports or database are used.
 * Set INSPECTIONS_FIXTURE_STATE to that fixture's state file; on Windows an
 * explicit INSPECTIONS_FIXTURE_SSH alias may bridge its random loopback port.
 */
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { resolve, dirname, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const frontend = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(frontend, '..');
const stateFile = process.env.INSPECTIONS_FIXTURE_STATE;
assert.ok(stateFile, 'INSPECTIONS_FIXTURE_STATE must name an explicitly owned fixture');
const state = JSON.parse(await readFile(stateFile, 'utf8'));
assert.equal(state.synthetic, true);
assert.match(state.address, /^127\.0\.0\.1:\d+$/);
assert.match(state.database, /^test_inspections_/);
assert.match(state.token, /^[a-f0-9-]{36}$/);
const output = resolve(repo, 'output/playwright/inspections');
const review = resolve(repo, '.impeccable/review/inspections');
await Promise.all([mkdir(output, { recursive: true }), mkdir(review, { recursive: true })]);
const checks = []; const pageErrors = []; const calls = []; let tunnel; let browser; let server;
let api = `http://${state.address}`;
async function until(predicate, label, timeout = 30000) { const start = Date.now(); while (Date.now() - start < timeout) { if (await predicate()) return; await delay(100); } throw new Error(`Timed out: ${label}`); }
function check(name, condition, detail = '') { checks.push({ name, passed: Boolean(condition), detail }); assert.ok(condition, `${name}: ${detail}`); console.log(`PASS ${name}`); }
async function fixture(path, init = {}) { const response = await globalThis.fetch(`${api}${path}`, { ...init, headers: { ...init.headers, 'X-Inspection-Fixture': state.token } }); assert.ok(response.ok, `fixture ${path}: ${response.status}`); return response; }
try {
  if (process.env.INSPECTIONS_FIXTURE_SSH) {
    const reservation = createNetServer(); await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve)); const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
    tunnel = spawn('ssh', ['-N', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-L', `127.0.0.1:${port}:${state.address}`, process.env.INSPECTIONS_FIXTURE_SSH], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let tunnelError = ''; tunnel.stderr.on('data', b => { tunnelError = (tunnelError + String(b)).slice(-1000); });
    api = `http://127.0.0.1:${port}`;
    await until(async () => { if (tunnel.exitCode !== null) throw new Error(`Owned SSH bridge exited: ${tunnelError}`); try { return (await (await fixture('/__fixture/state')).json()).synthetic === true; } catch { return false; } }, 'owned SSH bridge');
  }
  check('owned Go fixture handshake', (await (await fixture('/__fixture/state')).json()).synthetic === true);
  const dist = resolve(frontend, 'dist'); await stat(resolve(dist, 'index.html'));
  const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ico': 'image/x-icon' };
  server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fixture.local');
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/__fixture/')) {
      calls.push({ method: req.method, path: url.pathname, query: url.search, at: Date.now() });
      const remote = httpRequest(new URL(req.url, api), { method: req.method, headers: { ...req.headers, host: new URL(api).host, 'X-Inspection-Fixture': state.token } }, upstream => { res.writeHead(upstream.statusCode, upstream.headers); upstream.pipe(res); });
      remote.on('error', () => { if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' }); res.end('{"error":"owned fixture unavailable"}'); });
      res.on('close', () => remote.destroy()); req.pipe(remote); return;
    }
    let file = resolve(dist, '.' + decodeURIComponent(url.pathname));
    if (!file.startsWith(dist + sep) && file !== dist) { res.writeHead(404); res.end(); return; }
    try { if (!(await stat(file)).isFile()) file = resolve(dist, 'index.html'); } catch { file = resolve(dist, 'index.html'); }
    try { const body = await readFile(file); res.writeHead(200, { 'content-type': mime[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' }); res.end(body); } catch { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, locale: 'en-US' });
  await context.addInitScript(() => { localStorage.setItem('XCLOUD_LANGUAGE_PREFERENCE', 'en'); localStorage.setItem('XCLOUD_THEME_PREFERENCE', 'light'); });
  const page = await context.newPage(); page.on('pageerror', e => pageErrors.push(e.message));
  await page.goto(`${base}/inspections`); await page.getByRole('heading', { name: 'Scheduled inspections', exact: true }).waitFor();
  await page.getByRole('link', { name: 'Create inspection plan', exact: true }).click();
  const previewsBeforeInvalid = calls.filter(v => v.path === '/api/inspection-plans/preview').length;
  await page.getByRole('button', { name: 'Preview scope and schedule', exact: true }).click();
  await page.getByRole('alert', { name: 'Correct the following inputs', exact: true }).waitFor();
  check('invalid preview focuses a linked field error summary without a request', await page.getByRole('alert', { name: 'Correct the following inputs', exact: true }).evaluate(e => e === document.activeElement) && calls.filter(v => v.path === '/api/inspection-plans/preview').length === previewsBeforeInvalid && await page.getByLabel('Plan name', { exact: true }).getAttribute('aria-invalid') === 'true');
  await page.getByRole('alert', { name: 'Correct the following inputs', exact: true }).getByRole('link').first().click(); check('error summary link focuses its correction field', await page.getByLabel('Plan name', { exact: true }).evaluate(e => e === document.activeElement));
  await page.getByLabel('Plan name', { exact: true }).fill('SYNTHETIC station duty'); await page.getByLabel('Scope selection').selectOption('all');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click(); await page.getByRole('alertdialog').waitFor(); await page.getByRole('button', { name: 'Keep editing', exact: true }).click();
  check('navigation guard preserves unsaved plan and restores focus', await page.getByLabel('Plan name', { exact: true }).inputValue() === 'SYNTHETIC station duty' && await page.getByRole('button', { name: 'Cancel', exact: true }).evaluate(e => document.activeElement === e));
  check('save requires preview', await page.getByRole('button', { name: 'Save paused plan', exact: true }).isDisabled());
  await page.getByRole('button', { name: 'Preview scope and schedule', exact: true }).click();
  await page.getByRole('heading', { name: 'Next five scheduled occurrences' }).waitFor();
  check('preview captures actual bounded scope', (await page.locator('main').innerText()).includes('3 resources and 1 remote Agents'));
  await page.getByRole('button', { name: 'Save paused plan', exact: true }).click(); await page.waitForURL(/\/inspections\/plans\//);
  const planId = new URL(page.url()).pathname.split('/').at(-1); assert.match(planId, /^[a-f0-9-]{36}$/);
  await page.locator('[data-state="paused"]').waitFor(); check('created plan starts paused', await page.getByRole('button', { name: 'Enable plan', exact: true }).isVisible());
  await page.getByRole('button', { name: 'Run inspection', exact: true }).click(); await page.waitForURL(/\/inspections\/runs\//);
  await page.locator('[data-state="completed"]').waitFor({ timeout: 45000 }); const firstRunId = new URL(page.url()).pathname.split('/').at(-1);
  check('manual report separates completion and findings', await page.locator('[data-state="findings"]').isVisible());
  const snapshot = await (await page.request.get(`${base}/api/inspection-runs/${firstRunId}/export?format=json`)).text();
  const getCount = () => calls.filter(v => v.method === 'GET' && v.path === `/api/inspection-runs/${firstRunId}`).length;
  const beforePolling = getCount(); await delay(2200); check('terminal report polling stops', getCount() === beforePolling);
  await fixture('/__fixture/evidence/stale', { method: 'POST' }); await page.reload(); await page.locator('[data-state="completed"]').waitFor();
  const unchanged = await (await page.request.get(`${base}/api/inspection-runs/${firstRunId}/export?format=json`)).text();
  check('source changes do not rewrite a fixed report', snapshot === unchanged);
  const csv = await page.request.get(`${base}/api/inspection-runs/${firstRunId}/export?format=csv`); check('CSV and JSON export fixed report identity', csv.ok() && (await csv.text()).includes(firstRunId) && JSON.parse(snapshot).runId === firstRunId);
  await page.getByRole('link', { name: 'Open plan', exact: true }).click(); await page.getByRole('button', { name: 'Run inspection', exact: true }).click(); await page.waitForURL(/\/inspections\/runs\//); await page.locator('[data-state="completed"]').waitFor({ timeout: 45000 });
  const reportId = new URL(page.url()).pathname.split('/').at(-1); await page.getByLabel('Check result', { exact: true }).selectOption('unknown'); await page.getByRole('button', { name: 'Show evidence', exact: true }).first().waitFor();
  await page.getByRole('button', { name: 'Show evidence', exact: true }).first().click(); check('stale evidence stays unknown with visible provenance', await page.getByRole('link', { name: 'Open source workspace', exact: true }).isVisible());
  await page.goto(`${base}/inspections/plans/${planId}`); await page.getByRole('button', { name: 'Enable plan', exact: true }).click(); await page.getByRole('dialog').getByRole('button', { name: 'Confirm', exact: true }).click(); await page.locator('[data-state="enabled"]').waitFor();
  await fixture(`/__fixture/due/${planId}`, { method: 'POST' });
  await until(async () => { const data = await (await page.request.get(`${base}/api/inspection-runs?planId=${planId}&limit=20`)).json(); return data.items.some(v => v.mode === 'scheduled' && v.state === 'completed'); }, 'scheduled report completion');
  check('enabled schedule produces a persisted execution', true);
  await fixture(`/__fixture/due/${planId}?missed=1`, { method: 'POST' });
  const missed = await (await page.request.get(`${base}/api/inspection-runs?planId=${planId}&state=missed&limit=20`)).json(); check('missed occurrence is not backfilled', missed.items.length === 1 && missed.items[0].startedAt == null);
  await page.getByRole('button', { name: 'Pause plan', exact: true }).click(); await page.getByRole('dialog').getByRole('button', { name: 'Confirm', exact: true }).click(); await page.locator('[data-state="paused"]').waitFor();
  await page.getByRole('button', { name: 'Edit', exact: true }).click(); await page.getByLabel('Description', { exact: true }).fill('SYNTHETIC retained draft');
  await fixture(`/__fixture/conflict/${planId}`, { method: 'POST' }); await page.getByRole('button', { name: 'Preview scope and schedule', exact: true }).click(); await page.getByRole('heading', { name: 'Next five scheduled occurrences' }).waitFor(); await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await page.getByText('The plan changed. Your draft is preserved.', { exact: false }).waitFor(); check('CAS conflict retains unsaved draft', await page.getByLabel('Description', { exact: true }).inputValue() === 'SYNTHETIC retained draft');
  await page.getByText('Resolve version conflict', { exact: true }).click(); await page.getByRole('button', { name: 'Discard draft and load latest', exact: true }).click(); check('explicit conflict reload loads current version', await page.getByLabel('Description', { exact: true }).inputValue() === 'SYNTHETIC external edit');
  const viewer = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'en-US' }); await viewer.addCookies([{ name: 'inspection_fixture_role', value: 'viewer', url: base }]); await viewer.addInitScript(() => localStorage.setItem('XCLOUD_LANGUAGE_PREFERENCE', 'en'));
  const viewerPage = await viewer.newPage(); viewerPage.on('pageerror', e => pageErrors.push(e.message)); await viewerPage.goto(`${base}/inspections`); await viewerPage.getByRole('heading', { name: 'Scheduled inspections', exact: true }).waitFor(); check('viewer has no create control', await viewerPage.getByRole('link', { name: 'Create inspection plan', exact: true }).count() === 0);
  const denied = await viewerPage.request.post(`${base}/api/inspection-plans/${planId}/runs`, { data: {} }); check('viewer mutation rejected by actual Go handler', denied.status() === 403);
  await viewerPage.route('**/api/inspections/meta', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ readiness: 'unavailable', reason: 'INSPECTION_INDEXES_REQUIRED', retainedRuns: null, queuedRuns: null, maxRetainedRuns: 512, retentionDays: 90, running: true }) })); await viewerPage.reload(); await viewerPage.getByText('Inspection storage has not been initialized.', { exact: false }).waitFor(); check('uninitialized storage has actionable unavailable state', true); await viewer.close();
  const capture = async (name, viewport, language, theme, path, scale = 1) => {
    const c = await browser.newContext({ viewport, deviceScaleFactor: scale, locale: language === 'zh' ? 'zh-CN' : 'en-US' });
    await c.addInitScript(({ language, theme }) => { localStorage.setItem('XCLOUD_LANGUAGE_PREFERENCE', language); localStorage.setItem('XCLOUD_THEME_PREFERENCE', theme); }, { language, theme });
    const p = await c.newPage(); p.on('pageerror', e => pageErrors.push(e.message)); await p.goto(`${base}${path}`); await p.locator('[data-state="completed"]').waitFor(); await p.getByRole('table').last().waitFor(); await p.evaluate(() => document.fonts.ready);
    const overflow = await p.evaluate(() => ({ viewport: window.innerWidth, body: document.documentElement.scrollWidth })); check(`viewport ${name} has no page overflow`, overflow.body <= overflow.viewport + 1, JSON.stringify(overflow));
    const untranslated = await p.locator('main').innerText(); check(`viewport ${name} has translated inspection copy`, !/inspection_(?:reason|status|kind|comparison|error)_/.test(untranslated));
    await p.screenshot({ path: resolve(review, `${name}.png`), fullPage: true, animations: 'disabled' });
    await p.getByRole('table').last().scrollIntoViewIfNeeded(); await p.getByRole('button', { name: language === 'zh' ? '查看依据' : 'Show evidence', exact: true }).first().click();
    await p.screenshot({ path: resolve(review, `${name}-evidence.png`), fullPage: true, animations: 'disabled' });
    if (name === 'desktop' || name === 'mobile') {
      await p.goto(`${base}/inspections`); await p.getByRole('table').waitFor(); await p.screenshot({ path: resolve(review, `${name}-directory.png`), fullPage: true, animations: 'disabled' });
      await p.goto(`${base}/inspections/new`); await p.locator('#inspection-name').waitFor(); await p.screenshot({ path: resolve(review, `${name}-editor.png`), fullPage: true, animations: 'disabled' });
      await p.locator('#inspection-cadence').scrollIntoViewIfNeeded(); await p.screenshot({ path: resolve(review, `${name}-editor-schedule.png`), fullPage: true, animations: 'disabled' });
      await p.locator('form button[type="button"]').filter({ hasText: language === 'zh' ? '预览范围与时间' : 'Preview scope and schedule' }).click();
      await p.getByRole('alert', { name: language === 'zh' ? '请修正以下输入' : 'Correct the following inputs', exact: true }).waitFor();
      await p.screenshot({ path: resolve(review, `${name}-editor-invalid.png`), fullPage: true, animations: 'disabled' });
    }
    await c.close();
  };
  const reportPath = `/inspections/runs/${reportId}`;
  await capture('desktop', { width: 1600, height: 1000 }, 'zh', 'light', reportPath);
  await capture('mobile', { width: 375, height: 900 }, 'zh', 'light', reportPath);
  await capture('tablet', { width: 768, height: 1024 }, 'en', 'light', reportPath);
  await capture('dark', { width: 1440, height: 1000 }, 'en', 'dark', reportPath);
  await capture('reflow-200-equivalent', { width: 640, height: 500 }, 'zh', 'light', reportPath, 2);
  await context.close(); check('no browser runtime errors', pageErrors.length === 0, pageErrors.join('; '));
} catch (error) {
  checks.push({ name: 'acceptance completed', passed: false, detail: error.stack || String(error) }); process.exitCode = 1; console.error(error);
} finally {
  await browser?.close(); if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  if (tunnel) { tunnel.kill(); await Promise.race([new Promise(resolve => tunnel.once('exit', resolve)), delay(5000)]); }
  await writeFile(resolve(output, 'results.json'), JSON.stringify({ synthetic: true, realGoAndIsolatedMongo: true, checks, pageErrors, screenshotDirectory: review, requests: calls, zoomEvidence: '640 CSS px at DPR 2 models 200 percent reflow; no native browser zoom claim' }, null, 2));
}
