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
 * The direct Next.js API probe is interpreted, not merely reported: the Next.js
 * listener must never answer `/api/auth/me` with a JSON authentication response. If it
 * ever does, the UI runtime has started owning API behavior and the doctor reports
 * ARCHITECTURE_VIOLATION instead of a topology state.
 *
 * Usage:
 *   npm run local:doctor
 *   XCLOUD_EDGE_URL=http://127.0.0.1:8080 npm run local:doctor
 */

import http from 'node:http';
import { pathToFileURL } from 'node:url';

const DEFAULT_EDGE_URL = 'http://127.0.0.1';
const EDGE_URL = (process.env.XCLOUD_EDGE_URL || DEFAULT_EDGE_URL).replace(/\/+$/, '');

const GO_HEALTHZ = 'http://127.0.0.1:18888/healthz';
const NEXT_ROOT = 'http://127.0.0.1:13333/';
const NEXT_API = 'http://127.0.0.1:13333/api/auth/me';
const EDGE_ROOT = `${EDGE_URL}/`;
const EDGE_API = `${EDGE_URL}/api/auth/me`;

const PROBE_TIMEOUT_MS = 4000;
const MAX_BODY_BYTES = 8192;

/**
 * Probe a URL. Resolves with a status when the server answers (any status code is a
 * reachability success) and with a transport error otherwise. No credentials, no
 * cookies, no request body: this is a topology check, not an authentication check.
 * A bounded body sample and the content type are captured so the direct Next.js API
 * answer can be interpreted instead of merely observed.
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
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        if (size >= MAX_BODY_BYTES) return;
        size += chunk.length;
        chunks.push(chunk);
      });
      res.on('end', () => done({
        reachable: true,
        status: res.statusCode,
        contentType: String(res.headers['content-type'] || ''),
        body: Buffer.concat(chunks).subarray(0, MAX_BODY_BYTES).toString('utf8'),
      }));
      res.on('error', (err) => done({ reachable: false, error: err.message }));
    });
    req.on('timeout', () => {
      req.destroy(new Error('timeout'));
    });
    req.on('error', (err) => done({ reachable: false, error: err.message }));
  });
}

/**
 * Interpret a direct `GET http://127.0.0.1:13333/api/auth/me` probe.
 *
 * The Next.js listener owns no /api route, so the only acceptable answer is a
 * non-JSON framework page (typically a 404 HTML document). A JSON answer on an
 * authentication status code (200 or 401) means the Next.js listener is behaving as
 * the authentication API authority: that is an architecture violation, never a
 * topology quirk, and it must fail the doctor rather than pass as "expected 404".
 */
export function classifyDirectNextApi(result) {
  if (!result || !result.reachable) return 'UNREACHABLE';
  const contentType = String(result.contentType || '');
  const isJson = /application\/json/i.test(contentType);
  const isAuthBoundaryStatus = result.status === 401 || result.status === 200;
  if (isJson && isAuthBoundaryStatus) return 'ARCHITECTURE_VIOLATION';
  return 'UNSUPPORTED_BY_DESIGN';
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
  const directNextApi = classifyDirectNextApi(nextApi);

  let result;
  // An architecture violation outranks every topology state: a Next.js listener that
  // answers the authentication API is a contract breach, not a "Next is up" reading.
  if (directNextApi === 'ARCHITECTURE_VIOLATION') result = 'ARCHITECTURE_VIOLATION';
  else if (!goReady) result = 'GO_DOWN';
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

  if (directNextApi === 'ARCHITECTURE_VIOLATION') {
    console.log('\nARCHITECTURE_VIOLATION');
    console.log(`The Next.js listener at ${NEXT_API} answered with a JSON authentication`);
    console.log(`response (HTTP ${nextApi.status}, content-type "${nextApi.contentType}").`);
    console.log('Next.js owns no API route. Remove any Next.js /api handler, rewrite or');
    console.log('reverse proxy so /api and /api/* remain exclusively served by Go.');
  } else {
    console.log('\nDirect Next.js API access is intentionally unsupported. Use the Nginx edge URL.');
  }

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
  } else if (result === 'ARCHITECTURE_VIOLATION') {
    console.log('\nFull-stack browser access is NOT ready: the API ownership boundary is broken.');
  }

  console.log('\n==================================================');
  console.log(`local_stack_next=${nextReady ? 'READY' : 'DOWN'}`);
  console.log(`local_stack_go=${goReady ? 'READY' : 'DOWN'}`);
  console.log(`local_stack_edge=${edgeReady ? 'READY' : 'UNAVAILABLE'}`);
  console.log(`local_stack_edge_api=${edgeApiRouted ? 'READY' : edgeReady ? 'MISROUTED' : 'UNAVAILABLE'}`);
  console.log(`local_stack_direct_next_api=${directNextApi}`);
  console.log(`local_stack_result=${result}`);
  console.log('==================================================\n');

  process.exit(result === 'FULL_STACK_READY' ? 0 : 1);
}

// Only probe when invoked as a CLI. Importing this module (for example to reuse
// `classifyDirectNextApi` in an acceptance suite) must not touch the network.
const isDirectRun = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main().catch((err) => {
    console.error(`Local stack doctor failed: ${err.message}`);
    process.exit(2);
  });
}
