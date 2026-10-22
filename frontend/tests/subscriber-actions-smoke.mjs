#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { build } from 'vite';

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(frontendRoot, '..');
const outputDirectory = process.env.SUBSCRIBER_UI_ARTIFACT_DIR
  ? path.resolve(process.env.SUBSCRIBER_UI_ARTIFACT_DIR)
  : path.join(repositoryRoot, 'artifacts', 'subscriber-actions');
const viewport = { width: 1920, height: 920 };
const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

async function startStaticServer(distDirectory) {
  await stat(path.join(distDirectory, 'index.html'));
  const server = createServer(async (request, response) => {
    try {
      const requestPath = decodeURIComponent(new URL(request.url || '/', 'http://127.0.0.1').pathname);
      const relativePath = requestPath === '/' ? 'index.html' : requestPath.replace(/^\/+/, '');
      const candidate = path.resolve(distDirectory, relativePath);
      const safeCandidate = candidate.startsWith(`${distDirectory}${path.sep}`) ? candidate : path.join(distDirectory, 'index.html');
      const filePath = await stat(safeCandidate).then((entry) => entry.isFile() ? safeCandidate : path.join(distDirectory, 'index.html')).catch(() => path.join(distDirectory, 'index.html'));
      const body = await readFile(filePath);
      response.writeHead(200, { 'Content-Type': contentTypes[path.extname(filePath)] || 'application/octet-stream' });
      response.end(body);
    } catch (error) {
      response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end(error instanceof Error ? error.message : 'Static server failure');
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object', 'static server must expose a TCP address');
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

const gib = 1024 ** 3;
const subscribers = Array.from({ length: 10 }, (_, index) => {
  const sequence = index + 1;
  const used = Math.min(10, 9.5 + sequence * 0.05) * gib;
  return {
    imsi: `4600200000000${String(sequence).padStart(2, '0')}`,
    msisdn: `188000000${String(sequence).padStart(2, '0')}`,
    status: 'active',
    contractStatus: 'active',
    balanceState: sequence >= 8 ? 'exhausted' : 'normal',
    policy: 'default_plan',
    policyName: 'Default 4G/5G Tariff Plan',
    policyStatus: 'active',
    provisioning: { contract: true, balance: true, tariffPlan: true },
    lastActive: new Date(Date.now() - sequence * 60_000).toISOString(),
    traffic: { used, total: 10 * gib, balance: Math.max(0, 10 * gib - used) },
  };
});

const json = (route, body, status = 200) => route.fulfill({
  status,
  contentType: 'application/json; charset=utf-8',
  body: JSON.stringify(body),
});

async function assertInsideViewport(locator, label) {
  const box = await locator.boundingBox();
  assert.ok(box, `${label} must have a visible bounding box`);
  assert.ok(box.x >= 0, `${label} must stay inside the left viewport edge`);
  assert.ok(box.y >= 0, `${label} must stay inside the top viewport edge`);
  assert.ok(box.x + box.width <= viewport.width + 1, `${label} must stay inside the right viewport edge`);
  assert.ok(box.y + box.height <= viewport.height + 1, `${label} must stay inside the bottom viewport edge`);
  return box;
}

await mkdir(outputDirectory, { recursive: true });
const temporaryBuildDirectory = process.env.SUBSCRIBER_UI_BASE_URL
  ? null
  : await mkdtemp(path.join(tmpdir(), 'xcloud-subscriber-ui-'));
if (temporaryBuildDirectory) {
  await build({ root: frontendRoot, build: { outDir: temporaryBuildDirectory, emptyOutDir: true } });
}
const ownedServer = temporaryBuildDirectory ? await startStaticServer(temporaryBuildDirectory) : null;
const baseUrl = process.env.SUBSCRIBER_UI_BASE_URL || ownedServer.baseUrl;
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport, reducedMotion: 'reduce' });
const consoleErrors = [];
const pageErrors = [];

page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text());
});
page.on('pageerror', (error) => pageErrors.push(error.message));

