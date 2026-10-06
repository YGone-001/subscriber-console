#!/usr/bin/env node
/*
 * UI parity screenshot capture (frozen baseline).
 *
 * Drives one headless Chrome over CDP and screenshots the same route set on both
 * the current app and the reference app, at every viewport in the baseline
 * manifest, so parity is judged from evidence rather than from source alone.
 *
 * The run is FAIL-CLOSED: a route that does not render (blank document, framework
 * error overlay, uncaught exception, or an unexpected redirect to the login page)
 * is recorded as a failure and makes the process exit non-zero. Screenshots are
 * still written for the routes that did render, so a failing run remains
 * diagnosable.
 *
 * Usage:
 *   node scripts/capture-ui-parity.mjs
 *   node scripts/capture-ui-parity.mjs --apps=current --viewports=desktop
 *   node scripts/capture-ui-parity.mjs --routes=dashboard:/,users:/users --out=.workbuddy-ai/tmp/shots
 *   node scripts/capture-ui-parity.mjs --allow-failures        # capture-only, always exit 0
 *
 * Environment fallbacks (kept for compatibility with earlier invocations):
 *   UI_CAPTURE_APPS, UI_CAPTURE_ROUTES, UI_CAPTURE_OUT, UI_CAPTURE_TOKEN,
 *   UI_CAPTURE_VIEWPORTS, UI_CAPTURE_CURRENT, UI_CAPTURE_REFERENCE,
 *   UI_CAPTURE_CHROME, UI_CAPTURE_CDP_PORT
 *
 * Auth: pass the `auth_token` cookie value. Obtain it by POSTing to
 * http://127.0.0.1:18888/api/auth/login with the admin credentials and reading
 * `auth_token` out of the Set-Cookie response header. Both backends share
 * JWT_SECRET, so one token authenticates both apps.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCdpClient, launchChrome, sleep } from './lib/cdp.mjs';

const args = new Map(
  process.argv.slice(2).filter((arg) => arg.startsWith('--')).map((arg) => {
    const [key, value = 'true'] = arg.replace(/^--/, '').split('=');
    return [key, value];
  }),
);
const flag = (name, envName, fallback) => args.get(name) ?? process.env[envName] ?? fallback;

const CHROME = flag('chrome', 'UI_CAPTURE_CHROME', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
const CDP_PORT = Number(flag('cdp-port', 'UI_CAPTURE_CDP_PORT', 9337));
const OUT = path.resolve(flag('out', 'UI_CAPTURE_OUT', '.workbuddy-ai/tmp/ui-parity'));
const TOKEN = flag('token', 'UI_CAPTURE_TOKEN', '');
const ALLOW_FAILURES = args.get('allow-failures') === 'true';

const APPS = [
  { key: 'current', base: flag('current', 'UI_CAPTURE_CURRENT', 'http://localhost:13333') },
  { key: 'reference', base: flag('reference', 'UI_CAPTURE_REFERENCE', 'http://localhost') },
].filter((app) => flag('apps', 'UI_CAPTURE_APPS', 'current,reference').split(',').includes(app.key));

const DEFAULT_ROUTES = [
  'login:/login',
  'dashboard:/',
  'subscribers:/subscribers',
  'profile:/profile',
  'ocs-tariffs:/ocs/tariffs',
  'ocs-contracts:/ocs/contracts',
  'ocs-balances:/ocs/balances',
  'users:/users',
  'system-health:/system-health',
  'inventory:/inventory',
];

/* Baseline viewports. Order matters: the manifest is emitted in this order. */
const VIEWPORTS = (flag('viewports', 'UI_CAPTURE_VIEWPORTS', 'desktop,tablet,mobile').split(','))
  .map((key) => ({
    desktop: { key: 'desktop', width: 1440, height: 900 },
    tablet: { key: 'tablet', width: 1024, height: 768 },
    mobile: { key: 'mobile', width: 390, height: 844 },
  }[key]))
  .filter(Boolean);

/* When set, real horizontal overflow fails the run instead of only being recorded. */
const STRICT_LAYOUT = args.get('strict-layout') === 'true' || process.env.UI_CAPTURE_STRICT_LAYOUT === '1';

const ROUTES = (flag('routes', 'UI_CAPTURE_ROUTES', DEFAULT_ROUTES.join(','))
  .split(',')
  .map((entry) => {
    const index = entry.indexOf(':');
    return { name: entry.slice(0, index), route: entry.slice(index + 1) };
  }));

