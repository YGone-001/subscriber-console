#!/usr/bin/env node
/**
 * Local Full-Stack Access Doctor.
 *
 * READ-ONLY diagnostic. It never starts or stops Vite, Go, or MongoDB; it
 * only inspects the currently running local development topology and reports what is reachable.
 *
 * The supported development browser entry is the Vite dev server at http://127.0.0.1:13334.
 * Vite proxies browser-relative /api requests directly to Go at 127.0.0.1:18888.
 *
 * Probing and interpretation live in `scripts/lib/local-runtime.mjs` so this doctor
 * cannot drift from `local:preflight` or `local:status`.
 *
 * Usage:
 *   npm run local:doctor
 */

import { pathToFileURL } from 'node:url';

import {
  GO_HEALTHZ,
  FRONTEND_ROOT,
  FRONTEND_API_PROXY,
  probeTopology,
} from './lib/local-runtime.mjs';

function statusLine(label, url, result) {
  const state = result && result.reachable ? `reachable (HTTP ${result.status})` : 'unreachable';
  return `  ${label}: ${state}  ${url}`;
}

async function main() {
  const topology = await probeTopology();
  const {
    go, frontend, frontendApi,
    goReady, frontendReady, frontendApiRouted, result,
  } = topology;

  console.log('Local full-stack access doctor');
  console.log(`  Frontend URL: ${FRONTEND_ROOT}`);
  console.log('Probes:');
  console.log(statusLine('Go internal       ', GO_HEALTHZ, go));
  console.log(statusLine('Frontend internal ', FRONTEND_ROOT, frontend));
  console.log(statusLine('Frontend API proxy', FRONTEND_API_PROXY, frontendApi));

  if (!goReady) {
    console.log('\nGo backend is not reachable on 127.0.0.1:18888.');
  }
  if (!frontendReady) {
    console.log('\nFrontend UI is not reachable on 127.0.0.1:13334.');
  }
  if (frontendReady && goReady && !frontendApiRouted) {
    console.log('\nFrontend API proxy at 127.0.0.1:13334/api did not reach Go authentication boundary.');
  }

  if (result === 'FULL_STACK_READY') {
    console.log('\nFull-stack browser access is ready.');
    console.log(`Open: ${FRONTEND_ROOT}`);
  } else if (result === 'FRONTEND_DOWN') {
    console.log('\nFull-stack browser access is NOT ready: the Frontend dev server is down.');
  } else if (result === 'GO_DOWN') {
    console.log('\nFull-stack browser access is NOT ready: the Go backend is down.');
  } else if (result === 'FRONTEND_API_MISROUTED') {
    console.log('\nFull-stack browser access is NOT ready: /api proxy is misrouted.');
  }

  console.log('\n==================================================');
  console.log(`local_stack_frontend=${frontendReady ? 'READY' : 'DOWN'}`);
  console.log(`local_stack_go=${goReady ? 'READY' : 'DOWN'}`);
  console.log(`local_stack_api_proxy=${frontendApiRouted ? 'READY' : frontendReady ? 'MISROUTED' : 'UNAVAILABLE'}`);
  console.log(`local_stack_result=${result}`);
  console.log('==================================================\n');

  process.exit(result === 'FULL_STACK_READY' ? 0 : 1);
}

const isDirectRun = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main().catch((err) => {
    console.error(`Local stack doctor failed: ${err.message}`);
    process.exit(2);
  });
}
