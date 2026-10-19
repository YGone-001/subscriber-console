#!/usr/bin/env node
/*
 * Log workspace browser acceptance.
 *
 * Renders the built SPA against a deterministic log fixture and asserts the
 * behaviours that only exist across a stream: the source list, the deep link
 * that resolves a bound resource, live frames, level changes reopening the
 * stream with the new filter, pause discarding what arrives, and the fact that
 * the page never asks for a path.
 *
 * Usage (from frontend/): node tests/nf-logs-smoke.mjs
 */
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { clearInterval, setInterval } from 'node:timers';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const frontendRoot = resolve(here, '..');
const distDir = process.env.XCLOUD_LOGS_DIST_DIR
  ? resolve(process.env.XCLOUD_LOGS_DIST_DIR)
  : resolve(frontendRoot, 'dist');

const SOURCES = [
  {
    sourceId: 'amf',
    name: 'amfd.log',
    kind: 'file',
    sizeBytes: 2048,
    updatedAt: '2026-10-19T12:00:00Z',
    readable: true,
    resourceIds: ['resource-1'],
  },
  {
    sourceId: 'smf',
    name: 'smfd.log',
    kind: 'file',
    sizeBytes: 1024,
    updatedAt: '2026-10-19T12:00:00Z',
    readable: true,
  },
];

const CAPABILITIES = {
  defaultTailLines: 100,
  maxTailLines: 500,
  levels: ['debug', 'info', 'warn', 'error'],
  maxLineBytes: 4096,
  follow: true,
  keywordIsLiteral: true,
  concurrencyPerSession: 2,
};

const SESSION = {
  username: 'operator1',
  role: 'operator',
  normalizedRole: 'operator',
  status: 'active',
  permissions: ['core.read', 'core.configure'],
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

const checks = [];
const failures = [];

function check(id, ok, detail = '') {
  checks.push({ id, ok: Boolean(ok), detail });
  if (!ok) failures.push(`${id} ${detail}`);
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function startServer() {
  const unexpected = [];
  const streamRequests = [];
  const open = new Set();

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const pathname = url.pathname;

    if (pathname === '/api/auth/me') return sendJson(res, 200, SESSION);
    if (pathname === '/api/auth/permissions') return sendJson(res, 200, { permissions: SESSION.permissions });
    if (pathname === '/api/notifications/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write('retry: 600000\n\n');
      res.write(`event: init\ndata: ${JSON.stringify({ alerts: { activeCount: 0, activeCriticalCount: 0, activeWarningCount: 0, recent: [] } })}\n\n`);
      open.add(res);
      req.on('close', () => open.delete(res));
      return undefined;
    }
    if (pathname === '/api/alerts') return sendJson(res, 200, { alerts: [] });

    if (pathname === '/api/nf-logs/sources') {
      const resourceId = url.searchParams.get('resourceId');
      const sources = resourceId
        ? SOURCES.filter((source) => (source.resourceIds ?? []).includes(resourceId))
        : SOURCES;
      return sendJson(res, 200, {
        generatedAt: '2026-10-19T12:00:00Z',
        sources,
        capabilities: CAPABILITIES,
      });
    }

    if (pathname === '/api/nf-logs/stream') {
      streamRequests.push(url.search);
      const level = url.searchParams.get('level') ?? '';
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write('retry: 3000\n\n');
      const frame = (name, payload) => res.write(`event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`);
      frame('meta', {
        sourceId: url.searchParams.get('sourceId'),
        name: 'amfd.log',
        tailLines: Number(url.searchParams.get('tailLines') ?? 100),
        level,
        follow: true,
        startedAt: '2026-10-19T12:00:00Z',
      });
      const lines = level === 'error'
        ? [{ seq: 9, level: 'error', text: 'ERROR only error lines remain' }]
        : [
          { seq: 1, level: 'info', text: 'INFO amf started with imsi [imsi]' },
          { seq: 2, level: 'warn', text: 'WARN interface latency 10.20.*.*' },
        ];
      for (const line of lines) frame('line', line);
      frame('dropped', { count: 2 });

      // Keep the stream open: a closed stream would surface as a reconnect.
      const timer = setInterval(() => {
        frame('heartbeat', { at: new Date().toISOString() });
        if (level === 'error') {
          frame('line', { seq: 10, level: 'error', text: 'ERROR late frame while paused' });
        }
      }, 400);
      open.add(res);
      req.on('close', () => {
        clearInterval(timer);
        open.delete(res);
      });
      return undefined;
    }

    if (pathname.startsWith('/api/')) {
      unexpected.push(`${req.method} ${pathname}`);
      return sendJson(res, 404, { error: 'unexpected fixture request', code: 'FIXTURE_UNEXPECTED' });
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end();
      return;
    }
    const relative = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '');
    const candidate = join(distDir, relative);
    if (relative && candidate.startsWith(distDir) && existsSync(candidate) && statSync(candidate).isFile()) {
      const body = readFileSync(candidate);
      res.writeHead(200, {
        'Content-Type': MIME[extname(candidate).toLowerCase()] ?? 'application/octet-stream',
        'Content-Length': body.length,
      });
      res.end(body);
      return;
    }
    const body = readFileSync(join(distDir, 'index.html'));
    res.writeHead(200, { 'Content-Type': MIME['.html'], 'Content-Length': body.length });
    res.end(body);
  });

  return new Promise((done) => {
    server.listen(0, '127.0.0.1', () => {
      done({
        origin: `http://127.0.0.1:${server.address().port}`,
        unexpected,
        streamRequests,
        close: () => new Promise((closed) => {
          for (const res of open) {
            try {
              res.destroy();
            } catch {
              /* already closed */
            }
          }
          server.close(closed);
        }),
      });
    });
  });
}