/*
 * In-page health AND layout probe. Runs as a plain expression so it works in any
 * app shell.
 *
 * The layout half is what makes responsive parity checkable rather than a matter of
 * opinion: it reports real horizontal overflow and the elements that cause it, plus
 * interactive targets below the 24x24 CSS-pixel minimum. Elements inside an
 * intentionally scrollable ancestor are not counted as overflow — a data table is
 * allowed to scroll inside its own wrapper.
 */
const HEALTH_PROBE = `(() => {
  const text = ((document.body && document.body.innerText) || '').trim();
  const root = document.querySelector('#root');

  const doc = document.documentElement;
  const overflow = Math.max(0, doc.scrollWidth - doc.clientWidth);
  const offenders = [];
  if (overflow > 1) {
    const viewportWidth = doc.clientWidth;
    for (const el of document.querySelectorAll('body *')) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (rect.right <= viewportWidth + 1 && rect.left >= -1) continue;
      let ancestor = el.parentElement;
      let insideScroller = false;
      while (ancestor && ancestor !== document.body) {
        const style = getComputedStyle(ancestor);
        if (style.overflowX === 'auto' || style.overflowX === 'scroll') { insideScroller = true; break; }
        ancestor = ancestor.parentElement;
      }
      if (insideScroller) continue;
      offenders.push({
        tag: el.tagName.toLowerCase(),
        cls: String(el.className || '').slice(0, 90),
        left: Math.round(rect.left),
        right: Math.round(rect.right),
      });
      if (offenders.length >= 8) break;
    }
  }

  const smallTargets = [];
  for (const el of document.querySelectorAll('button, a[href], input, select, textarea, [role="button"]')) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    if (rect.width >= 24 && rect.height >= 24) continue;
    smallTargets.push({
      tag: el.tagName.toLowerCase(),
      cls: String(el.className || '').slice(0, 60),
      w: Math.round(rect.width),
      h: Math.round(rect.height),
    });
    if (smallTargets.length >= 12) break;
  }

  return JSON.stringify({
    overlay: !!document.querySelector('vite-error-overlay'),
    browserErrorPage: !!document.querySelector('#main-frame-error, .neterror'),
    runtimeError: /Unhandled Runtime Error|Application error: a client-side exception|Cannot read propert|is not defined/i.test(text),
    textLength: text.length,
    rootChildren: root ? root.children.length : null,
    pathname: location.pathname,
    title: document.title,
    layout: { overflow, offenders, smallTargets },
  });
})()`;

function evaluateHealth(snapshot, requestedRoute) {
  if (snapshot.overlay) return 'framework_error_overlay';
  if (snapshot.browserErrorPage) return 'browser_error_page';
  if (snapshot.runtimeError) return 'runtime_error_text';
  if (snapshot.textLength < 40) return 'empty_document';
  if (snapshot.rootChildren === 0) return 'empty_root';
  const wantsLogin = requestedRoute === '/login';
  if (!wantsLogin && snapshot.pathname.replace(/\/$/, '') === '/login') return 'redirected_to_login';
  return null;
}

