#!/usr/bin/env node
/* global URLSearchParams, fetch, MessageEvent, Event, getComputedStyle */
/*
 * Log Center lifecycle acceptance.
 *
 * The streaming benchmark covers volume; this harness covers the transitions
 * around it. It renders the real production SPA and the real useLogStream hook
 * against a deterministic SSE fixture, then asserts the invariants that only
 * exist across a source change, an automatic reconnect and an unreadable
 * source:
 *
 *   - a source change closes the old stream and never mixes its frames into
 *     the new view;
 *   - the fixture's frames are injected on the live EventSource object so the
 *     switch is synchronous with the frame delivery (no wall-clock race);
 *   - an automatic reconnect is a new tail, so the replayed click does not
 *     duplicate the previous scrollback in the rendered window;
 *   - a source the registry declares unreadable is never opened and is not
 *     presented as a live connection;
 *   - the connection-status live region does not announce the high-volume
 *     counters;
 *   - the keyword field shows a visible keyboard focus indicator.
 *
 * Usage (from frontend/): node tests/log-center-lifecycle-smoke.mjs
 */
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const frontendRoot = resolve(here, '..');
const configuredDistDir = process.env.XCLOUD_LOGS_DIST_DIR
  ? resolve(process.env.XCLOUD_LOGS_DIST_DIR)
  : resolve(frontendRoot, 'dist');

