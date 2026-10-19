#!/usr/bin/env node
/*
 * NF Alerts duty-workspace browser acceptance.
 *
 * Renders the already built SPA against a deterministic alert fixture and
 * asserts the behaviours that only exist across a request sequence:
 *
 *   - the default view shows the open queue and no rule table;
 *   - the queue asks the server for the open scope and the risk order;
 *   - opening a row shows the immutable evidence snapshot;
 *   - resolving closes the drawer and removes the row from the open queue;
 *   - history and rules are separate views, never stacked below the queue;
 *   - a failing rule read never blanks the queue;
 *   - a read-only session gets no mutation control.
 *
 * Usage (from frontend/): node tests/nf-alerts-smoke.mjs
 */
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const frontendRoot = resolve(here, '..');
const distDir = process.env.XCLOUD_NF_ALERTS_DIST_DIR
  ? resolve(process.env.XCLOUD_NF_ALERTS_DIST_DIR)
  : resolve(frontendRoot, 'dist');

const TS = {
  first: '2026-10-19T08:00:00Z',
  last: '2026-10-19T09:00:00Z',
  ack: '2026-10-19T09:30:00Z',
  resolved: '2026-10-19T10:00:00Z',
  sample: '2026-10-19T08:59:00Z',
};

const ALERTS = [
  {
    alertId: 'alert-critical-active',
    schemaVersion: 1,
    ruleId: 'rule-1',
    ruleName: 'AMF process unhealthy',
    targetId: 'target-amf',
    resourceId: '6f1c1a10-0001-4a01-8b01-000000000001',
    targetName: 'amf-01',
    severity: 'critical',
    state: 'active',
    conditionType: 'state',
    condition: { scope: 'process', state: 'unhealthy' },
    triggerCount: 3,
    firstTriggeredAt: TS.first,
    lastTriggeredAt: TS.last,
    evidence: {
      runStatus: 'partial',
      sampleId: 'sample-critical',
      collectedAt: TS.sample,
      overallState: 'unhealthy',
      layers: {
        process: { state: 'unhealthy', evidenceKind: 'process', measured: true },
        interface: { state: 'healthy', evidenceKind: 'http_metrics', measured: true },
        service: { state: 'not_configured', evidenceKind: 'none', measured: false },
      },
    },
    updatedAt: TS.last,
  },
  {
    alertId: 'alert-warning-ack',
    schemaVersion: 1,
    ruleId: 'rule-2',
    ruleName: 'SMF interface degraded',
    targetId: 'target-smf',
    targetName: 'smf-01',
    severity: 'warning',
    state: 'acknowledged',
    conditionType: 'state',
    condition: { scope: 'interface', state: 'degraded' },
    triggerCount: 1,
    firstTriggeredAt: TS.first,
    lastTriggeredAt: TS.first,
    evidence: {
      runStatus: 'success',
      sampleId: 'sample-warning',
      collectedAt: TS.first,
      overallState: 'degraded',
    },
    acknowledgedAt: TS.ack,
    acknowledgedBy: 'operator1',
    updatedAt: TS.ack,
  },
  {
    alertId: 'alert-resolved',
    schemaVersion: 1,
    ruleId: 'rule-2',
    ruleName: 'SMF interface degraded',
    targetId: 'target-smf',
    targetName: 'smf-01',
    severity: 'warning',
    state: 'resolved',
    conditionType: 'run_failed',
    triggerCount: 2,
    firstTriggeredAt: TS.first,
    lastTriggeredAt: TS.first,
    evidence: {
      runStatus: 'failed',
      collectedAt: TS.first,
      overallState: 'unknown',
    },
    resolvedAt: TS.resolved,
    resolvedReason: 'recovery',
    updatedAt: TS.resolved,
  },
];

const RULES = [
  {
    ruleId: 'rule-1',
    schemaVersion: 1,
    name: 'AMF process unhealthy',
    enabled: true,
    conditionType: 'state',
    condition: { scope: 'process', state: 'unhealthy' },
    severity: 'critical',
    cooldownSeconds: 300,
    revision: 1,
    createdAt: TS.first,
    createdBy: 'operator1',
    updatedAt: TS.first,
    updatedBy: 'operator1',
  },
];

const NOTIFY_CHANNELS = [
  { id: 'ch-1', name: 'Ops webhook', kind: 'webhook', enabled: true, url: 'https://hooks.example.com/alert', revision: 1, createdAt: TS.first, updatedAt: TS.first },
];

const NOTIFY_ESCALATIONS = [
  { id: 'esc-1', name: 'Critical to ops', enabled: true, severities: ['critical'], channelIds: ['ch-1'], escalateAfterSeconds: 300, escalateChannelIds: ['ch-1'], revision: 1, createdAt: TS.first, updatedAt: TS.first },
];

