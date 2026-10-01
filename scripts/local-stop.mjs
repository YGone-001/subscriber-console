#!/usr/bin/env node
/**
 * Safe local stop.
 *
 * Terminates ONLY processes that can be proven to have been launched by this
 * repository's managed `local:dev` flow, by verifying the runtime ownership record
 * against the live process before acting.
 *
 * A requested termination is NOT a completed stop: the ownership record is removed only
 * after the process is confirmed gone. If a managed process outlives the stop timeout
 * the record is KEPT, the run reports STOP_TIMEOUT / NEEDS_ATTENTION and exits non-zero,
 * so the operator can retry `npm run local:stop` or inspect the PID manually.
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
  STOP_STATUSES,
  inspectProcess,
  readRecord,
  stopManagedProcess,
  stopManagedProcesses,
  stopTimeoutMs,
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

function reasons(ownership) {
  if (!ownership) return 'no ownership evidence';
  return ownership.reasons.length > 0 ? ownership.reasons.join('; ') : ownership.verdict;
}

/**
 * Read-only plan. The stop path re-verifies ownership immediately before terminating, so
 * this summary can never authorize a termination on its own.
 */
async function reportOwnershipPlan() {
  console.log('Ownership verification:');
  for (const role of REGISTRY_ROLES) {
    const record = readRecord(ROOT, role);
    if (!record) {
      console.log(`  ${role}: no ownership record`);
      continue;
    }
    const info = await inspectProcess(record.pid, { refresh: true });
    const ownership = verifyOwnership(record, info);
    console.log(`  ${role}: pid ${record.pid} -> ${ownership.verdict}`);
    for (const reason of ownership.reasons) console.log(`      ${reason}`);
  }
  console.log('');
}

function reportOutcome(outcome) {
  switch (outcome.status) {
    case STOP_STATUSES.ABSENT:
      console.log(outcome.ownership
        ? `  ${outcome.role}: malformed ownership record -> removed`
        : `  ${outcome.role}: no ownership record`);
      break;
    case STOP_STATUSES.STALE:
      console.log(`  ${outcome.role}: recorded pid ${outcome.pid} is no longer running -> stale record removed`);
      break;
    case STOP_STATUSES.REFUSED:
      console.log(`  ${outcome.role}: REFUSE_TO_KILL`);
      console.log(`    ${describeProcess(outcome.processInfo)}`);
      if (outcome.processInfo && outcome.processInfo.commandLine) console.log(`    command = ${outcome.processInfo.commandLine}`);
      console.log(`    reasons = ${reasons(outcome.ownership)}`);
      console.log('    The record does not prove ownership of this process. Nothing was terminated.');
      console.log('    Inspect the process manually before acting.');
      break;
    case STOP_STATUSES.STOPPED:
      console.log(`  ${outcome.role}: stopped (pid ${outcome.pid})`);
      console.log('    exit confirmed; the ownership record was removed after the process was gone');
      break;
    case STOP_STATUSES.STOP_TIMEOUT:
      console.log(`  ${outcome.role}: STOP_TIMEOUT`);
      console.log(`    ${describeProcess(outcome.processInfo)}`);
      console.log('    The process is still alive after the stop timeout.');
      console.log(`    The ownership record was PRESERVED as ${outcome.role}.pid.json.`);
      console.log('    Retry `npm run local:stop` or inspect the PID manually.');
      break;
    case STOP_STATUSES.INSUFFICIENT_PERMISSION:
      console.log(`  ${outcome.role}: INSUFFICIENT_PERMISSION`);
      console.log(`    ${describeProcess(outcome.processInfo)}`);
      if (outcome.detail) console.log(`    ${outcome.detail}`);
      console.log('    Open an elevated PowerShell / Windows Terminal and inspect the PID.');
      console.log('    Terminate it manually only after confirming its executable and command line.');
      console.log('    This tooling never elevates and never launches UAC.');
      console.log(`    The ownership record was PRESERVED as ${outcome.role}.pid.json.`);
      break;
    default:
      console.log(`  ${outcome.role}: stop failed (${outcome.status})`);
      console.log(`    ${describeProcess(outcome.processInfo)}`);
      if (outcome.detail) console.log(`    ${outcome.detail}`);
      console.log(`    The ownership record was PRESERVED as ${outcome.role}.pid.json.`);
      break;
  }
}

async function main() {
  console.log('Local managed stop');
  console.log(`  Repository : ${ROOT}`);
  console.log('');

  await reportOwnershipPlan();

  const report = await stopManagedProcesses({
    repoRoot: ROOT,
    env: process.env,
    timeoutMs: stopTimeoutMs(process.env),
    // Termination always goes through the verified ownership entry point.
    stopFn: (args) => stopManagedProcess({ ...args, terminateFn: terminateVerifiedProcess }),
  });

  for (const outcome of report.outcomes) reportOutcome(outcome);

  console.log('');
  console.log('==================================================');
  for (const role of REGISTRY_ROLES) {
    const outcome = report.outcomes.find((entry) => entry.role === role);
    console.log(`local_stop_${role}=${outcome ? outcome.status : STOP_STATUSES.ABSENT}`);
  }
  console.log(`local_stop_record_preserved_on_timeout=${report.recordPreservedOnTimeout === null ? 'n/a' : String(report.recordPreservedOnTimeout)}`);
  console.log(`local_stop_refusals=${report.refusals}`);
  console.log(`local_stop_failures=${report.failures}`);
  console.log(`local_stop_result=${report.result}`);
  console.log('==================================================\n');

  process.exit(report.exitCode);
}

main().catch((err) => {
  console.error(`local:stop failed: ${err && err.message ? err.message : err}`);
  process.exit(2);
});
