#!/usr/bin/env node
/**
 * Local runtime preflight — ports and process ownership.
 *
 * RUN BEFORE starting local Go/Next services or any runtime acceptance suite.
 *
 * READ-ONLY. It never starts, stops, or terminates a process. It inspects the
 * canonical local ports, classifies who owns each listener, and reports whether the
 * environment is safe to proceed.
 *
 * Canonical component ports (13333 Next, 18888 Go) must be project-managed, never
 * merely occupied. MongoDB (27017) and the HTTP edge (80) are allowed to already be
 * running, provided the expected service answers.
 *
 * Resolving an occupied canonical port by changing the port is forbidden. Diagnose
 * the owner instead.
 *
 * Usage:
 *   npm run local:preflight
 *   XCLOUD_EDGE_URL=http://127.0.0.1:8080 npm run local:preflight
 *   XCLOUD_PREFLIGHT_EXTRA_PORTS=19001,19002 npm run local:preflight
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CANONICAL_PORTS,
  PORT_OUTCOMES,
  PORT_ROLES,
  PORT_ROLE_LABELS,
  INTERNAL_PORT_ROLES,
  edgePortFromUrl,
  inspectPort,
  readRegistry,
  resolveEdgeUrl,
  describeListener,
} from './lib/local-runtime.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

function extraPortsFromEnv(env = process.env) {
  const raw = env.XCLOUD_PREFLIGHT_EXTRA_PORTS || '';
  return raw
    .split(',')
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value) && value > 0 && value <= 65535);
}

function printPortReport(roleLabel, result) {
  console.log(`  ${roleLabel}`);
  console.log(`    port      = ${result.port}`);
  if (result.listener) {
    console.log(`    state     = LISTEN`);
    console.log(`    ${describeListener(result.listener)}`);
    if (result.listener.executable) console.log(`    executable= ${result.listener.executable}`);
    if (result.listener.commandLine) console.log(`    command   = ${result.listener.commandLine}`);
    if (result.listener.startTime) console.log(`    startedAt = ${result.listener.startTime}`);
    if (result.processInfo && result.processInfo.user) console.log(`    owner     = ${result.processInfo.user}`);
  } else {
    console.log(`    state     = FREE`);
  }
  console.log(`    class     = ${result.state}`);
  console.log(`    outcome   = ${result.outcome}`);
  console.log(`    reason    = ${result.reason}`);
  if (result.ownership && result.ownership.reasons.length > 0) {
    console.log(`    ownership = ${result.ownership.verdict} (${result.ownership.reasons.join('; ')})`);
  }
}

async function main() {
  const edgeUrl = resolveEdgeUrl();
  const edgePort = edgePortFromUrl(edgeUrl);
  const extraPorts = extraPortsFromEnv();
  const registry = readRegistry(ROOT);

  console.log('Local runtime preflight (read-only)');
  console.log(`  Repository : ${ROOT}`);
  console.log(`  Edge URL   : ${edgeUrl}`);
  console.log('');

  const portSpecs = [
    { role: 'edge', port: edgePort, label: `${PORT_ROLE_LABELS.edge} (${edgePort})` },
    { role: 'next', port: CANONICAL_PORTS.next, label: PORT_ROLE_LABELS.next },
    { role: 'go', port: CANONICAL_PORTS.go, label: PORT_ROLE_LABELS.go },
    { role: 'mongo', port: CANONICAL_PORTS.mongo, label: PORT_ROLE_LABELS.mongo },
  ];

  const results = [];
  for (const spec of portSpecs) {
    const result = await inspectPort(spec.port, {
      role: spec.role,
      repoRoot: ROOT,
      registryRecord: registry[spec.role] || null,
    });
    result.label = spec.label;
    results.push(result);
  }

  const extraResults = [];
  for (const port of extraPorts) {
    const result = await inspectPort(port, { role: 'custom', repoRoot: ROOT });
    result.label = `extra port ${port}`;
    extraResults.push(result);
  }

  console.log('Canonical ports:');
  console.log('');
  for (const result of results) {
    printPortReport(result.label, result);
    console.log('');
  }

  if (extraResults.length > 0) {
    console.log('Extra requested ports:');
    console.log('');
    for (const result of extraResults) {
      printPortReport(result.label, result);
      console.log('');
    }
  }

  const failures = [];
  for (const result of results) {
    if (!INTERNAL_PORT_ROLES.includes(result.role)) continue;
    if (result.outcome === PORT_OUTCOMES.PORT_FREE) continue;
    if (result.outcome === PORT_OUTCOMES.PROJECT_MANAGED_PROCESS) continue;
    failures.push(result);
  }
  for (const result of extraResults) {
    if (result.outcome === PORT_OUTCOMES.PORT_FREE) continue;
    failures.push(result);
  }

  const contaminated = results.filter(
    (result) => result.outcome === PORT_OUTCOMES.FOREIGN_PROCESS
      || result.outcome === PORT_OUTCOMES.STALE_PROJECT_PROCESS
      || result.outcome === PORT_OUTCOMES.INSUFFICIENT_PERMISSION,
  );

  if (failures.length === 0) {
    console.log('Preflight result: SAFE TO PROCEED');
    const managed = results.filter((r) => r.outcome === PORT_OUTCOMES.PROJECT_MANAGED_PROCESS);
    if (managed.length > 0) {
      console.log(`  Already managed: ${managed.map((r) => `${r.role}:${r.port}`).join(', ')}`);
      console.log('  Run `npm run local:stop` before `npm run local:dev` if you want a clean start.');
    }
  } else {
    console.log('Preflight result: CONTAMINATED');
    console.log('');
    for (const result of failures) {
      console.log(`  ${result.role} port ${result.port} -> ${result.outcome} (${result.reason})`);
      if (result.listener) console.log(`    ${describeListener(result.listener)}`);
    }
    console.log('');
    console.log('Do not continue blindly, and do not change the canonical port to bypass this.');
    console.log('The acceptance suites must own the processes they measure.');
    for (const result of contaminated) {
      if (result.outcome === PORT_OUTCOMES.INSUFFICIENT_PERMISSION) {
        console.log('');
        console.log('INSUFFICIENT_PERMISSION');
        console.log(`  Port ${result.port} is visible but its owner cannot be controlled.`);
        console.log('  Open an elevated PowerShell / Windows Terminal and inspect the PID.');
        console.log('  Terminate it manually only after confirming its executable and command line.');
        console.log('  This tooling never elevates and never launches UAC.');
      }
    }
  }

  console.log('');
  console.log('==================================================');
  for (const role of PORT_ROLES) {
    const result = results.find((r) => r.role === role);
    console.log(`local_preflight_${role}=${result ? result.outcome : 'UNKNOWN'}`);
  }
  for (const result of extraResults) {
    console.log(`local_preflight_extra_${result.port}=${result.outcome}`);
  }
  console.log(`local_preflight_contamination=${contaminated.length}`);
  console.log(`local_preflight_failures=${failures.length}`);
  console.log(`local_preflight_result=${failures.length === 0 ? 'SAFE_TO_PROCEED' : 'CONTAMINATED'}`);
  console.log('==================================================\n');

  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`Local preflight failed: ${err && err.message ? err.message : err}`);
  process.exit(2);
});