await page.addInitScript(() => {
  localStorage.setItem('XCLOUD_LANGUAGE_PREFERENCE', 'zh');
  localStorage.setItem('XCLOUD_THEME_PREFERENCE', 'light');
  Object.defineProperty(window, 'EventSource', { configurable: true, value: undefined });
});

await page.route('**/data/mcc-mnc-table.json', (route) => json(route, []));
await page.route('**/api/**', (route) => {
  const url = new URL(route.request().url());
  if (url.pathname === '/api/auth/me') {
    return json(route, {
      username: 'admin',
      role: 'admin',
      normalizedRole: 'admin',
      status: 'active',
      permissions: ['subscribers.read', 'subscribers.write', 'subscribers.delete', 'ocs.read', 'ocs.balance.adjust', 'profiles.read'],
    });
  }
  if (url.pathname === '/api/subscribers') {
    return json(route, {
      subscribers,
      total: subscribers.length,
      page: 1,
      limit: 10,
      summary: { total: 10, active: 10, restricted: 0, lowTraffic: 0, lowBalance: 0, unprovisioned: 0 },
    });
  }
  if (/^\/api\/subscribers\/\d{15}$/.test(url.pathname)) return json(route, {});
  if (url.pathname === '/api/profiles') return json(route, { profiles: [{ name: 'default' }] });
  if (url.pathname === '/api/tariff-plans') {
    return json(route, { plans: [{ id: 'default_plan', plan_id: 'default_plan', name: 'Default 4G/5G Tariff Plan', enabled: true }] });
  }
  return json(route, {});
});

