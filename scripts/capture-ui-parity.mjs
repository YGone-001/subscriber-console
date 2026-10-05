#!/usr/bin/env node
/*
 * UI parity screenshot capture.
 *
 * Drives one headless Chrome over CDP and screenshots the same route set on both
 * the current app and (optionally) the reference app, so parity can be judged from
 * evidence rather than from source alone.
 *
 * Usage:
 *   node scripts/capture-ui-parity.mjs                       # both apps, default routes
 *   UI_CAPTURE_APPS=current node scripts/capture-ui-parity.mjs
 *   UI_CAPTURE_ROUTES="dashboard:/,users:/users" node scripts/capture-ui-parity.mjs
 *   UI_CAPTURE_OUT=.workbuddy-ai/tmp/shots node scripts/capture-ui-parity.mjs
 *
 * Auth: set UI_CAPTURE_TOKEN to the `auth_token` cookie value. Obtain it by POSTing
 * to http://127.0.0.1:18888/api/auth/login with the admin credentials and reading
 * the `auth_token` value out of the Set-Cookie response header.
 *
 * Both backends share JWT_SECRET, so one token authenticates both apps.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = process.env.UI_CAPTURE_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CDP_PORT = Number(process.env.UI_CAPTURE_CDP_PORT || 9337);
const OUT = path.resolve(process.env.UI_CAPTURE_OUT || '.workbuddy-ai/tmp/ui-parity');
const TOKEN = process.env.UI_CAPTURE_TOKEN || '';
const WIDTH = Number(process.env.UI_CAPTURE_WIDTH || 1440);
const HEIGHT = Number(process.env.UI_CAPTURE_HEIGHT || 900);

const APPS = [
  { key: 'current', base: process.env.UI_CAPTURE_CURRENT || 'http://localhost:13333' },
  { key: 'reference', base: process.env.UI_CAPTURE_REFERENCE || 'http://localhost' },
].filter((app) => (process.env.UI_CAPTURE_APPS || 'current,reference').split(',').includes(app.key));

const DEFAULT_ROUTES = [
  'dashboard:/', 'subscribers:/subscribers', 'profile:/profile',
  'ocs-tariffs:/ocs/tariffs', 'ocs-contracts:/ocs/contracts', 'ocs-balances:/ocs/balances',
  'users:/users', 'system-health:/system-health', 'inventory:/inventory',
];
const ROUTES = (process.env.UI_CAPTURE_ROUTES
  ? process.env.UI_CAPTURE_ROUTES.split(',')
  : DEFAULT_ROUTES
).map((entry) => {
  const index = entry.indexOf(':');
  return [entry.slice(0, index), entry.slice(index + 1)];
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(url, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { const res = await fetch(url); if (res.ok) return true; } catch { /* retry */ }
    await sleep(300);
  }
  throw new Error(`timeout waiting for ${url}`);
}

function cdp(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 1;
    const pending = new Map();
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id && pending.has(message.id)) {
        const { res, rej } = pending.get(message.id);
        pending.delete(message.id);
        message.error ? rej(new Error(message.error.message)) : res(message.result);
      }
    };
    ws.onerror = reject;
    ws.onopen = () => resolve({
      send: (method, params = {}) => new Promise((res, rej) => {
        const requestId = id++;
        pending.set(requestId, { res, rej });
        ws.send(JSON.stringify({ id: requestId, method, params }));
      }),
      close: () => ws.close(),
    });
  });
}

let chrome = null;
let tempDir = null;

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-parity-'));
  chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${tempDir}`,
    `--window-size=${WIDTH},${HEIGHT}`, '--hide-scrollbars', '--disable-gpu',
    '--no-first-run', '--no-default-browser-check', '--force-device-scale-factor=1', 'about:blank',
  ], { stdio: 'ignore' });

  await waitFor(`http://127.0.0.1:${CDP_PORT}/json/version`);
  const tab = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: 'PUT' })).json();
  const client = await cdp(tab.webSocketDebuggerUrl);
  await client.send('Page.enable');
  await client.send('Network.enable');
  await client.send('Runtime.enable');
  await client.send('Emulation.setDeviceMetricsOverride', {
    width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false,
  });
  if (TOKEN) {
    await client.send('Network.setCookie', {
      name: 'auth_token', value: TOKEN, domain: 'localhost', path: '/', httpOnly: true, sameSite: 'Lax',
    });
  }

  for (const app of APPS) {
    fs.mkdirSync(path.join(OUT, app.key), { recursive: true });
    for (const [name, route] of ROUTES) {
      try { await client.send('Page.navigate', { url: app.base + route }); } catch { /* redirects abort navigation */ }
      await sleep(name === 'dashboard' ? 5000 : 3800);
      const shot = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      const buffer = Buffer.from(shot.data, 'base64');
      fs.writeFileSync(path.join(OUT, app.key, `${name}.png`), buffer);
      console.log(`[${app.key}] ${route} -> ${buffer.readUInt32BE(16)}x${buffer.readUInt32BE(20)} ${(buffer.length / 1024).toFixed(0)}KB`);
    }
  }
  client.close();
  console.log(`\ncaptured to ${OUT}`);
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
