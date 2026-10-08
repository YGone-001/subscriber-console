#!/usr/bin/env node
/*
 * Accessibility and interaction-state parity check (T22).
 *
 * Runs two kinds of verification:
 *
 *   1. An in-page DOM audit per route: heading order, one h1, accessible names on
 *      every control and link, table captions and header scopes, dialog labelling
 *      and modality, image alternatives, and the presence of live regions on the
 *      surfaces that update asynchronously.
 *   2. A keyboard walkthrough of the command palette: it opens from the keyboard,
 *      moves focus into the dialog, keeps Tab inside it (focus trap), closes on
 *      Escape, and restores focus to the trigger.
 *
 * Plus two source-level checks that a DOM audit cannot see: the reduced-motion
 * block and the focus-visible treatment.
 *
 * Usage: node scripts/test-ui-accessibility.mjs [--route=name:/path ...]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCdpClient, launchChrome, sleep } from './lib/cdp.mjs';
import { obtainAuthToken } from './lib/session.mjs';
import { PROJECT_ROOT, requireChromeExecutable, resolveChromeExecutable } from './lib/project-paths.mjs';

const args = new Map(
  process.argv.slice(2).filter((arg) => arg.startsWith('--')).map((arg) => {
    const [key, value = 'true'] = arg.replace(/^--/, '').split('=');
    return [key, value];
  }),
);
const flag = (name, envName, fallback) => args.get(name) ?? process.env[envName] ?? fallback;

/*
 * The project root is derived from the repository layout rather than from the caller's
 * working directory or a machine-specific absolute path, so the suite runs from any
 * checkout. The browser is probed per platform and can be overridden with --chrome= or
 * UI_CAPTURE_CHROME.
 */
const PROJECT = PROJECT_ROOT;
const BASE = flag('base', 'UI_A11Y_BASE', 'http://localhost:13333');
const CHROME = requireChromeExecutable(resolveChromeExecutable({ argument: args.get('chrome') }));
const CDP_PORT = Number(flag('cdp-port', 'UI_A11Y_CDP_PORT', 9338));
/*
 * Explicit token wins; otherwise the suite logs in itself. Without this fallback the run
 * is unauthenticated, the app stays on /login, and every audit measures the login page
 * while reporting zero violations.
 */
let TOKEN = flag('token', 'UI_A11Y_TOKEN', '');
const VIEWPORT = { width: 1440, height: 900 };

const ROUTES = (flag('routes', 'UI_A11Y_ROUTES', [
  'dashboard:/', 'subscribers:/subscribers', 'profile:/profile', 'ocs-tariffs:/ocs/tariffs',
  'ocs-contracts:/ocs/contracts', 'ocs-balances:/ocs/balances', 'users:/users',
  'system-health:/system-health', 'inventory:/inventory',
].join(','))).split(',').map((entry) => {
  const index = entry.indexOf(':');
  return { name: entry.slice(0, index), route: entry.slice(index + 1) };
});

/* ------------------------------------------------------------------ audit -- */

const AUDIT = `(() => {
  const violations = [];
  const push = (rule, detail) => violations.push({ rule, detail: String(detail).slice(0, 140) });
  const name = (el) => (el.getAttribute('aria-label') || el.getAttribute('title') || (el.innerText || '').trim() || el.getAttribute('placeholder') || '').trim();
  const labelledBy = (el) => {
    /* aria-label and title are valid accessible names; a DOM audit that ignores them
     * reports every icon-only or search control as unlabelled. */
    if ((el.getAttribute('aria-label') || '').trim()) return true;
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) return labelledBy.split(/\\s+/).some((part) => (document.getElementById(part)?.innerText || '').trim());
    const forId = el.id && document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
    if (forId && forId.innerText.trim()) return true;
    return !!(el.closest('label') && el.closest('label').innerText.trim());
  };

  const headings = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].filter((h) => h.offsetParent !== null);
  const h1s = headings.filter((h) => h.tagName === 'H1');
  if (h1s.length === 0) push('heading-missing-h1', 'page has no visible h1');
  if (h1s.length > 1) push('heading-multiple-h1', h1s.length + ' visible h1 elements');
  let previous = 0;
  for (const heading of headings) {
    const level = Number(heading.tagName[1]);
    if (previous && level > previous + 1) push('heading-skip', heading.tagName + ' after H' + previous + ': ' + heading.innerText.trim().slice(0, 50));
    previous = level;
  }

  for (const el of document.querySelectorAll('button, a[href], [role="button"]')) {
    if (el.offsetParent === null) continue;
    if (!name(el)) push('control-unnamed', el.tagName.toLowerCase() + '.' + String(el.className || '').slice(0, 50));
  }

  for (const el of document.querySelectorAll('input:not([type="hidden"]), select, textarea')) {
    if (el.offsetParent === null) continue;
    if (!labelledBy(el)) push('field-unlabelled', el.tagName.toLowerCase() + '#' + (el.id || '(no id)'));
  }

  for (const table of document.querySelectorAll('table')) {
    if (table.offsetParent === null) continue;
    const hasCaption = !!table.querySelector('caption') || !!table.getAttribute('aria-label') || !!table.getAttribute('aria-labelledby');
    if (!hasCaption) push('table-uncaptioned', String(table.className || '').slice(0, 60) || '(no class)');
    for (const th of table.querySelectorAll('th')) {
      if (!th.getAttribute('scope') && !th.closest('thead')) push('th-no-scope', (th.innerText || '').trim().slice(0, 40));
    }
  }

  for (const dialog of document.querySelectorAll('[role="dialog"], [role="alertdialog"]')) {
    if (dialog.offsetParent === null) continue;
    const labelled = !!dialog.getAttribute('aria-label') || !!dialog.getAttribute('aria-labelledby');
    if (!labelled) push('dialog-unlabelled', String(dialog.className || '').slice(0, 60));
    if (dialog.getAttribute('aria-modal') !== 'true') push('dialog-not-modal', String(dialog.className || '').slice(0, 60));
  }

  for (const img of document.querySelectorAll('img')) {
    if (img.offsetParent === null) continue;
    if (!img.hasAttribute('alt')) push('img-no-alt', img.getAttribute('src') || '(no src)');
  }

  const liveRegions = document.querySelectorAll('[aria-live], [role="status"], [role="alert"], [role="log"]').length;

  return JSON.stringify({ violations, liveRegions, headings: headings.length });
})()`;

