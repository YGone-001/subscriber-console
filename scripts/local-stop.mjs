#!/usr/bin/env node
/**
 * Safe local stop.
 *
 * Terminates ONLY processes that can be proven to have been launched by this
 * repository's managed `local:dev` flow, by verifying the runtime ownership record
 * against the live process before acting.
 *
 * Forbidden and not implemented:
 *   kill whatever owns port 13333 / 18888
 *   taskkill /F by image name (node.exe, server.exe)
 *   pkill / killall
 *
 * When ownership cannot be proven the tool refuses (REFUSE_TO_KILL) and prints the
 * process details. When the process is visible but cannot be controlled it reports
 * INSUFFICIENT_PERMISSION and gives a manual instruction; it never elevates and never
 * launches UAC.
 *
 * Usage:
 *   npm run local:stop
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  REGISTRY_ROLES,
  inspectProcess,
  readRecord,
  removeRecord,
  terminateVerifiedProcess,
  verifyOwnership,
} from './lib/local-runtime.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

function describeProcess(info) {
  if (!info) return 'not running';
  const parts = [`pid ${info.processId}`];
  if (info.name) parts.push(`process ${info.name}`);
  if (info.executable) parts.push(`exe ${info.executable}`);
  return parts.join(', ');
}

async function waitForExit(pid, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const info = await inspectProcess(pid, { refresh: true });
    if (!info) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

async function main() {
  console.log('Local managed stop');
  console.log(`  Repository : ${ROOT}`);
  console.log('');

  const outcomes = {};
  let refusals = 0;
  let failures = 0;

  for (const role of REGISTRY_ROLES) {
    const record = readRecord(ROOT, role);
    if (!record) {
      console.log(`  ${role}: no ownership record`);
      outcomes[role] = 'ABSENT';
      continue;
    }

    const info = await inspectProcess(record.pid, { refresh: true });
    const ownership = verifyOwnership(record, info);

    if (ownership.verdict === 'STALE') {
      console.log(`  ${role}: recorded pid ${record.pid} is no longer running -> stale record removed`);
      removeRecord(ROOT, role);
      outcomes[role] = 'STALE';
      continue;
    }

    if (ownership.verdict === 'NOT_FOUND') {
      console.log(`  ${role}: malformed ownership record -> removed`);
      removeRecord(ROOT, role);
      outcomes[role] = 'ABSENT';
      continue;
    }

    if (ownership.verdict === 'REFUSE_TO_KILL') {
      refusals += 1;
      console.log(`  ${role}: REFUSE_TO_KILL`);
      console.log(`    ${describeProcess(info)}`);
      if (info && info.commandLine) console.log(`    command = ${info.commandLine}`);
      console.log(`    reasons = ${ownership.reasons.join('; ')}`);
      console.log('    The record does not prove ownership of this process. Nothing was terminated.');
      console.log('    Inspect the process manually before acting.');
      outcomes[role] = 'REFUSED';
      continue;
    }

    // OWNED
    const result = terminateVerifiedProcess(record, info);
    if (result.ok) {
      const exited = await waitForExit(record.pid);
      removeRecord(ROOT, role);
      console.log(`  ${role}: stopped (pid ${record.pid})${exited ? '' : ' (still exiting)'}`);
      outcomes[role] = 'STOPPED';
      continue;
    }

    if (result.refusal === 'INSUFFICIENT_PERMISSION') {
      failures += 1;
      console.log(`  ${role}: INSUFFICIENT_PERMISSION`);
      console.log(`    ${describeProcess(info)}`);
      console.log(`    ${result.detail || ''}`.trimEnd());
      console.log('    Open an elevated PowerShell / Windows Terminal and inspect the PID.');
      console.log('    Terminate it manually only after confirming its executable and command line.');
      console.log('    This tooling never elevates and never launches UAC.');
      outcomes[role] = 'INSUFFICIENT_PERMISSION';
      continue;
    }

    failures += 1;
    console.log(`  ${role}: stop failed (${result.refusal})`);
    console.log(`    ${describeProcess(info)}`);
    if (result.detail) console.log(`    ${result.detail}`);
    outcomes[role] = 'FAILED';
  }

  console.log('');
  console.log('==================================================');
  for (const role of REGISTRY_ROLES) {
    console.log(`local_stop_${role}=${outcomes[role] || 'ABSENT'}`);
  }
  console.log(`local_stop_refusals=${refusals}`);
  console.log(`local_stop_failures=${failures}`);
  console.log(`local_stop_result=${failures === 0 && refusals === 0 ? 'PASS' : 'NEEDS_ATTENTION'}`);
  console.log('==================================================\n');

  process.exit(failures === 0 && refusals === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`local:stop failed: ${err && err.message ? err.message : err}`);
  process.exit(2);
});