const SOURCES = [
  {
    sourceId: 'amf',
    name: 'amfd.log',
    kind: 'file',
    sizeBytes: 4096,
    updatedAt: '2026-11-20T12:00:00Z',
    readable: true,
    resourceIds: ['resource-1'],
  },
  {
    sourceId: 'smf',
    name: 'smfd.log',
    kind: 'file',
    sizeBytes: 2048,
    updatedAt: '2026-11-20T12:00:00Z',
    readable: true,
  },
  {
    sourceId: 'locked',
    name: 'locked.log',
    kind: 'file',
    sizeBytes: 0,
    readable: false,
    note: 'the service account cannot read this file',
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

/* Per-source tails. `initial` is what a first connection re-tails; `replay` is
 * what the server sends after an automatic reconnect (the same file read
 * again). A scenario arms `replay` explicitly so the harness never depends on
 * how many pages ran before it. */
const SCRIPTS = {
  amf: {
    initial: [1, 2, 3, 4, 5, 6].map((n) => ({ seq: n, level: 'info', text: `INFO idle tick ${n}` })),
    replay: [
      { seq: 1, level: 'info', text: 'INFO idle tick 1' },
      { seq: 2, level: 'info', text: 'INFO idle tick 2' },
      { seq: 3, level: 'info', text: 'INFO idle tick 3' },
      { seq: 4, level: 'info', text: 'INFO idle tick 7' },
    ],
  },
  smf: { initial: [], replay: [] },
};

function startServer(distDir) {
  const unexpected = [];
  const requests = new Map();
  const open = new Map();
  const armed = new Set();

  const nextScript = (source) => {
    const scripts = SCRIPTS[source] ?? { initial: [], replay: [] };
    if (armed.has(source)) {
      armed.delete(source);
      return scripts.replay;
    }
    return scripts.initial;
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const pathname = url.pathname;

    if (pathname === '/__fx/state') {
      const snapshot = {};
      for (const source of SOURCES) {
        snapshot[source.sourceId] = {
          requests: requests.get(source.sourceId) ?? 0,
          open: (open.get(source.sourceId) ?? []).filter((res) => !res.writableEnded).length,
        };
      }
      return sendJson(res, 200, snapshot);
    }

    if (pathname === '/__fx/send') {
      const source = url.searchParams.get('source') ?? '';
      const lines = (url.searchParams.get('lines') ?? '').split('|').filter(Boolean);
      const targets = (open.get(source) ?? []).filter((entry) => !entry.writableEnded);
      let sent = 0;
      for (const entry of targets) {
        for (const text of lines) {
          sent += 1;
          entry.write(`event: line\ndata: ${JSON.stringify({ seq: sent, level: 'info', text })}\n\n`);
        }
      }
      return sendJson(res, 200, { sent });
    }

    if (pathname === '/__fx/arm') {
      const source = url.searchParams.get('source') ?? '';
      armed.add(source);
      return sendJson(res, 200, { armed: source });
    }

    if (pathname === '/__fx/close') {
      const source = url.searchParams.get('source') ?? '';
      for (const entry of open.get(source) ?? []) {
        if (!entry.writableEnded) entry.end();
      }
      return sendJson(res, 200, { closed: true });
    }

    if (pathname === '/api/auth/me') return sendJson(res, 200, SESSION);
    if (pathname === '/api/auth/permissions') return sendJson(res, 200, { permissions: SESSION.permissions });
    if (pathname === '/api/operations/summary') {
      return sendJson(res, 200, {
        generatedAt: '2026-11-20T12:00:00Z',
        sections: ['alerts'],
        alerts: {
          completeness: 'complete',
          scope: 'full_collection',
          alerts: { totalRules: 0, enabledRules: 0, alertsByState: {}, openBySeverity: {} },
        },
      });
    }
    if (pathname === '/api/alerts') return sendJson(res, 200, { alerts: [] });
    if (pathname === '/api/notifications/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write('retry: 600000\n\n');
      res.write('event: init\ndata: {"alerts":{"activeCount":0,"activeCriticalCount":0,"activeWarningCount":0,"recent":[]}}\n\n');
      return undefined;
    }

    if (pathname === '/api/nf-logs/sources') {
      const resourceId = url.searchParams.get('resourceId');
      const sources = resourceId
        ? SOURCES.filter((source) => (source.resourceIds ?? []).includes(resourceId))
        : SOURCES;
      return sendJson(res, 200, { generatedAt: '2026-11-20T12:00:00Z', sources, capabilities: CAPABILITIES });
    }

    if (pathname === '/api/nf-logs/stream') {
      const source = url.searchParams.get('sourceId') ?? '';
      /* Every attempt is recorded before the request is judged: an unreadable
       * source must be provably never asked for. */
      requests.set(source, (requests.get(source) ?? 0) + 1);
      const known = SOURCES.find((item) => item.sourceId === source);
      if (!known) {
        return sendJson(res, 404, { error: 'log source not found', code: 'NF_LOG_SOURCE_NOT_FOUND' });
      }
      if (!known.readable) {
        /* What the real handler does when os.Open fails or the journal is
         * unavailable: the stream never starts. */
        return sendJson(res, 409, { error: 'log source is not readable', code: 'NF_LOG_SOURCE_UNREADABLE' });
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write('retry: 200\n\n');
      const frame = (name, payload) => res.write(`event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`);
      frame('meta', {
        sourceId: source,
        name: known.name,
        tailLines: Number(url.searchParams.get('tailLines') ?? 100),
        follow: true,
        startedAt: '2026-11-20T12:00:00Z',
      });
      const script = nextScript(source);
      for (const line of script) frame('line', line);
      res.write('\n');
      const bucket = open.get(source) ?? [];
      bucket.push(res);
      open.set(source, bucket);
      req.on('close', () => {
        const remaining = (open.get(source) ?? []).filter((entry) => entry !== res);
        open.set(source, remaining);
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
        requests,
        close: () => new Promise((closed) => {
          for (const bucket of open.values()) {
            for (const res of bucket) {
              try {
                res.destroy();
              } catch {
                /* already closed */
              }
            }
          }
          server.close(closed);
        }),
      });
    });
  });
}

async function control(origin, route, params = {}) {
  const query = new URLSearchParams(params).toString();
  const response = await fetch(`${origin}${route}${query ? `?${query}` : ''}`);
  return response.json();
}

/* Instrument the transport: keep the native EventSource (so the hook runs its
 * real connection) and add a registry so the fixture can deliver a frame in the
 * same task as the source change. */
async function installTransportProbe(context) {
  await context.addInitScript(() => {
    const Native = window.EventSource;
    const entries = [];
    function Wrapped(url, config) {
      const source = new Native(url, config);
      entries.push({ url: String(url), source });
      return source;
    }
    Wrapped.CONNECTING = 0;
    Wrapped.OPEN = 1;
    Wrapped.CLOSED = 2;
    Wrapped.prototype = Native.prototype;
    window.EventSource = Wrapped;
    window.__fxTransport = {
      entries,
      dispatch(fragment, name, payload) {
        const entry = entries.filter((item) => item.url.includes(fragment)).at(-1);
        if (!entry) return false;
        entry.source.dispatchEvent(new MessageEvent(name, { data: JSON.stringify(payload) }));
        return true;
      },
      openUrls() {
        return entries.filter((item) => item.source.readyState === 1).map((item) => item.url);
      },
    };
  });
}

async function withPage(browser, origin, route, run, options = {}) {
  const context = await browser.newContext({
    viewport: options.viewport ?? { width: 1440, height: 900 },
    locale: options.locale ?? 'en-US',
    timezoneId: 'UTC',
    reducedMotion: 'reduce',
    colorScheme: options.colorScheme ?? 'light',
  });
  await context.addInitScript((preferences) => {
    try {
      localStorage.setItem('XCLOUD_THEME_PREFERENCE', preferences.theme);
      localStorage.setItem('XCLOUD_LANGUAGE_PREFERENCE', preferences.language);
    } catch {
      /* storage unavailable */
    }
  }, { language: options.language ?? 'en', theme: options.theme ?? 'light' });
  await installTransportProbe(context);
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error?.message ?? String(error)));
  try {
    await page.goto(`${origin}${route}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.layout-root', { state: 'visible', timeout: 30000 });
    await run(page);
    check(`no_uncaught_page_error_${options.tag ?? ''}`, pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
  } finally {
    await context.close();
  }
}

const rowTexts = (page) => page.evaluate(() => (
  Array.from(document.querySelectorAll('[data-logs-viewport="true"] li')).map((node) => node.textContent || '')
));

async function main() {
  /* A clean checkout has no dist; the harness owns the build it measures, the
   * same way the streaming benchmark does. */
  let distDir = configuredDistDir;
  let temporaryDist = null;
  if (!existsSync(join(distDir, 'index.html'))) {
    const { build } = await import('vite');
    temporaryDist = await mkdtemp(join(tmpdir(), 'xcloud-log-lifecycle-'));
    await build({ root: frontendRoot, build: { outDir: temporaryDist, emptyOutDir: true }, logLevel: 'warn' });
    distDir = temporaryDist;
  }
  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const server = await startServer(distDir);
  try {
    /* 1. A source change closes the old stream and never mixes its frames in. */
    await withPage(browser, server.origin, '/logs?sourceId=amf', async (page) => {
      await page.waitForSelector('[data-logs-status="live"]', { timeout: 30000 });
      await page.waitForFunction(
        () => document.querySelectorAll('[data-logs-viewport="true"] li').length === 6,
        undefined,
        { timeout: 10000 },
      );
      const switched = await page.evaluate(() => {
        /* Deliver four frames for amf and change the source in the same task:
         * the frames are buffered but not yet flushed to React when the source
         * change unmounts the old stream. */
        const delivered = [];
        for (let index = 1; index <= 4; index += 1) {
          delivered.push(window.__fxTransport.dispatch('sourceId=amf', 'line', {
            seq: 100 + index,
            level: 'info',
            text: `INFO amf-only marker ${index}`,
          }));
        }
        const select = document.querySelector('#logs-source');
        select.value = 'smf';
        select.dispatchEvent(new Event('change', { bubbles: true }));
        return delivered;
      });
      check('switch_frames_delivered', switched.every(Boolean), JSON.stringify(switched));

      await page.waitForFunction(() => {
        const status = document.querySelector('[data-logs-status="live"]');
        const rows = Array.from(document.querySelectorAll('[data-logs-viewport="true"] li'));
        return Boolean(status) && rows.some((row) => (row.textContent || '').includes('smf'));
      }, undefined, { timeout: 15000 }).catch(() => undefined);

      await control(server.origin, '/__fx/send', { source: 'smf', lines: 'INFO smf-only marker' });
      await page.waitForFunction(() => {
        const rows = Array.from(document.querySelectorAll('[data-logs-viewport="true"] li'));
        return rows.some((row) => (row.textContent || '').includes('smf-only marker'));
      }, undefined, { timeout: 15000 });

      const texts = await rowTexts(page);
      check(
        'switch_does_not_mix_old_frames',
        !texts.some((text) => text.includes('amf-only marker')),
        texts.slice(0, 12).join(' | '),
      );
      const state = await control(server.origin, '/__fx/state');
      check('switch_closes_old_stream', state.amf.open === 0, JSON.stringify(state.amf));
      check('switch_leaves_one_open_stream', state.smf.open === 1 && state.amf.open === 0, JSON.stringify(state));
      const openUrls = await page.evaluate(() => window.__fxTransport.openUrls());
      check('switch_leaves_one_event_source', openUrls.filter((url) => url.includes('/api/nf-logs/stream')).length === 1, openUrls.join(' | '));
    }, { tag: 'switch' });

    /* 1b. Back/Forward: returning to the previous source reopens its stream and
     *     shows only that source's lines. */
    await withPage(browser, server.origin, '/logs?sourceId=smf', async (page) => {
      await page.waitForSelector('[data-logs-status="live"]', { timeout: 30000 });
      await page.selectOption('#logs-source', 'amf');
      await page.waitForFunction(
        () => document.querySelectorAll('[data-logs-viewport="true"] li').length === 6,
        undefined,
        { timeout: 15000 },
      );
      await page.goBack();
      await page.waitForFunction(
        () => document.querySelector('#logs-source')?.value === 'smf',
        undefined,
        { timeout: 10000 },
      );
      await control(server.origin, '/__fx/send', { source: 'smf', lines: 'INFO after back' });
      await page.waitForFunction(() => {
        const rows = Array.from(document.querySelectorAll('[data-logs-viewport="true"] li'));
        return rows.some((row) => (row.textContent || '').includes('after back'));
      }, undefined, { timeout: 15000 });
      const texts = await rowTexts(page);
      check(
        'back_forward_does_not_carry_the_previous_source',
        !texts.some((text) => text.includes('idle tick')),
        texts.slice(0, 8).join(' | '),
      );
      const state = await control(server.origin, '/__fx/state');
      check(
        'back_forward_closes_the_previous_stream',
        state.amf.open === 0 && state.smf.open === 1,
        JSON.stringify(state),
      );
    }, { tag: 'back-forward' });

    /* 2. An automatic reconnect is a new tail: the replay must not double the
     *    previous scrollback, and no two entries may share a React key. */
    await withPage(browser, server.origin, '/logs?sourceId=amf', async (page) => {
      await page.waitForSelector('[data-logs-status="live"]', { timeout: 30000 });
      await page.waitForFunction(
        () => document.querySelectorAll('[data-logs-viewport="true"] li').length === 6,
        undefined,
        { timeout: 10000 },
      );
      await control(server.origin, '/__fx/arm', { source: 'amf' });
      await control(server.origin, '/__fx/close', { source: 'amf' });
      await page.waitForFunction(() => {
        const rows = Array.from(document.querySelectorAll('[data-logs-viewport="true"] li'));
        return rows.some((row) => (row.textContent || '').includes('tick 7'));
      }, undefined, { timeout: 20000 }).catch(() => undefined);
      const state = await control(server.origin, '/__fx/state');
      const texts = await rowTexts(page);
      const replayRows = texts.filter((text) => text.includes('idle tick 1')).length;
      check('reconnect_reopens_the_stream', state.amf.requests >= 2, JSON.stringify(state.amf));
      check('reconnect_restates_live', (await page.locator('[data-logs-status="live"]').count()) === 1, 'live after reconnect');
      check(
        'reconnect_replay_replaces_scrollback',
        texts.length === 4,
        `rows=${texts.length} ${texts.slice(0, 8).join(' | ')}`,
      );
      check('reconnect_replay_not_duplicated', replayRows === 1, `tick1 rows=${replayRows}`);
    }, { tag: 'reconnect' });

    /* 3. A source the registry declares unreadable is never opened and is never
     *    presented as a live connection. */
    await withPage(browser, server.origin, '/logs?sourceId=locked', async (page) => {
      await page.waitForSelector('[data-logs-source="true"]', { state: 'visible', timeout: 30000 });
      await page.waitForTimeout(1200);
      const state = await control(server.origin, '/__fx/state');
      const status = await page.locator('[data-logs-status]').getAttribute('data-logs-status');
      const text = await page.locator('body').innerText();
      check('unreadable_source_never_opens_a_stream', state.locked.requests === 0, JSON.stringify(state.locked));
      check('unreadable_source_reports_unavailable', status === 'unavailable', `status=${status}`);
      check('unreadable_source_states_the_reason', /cannot read this file|not readable/i.test(text), text.slice(0, 200));
    }, { tag: 'unreadable' });

    /* 4. The connection live region stays quiet: counters are visible but never
     *    announced on every frame. */
    await withPage(browser, server.origin, '/logs?sourceId=amf', async (page) => {
      await page.waitForSelector('[data-logs-status="live"]', { timeout: 30000 });
      await page.evaluate(() => {
        window.__fxTransport.dispatch('sourceId=amf', 'dropped', { count: 3 });
      });
      await page.waitForSelector('[data-logs-dropped="3"]', { timeout: 10000 });
      const liveRegionText = await page.evaluate(() => {
        const regions = Array.from(document.querySelectorAll('[role="status"], [aria-live]'))
          .filter((node) => (node.getAttribute('aria-live') ?? 'polite') !== 'off');
        return regions.map((node) => node.textContent || '').join(' || ');
      });
      const body = await page.locator('body').innerText();
      check('dropped_counter_is_visible', /3 lines dropped by the server/.test(body), body.slice(0, 240));
      check(
        'status_live_region_omits_counters',
        !/lines dropped|lines discarded|Keeping the newest/i.test(liveRegionText),
        liveRegionText.slice(0, 240),
      );
    }, { tag: 'aria' });

    /* 5. The keyword field shows a visible focus indicator when reached by
     *    keyboard. */
    await withPage(browser, server.origin, '/logs?sourceId=amf', async (page) => {
      await page.waitForSelector('[data-logs-status="live"]', { timeout: 30000 });
      await page.locator('#logs-source').focus();
      await page.keyboard.press('Tab');
      const levelFocus = await page.evaluate(() => document.activeElement?.id ?? '');
      await page.keyboard.press('Tab');
      const indicator = await page.evaluate(() => {
        const active = document.activeElement;
        const input = document.querySelector('form[role="search"] input');
        const form = document.querySelector('form[role="search"]');
        const read = (node) => {
          if (!node) return null;
          const style = window.getComputedStyle(node);
          return {
            tag: node.tagName,
            outlineStyle: style.outlineStyle,
            outlineWidth: style.outlineWidth,
            boxShadow: style.boxShadow,
            borderColor: style.borderColor,
          };
        };
        return {
          isSearchInput: active === input,
          active: active?.tagName ?? '',
          input: read(input),
          form: read(form),
        };
      });
      const visible = (() => {
        const nodes = [indicator.input, indicator.form].filter(Boolean);
        return nodes.some((node) => (
          (node.outlineStyle !== 'none' && Number.parseFloat(node.outlineWidth) > 0)
          || (node.boxShadow !== 'none' && node.boxShadow !== '')
        ));
      })();
      check('tab_reaches_level_control', levelFocus === 'logs-level', `focus=${levelFocus}`);
      check('tab_reaches_search_input', indicator.isSearchInput, `focus=${indicator.active}`);
      check('search_focus_is_visible', visible, JSON.stringify(indicator));
    }, { tag: 'focus' });

    /* 6. Narrow layout: the toolbar and the line grid fit, and a long line
     *    wraps instead of forcing a horizontal scrollbar. */
    for (const width of [320, 375, 768, 1180]) {
      await withPage(browser, server.origin, '/logs?sourceId=smf', async (page) => {
        await page.waitForSelector('[data-logs-status="live"]', { timeout: 30000 });
        await control(server.origin, '/__fx/send', {
          source: 'smf',
          lines: 'INFO averylongunbrokentokenwithoutanyspaces0123456789012345678901234567890123456789',
        });
        await page.waitForSelector('[data-logs-viewport="true"] li', { timeout: 15000 });
        const layout = await page.evaluate(() => {
          const viewport = document.querySelector('[data-logs-viewport="true"]');
          const workspace = viewport?.closest('section');
          return {
            documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            viewportOverflow: viewport ? viewport.scrollWidth - viewport.clientWidth : 0,
            workspaceOverflow: workspace ? workspace.scrollWidth - workspace.clientWidth : 0,
          };
        });
        check(`narrow_${width}_no_page_overflow`, layout.documentOverflow <= 1, JSON.stringify(layout));
        check(`narrow_${width}_no_workspace_overflow`, layout.workspaceOverflow <= 1, JSON.stringify(layout));
      }, { tag: `narrow-${width}`, viewport: { width, height: 780 } });
    }

    /* 7. Localized, dark-theme presentation: the Chinese vocabulary renders and
     *    the surface really is dark, with the status pill readable on it. */
    await withPage(browser, server.origin, '/logs?sourceId=amf', async (page) => {
      await page.waitForSelector('[data-logs-status="live"]', { timeout: 30000 });
      const look = await page.evaluate(() => {
        const parse = (value) => {
          const match = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(value || '');
          return match ? Number(match[1]) + Number(match[2]) + Number(match[3]) : null;
        };
        const pill = document.querySelector('[data-logs-status]');
        const surface = document.querySelector('[data-logs-viewport="true"]');
        return {
          text: (document.body.innerText || '').slice(0, 400),
          channelSum: parse(getComputedStyle(surface ?? document.body).backgroundColor),
          pillColor: pill ? getComputedStyle(pill).color : '',
          pillChannelSum: pill ? parse(getComputedStyle(pill).color) : null,
        };
      });
      check('zh_locale_renders', /网元日志/.test(look.text), look.text.slice(0, 120));
      check('dark_theme_surface_is_dark', look.channelSum !== null && look.channelSum < 240, JSON.stringify(look));
      check('status_pill_contrasts_on_dark', look.pillChannelSum !== null && look.pillChannelSum > look.channelSum + 120, JSON.stringify(look));
    }, { tag: 'zh-dark', language: 'zh', theme: 'dark', colorScheme: 'dark' });

    check('no_unexpected_api_requests', server.unexpected.length === 0, server.unexpected.slice(0, 5).join(' | '));
  } finally {
    await browser.close();
    await server.close();
    if (temporaryDist) await rm(temporaryDist, { recursive: true, force: true }).catch(() => undefined);
  }

  const failed = failures.length;
  for (const item of checks) {
    console.log(`${item.ok ? 'PASS' : 'FAIL'} ${item.id}${item.detail ? ` ${item.detail}` : ''}`);
  }
  console.log(`\nLog Center lifecycle acceptance: ${failed === 0 ? 'PASS' : 'FAIL'} (${checks.length - failed}/${checks.length})`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});