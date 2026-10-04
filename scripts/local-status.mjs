#!/usr/bin/env node
/**
 * Local runtime status.
 *
 * Read-only. Reports both component process state (Mongo, Go, Frontend) and the
 * overall topology state, reusing the shared runtime library so it cannot drift from
 * `local:preflight` or `local:doctor`.
 *
 * Usage:
 *   npm run local:status
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CANONICAL_PORTS,
  PORT_OUTCOMES,
  TOPOLOGY_STATES,
  FRONTEND_ROOT,
  describeListener,
  inspectPort,
  isContaminated,
  probeTopology,
  readRegistry,
} from './lib/local-runtime.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

function processLabel(portResult, topologyReady) {
  if (isContaminated(portResult)) return 'CONTAMINATED';
  if (topologyReady) return 'UP';
  if (!portResult || portResult.outcome === PORT_OUTCOMES.PORT_FREE) return 'DOWN';
  return 'UP';
}

async function main() {
  const registry = readRegistry(ROOT);

  const [frontend, go, mongo, topology] = await Promise.all([
    inspectPort(CANONICAL_PORTS.frontend, { role: 'frontend', repoRoot: ROOT, registryRecord: registry.frontend }),
    inspectPort(CANONICAL_PORTS.go, { role: 'go', repoRoot: ROOT, registryRecord: registry.go }),
    inspectPort(CANONICAL_PORTS.mongo, { role: 'mongo', repoRoot: ROOT }),
    probeTopology(),
  ]);

  const contaminated = [frontend, go].filter(isContaminated);
  const topologyState = contaminated.length > 0 ? TOPOLOGY_STATES.PORT_CONTAMINATION : topology.result;

  console.log('Local runtime status');
  console.log(`  Repository : ${ROOT}`);
  console.log(`  Frontend URL: ${FRONTEND_ROOT}`);
  console.log('');

  console.log('Process state:');
  console.log(`  MongoDB  : ${processLabel(mongo, mongo.outcome === PORT_OUTCOMES.EXPECTED_SERVICE)}  (port ${CANONICAL_PORTS.mongo})`);
  console.log(`  Go       : ${processLabel(go, topology.goReady)}  (port ${CANONICAL_PORTS.go})`);
  console.log(`  Frontend : ${processLabel(frontend, topology.frontendReady)}  (port ${CANONICAL_PORTS.frontend})`);
  console.log('');

  console.log('Canonical port ownership:');
  for (const [name, result] of [['frontend', frontend], ['go', go], ['mongo', mongo]]) {
    console.log(`  ${name.padEnd(8)} ${String(result.port).padEnd(6)} ${result.outcome}${result.listener ? `  ${describeListener(result.listener)}` : ''}`);
  }
  console.log('');

  console.log(`Topology state: ${topologyState}`);
  if (topologyState === TOPOLOGY_STATES.PORT_CONTAMINATION) {
    for (const result of contaminated) {
      console.log(`  port ${result.port} (${result.role}) -> ${result.outcome}: ${result.reason}`);
    }
    console.log('  Diagnose the owner with `npm run local:preflight`. Do not change the port.');
  } else if (topologyState === TOPOLOGY_STATES.GO_DOWN) {
    console.log('  Go backend is down. Start with `npm run local:dev`.');
  } else if (topologyState === TOPOLOGY_STATES.FRONTEND_DOWN) {
    console.log('  Frontend Vite server is down. Start with `npm run local:dev`.');
  } else if (topologyState === TOPOLOGY_STATES.FRONTEND_API_MISROUTED) {
    console.log('  Frontend is up but /api proxy does not reach Go.');
  } else if (topologyState === TOPOLOGY_STATES.FULL_STACK_READY) {
    console.log(`  Open: ${FRONTEND_ROOT}`);
  }

  console.log('');
  console.log('==================================================');
  console.log(`local_status_mongo=${processLabel(mongo, mongo.outcome === PORT_OUTCOMES.EXPECTED_SERVICE)}`);
  console.log(`local_status_go=${processLabel(go, topology.goReady)}`);
  console.log(`local_status_frontend=${processLabel(frontend, topology.frontendReady)}`);
  console.log(`local_status_topology=${topologyState}`);
  console.log('==================================================\n');

  process.exit(topologyState === TOPOLOGY_STATES.FULL_STACK_READY ? 0 : 1);
}

main().catch((err) => {
  console.error(`local:status failed: ${err && err.message ? err.message : err}`);
  process.exit(2);
});