const NOTIFY_DELIVERIES = [
  { id: 'd-1', deliveryKey: 'alert-critical-active:opened:ch-1', event: 'opened', alertId: 'alert-critical-active', ruleId: 'rule-1', ruleName: 'AMF process unhealthy', targetId: 'target-amf', targetName: 'amf-01', severity: 'critical', triggerCount: 1, occurredAt: TS.first, channelId: 'ch-1', status: 'sent', attempts: 1, createdAt: TS.first, completedAt: TS.first },
];

const META = {
  schemaVersion: 1,
  alertStates: ['active', 'acknowledged', 'resolved'],
  severities: ['critical', 'warning', 'info'],
  conditionTypes: ['state', 'run_failed'],
  conditionScopes: ['overall', 'process', 'interface', 'service'],
  stateConditionValues: ['unhealthy', 'degraded', 'unknown'],
  resolveReasons: ['recovery', 'manual', 'rule_deleted'],
  minCooldownSeconds: 60,
  maxCooldownSeconds: 86400,
  defaultCooldownSeconds: 300,
  runStatuses: ['success', 'partial', 'failed'],
};

const SESSION = {
  username: 'operator1',
  role: 'operator',
  normalizedRole: 'operator',
  status: 'active',
  permissions: ['core.read', 'core.configure'],
};
const VIEWER = {
  username: 'viewer1',
  role: 'viewer',
  normalizedRole: 'viewer',
  status: 'active',
  permissions: ['core.read'],
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

function page(limit) {
  return { limit, nextCursor: null, hasMore: false };
}

function alertsSummary(alerts) {
  const byState = {};
  for (const alert of alerts) byState[alert.state] = (byState[alert.state] ?? 0) + 1;
  return {
    totalRules: RULES.length,
    enabledRules: RULES.filter((rule) => rule.enabled).length,
    alertsByState: byState,
    openBySeverity: {
      critical: alerts.filter((alert) => alert.state !== 'resolved' && alert.severity === 'critical').length,
      warning: alerts.filter((alert) => alert.state !== 'resolved' && alert.severity === 'warning').length,
      info: 0,
    },
  };
}

function startServer({ failRules = false, session = SESSION } = {}) {
  const unexpected = [];
  const requestLog = [];
  const streamed = new Set();
  const alerts = ALERTS.map((alert) => ({ ...alert }));

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const pathname = url.pathname;

    if (pathname.startsWith('/api/')) {
      requestLog.push(`${req.method} ${pathname}${url.search}`);
      return handleApi(req, res, url, { failRules, session, unexpected, streamed, alerts });
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
        requestLog,
        close: () => new Promise((closed) => {
          for (const stream of streamed) {
            try {
              stream.destroy();
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

function handleApi(req, res, url, context) {
  const pathname = url.pathname;

  if (pathname === '/api/auth/me') return sendJson(res, 200, context.session);
  if (pathname === '/api/auth/permissions') return sendJson(res, 200, { permissions: context.session.permissions });
  if (pathname === '/api/notifications/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 600000\n\n');
    res.write(`event: init\ndata: ${JSON.stringify({
      alerts: { activeCount: 1, activeCriticalCount: 1, activeWarningCount: 0, recent: [] },
    })}\n\n`);
    context.streamed.add(res);
    req.on('close', () => context.streamed.delete(res));
    return undefined;
  }
  if (pathname === '/api/alerts') return sendJson(res, 200, { alerts: [] });
  if (pathname === '/api/search') return sendJson(res, 200, { results: [] });

  if (pathname === '/api/nf-alerts/meta') return sendJson(res, 200, META);

  if (pathname === '/api/operations/summary') {
    const sections = (url.searchParams.get('sections') ?? 'alerts')
      .split(',')
      .map((token) => token.trim())
      .filter(Boolean);
    const body = { generatedAt: TS.last, sections };
    if (sections.includes('alerts')) {
      body.alerts = { completeness: 'complete', scope: 'full_collection', alerts: alertsSummary(context.alerts) };
    }
    return sendJson(res, 200, body);
  }

  if (pathname === '/api/nf-alerts' && req.method === 'GET') {
    const scope = url.searchParams.get('scope') ?? '';
    const severity = url.searchParams.get('severity') ?? '';
    let items = context.alerts;
    if (scope === 'open') items = items.filter((alert) => alert.state !== 'resolved');
    if (scope === 'history') items = items.filter((alert) => alert.state === 'resolved');
    if (severity) items = items.filter((alert) => alert.severity === severity);
    if (url.searchParams.get('sort') === 'risk') {
      const stateRank = { active: 0, acknowledged: 1, resolved: 2 };
      const severityRank = { critical: 0, warning: 1, info: 2 };
      items = [...items].sort((left, right) =>
        (stateRank[left.state] * 10 + severityRank[left.severity]) -
        (stateRank[right.state] * 10 + severityRank[right.severity]));
    }
    return sendJson(res, 200, { alerts: items, page: page(20) });
  }

  const resolveMatch = /^\/api\/nf-alerts\/([^/]+)\/resolve$/.exec(pathname);
  if (resolveMatch && req.method === 'POST') {
    const alert = context.alerts.find((item) => item.alertId === resolveMatch[1]);
    if (!alert) return sendJson(res, 404, { error: 'not found', code: 'NF_ALERT_INSTANCE_NOT_FOUND' });
    alert.state = 'resolved';
    alert.resolvedAt = TS.resolved;
    alert.resolvedReason = 'manual';
    alert.updatedAt = TS.resolved;
    return sendJson(res, 200, { ...alert });
  }

  const ackMatch = /^\/api\/nf-alerts\/([^/]+)\/acknowledge$/.exec(pathname);
  if (ackMatch && req.method === 'POST') {
    const alert = context.alerts.find((item) => item.alertId === ackMatch[1]);
    if (!alert) return sendJson(res, 404, { error: 'not found', code: 'NF_ALERT_INSTANCE_NOT_FOUND' });
    alert.state = 'acknowledged';
    alert.acknowledgedAt = TS.ack;
    alert.updatedAt = TS.ack;
    return sendJson(res, 200, { ...alert });
  }

  if (pathname === '/api/nf-alerts/rules' && req.method === 'GET') {
    if (context.failRules) {
      return sendJson(res, 503, { error: 'fixture injected failure', code: 'FIXTURE_INJECTED_FAILURE' });
    }
    return sendJson(res, 200, { rules: RULES, page: page(20) });
  }

  if (pathname === '/api/nf-notifications/channels' && req.method === 'GET') {
    return sendJson(res, 200, { channels: NOTIFY_CHANNELS });
  }
  if (pathname === '/api/nf-notifications/escalations' && req.method === 'GET') {
    return sendJson(res, 200, { escalations: NOTIFY_ESCALATIONS });
  }
  if (pathname === '/api/nf-notifications/deliveries' && req.method === 'GET') {
    return sendJson(res, 200, { deliveries: NOTIFY_DELIVERIES, page: { limit: 20, nextCursor: null, hasMore: false } });
  }

  context.unexpected.push(`${req.method} ${pathname}`);
  return sendJson(res, 404, { error: 'unexpected fixture request', code: 'FIXTURE_UNEXPECTED' });
}

async function withPage(browser, origin, run) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
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
      /* storage unavailable */
    }
  });
  const browserPage = await context.newPage();
  const pageErrors = [];
  browserPage.on('pageerror', (error) => pageErrors.push(error?.message ?? String(error)));
  try {
    await browserPage.goto(`${origin}/nf-alerts`, { waitUntil: 'domcontentloaded' });
    await browserPage.waitForSelector('.layout-root', { state: 'visible', timeout: 30000 });
    await run(browserPage);
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
  const servers = [];
  try {
    /* 1. Default duty queue. */
    const server = await startServer();
    servers.push(server);
    await withPage(browser, server.origin, async (page) => {
      await page.getByText('AMF process unhealthy').first().waitFor({ timeout: 30000 });
      check('open_queue_is_default', (await page.locator('[data-nf-alert-panel="open"]').count()) === 1, 'open panel');
      check('rules_hidden_behind_their_view', (await page.locator('[data-nf-alert-panel="rules"]').count()) === 0, 'rules panel');
      check('queue_requests_open_scope', server.requestLog.some((entry) => entry.includes('/api/nf-alerts?scope=open')), 'scope=open');
      check('queue_requests_risk_order', server.requestLog.some((entry) => entry.includes('sort=risk')), 'sort=risk');

      /* 2. Evidence drawer. */
      await page.getByRole('button', { name: 'AMF process unhealthy' }).first().click();
      await page.locator('#nf-alert-evidence-title').waitFor({ state: 'visible', timeout: 20000 });
      const drawer = await page.getByRole('dialog').first().innerText();
      check('drawer_shows_evidence', drawer.includes('sample-critical'), 'sample id');
      check('drawer_states_immutability', /never rewrites/i.test(drawer), 'immutable note');
      check('drawer_shows_lifecycle', /Trigger count/i.test(drawer) && /3/.test(drawer), 'lifecycle');

      /* 3. Resolve closes the drawer and drops the row from the queue. */
      await page.getByRole('button', { name: /^Resolve$/ }).first().click();
      await page.locator('#nf-alert-evidence-title').waitFor({ state: 'detached', timeout: 20000 });
      await page.waitForTimeout(500);
      const afterResolve = await page.locator('body').innerText();
      check('resolved_row_leaves_the_queue', !afterResolve.includes('AMF process unhealthy'), 'queue reloaded');
      check('acknowledged_row_stays_open', afterResolve.includes('SMF interface degraded'), 'acknowledged stays in the queue');

      /* 4. Views are exclusive. */
      await page.getByRole('button', { name: 'Rules' }).click();
      await page.locator('[data-nf-alert-panel="rules"]').waitFor({ state: 'visible', timeout: 20000 });
      check('rules_view_replaces_queue', (await page.locator('[data-nf-alert-panel="open"]').count()) === 0, 'queue hidden');
      check('rules_table_renders', /AMF process unhealthy/.test(await page.locator('body').innerText()), 'rule row');

      await page.getByRole('button', { name: 'History' }).click();
      await page.locator('[data-nf-alert-panel="history"]').waitFor({ state: 'visible', timeout: 20000 });
      const history = await page.locator('body').innerText();
      check('history_requests_history_scope', server.requestLog.some((entry) => entry.includes('scope=history')), 'scope=history');
      check('history_shows_resolved_alerts', /Resolved/.test(history), 'resolved rows');
      check('history_hides_rules', (await page.locator('[data-nf-alert-panel="rules"]').count()) === 0, 'rules hidden');

      const unexpected = server.unexpected;
      check('no_unexpected_api_requests', unexpected.length === 0, unexpected.slice(0, 3).join(' | '));
    });
    await server.close();

    /* 5. A failing rule read never blanks the queue. */
    const failing = await startServer({ failRules: true });
    servers.push(failing);
    await withPage(browser, failing.origin, async (page) => {
      await page.getByText('AMF process unhealthy').first().waitFor({ timeout: 30000 });
      await page.getByRole('button', { name: 'Rules' }).click();
      await page.locator('[data-nf-alert-panel="rules"]').waitFor({ state: 'visible', timeout: 20000 });
      await page.waitForTimeout(500);
      const rulesText = await page.locator('body').innerText();
      check('rules_failure_is_reported', /Error|failed/i.test(rulesText), 'the rules view reports its own failure');
      await page.getByRole('button', { name: 'Open queue' }).click();
      await page.locator('[data-nf-alert-panel="open"]').waitFor({ state: 'visible', timeout: 20000 });
      await page.getByText('SMF interface degraded').first().waitFor({ timeout: 20000 });
      check('rules_failure_keeps_queue_readable', true, 'the queue still renders after a rule failure');
    });
    await failing.close();

    /* 6. A read-only session gets no mutation control. */
    const viewerServer = await startServer({ session: VIEWER });
    servers.push(viewerServer);
    await withPage(browser, viewerServer.origin, async (page) => {
      await page.getByText('AMF process unhealthy').first().waitFor({ timeout: 30000 });
      await page.getByRole('button', { name: 'AMF process unhealthy' }).first().click();
      await page.locator('#nf-alert-evidence-title').waitFor({ state: 'visible', timeout: 20000 });
      const drawer = await page.getByRole('dialog').first().innerText();
      check('viewer_has_no_acknowledge', !/^Acknowledge$/m.test(drawer), 'no acknowledge action');
      check('viewer_has_no_resolve', !/^Resolve$/m.test(drawer), 'no resolve action');
      check('viewer_reads_evidence', drawer.includes('sample-critical'), 'evidence stays readable');
    });
    await viewerServer.close();

    /* 7. Notification settings live in the rules view and never echo a secret. */
    const notifyServer = await startServer();
    servers.push(notifyServer);
    await withPage(browser, notifyServer.origin, async (page) => {
      await page.getByText('AMF process unhealthy').first().waitFor({ timeout: 30000 });
      await page.getByRole('button', { name: 'Rules' }).click();
      await page.locator('[data-nf-alert-panel="rules"]').waitFor({ state: 'visible', timeout: 20000 });
      await page.locator('[data-nf-notify-open="true"]').click();
      await page.locator('[data-notify-tab="channels"]').waitFor({ state: 'visible', timeout: 20000 });
      const channelText = await page.getByRole('dialog').first().innerText();
      check('notify_settings_show_channels', channelText.includes('Ops webhook'), 'channel row');
      check('notify_settings_never_echo_secret', !channelText.includes('s3cr3t'), 'the secret is write-only');
      await page.locator('[data-notify-tab="deliveries"]').click();
      await page.locator('[data-notify-deliveries="true"]').waitFor({ state: 'visible', timeout: 20000 });
      const deliveryText = await page.getByRole('dialog').first().innerText();
      check('notify_delivery_health_visible', /sent/i.test(deliveryText), 'delivery rows render');
    });
    await notifyServer.close();
    servers.length = 0;
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
  console.log(`\nNF Alerts duty workspace acceptance: ${failed === 0 ? 'PASS' : 'FAIL'} (${checks.length - failed}/${checks.length})`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
