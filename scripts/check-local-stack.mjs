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
 * Probing and interpretation live in `scripts/lib/local-runtime.mjs` so this doctor
 * cannot drift from `local:preflight` or `local:status`.
 *
 * Usage:
 *   npm run local:doctor
 *   XCLOUD_EDGE_URL=http://127.0.0.1:8080 npm run local:doctor
 */

import { pathToFileURL } from 'node:url';

import {
  GO_HEALTHZ,
  NEXT_DIRECT_API,
  NEXT_ROOT,
  classifyDirectNextApi,
  probeTopology,
  resolveEdgeUrl,
} from './lib/local-runtime.mjs';

export { classifyDirectNextApi };

const EDGE_URL = resolveEdgeUrl();

function statusLine(label, url, result) {
  const state = result.reachable ? `reachable (HTTP ${result.status})` : 'unreachable';
  return `  ${label}: ${state}  ${url}`;
}

async function main() {
  const topology = await probeTopology({ edgeUrl: EDGE_URL });
  const {
    go, next, edge, edgeLogin, edgeApi, nextApi,
    goReady, nextReady, edgeReady, edgeApiRouted, directNextApi, edgeUiOwner, result,
  } = topology;
  const EDGE_ROOT = topology.edgeRootUrl;
  const EDGE_API = topology.edgeApiUrl;

  console.log('Local full-stack access doctor');
  console.log(`  Edge URL: ${EDGE_URL}`);
  console.log('Probes:');
  console.log(statusLine('Go internal  ', GO_HEALTHZ, go));
  console.log(statusLine('Next internal', NEXT_ROOT, next));
  console.log(statusLine('Edge UI      ', EDGE_ROOT, edge));
  console.log(statusLine('Edge API     ', EDGE_API, edgeApi));
  console.log(statusLine('Next direct API', NEXT_DIRECT_API, nextApi));
  console.log(`  Edge UI owner: ${edgeUiOwner}`);

  if (!goReady) {
    console.log('\nGo backend is not reachable on 127.0.0.1:18888.');
  }
  if (!nextReady) {
    console.log('\nNext.js UI is not reachable on 127.0.0.1:13333.');
  }

  if (directNextApi === 'ARCHITECTURE_VIOLATION') {
    console.log('\nARCHITECTURE_VIOLATION');
    console.log(`The Next.js listener at ${NEXT_DIRECT_API} answered with a JSON authentication`);
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
    console.log('Install/start the temporary legacy development Nginx edge:');
    console.log('  sudo ./deploy/nginx/setup-next-legacy.sh');
  } else if (result === 'EDGE_UI_MISROUTED') {
    console.log('\nEDGE_UI_MISROUTED');
    console.log(`The edge answered ${EDGE_ROOT} but UI is not routed to Next.js (observed owner: ${edgeUiOwner}).`);
    console.log('For local Next.js development, install the legacy development edge:');
    console.log('  sudo ./deploy/nginx/setup-next-legacy.sh');
    console.log('then reload Nginx and retry.');
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
  console.log(`local_stack_edge_ui_owner=${edgeUiOwner}`);
  console.log(`local_stack_edge_ui_contract=${edgeUiOwner === 'next' ? 'READY' : edgeReady ? 'MISROUTED' : 'UNAVAILABLE'}`);
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
