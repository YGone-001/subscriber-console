import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { startFixtureServer, TARGET_IDS } from './nf-health-fixtures.mjs';

const server = await startFixtureServer({ distDir: resolve(process.env.XCLOUD_NF_HEALTH_DIST_DIR || 'dist'), sessionKey: 'viewer' });
const browser = await chromium.launch({ headless: true });
const errors = [];
const requests = [];
try {
  const context = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Shanghai', viewport: { width: 1280, height: 900 } });
  await context.addInitScript(() => { localStorage.setItem('xcloud.language', 'en'); });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(String(error)));
  let conflict = false;
  await page.route('**/api/nf-health/meta', async route => {
    const response = await route.fetch(); const payload = await response.json();
    await route.fulfill({ json: { ...payload, metricHistory: { enabled: true, state: 'running', failures: 0 } } });
  });
  await page.route('**/api/nf-health/targets/*/metric-history?**', async route => {
    const url = new URL(route.request().url()); requests.push(url);
    if (url.searchParams.has('cursor') && conflict) return route.fulfill({ status: 409, json: { code: 'NF_METRIC_HISTORY_CHANGED', error: 'restart' } });
    const from = url.searchParams.get('from'); const to = url.searchParams.get('to');
    const segment = { identityEpoch: 'a'.repeat(64), count: 30, sum: 3000, mean: 100, min: 50, max: 150, coveredSeconds: 3540, firstObservedAt: from, lastObservedAt: to };
    await route.fulfill({ json: { metricType: 'gauge', metric: 'process_resident_memory_bytes', series: 'unlabeled', resolution: '1h', unit: 'bytes', subject: 'exporter_process', algorithmVersion: 'rss-hour-v1', from, to, watermark: 'watermark-v1', complete: false, missingHours: 23, buckets: [{ from, to: new Date(Date.parse(from) + 3600000).toISOString(), coveredSeconds: 3540, sourceComplete: true, quality: 'measured', generatedAt: to, revision: 1, excluded: {}, segments: [segment] }], page: { limit: 200, nextCursor: 'page-two', hasMore: true } } });
  });
  await page.goto(`${server.origin}/nf-health/${TARGET_IDS.amf}`);
  const panel = page.getByRole('region', { name: 'Hourly RSS history', exact: true });
  await panel.getByText('Read version:', { exact: false }).waitFor();
  assert.ok((await panel.innerText()).includes('sample means, not time averages'));
  await panel.getByText('View hourly data table', { exact: true }).click();
  assert.ok((await panel.innerText()).includes('98.3% (3540s)'));
  assert.equal(await panel.locator('tbody tr').count(), 1);
  assert.ok(requests[0].searchParams.get('metric') === 'process_resident_memory_bytes');
  assert.equal(requests[0].searchParams.get('limit'), '200');
  conflict = true;
  await panel.getByRole('button', { name: 'Next page', exact: true }).click();
  await panel.getByText('History could not be read or aggregates changed.', { exact: false }).waitFor();
  await panel.getByRole('button', { name: 'Restart from first page', exact: true }).click();
  await panel.getByText('Read version:', { exact: false }).waitFor();
  assert.equal(requests.at(-1).searchParams.has('cursor'), false);
  await page.locator('#nf-metric-history-hours').selectOption('168');
  await page.waitForURL(url => url.searchParams.get('metricHours') === '168');
  await panel.getByText('Read version:', { exact: false }).waitFor();
  assert.equal(Date.parse(requests.at(-1).searchParams.get('to')) - Date.parse(requests.at(-1).searchParams.get('from')), 168 * 3600000);
  assert.equal(errors.length, 0, errors.join('\n'));
  assert.equal(server.unexpected.length, 0, JSON.stringify(server.unexpected));
  console.log('Metric hour history browser acceptance: PASS (read-only view, UTC window, coverage table, bounded request, conflict restart, URL range, no page errors)');
  await context.close();
} finally {
  await browser.close(); await server.close();
}