async function withPage(browser, origin, route, run) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
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
      /* storage unavailable */
    }
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error?.message ?? String(error)));
  try {
    await page.goto(`${origin}${route}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.layout-root', { state: 'visible', timeout: 30000 });
    await run(page);
    check('no_uncaught_page_error', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
  } finally {
    await context.close();
  }
}

async function main() {
  if (!existsSync(join(distDir, 'index.html'))) {
    throw new Error(`built SPA not found at ${distDir}; run "npm run build" first`);
  }
  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const server = await startServer();
  try {
    /* 1. Source list and explicit selection. */
    await withPage(browser, server.origin, '/logs', async (page) => {
      await page.locator('option', { hasText: 'amfd.log' }).first().waitFor({ state: 'attached', timeout: 30000 });
      const options = await page.locator('#logs-source option').allTextContents();
      check('sources_listed', options.some((text) => text.includes('amfd.log')) && options.some((text) => text.includes('smfd.log')), options.join(' | '));
      check('status_idle_before_selection', (await page.locator('[data-logs-status="idle"]').count()) === 1, 'no connection before a source is chosen');
      check('pick_source_prompt', /Select a log source/.test(await page.locator('body').innerText()), 'explicit prompt');

      await page.selectOption('#logs-source', 'amf');
      await page.getByText('INFO amf started with imsi [imsi]').first().waitFor({ timeout: 30000 });
      const text = await page.locator('body').innerText();
      check('lines_render', /WARN interface latency 10\.20\.\*\.\*/.test(text), 'both wrapped lines');
      check('stream_is_live', (await page.locator('[data-logs-status="live"]').count()) === 1, 'live status');
      check('dropped_reported', (await page.locator('[data-logs-dropped="2"]').count()) === 1, 'server drop count');
      check('stream_request_is_bounded', server.streamRequests.some((query) => query.includes('sourceId=amf') && query.includes('tailLines=100')), server.streamRequests.join(' | '));

      /* 2. Level change reopens the stream with the new filter. */
      const before = server.streamRequests.length;
      await page.selectOption('#logs-level', 'error');
      await page.getByText('ERROR only error lines remain').first().waitFor({ timeout: 30000 });
      check('level_filter_reopens_stream', server.streamRequests.length > before && server.streamRequests.some((query) => query.includes('level=error')), server.streamRequests.slice(-2).join(' | '));

      /* 3. Pause discards what arrives and says so. */
      await page.getByRole('button', { name: 'Pause view' }).click();
      // Let the batch that was already in flight land before sampling.
      await page.waitForTimeout(400);
      const linesBefore = await page.locator('[data-logs-viewport] li').count();
      await page.waitForTimeout(1200);
      const linesAfter = await page.locator('[data-logs-viewport] li').count();
      const discarded = await page.locator('[data-logs-discarded]').first().getAttribute('data-logs-discarded');
      check('paused_lines_discarded', Number(discarded) > 0, `discarded=${discarded}`);
      check('paused_badge', /View paused/.test(await page.locator('body').innerText()), 'pause is visible');
      check('paused_hides_new_lines', linesAfter === linesBefore, `before=${linesBefore} after=${linesAfter}`);

      /* 4. Resume brings the view back to live and keeps streaming. */
      await page.getByRole('button', { name: 'Resume view' }).click();
      await page.getByText('ERROR late frame while paused').first().waitFor({ timeout: 30000 });
      check('resume_appends_again', true, 'resumed view receives frames');

      check('no_unexpected_api_requests', server.unexpected.length === 0, server.unexpected.slice(0, 3).join(' | '));
    });

    /* 5. A context link resolves the resource binding without guessing. */
    await withPage(browser, server.origin, '/logs?resourceId=resource-1', async (page) => {
      await page.locator('option', { hasText: 'amfd.log' }).first().waitFor({ state: 'attached', timeout: 30000 });
      await page.waitForTimeout(500);
      const selected = await page.locator('#logs-source').inputValue();
      check('resource_link_selects_bound_source', selected === 'amf', `selected=${selected}`);
      check('resource_scope_note', /bound to this resource/.test(await page.locator('body').innerText()), 'scope is stated');
      const options = await page.locator('#logs-source option').allTextContents();
      check('resource_link_hides_unbound_sources', !options.some((text) => text.includes('smfd.log')), options.join(' | '));
    });
  } finally {
    await browser.close();
    await server.close();
  }

  const failed = failures.length;
  for (const item of checks) {
    console.log(`${item.ok ? 'PASS' : 'FAIL'} ${item.id}${item.detail ? ` ${item.detail}` : ''}`);
  }
  console.log(`\nNF Logs workspace acceptance: ${failed === 0 ? 'PASS' : 'FAIL'} (${checks.length - failed}/${checks.length})`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