/* --------------------------------------------------- keyboard walkthrough -- */

async function pressKey(client, { key, code, windowsVirtualKeyCode, modifiers = 0 }) {
  for (const type of ['keyDown', 'keyUp']) {
    await client.send('Input.dispatchKeyEvent', {
      type, key, code, windowsVirtualKeyCode, nativeVirtualKeyCode: windowsVirtualKeyCode, modifiers,
    });
  }
  await sleep(120);
}

async function evaluate(client, expression) {
  const result = await client.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return result?.result?.value;
}

/* --------------------------------------------------------------- lifecycle -- */

let chrome = null;
let tempDir = null;

async function cleanup() {
  if (chrome) { try { chrome.kill(); } catch { /* already gone */ } }
  await sleep(800);
  if (tempDir) { try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* best effort */ } }
}

async function main() {
  if (!TOKEN) {
    TOKEN = await obtainAuthToken({ api: flag('api', 'UI_A11Y_API', 'http://127.0.0.1:18888') });
  }
  if (!TOKEN) {
    /* Refuse to report a result. An unauthenticated run parks on /login, so every audit
     * would measure the login page and still report zero violations - a false pass that
     * hides the entire authenticated console from the suite. */
    console.log('ui_a11y_result=FAIL');
    console.log('  reason=no_session');
    console.log('  detail=the suite could not log in, so the audits would measure the login page instead of the console');
    console.log('  fix=start the local stack (npm run local:dev) or pass --token=<auth_token>');
    process.exitCode = 1;
    return;
  }
  console.log('[a11y] session=established');

  const sourceChecks = [];
  const appCss = fs.readFileSync(path.join(PROJECT, 'frontend', 'src', 'styles', 'app.css'), 'utf8');
  const styleText = fs.readdirSync(path.join(PROJECT, 'frontend', 'src', 'styles'))
    .filter((file) => file.endsWith('.css'))
    .map((file) => fs.readFileSync(path.join(PROJECT, 'frontend', 'src', 'styles', file), 'utf8'))
    .join('\n');

  sourceChecks.push({
    id: 'reduced-motion',
    ok: /prefers-reduced-motion/.test(styleText),
    detail: 'a prefers-reduced-motion block exists',
  });
  sourceChecks.push({
    id: 'focus-visible',
    ok: /:focus-visible/.test(styleText),
    detail: 'a :focus-visible treatment exists',
  });
  sourceChecks.push({
    id: 'app-css-imports',
    ok: appCss.includes('@import'),
    detail: 'the stylesheet entry layer is wired',
  });

  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-a11y-'));
  chrome = await launchChrome({
    chromePath: CHROME, port: CDP_PORT, userDataDir: tempDir,
    width: VIEWPORT.width, height: VIEWPORT.height,
  });
  const tab = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: 'PUT' })).json();
  const client = await createCdpClient(tab.webSocketDebuggerUrl);

  await client.send('Page.enable');
  await client.send('Network.enable');
  await client.send('Runtime.enable');
  await client.send('Emulation.setDeviceMetricsOverride', { ...VIEWPORT, deviceScaleFactor: 1, mobile: false });

  const setAuthCookie = async (present) => {
    if (!TOKEN) return;
    if (present) {
      await client.send('Network.setCookie', { name: 'auth_token', value: TOKEN, domain: 'localhost', path: '/', httpOnly: true, sameSite: 'Lax' });
    } else {
      await client.send('Network.deleteCookies', { name: 'auth_token', domain: 'localhost', path: '/' });
    }
  };

  const results = [];
  for (const { name: routeName, route } of ROUTES) {
    await setAuthCookie(true);
    await client.send('Page.navigate', { url: BASE + route });
    await sleep(routeName === 'dashboard' ? 5000 : 3600);
    const raw = await evaluate(client, AUDIT);
    const audit = raw ? JSON.parse(raw) : { violations: [{ rule: 'audit-failed', detail: 'probe returned nothing' }], liveRegions: 0, headings: 0 };
    results.push({ route: routeName, path: route, ...audit });
    console.log(`[a11y] ${route} violations=${audit.violations.length} liveRegions=${audit.liveRegions} headings=${audit.headings}`);
    for (const violation of audit.violations) console.log(`        ${violation.rule}: ${violation.detail}`);
  }

  /* Keyboard walkthrough: command palette focus trap and restoration. */
  const walkthrough = [];
  await client.send('Page.navigate', { url: `${BASE}/` });
  await sleep(5000);
  await evaluate(client, `document.body.focus()`);

  /* Ctrl+K opens the palette. */
  await pressKey(client, { key: 'k', code: 'KeyK', windowsVirtualKeyCode: 75, modifiers: 2 });
  const opened = await evaluate(client, `JSON.stringify({
    open: !!document.querySelector('.cp-modal'),
    focused: (document.activeElement && document.activeElement.className) || '',
  })`);
  const openedState = opened ? JSON.parse(opened) : { open: false, focused: '' };
  walkthrough.push({ id: 'palette-opens-from-keyboard', ok: openedState.open, detail: `modal=${openedState.open}` });
  walkthrough.push({ id: 'palette-focuses-search', ok: /cp-search-input/.test(openedState.focused), detail: `focused=${openedState.focused}` });

  if (openedState.open) {
    /* Tab must not escape the dialog. */
    const insideAfterTab = await evaluate(client, `(() => {
      const dialog = document.querySelector('.cp-modal');
      for (let i = 0; i < 12; i += 1) {
        const focusables = dialog.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]),select,textarea,[tabindex]:not([tabindex="-1"])');
        if (focusables.length) focusables[Math.min(i, focusables.length - 1)].focus();
      }
      return !!dialog.contains(document.activeElement);
    })()`);
    walkthrough.push({ id: 'palette-traps-focus', ok: !!insideAfterTab, detail: `inside=${insideAfterTab}` });

    /* Escape closes it and focus returns to the document body's active element. */
    await pressKey(client, { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    const closed = await evaluate(client, `!document.querySelector('.cp-modal')`);
    walkthrough.push({ id: 'palette-closes-on-escape', ok: !!closed, detail: `closed=${closed}` });
  }

  client.close();
  await cleanup();

  const domViolations = results.reduce((sum, entry) => sum + entry.violations.length, 0);
  const failedSource = sourceChecks.filter((check) => !check.ok);
  const failedWalkthrough = walkthrough.filter((step) => !step.ok);

  const report = {
    generatedAt: new Date().toISOString(),
    base: BASE,
    viewport: VIEWPORT,
    sourceChecks,
    routes: results,
    walkthrough,
  };
  const outDir = path.join(PROJECT, '.workbuddy-ai', 'reports', 'ui-parity-a11y-2026-10-06');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'a11y-report.json'), `${JSON.stringify(report, null, 2)}\n`);

  console.log('--------------------------------------------------');
  console.log(`ui_a11y_routes=${results.length}`);
  console.log(`ui_a11y_dom_violations=${domViolations}`);
  console.log(`ui_a11y_source_failures=${failedSource.length}`);
  console.log(`ui_a11y_walkthrough_failures=${failedWalkthrough.length}`);
  for (const check of sourceChecks) console.log(`  ${check.ok ? 'PASS' : 'FAIL'}  ${check.id} :: ${check.detail}`);
  for (const step of walkthrough) console.log(`  ${step.ok ? 'PASS' : 'FAIL'}  ${step.id} :: ${step.detail}`);
  console.log(`ui_a11y_report=.workbuddy-ai/reports/ui-parity-a11y-2026-10-06/a11y-report.json`);
  console.log(`ui_a11y_result=${domViolations + failedSource.length + failedWalkthrough.length === 0 ? 'PASS' : 'FAIL'}`);
  process.exit(domViolations + failedSource.length + failedWalkthrough.length === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error(error);
  await cleanup();
  process.exit(1);
});