try {
  await page.goto(`${baseUrl}/subscribers`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.locator('.subscribers-table tbody tr').nth(9).waitFor({ state: 'visible', timeout: 15_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(180);

  const rows = page.locator('.subscribers-table tbody tr');
  assert.equal(await rows.count(), 10, 'subscriber fixture must render ten rows');
  const documentWidth = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  assert.ok(documentWidth.scroll <= documentWidth.client + 1, 'subscriber page must not create viewport-level horizontal overflow');
  await page.screenshot({ path: path.join(outputDirectory, 'subscriber-page.png'), fullPage: false });

  const lastTrigger = rows.nth(9).locator('button[aria-haspopup="menu"]');
  await lastTrigger.scrollIntoViewIfNeeded();
  const lastTriggerBox = await assertInsideViewport(lastTrigger, 'last-row menu trigger');
  await lastTrigger.click();
  const menu = page.locator('body > #subscriber-row-action-menu');
  await menu.waitFor({ state: 'visible' });
  await page.waitForTimeout(180);
  const lastMenuBox = await assertInsideViewport(menu, 'last-row action menu');
  assert.ok(lastMenuBox.y + lastMenuBox.height <= lastTriggerBox.y, 'last-row menu must flip above its trigger');
  assert.equal(await menu.locator('[role="menuitem"]').count(), 3, 'action menu must expose all three actions');
  assert.equal(await menu.evaluate((node) => node.parentElement === document.body), true, 'action menu must render in the body portal');
  await page.screenshot({ path: path.join(outputDirectory, 'subscriber-last-row-menu.png'), fullPage: false });
  await page.keyboard.press('Escape');
  await menu.waitFor({ state: 'detached' });
  assert.equal(await lastTrigger.evaluate((node) => node === document.activeElement), true, 'Escape must restore focus to the trigger');

  const firstTrigger = rows.nth(0).locator('button[aria-haspopup="menu"]');
  await firstTrigger.scrollIntoViewIfNeeded();
  const firstTriggerBox = await assertInsideViewport(firstTrigger, 'first-row menu trigger');
  await firstTrigger.click();
  await menu.waitFor({ state: 'visible' });
  await page.waitForTimeout(180);
  const firstMenuBox = await assertInsideViewport(menu, 'first-row action menu');
  assert.ok(firstMenuBox.y >= firstTriggerBox.y + firstTriggerBox.height, 'first-row menu must open below its trigger');
  await page.keyboard.press('Escape');

  const viewButton = rows.nth(9).locator('.action-btn-primary').nth(0);
  await viewButton.click();
  const subscriberDialog = page.getByRole('dialog').last();
  await subscriberDialog.waitFor({ state: 'visible' });
  await page.waitForTimeout(180);
  await assertInsideViewport(subscriberDialog, 'subscriber detail dialog');
  await page.screenshot({ path: path.join(outputDirectory, 'subscriber-detail-dialog.png'), fullPage: false });
  await page.keyboard.press('Escape');
  await subscriberDialog.waitFor({ state: 'detached' });

  const trafficButton = rows.nth(9).locator('.action-btn-primary').nth(1);
  await trafficButton.click();
  const trafficDialog = page.getByRole('dialog').last();
  await trafficDialog.waitFor({ state: 'visible' });
  await assertInsideViewport(trafficDialog, 'traffic adjustment dialog');
  await page.keyboard.press('Escape');
  await trafficDialog.waitFor({ state: 'detached' });

  await lastTrigger.click();
  await menu.waitFor({ state: 'visible' });
  await menu.locator('.dropdown-menu-item.danger').click();
  const deleteDialog = page.getByRole('alertdialog');
  await deleteDialog.waitFor({ state: 'visible' });
  await page.waitForTimeout(180);
  await assertInsideViewport(deleteDialog, 'delete confirmation dialog');
  await page.screenshot({ path: path.join(outputDirectory, 'subscriber-delete-dialog.png'), fullPage: false });
  await page.keyboard.press('Escape');
  await deleteDialog.waitFor({ state: 'detached' });

  const toolbarButtons = page.locator('.page-action-buttons > button');
  await toolbarButtons.nth(0).click();
  const createDialog = page.getByRole('dialog').last();
  await createDialog.waitFor({ state: 'visible' });
  await assertInsideViewport(createDialog, 'create subscriber dialog');
  await page.keyboard.press('Escape');
  const unsavedChangesDialog = page.getByRole('alertdialog');
  if (await unsavedChangesDialog.isVisible().catch(() => false)) {
    await assertInsideViewport(unsavedChangesDialog, 'unsaved changes dialog');
    await unsavedChangesDialog.locator('button').last().click();
  }
  await page.locator('[role="dialog"]').waitFor({ state: 'detached' });

  await toolbarButtons.nth(1).click();
  const batchCreateDialog = page.getByRole('dialog').last();
  await batchCreateDialog.waitFor({ state: 'visible' });
  await assertInsideViewport(batchCreateDialog, 'batch create dialog');
  await page.keyboard.press('Escape');
  await batchCreateDialog.waitFor({ state: 'detached' });

  await rows.nth(0).locator('input[type="checkbox"]').check();
  await page.locator('.btn-bulk-outline').click();
  const batchUpdateDialog = page.getByRole('dialog').last();
  await batchUpdateDialog.waitFor({ state: 'visible' });
  await assertInsideViewport(batchUpdateDialog, 'batch update dialog');
  await page.keyboard.press('Escape');
  await batchUpdateDialog.waitFor({ state: 'detached' });

  assert.deepEqual(pageErrors, [], `page errors: ${pageErrors.join(' | ')}`);
  assert.deepEqual(consoleErrors, [], `console errors: ${consoleErrors.join(' | ')}`);
  console.log(JSON.stringify({
    result: 'PASS',
    rows: await rows.count(),
    lastMenuPlacement: 'top',
    firstMenuPlacement: 'bottom',
    dialogsChecked: ['detail', 'traffic-adjustment', 'delete-confirmation', 'create', 'batch-create', 'batch-update'],
    outputDirectory,
  }, null, 2));
} finally {
  await browser.close();
  if (ownedServer) await new Promise((resolve, reject) => ownedServer.server.close((error) => error ? reject(error) : resolve()));
  if (temporaryBuildDirectory) {
    assert.ok(temporaryBuildDirectory.startsWith(`${tmpdir()}${path.sep}xcloud-subscriber-ui-`), 'temporary build directory must stay inside the expected system temp prefix');
    await rm(temporaryBuildDirectory, { recursive: true, force: true });
  }
}
