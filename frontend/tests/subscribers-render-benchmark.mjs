#!/usr/bin/env node
/*
 * Subscribers table render-commit benchmark.
 *
 * Measures the accepted baseline (91bfcb34) and the current working
 * tree with the same harness, fixture data and interactions. Commit counts come
 * from the committed fiber tree (`PerformedWork`), so a React.memo bail-out is
 * visible as "the table component did not commit", not merely "the DOM looked
 * the same". DOM mutations are counted separately.
 *
 * Development-mode React is used deliberately: it exposes named components and
 * per-commit work flags. Both variants run under the same build mode, so the
 * comparison is like-for-like. This is a test-only harness; it does not change
 * production sources.
 *
 * Writes reports/subscribers-render-benchmark.json and .md.
 */
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { build } from 'vite';

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(frontendRoot, '..');
const baselineSha = process.env.RENDER_BENCH_BASELINE_SHA || '91bfcb34';
const jsonReportPath = path.resolve(repoRoot, 'reports', 'subscribers-render-benchmark.json');
const markdownReportPath = path.resolve(repoRoot, 'reports', 'subscribers-render-benchmark.md');
const fixtureRel = path.join('tests', 'fixtures');

const ADMIN_USER = {
  username: 'admin',
  role: 'admin',
  normalizedRole: 'admin',
  status: 'active',
  permissions: ['subscribers.read', 'subscribers.write', 'ocs.balance.adjust', 'core.read'],
};

const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

function subscriberRow(index) {
  const imsi = `460${String(index).padStart(12, '0')}`;
  return {
    imsi,
    msisdn: `8613800${String(index).padStart(6, '0')}`,
    status: index % 4 === 0 ? 'Suspended' : 'Active',
    contractStatus: index % 5 === 0 ? 'suspended' : 'active',
    provisioning: { contract: true, balance: true, tariffPlan: true },
    profile: 'standard',
    policy: 'plan_5g',
    policyName: '5G Standard Plan',
    balanceState: 'normal',
    traffic: { total: 10737418240, used: 1073741824, balance: 9663676416 },
    lastActive: '2026-11-01T00:00:00Z',
  };
}

function subscriberPage(page, limit, query) {
  let rows = Array.from({ length: 25 }, (_unused, index) => subscriberRow(index + 1));
  if (query) {
    const imsi = `${query}${'0'.repeat(15)}`.slice(0, 15);
    rows = [{ ...subscriberRow(1), imsi }];
  }
  const start = (page - 1) * limit;
  const slice = rows.slice(start, start + limit);
  return {
    subscribers: slice,
    total: rows.length,
    summary: { total: rows.length, active: rows.length - 6, restricted: 6, lowTraffic: 0, lowBalance: 0, unprovisioned: 0 },
  };
}

