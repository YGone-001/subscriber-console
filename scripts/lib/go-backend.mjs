/**
 * Shared harness support for the gates that run the real Go backend.
 *
 * Two properties the per-gate copies kept getting wrong:
 *
 *   - Readiness is bounded by wall-clock time, not an iteration count. A cold
 *     MongoDB container runs the whole index initializer before the listener
 *     opens, which takes an order of magnitude longer than a warm local server,
 *     so a fixed 60x100ms budget fails only in CI.
 *   - The child's stdout and stderr are drained. A pipe nobody reads is both a
 *     deadlock risk once the buffer fills and the reason a startup failure used
 *     to report nothing but "failed to become ready".
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MAX_RETAINED_CHUNKS = 400;
const RETAINED_ON_FAILURE = 40;
const POLL_INTERVAL_MS = 250;
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * A writable attachment store for one spawned server.
 *
 * The product default lives under /srv, which an unprivileged CI runner cannot
 * create; the server fails closed when the directory is absent, so every gate
 * that starts the backend must own this path rather than inherit the default.
 */
export function knowledgeSandbox() {
  return mkdtempSync(join(tmpdir(), 'xcloud-knowledge-'));
}

/**
 * Wait until the server answers `/healthz`.
 *
 * Resolves once the listener is up. Rejects with the last retained lines of the
 * server output, plus the exit status when the process died, so the failure is
 * self-explanatory in a CI log.
 */
export function waitForGoServer(proc, port, {
  timeoutMs = DEFAULT_TIMEOUT_MS,
  path = '/healthz',
} = {}) {
  const chunks = [];
  const retain = (stream) => (buffer) => {
    for (const line of buffer.toString().split('\n')) {
      if (!line.trim()) continue;
      chunks.push(`[${stream}] ${line}`);
      if (chunks.length > MAX_RETAINED_CHUNKS) chunks.shift();
    }
  };
  proc.stdout?.on('data', retain('go:out'));
  proc.stderr?.on('data', retain('go:err'));

  let exit = null;
  proc.on('exit', (code, signal) => { exit = { code, signal }; });

  const deadline = Date.now() + timeoutMs;
  return (async () => {
    while (Date.now() < deadline) {
      if (exit) break;
      try {
        const response = await fetch(`http://127.0.0.1:${port}${path}`);
        if (response.ok) return true;
      } catch {
        /* not listening yet */
      }
      await new Promise((resolve) => { setTimeout(resolve, POLL_INTERVAL_MS); });
    }

    const reason = exit
      ? `exited with code=${exit.code} signal=${exit.signal}`
      : `did not answer ${path} within ${timeoutMs}ms`;
    const detail = chunks.slice(-RETAINED_ON_FAILURE).join('\n');
    const error = new Error(`Go backend server failed to become ready: ${reason}`);
    error.serverOutput = detail;
    console.error(detail || '(the server produced no output)');
    throw error;
  })();
}
