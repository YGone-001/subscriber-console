#!/usr/bin/env node
/**
 * Local runtime status.
 *
 * Read-only. Reports both component process state (Mongo, Go, Next, Nginx) and the
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
  describeListener,
  inspectPort,
  isContaminated,
  probeTopology,
  readRegistry,
  resolveEdgeUrl,
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
  const edgeUrl = resolveEdgeUrl();
  const registry = readRegistry(ROOT);

  const [edge, next, go, mongo, topology] = await Promise.all([
    inspectPort(CANONICAL_PORTS.edge, { role: 'edge', repoRoot: ROOT }),
    inspectPort(CANONICAL_PORTS.next, { role: 'next', repoRoot: ROOT, registryRecord: registry.next }),
    inspectPort(CANONICAL_PORTS.go, { role: 'go', repoRoot: ROOT, registryRecord: registry.go }),
    inspectPort(CANONICAL_PORTS.mongo, { role: 'mongo', repoRoot: ROOT }),
    probeTopology({ edgeUrl }),
  ]);

  const contaminated = [next, go].filter(isContaminated);
  const topologyState = contaminated.length > 0 ? TOPOLOGY_STATES.PORT_CONTAMINATION : topology.result;

  console.log('Local runtime status');
  console.log(`  Repository : ${ROOT}`);
  console.log(`  Edge URL   : ${edgeUrl}`);
  console.log('');

  console.log('Process state:');
  console.log(`  MongoDB : ${processLabel(mongo, mongo.outcome === PORT_OUTCOMES.EXPECTED_SERVICE)}  (port ${CANONICAL_PORTS.mongo})`);
  console.log(`  Go      : ${processLabel(go, topology.goReady)}  (port ${CANONICAL_PORTS.go})`);
  console.log(`  Next    : ${processLabel(next, topology.nextReady)}  (port ${CANONICAL_PORTS.next})`);
  console.log(`  Nginx   : ${topology.edgeReady ? 'UP' : 'DOWN'}  (port ${CANONICAL_PORTS.edge})`);
  console.log('');

  console.log('Canonical port ownership:');
  for (const [name, result] of [['edge', edge], ['next', next], ['go', go], ['mongo', mongo]]) {
    console.log(`  ${name.padEnd(5)} ${String(result.port).padEnd(6)} ${result.outcome}${result.listener ? `  ${describeListener(result.listener)}` : ''}`);
  }
  console.log('');

  console.log(`Topology state: ${topologyState}`);
  if (topologyState === TOPOLOGY_STATES.PORT_CONTAMINATION) {
    for (const result of contaminated) {
      console.log(`  port ${result.port} (${result.role}) -> ${result.outcome}: ${result.reason}`);
    }
    console.log('  Diagnose the owner with `npm run local:preflight`. Do not change the port.');
  } else if (topologyState === TOPOLOGY_STATES.EDGE_REQUIRED) {
    console.log('  Go and Next are up, but the Nginx edge is missing.');
    console.log('  Run `sudo ./deploy/nginx/setup.sh`, then `npm run local:doctor`.');
  } else if (topologyState === TOPOLOGY_STATES.FULL_STACK_READY) {
    console.log(`  Open: ${edgeUrl}`);
  }

  console.log('');
  console.log('==================================================');
  console.log(`local_status_mongo=${processLabel(mongo, mongo.outcome === PORT_OUTCOMES.EXPECTED_SERVICE)}`);
  console.log(`local_status_go=${processLabel(go, topology.goReady)}`);
  console.log(`local_status_next=${processLabel(next, topology.nextReady)}`);
  console.log(`local_status_nginx=${topology.edgeReady ? 'UP' : 'DOWN'}`);
  console.log(`local_status_topology=${topologyState}`);
  console.log('==================================================\n');

  process.exit(topologyState === TOPOLOGY_STATES.FULL_STACK_READY ? 0 : 1);
}

main().catch((err) => {
  console.error(`local:status failed: ${err && err.message ? err.message : err}`);
  process.exit(2);
});