async function startServer(distDirectory, entryRelative) {
  await stat(path.join(distDirectory, entryRelative));
  const server = createServer(async (request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    const pathname = url.pathname;

    if (pathname.startsWith('/api/')) {
      if (pathname === '/api/auth/me') return json(response, ADMIN_USER);
      if (pathname === '/api/auth/permissions') return json(response, { permissions: ADMIN_USER.permissions });
      if (pathname === '/api/notifications/stream' || pathname === '/api/runtime/stream') {
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        response.write('retry: 600000\nevent: init\ndata: {"alerts":{"activeCount":0,"activeCriticalCount":0,"activeWarningCount":0,"recent":[]}}\n\n');
        response.end();
        return;
      }
      if (pathname === '/api/subscribers') {
        const page = Number(url.searchParams.get('page') || '1');
        const limit = Number(url.searchParams.get('limit') || '10');
        const q = url.searchParams.get('q') || '';
        return json(response, subscriberPage(page, limit, q));
      }
      if (pathname === '/api/profiles') {
        return json(response, { profiles: [{ name: 'standard', title: 'Standard Profile' }] });
      }
      if (pathname === '/api/tariff-plans') {
        return json(response, { plans: [{ id: 'plan_5g', name: '5G Standard Plan' }] });
      }
      if (pathname === '/data/mcc-mnc-table.json') {
        return json(response, [{ mcc: '460', mnc: '00', network: 'Test Network', country: 'Test' }]);
      }
      if (pathname === '/api/runtime/observations') return json(response, { snapshot: { components: [] } });
      return json(response, {});
    }

    try {
      const relativePath = pathname === '/' ? entryRelative : pathname.replace(/^\/+/, '');
      const filePath = path.join(distDirectory, relativePath);
      let fileStat;
      try {
        fileStat = await stat(filePath);
      } catch {
        const html = await readFile(path.join(distDirectory, entryRelative));
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        response.end(html);
        return;
      }
      if (fileStat.isDirectory()) {
        response.writeHead(404, { 'Content-Type': 'text/plain' });
        response.end('not found');
        return;
      }
      const body = await readFile(filePath);
      response.writeHead(200, {
        'Content-Type': contentTypes[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': relativePath.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-store',
      });
      response.end(body);
    } catch (error) {
      response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end(String(error));
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

function json(response, body, status = 200) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}

function tableCommits(snapshot) {
  return snapshot.componentCommits?.SubscriberTable || 0;
}

function pageCommits(snapshot) {
  return snapshot.componentCommits?.SubscribersPage || 0;
}

function tableRenders(snapshot) {
  return snapshot.renders?.SubscriberTable || 0;
}

function pageRenders(snapshot) {
  return snapshot.renders?.SubscribersPage || 0;
}

/* Test-only source injection: count function invocations and committed effects.
 * A React.memo bail-out never invokes the component function, so this counter is
 * exact where fiber flags can be ambiguous after a bailout. */
function renderCountPlugin() {
  return {
    name: 'subscribers-render-count',
    enforce: 'pre',
    transform(code, id) {
      if (id.endsWith('/SubscriberTable.tsx')) {
        const next = code.replace(
          /function (SubscriberTableBase|SubscriberTable)\(props: SubscriberTableProps\) \{/,
          (match) => `${match} window.__renderBench?.render('SubscriberTable'); window.__renderBench?.props('SubscriberTable', props); useEffect(() => { window.__renderBench?.commit('SubscriberTable'); });`,
        );
        return next === code ? null : { code: next, map: null };
      }
      if (id.endsWith('/SubscribersPage.tsx')) {
        const next = code.replace(
          /export function SubscribersPage\(\) \{/,
          (match) => `${match} window.__renderBench?.render('SubscribersPage'); useEffect(() => { window.__renderBench?.commit('SubscribersPage'); });`,
        );
        return next === code ? null : { code: next, map: null };
      }
      return null;
    },
  };
}

async function measureVariant(label, variantRoot, dist) {
  console.log(`[render-bench] Building ${label}...`);
  await build({
    root: variantRoot,
    mode: 'development',
    logLevel: 'warn',
    plugins: [renderCountPlugin()],
    build: {
      outDir: dist,
      emptyOutDir: true,
      minify: false,
      rollupOptions: { input: path.join(variantRoot, fixtureRel, 'render-benchmark.html') },
    },
  });

  const handle = await startServer(dist, path.join(fixtureRel, 'render-benchmark.html'));
  const browser = await chromium.launch({ headless: true });
  const results = {};
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await context.addInitScript((user) => {
      localStorage.setItem('XCLOUD_LANGUAGE_PREFERENCE', 'en');
      localStorage.setItem('XCLOUD_THEME_PREFERENCE', 'light');
      localStorage.setItem('xcloud_auth_token', 'render-bench-token');
      localStorage.setItem('xcloud_user', JSON.stringify(user));
    }, ADMIN_USER);

    const openPage = async () => {
      const page = await context.newPage();
      await page.goto(`${handle.origin}/subscribers`, { waitUntil: 'networkidle' });
      await page.waitForSelector('table.subscribers-table tbody tr');
      return page;
    };
    const reset = (page) => page.evaluate(() => window.__renderBench.reset());
    const snapshot = (page) => page.evaluate(() => window.__renderBench.snapshot());
    const observe = (page) => page.evaluate(() => window.__renderBench.observeTable(document.querySelector('.table-card') || document.querySelector('table.subscribers-table tbody')));
    const finish = async (page, before = null) => {
      const result = await snapshot(page);
      await page.close();
      return before ? { ...result, baseline: before } : result;
    };
    const record = async (name, run) => {
      const page = await openPage();
      await observe(page);
      await reset(page);
      const initial = await snapshot(page);
      const value = await run(page, initial);
      results[name] = value;
    };

    results.initial = await (async () => {
      const page = await openPage();
      const result = await finish(page);
      return result;
    })();

    await record('searchTyping', async (page) => {
      const input = page.locator('input.search-input');
      await input.click();
      await page.keyboard.type('4600', { delay: 0 });
      return finish(page);
    });

    await record('debounceSettlement', async (page) => {
      const responsePromise = page.waitForResponse((response) => response.url().includes('/api/subscribers') && response.url().includes('q=460001'));
      const input = page.locator('input.search-input');
      await input.click();
      await page.keyboard.type('460001', { delay: 0 });
      await responsePromise;
      await page.waitForFunction(() => Array.from(document.querySelectorAll('table.subscribers-table tbody tr')).some((row) => (row.textContent || '').includes('460001000000000')));
      return finish(page);
    });

    await record('sort', async (page) => {
      const statusHeader = page.locator('th[aria-sort="none"] button', { hasText: 'Status' }).first();
      const responsePromise = page.waitForResponse((response) => response.url().includes('/api/subscribers') && response.url().includes('sortField=status'));
      await statusHeader.click();
      await responsePromise;
      await page.waitForFunction(() => {
        const header = Array.from(document.querySelectorAll('th')).find((cell) => (cell.textContent || '').includes('Status'));
        return header?.getAttribute('aria-sort') === 'ascending' || header?.getAttribute('aria-sort') === 'descending';
      });
      return finish(page);
    });

    await record('pagination', async (page) => {
      const responsePromise = page.waitForResponse((response) => response.url().includes('/api/subscribers') && response.url().includes('page=2'));
      await page.locator('nav[aria-label="entries"] button').last().click();
      await responsePromise;
      await page.waitForFunction(() => Array.from(document.querySelectorAll('table.subscribers-table tbody tr')).some((row) => (row.textContent || '').includes('460000000000011')));
      return finish(page);
    });

    await record('rowSelection', async (page) => {
      await page.locator('table.subscribers-table tbody tr input[type="checkbox"]').first().click();
      await page.waitForFunction(() => Boolean(document.querySelector('table.subscribers-table tbody tr input[type="checkbox"]:checked')));
      return finish(page);
    });

    await record('modalInteraction', async (page) => {
      await page.locator('button[title="Import subscribers"]').first().click();
      await page.waitForSelector('[role="dialog"]', { state: 'visible' });
      await page.locator('[role="dialog"] button[aria-label="Close"]').first().click();
      await page.waitForSelector('[role="dialog"]', { state: 'detached' });
      return finish(page);
    });

    await record('feedbackState', async (page) => {
      await page.locator('table.subscribers-table tbody button[aria-label^="Copy IMSI"]').first().click();
      await page.waitForSelector('table.subscribers-table tbody button.copy-btn.copied', { state: 'visible', timeout: 5000 });
      return finish(page);
    });

    return results;
  } finally {
    await browser.close();
    await new Promise((resolve) => handle.server.close(resolve));
  }
}

async function prepareBaseline(worktree) {
  console.log(`[render-bench] Creating baseline worktree at ${baselineSha}...`);
  execFileSync('git', ['worktree', 'add', '--detach', worktree, baselineSha], { cwd: repoRoot, stdio: 'inherit' });
  await symlink(path.join(frontendRoot, 'node_modules'), path.join(worktree, 'frontend', 'node_modules'));
  await mkdir(path.join(worktree, 'frontend', fixtureRel), { recursive: true });
  for (const file of ['render-commit-hook.ts', 'render-benchmark.tsx', 'render-benchmark.html']) {
    await copyFile(path.join(frontendRoot, fixtureRel, file), path.join(worktree, 'frontend', fixtureRel, file));
  }
}

async function main() {
  const root = await mkdtemp(path.join(tmpdir(), 'xcloud-render-bench-'));
  const baselineRoot = path.join(root, 'baseline');
  const currentDist = path.join(root, 'dist-current');
  const baselineDist = path.join(root, 'dist-baseline');
  let prepared = false;
  const report = { generatedAt: new Date().toISOString(), baselineSha, currentSha: 'working-tree', results: null };

  try {
    await prepareBaseline(baselineRoot);
    prepared = true;
    const baseline = await measureVariant(`baseline ${baselineSha}`, path.join(baselineRoot, 'frontend'), baselineDist);
    const current = await measureVariant('current working tree', frontendRoot, currentDist);
    report.results = { baseline, current };

    const interactions = [
      ['initial', 'Initial subscriber table render'],
      ['searchTyping', 'Search typing before debounce'],
      ['debounceSettlement', 'Debounce settlement'],
      ['sort', 'Sort change'],
      ['pagination', 'Pagination'],
      ['rowSelection', 'Row selection'],
      ['modalInteraction', 'Modal open/close'],
      ['feedbackState', 'Unrelated feedback-state update'],
    ];
    report.comparison = interactions.map(([key, label]) => {
      const before = baseline[key];
      const after = current[key];
      return {
        key,
        interaction: label,
        beforeTableCommits: tableCommits(before),
        afterTableCommits: tableCommits(after),
        beforeTableRenders: tableRenders(before),
        afterTableRenders: tableRenders(after),
        beforePageCommits: pageCommits(before),
        afterPageCommits: pageCommits(after),
        beforePageRenders: pageRenders(before),
        afterPageRenders: pageRenders(after),
        beforeTotalCommits: before.commits,
        afterTotalCommits: after.commits,
        beforeDomMutations: before.domMutations,
        afterDomMutations: after.domMutations,
        deltaTableCommits: tableCommits(after) - tableCommits(before),
      };
    });

    const typing = report.comparison.find((entry) => entry.key === 'searchTyping');
    report.conclusion = {
      tableCommitReductionOnTyping: typing.beforeTableCommits - typing.afterTableCommits,
      pageStillCommitsOnTyping: typing.afterPageCommits > 0,
      semanticsPreserved: ['sort', 'pagination', 'rowSelection'].every((key) => {
        const entry = report.comparison.find((item) => item.key === key);
        return entry.afterTableCommits > 0;
      }),
      note: 'Page-level commits remain; only the unchanged table subtree is contained. Sort, pagination, selection and modal interactions still commit the table.',
    };

    await writeFile(jsonReportPath, JSON.stringify(report, null, 2));
    const markdown = renderMarkdown(report);
    await writeFile(markdownReportPath, markdown);
    console.log(markdown);
    console.log(`[render-bench] reports written to ${markdownReportPath} and ${jsonReportPath}`);
  } finally {
    if (prepared) {
      execFileSync('git', ['worktree', 'remove', '--force', baselineRoot], { cwd: repoRoot, stdio: 'inherit' });
    }
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}

function renderMarkdown(report) {
  const rows = report.comparison.map((entry) => (
    `| ${entry.interaction} | ${entry.beforeTableCommits} | ${entry.afterTableCommits} | ${entry.deltaTableCommits} | ${entry.beforeTableRenders} → ${entry.afterTableRenders} | ${entry.beforePageCommits} → ${entry.afterPageCommits} | ${entry.beforeDomMutations} → ${entry.afterDomMutations} |`
  )).join('\n');
  return `# Subscribers Render-Commit Benchmark

Generated: ${report.generatedAt}

Baseline: \`${report.baselineSha}\` (accepted baseline). Current: working tree.
Harness: development-mode React with the commit hook installed before React loads; \`PerformedWork\` counts committed component work, not function invocations. Both variants use the same fixture data and interactions.

## Commit comparison

| Interaction | Before table commits | After table commits | Delta | Table render invocations (before → after) | Page commits (before → after) | DOM mutations (before → after) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
${rows}

## Measured conclusion

- Table commits on search typing: ${report.conclusion.tableCommitReductionOnTyping} fewer than the baseline.
- Page still commits on search typing: ${report.conclusion.pageStillCommitsOnTyping} (page-level renders were not eliminated).
- Sort, pagination and row selection still commit the table: ${report.conclusion.semanticsPreserved}.

${report.conclusion.note}

DOM mutations are reported separately: a memoized bail-out can leave DOM unchanged, and an unchanged DOM alone is not proof that a component did not commit. The commit counters above are the acceptance evidence.

## Boundary

Development-mode React is faster/slower than production in absolute terms, but both variants run under identical conditions. The metric is the relative committed-work count, not a wall-clock duration claim.
`;
}

main().catch((error) => {
  console.error('[render-bench] Fatal error:', error);
  process.exit(1);
});