#!/usr/bin/env node
/**
 * Local Full-Stack Access Doctor.
 *
 * READ-ONLY diagnostic. It never starts or stops Next.js, Go, MongoDB or Nginx; it
 * only inspects the currently running local topology and reports what is reachable.
 *
 * The full application browser entry is the Nginx edge. Next.js (:13333) and Go
 * (:18888) are loopback-internal component endpoints; the browser must never be
 * pointed at them for full-stack use. Relative browser `/api` requests only reach Go
 * when they enter through the Nginx edge.
 *
 * Usage:
 *   npm run local:doctor
 *   XCLOUD_EDGE_URL=http://127.0.0.1:8080 npm run local:doctor
 */

import http from 'node:http';

const DEFAULT_EDGE_URL = 'http://127.0.0.1';
const EDGE_URL = (process.env.XCLOUD_EDGE_URL || DEFAULT_EDGE_URL).replace(/\/+$/, '');

const GO_HEALTHZ = 'http://127.0.0.1:18888/healthz';
const NEXT_ROOT = 'http://127.0.0.1:13333/';
const NEXT_API = 'http://127.0.0.1:13333/api/auth/me';
const EDGE_ROOT = `${EDGE_URL}/`;
const EDGE_API = `${EDGE_URL}/api/auth/me`;

const PROBE_TIMEOUT_MS = 4000;

/**
 * Probe a URL. Resolves with a status when the server answers (any status code is a
 * reachability success) and with a transport error otherwise. No credentials, no
 * cookies, no request body: this is a topology check, not an authentication check.
 */
function probe(url) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const req = http.get(url, { timeout: PROBE_TIMEOUT_MS }, (res) => {
      res.resume();
      res.on('end', () => done({ reachable: true, status: res.statusCode }));
      res.on('error', (err) => done({ reachable: false, error: err.message }));
    });
    req.on('timeout', () => {
      req.destroy(new Error('timeout'));
    });
    req.on('error', (err) => done({ reachable: false, error: err.message }));
  });
}

function statusLine(label, url, result) {
  const state = result.reachable ? `reachable (HTTP ${result.status})` : 'unreachable';
  return `  ${label}: ${state}  ${url}`;
}

async function main() {
  const [go, next, edge, edgeApi, nextApi] = await Promise.all([
    probe(GO_HEALTHZ),
    probe(NEXT_ROOT),
    probe(EDGE_ROOT),
    probe(EDGE_API),
    probe(NEXT_API),
  ]);

  const goReady = go.reachable;
  const nextReady = next.reachable;
  const edgeReady = edge.reachable;
  const edgeApiRouted = edgeApi.reachable && edgeApi.status === 401;

  let result;
  if (!goReady) result = 'GO_DOWN';
  else if (!nextReady) result = 'NEXT_DOWN';
  else if (!edgeReady) result = 'EDGE_REQUIRED';
  else if (!edgeApiRouted) result = 'EDGE_API_MISROUTED';
  else result = 'FULL_STACK_READY';

  console.log('Local full-stack access doctor');
  console.log(`  Edge URL: ${EDGE_URL}`);
  console.log('Probes:');
  console.log(statusLine('Go internal  ', GO_HEALTHZ, go));
  console.log(statusLine('Next internal', NEXT_ROOT, next));
  console.log(statusLine('Edge UI      ', EDGE_ROOT, edge));
  console.log(statusLine('Edge API     ', EDGE_API, edgeApi));
  console.log(statusLine('Next direct API', NEXT_API, nextApi));

  if (!goReady) {
    console.log('\nGo backend is not reachable on 127.0.0.1:18888.');
  }
  if (!nextReady) {
    console.log('\nNext.js UI is not reachable on 127.0.0.1:13333.');
  }

  console.log('\nDirect Next.js API access is intentionally unsupported. Use the Nginx edge URL.');

  if (result === 'FULL_STACK_READY') {
    console.log('\nFull-stack browser access is ready.');
    console.log(`Open: ${EDGE_URL}`);
  } else if (result === 'EDGE_REQUIRED') {
    console.log('\nFull-stack browser access is NOT ready.');
    console.log('');
    console.log('Do not use http://localhost:13333.');
    console.log('Install/start the Nginx edge and use:');
    console.log('http://localhost');
  } else if (result === 'EDGE_API_MISROUTED') {
    console.log('\nEDGE_API_MISROUTED');
    console.log(`The edge answered ${EDGE_ROOT} but ${EDGE_API} did not reach the Go`);
    console.log('authentication boundary (expected HTTP 401 without credentials).');
    console.log('Check that deploy/nginx/xcloud.conf routes `location = /api` and');
    console.log('`location /api/` to the Go upstream (127.0.0.1:18888), then reload Nginx.');
  } else if (result === 'NEXT_DOWN') {
    console.log('\nFull-stack browser access is NOT ready: the Next.js UI is down.');
  } else if (result === 'GO_DOWN') {
    console.log('\nFull-stack browser access is NOT ready: the Go backend is down.');
  }

  console.log('\n==================================================');
  console.log(`local_stack_next=${nextReady ? 'READY' : 'DOWN'}`);
  console.log(`local_stack_go=${goReady ? 'READY' : 'DOWN'}`);
  console.log(`local_stack_edge=${edgeReady ? 'READY' : 'UNAVAILABLE'}`);
  console.log(`local_stack_edge_api=${edgeApiRouted ? 'READY' : edgeReady ? 'MISROUTED' : 'UNAVAILABLE'}`);
  console.log(`local_stack_direct_next_api=UNSUPPORTED_BY_DESIGN`);
  console.log(`local_stack_result=${result}`);
  console.log('==================================================\n');

  process.exit(result === 'FULL_STACK_READY' ? 0 : 1);
}

main().catch((err) => {
  console.error(`Local stack doctor failed: ${err.message}`);
  process.exit(2);
});
