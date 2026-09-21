#!/usr/bin/env node
/**
 * Capture Phase 5.6 Production Evidence Screenshots
 * Target:
 *  - docs/backend-migration/evidence/phase-5-6/tariffs.png
 *  - docs/backend-migration/evidence/phase-5-6/contracts.png
 *  - docs/backend-migration/evidence/phase-5-6/balances.png
 * Resolution: 1440x900
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SignJWT } from 'jose';

const JWT_SECRET = 'management-freeze-secret-token-32bytes-long';
const secretKey = new TextEncoder().encode(JWT_SECRET);
const MONGO_URI = process.env.MONGODB_URI || 'mongodb://10.10.0.139:27017';
const EVIDENCE_DIR = path.resolve('test-results/screenshots');
const GO_PORT = 18888;
const NEXT_PORT = 13333;
const CDP_PORT = 9222;

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

let goProcess = null;
let nextProcess = null;
let chromeProcess = null;
let tempChromeDir = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHttp(url, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status === 401 || res.status === 307) {
        return true;
      }
    } catch {
      // Retry
    }
    await sleep(300);
  }
  throw new Error(`Timeout waiting for ${url}`);
}

function createCDPClient(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let msgId = 1;
    const callbacks = new Map();
    const eventListeners = new Map();

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.id && callbacks.has(msg.id)) {
          const { resolve: res, reject: rej } = callbacks.get(msg.id);
          callbacks.delete(msg.id);
          if (msg.error) {
            rej(new Error(`CDP Error [${msg.error.code}]: ${msg.error.message}`));
          } else {
            res(msg.result);
          }
        } else if (msg.method) {
          const handler = eventListeners.get(msg.method);
          if (handler) handler(msg.params);
        }
      } catch (err) {
        console.error('CDP parse error:', err);
      }
    };

    ws.onerror = (err) => reject(err);

    ws.onopen = () => {
      resolve({
        send: (method, params = {}) =>
          new Promise((res, rej) => {
            const id = msgId++;
            callbacks.set(id, { resolve: res, reject: rej });
            ws.send(JSON.stringify({ id, method, params }));
          }),
        on: (event, handler) => {
          eventListeners.set(event, handler);
        },
        close: () => ws.close(),
      });
    };
  });
}

function parsePngDimensions(buffer) {
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

async function cleanup() {
  console.log('Cleaning up processes...');
  if (chromeProcess) {
    try { chromeProcess.kill(); } catch {}
  }
  if (nextProcess) {
    try { nextProcess.kill(); } catch {}
  }
  if (goProcess) {
    try { goProcess.kill(); } catch {}
  }
  await sleep(1500);
  if (tempChromeDir) {
    try {
      fs.rmSync(tempChromeDir, { recursive: true, force: true });
    } catch {}
  }
}

process.on('SIGINT', async () => {
  await cleanup();
  process.exit(1);
});

async function main() {
  try {
    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });

    // 1. Generate Auth Token
    console.log('[1/6] Minting admin JWT...');
    const token = await new SignJWT({
      username: 'admin',
      role: 'root',
      sv: 0,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime('24h')
      .sign(secretKey);

    // 2. Start Go Backend
    console.log('[2/6] Starting Go backend on :' + GO_PORT + '...');
    const goBin = path.resolve('backend/server.exe');
    goProcess = spawn(goBin, [], {
      cwd: path.resolve('backend'),
      env: {
        ...process.env,
        HTTP_ADDR: `:${GO_PORT}`,
        MONGODB_URI: MONGO_URI,
        MONGODB_XCLOUD_DB: 'xcloud',
        MONGODB_APP_DB: 'xcloud_ops',
        JWT_SECRET: JWT_SECRET,
      },
      stdio: 'pipe',
    });

    goProcess.on('error', (err) => {
      console.error('Go backend error:', err);
    });

    await waitForHttp(`http://127.0.0.1:${GO_PORT}/readyz`);
    console.log('  Go backend is healthy.');

    // 3. Start Next.js
    console.log('[3/6] Starting Next.js frontend on :' + NEXT_PORT + '...');
    nextProcess = spawn('node', ['node_modules/next/dist/bin/next', 'start', '-p', String(NEXT_PORT)], {
      cwd: path.resolve('frontend'),
      env: {
        ...process.env,
        PORT: String(NEXT_PORT),
        GO_BACKEND_URL: `http://127.0.0.1:${GO_PORT}`,
        MONGODB_URI: MONGO_URI,
        MONGODB_XCLOUD_DB: 'xcloud',
        MONGODB_APP_DB: 'xcloud_ops',
        JWT_SECRET: JWT_SECRET,
      },
      stdio: 'pipe',
    });

    nextProcess.on('error', (err) => {
      console.error('Next.js error:', err);
    });

    await waitForHttp(`http://127.0.0.1:${NEXT_PORT}/login`);
    console.log('  Next.js frontend is healthy.');

    // 4. Start Chrome Headless
    console.log('[4/6] Launching Chrome Headless with CDP...');
    tempChromeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-evidence-'));
    chromeProcess = spawn(CHROME_PATH, [
      '--headless=new',
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${tempChromeDir}`,
      '--window-size=1440,900',
      '--hide-scrollbars',
      '--disable-gpu',
      '--no-first-run',
      'about:blank',
    ]);

    await waitForHttp(`http://127.0.0.1:${CDP_PORT}/json/version`);
    console.log('  Chrome CDP is ready.');

    // 5. Connect to CDP and capture screenshots
    console.log('[5/6] Connecting to CDP WebSocket...');
    const newTabRes = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: 'PUT' });
    const tabInfo = await newTabRes.json();
    const client = await createCDPClient(tabInfo.webSocketDebuggerUrl);

    await client.send('Page.enable');
    await client.send('Network.enable');

    // Set precise viewport
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });

    // Set auth cookie
    await client.send('Network.setCookie', {
      name: 'auth_token',
      value: token,
      domain: 'localhost',
      path: '/',
      httpOnly: true,
      sameSite: 'Lax',
    });

    const pagesToCapture = [
      { route: '/ocs/tariffs', filename: 'tariffs.png', label: 'Tariff Plans' },
      { route: '/ocs/contracts', filename: 'contracts.png', label: 'Contract Subscribers' },
      { route: '/ocs/balances', filename: 'balances.png', label: 'Subscriber Balances' },
    ];

    console.log('[6/6] Capturing production evidence screenshots...');
    for (const item of pagesToCapture) {
      console.log(`  Navigating to ${item.route} (${item.label})...`);
      let loadFired = false;
      client.on('Page.loadEventFired', () => {
        loadFired = true;
      });

      await client.send('Page.navigate', {
        url: `http://localhost:${NEXT_PORT}${item.route}`,
      });

      // Wait for page load and hydration/SWR data
      await sleep(3500);

      const shotRes = await client.send('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: false,
      });

      const buffer = Buffer.from(shotRes.data, 'base64');
      const targetPath = path.join(EVIDENCE_DIR, item.filename);
      fs.writeFileSync(targetPath, buffer);

      const dims = parsePngDimensions(buffer);
      console.log(`  Saved ${item.filename}: ${buffer.length} bytes, ${dims.width}x${dims.height}`);

      if (dims.width !== 1440 || dims.height !== 900) {
        throw new Error(`Invalid dimensions for ${item.filename}: expected 1440x900, got ${dims.width}x${dims.height}`);
      }
      if (buffer.length < 50000) {
        throw new Error(`Suspiciously small file size for ${item.filename}: ${buffer.length} bytes`);
      }
    }

    client.close();
    console.log('All 3 evidence screenshots successfully captured and verified!');
  } finally {
    await cleanup();
  }
}

main().catch((err) => {
  console.error('Evidence capture failed:', err);
  process.exit(1);
});