let chrome = null;
let tempDir = null;
const manifest = { generatedAt: new Date().toISOString(), apps: [], viewports: VIEWPORTS, routes: ROUTES, entries: [] };

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-parity-'));
  const first = VIEWPORTS[0] ?? { width: 1440, height: 900 };
  chrome = await launchChrome({
    chromePath: CHROME,
    port: CDP_PORT,
    userDataDir: tempDir,
    width: first.width,
    height: first.height,
  });

  const tab = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: 'PUT' })).json();
  const client = await createCdpClient(tab.webSocketDebuggerUrl);
  console.log(`cdp_transport=${client.transport}`);

  await client.send('Page.enable');
  await client.send('Network.enable');
  await client.send('Runtime.enable');

  /* Uncaught exceptions are collected into a per-navigation bucket. */
  let exceptions = [];
  client.onEvent((message) => {
    if (message.method !== 'Runtime.exceptionThrown') return;
    const detail = message.params?.exceptionDetails;
    const description = detail?.exception?.description || detail?.text || 'uncaught exception';
    exceptions.push(String(description).split('\n')[0].slice(0, 160));
  });

  if (TOKEN) {
    await client.send('Network.setCookie', {
      name: 'auth_token', value: TOKEN, domain: 'localhost', path: '/', httpOnly: true, sameSite: 'Lax',
    });
  }

  const setAuthCookie = async (present) => {
    if (!TOKEN) return;
    if (present) {
      await client.send('Network.setCookie', {
        name: 'auth_token', value: TOKEN, domain: 'localhost', path: '/', httpOnly: true, sameSite: 'Lax',
      });
    } else {
      await client.send('Network.deleteCookies', { name: 'auth_token', domain: 'localhost', path: '/' });
    }
  };

  for (const app of APPS) {
    manifest.apps.push({ key: app.key, base: app.base });
    for (const viewport of VIEWPORTS) {
      await client.send('Emulation.setDeviceMetricsOverride', {
        width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: viewport.key === 'mobile',
      });
      const dir = path.join(OUT, app.key, viewport.key);
      fs.mkdirSync(dir, { recursive: true });

      for (const { name, route } of ROUTES) {
        exceptions = [];
        /* The login surface must be captured signed out, every other route signed in. */
        await setAuthCookie(route !== '/login');
        const url = app.base + route;
        let navigationError = null;
        try {
          const navigation = await client.send('Page.navigate', { url });
          navigationError = navigation?.errorText || null;
        } catch (error) {
          navigationError = error.message;
        }
        await sleep(name === 'dashboard' ? 5000 : 3800);

        const shot = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
        const buffer = Buffer.from(shot.data, 'base64');
        const file = path.join(dir, `${name}.png`);
        fs.writeFileSync(file, buffer);

        let snapshot = { textLength: -1, rootChildren: null, pathname: route, overlay: false, runtimeError: false };
        try {
          const probe = await client.send('Runtime.evaluate', { expression: HEALTH_PROBE, returnByValue: true });
          snapshot = JSON.parse(probe.result.value);
        } catch { /* probe failure is itself recorded below */ }

        let reason = navigationError ? `navigation_error: ${navigationError}` : evaluateHealth(snapshot, route);
        if (!reason && exceptions.length) reason = `uncaught_exception: ${exceptions[0]}`;
        if (!reason && STRICT_LAYOUT && (snapshot.layout?.overflow ?? 0) > 1) {
          const first = snapshot.layout.offenders[0];
          reason = `layout_overflow: ${snapshot.layout.overflow}px${first ? ` via <${first.tag} class="${first.cls}">` : ''}`;
        }

        manifest.entries.push({
          app: app.key,
          viewport: viewport.key,
          name,
          route,
          url,
          file: path.relative(OUT, file).replace(/\\/g, '/'),
          bytes: buffer.length,
          width: buffer.readUInt32BE(16),
          height: buffer.readUInt32BE(20),
          status: reason ? 'FAIL' : 'OK',
          reason,
          snapshot,
        });

        console.log(`[${app.key}/${viewport.key}] ${route} -> ${buffer.readUInt32BE(16)}x${buffer.readUInt32BE(20)} ${(buffer.length / 1024).toFixed(0)}KB ${reason ? `FAIL(${reason})` : 'OK'}`);
      }
    }
  }

  client.close();

  const failures = manifest.entries.filter((entry) => entry.status === 'FAIL');
  manifest.failures = failures.length;
  manifest.result = failures.length === 0 ? 'PASS' : 'FAIL';
  fs.writeFileSync(path.join(OUT, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  console.log('--------------------------------------------------');
  console.log(`ui_capture_entries=${manifest.entries.length}`);
  console.log(`ui_capture_failures=${failures.length}`);
  console.log(`ui_capture_manifest=${path.relative(process.cwd(), path.join(OUT, 'manifest.json')).replace(/\\/g, '/')}`);
  console.log(`ui_capture_result=${manifest.result}`);
  if (failures.length) {
    for (const entry of failures) console.log(`  FAIL ${entry.app}/${entry.viewport} ${entry.route} :: ${entry.reason}`);
    process.exitCode = ALLOW_FAILURES ? 0 : 1;
  }
}

async function cleanup() {
  if (chrome) { try { chrome.kill(); } catch { /* already gone */ } }
  await sleep(1000);
  if (tempDir) { try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* best effort */ } }
}

main().then(cleanup).catch(async (error) => {
  console.error('capture failed:', error.message);
  await cleanup();
  process.exit(1);
});
