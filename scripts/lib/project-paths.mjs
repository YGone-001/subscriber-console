/*
 * Shared path resolution for the operational scripts.
 *
 * Every path a script needs must be derivable on whatever machine runs it. A script may
 * therefore never embed an absolute path that only exists on the machine it was written
 * on. This module centralises the three things the tooling needs:
 *
 *   1. `PROJECT_ROOT` - this repository, derived from this module's own location, so it
 *      is correct regardless of the caller's working directory or the checkout path.
 *   2. `resolveReferenceRoot()` - the historical reference checkout, which is an
 *      EXTERNAL artefact. It comes from an explicit argument, then an environment
 *      override, then a project-relative sibling. It may legitimately be absent; callers
 *      are expected to detect that and skip rather than fail.
 *   3. `resolveChromeExecutable()` - a Chromium-family browser, probed per platform
 *      (Windows / macOS / Linux) and finally on PATH.
 *   4. `resolveGoToolchain()` - the Go compiler, chosen by the version `backend/go.mod`
 *      requires rather than by PATH order, so an older distro Go cannot shadow a newer
 *      SDK that happens to be installed outside the default PATH.
 *
 * All Windows-style paths below are written with forward slashes: Node normalises them,
 * and it keeps the module readable and free of escape sequences.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Absolute path of the repository root. This module lives at `<root>/scripts/lib`. */
export const PROJECT_ROOT = path.resolve(HERE, '..', '..');

/**
 * Resolve the historical reference checkout used by the parity / forward-port tooling.
 *
 * Precedence: explicit argument, environment override, then a project-relative sibling
 * that actually contains `frontend/src`, then that sibling regardless (so a "not found"
 * message still names a stable, machine-independent location).
 *
 * A candidate that resolves to this repository is never returned. The reference is a
 * SEPARATE checkout, and silently resolving to the project itself would make a parity
 * gate compare the tree against itself and report a false pass.
 *
 * @param {object} [options]
 * @param {string|null} [options.argument] Explicit path (for example a `--reference=` flag).
 * @param {string} [options.env] Environment variable holding an override.
 * @param {string[]} [options.siblings] Project-relative candidate locations, in order.
 * @returns {string} Absolute path. May not exist - callers must check.
 */
export function resolveReferenceRoot({
  argument = null,
  env = 'UI_PARITY_REFERENCE',
  siblings = ['../../subscriber-console'],
} = {}) {
  if (argument) return path.resolve(argument);
  const fromEnv = process.env[env];
  if (fromEnv) return path.resolve(fromEnv);

  const canonical = (target) => {
    try { return fs.realpathSync.native(target); } catch { return path.resolve(target); }
  };
  const projectCanonical = canonical(PROJECT_ROOT);
  const candidates = siblings
    .map((sibling) => path.resolve(PROJECT_ROOT, sibling))
    .filter((candidate) => canonical(candidate) !== projectCanonical);

  for (const candidate of candidates) {
    try {
      if (fs.statSync(path.join(candidate, 'frontend', 'src')).isDirectory()) return candidate;
    } catch { /* keep probing */ }
  }
  return candidates[0] ?? path.resolve(PROJECT_ROOT, siblings[0]);
}

/** Absolute paths of known Chromium-family browsers, per platform. */
const CHROME_CANDIDATES = {
  win32: [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files/Google/Chrome Beta/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  ],
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ],
  linux: [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    '/usr/bin/microsoft-edge',
  ],
};

/** Commands to look up on PATH when no absolute candidate exists. */
const CHROME_COMMANDS = [
  'google-chrome',
  'google-chrome-stable',
  'chromium',
  'chromium-browser',
  'chrome',
  'msedge',
];

const isFile = (candidate) => {
  try { return fs.statSync(candidate).isFile(); } catch { return false; }
};

/** Look a command up on PATH, honouring PATHEXT on Windows. */
function searchPath(command) {
  const directories = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const extensions = process.platform === 'win32'
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';').filter(Boolean)
    : [''];
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${command}${extension}`);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Locate a Chromium-family browser for the CDP-driven capture and audit suites.
 *
 * Precedence: explicit argument, environment override, per-platform absolute candidates,
 * then PATH. Returns null when nothing is found so the caller can fail with guidance
 * instead of crashing inside the launcher.
 *
 * @param {object} [options]
 * @param {string|null} [options.argument] Explicit path (for example a `--chrome=` flag).
 * @param {string} [options.env] Environment variable holding an override.
 * @returns {string|null} Absolute path to the browser executable, or null.
 */
export function resolveChromeExecutable({ argument = null, env = 'UI_CAPTURE_CHROME' } = {}) {
  const explicit = argument || process.env[env];
  if (explicit) return explicit;

  const candidates = [];
  const localAppData = process.env.LOCALAPPDATA;
  if (process.platform === 'win32' && localAppData) {
    candidates.push(path.join(localAppData, 'Google/Chrome/Application/chrome.exe'));
    candidates.push(path.join(localAppData, 'Microsoft/Edge/Application/msedge.exe'));
  }
  candidates.push(...(CHROME_CANDIDATES[process.platform] || []));

  for (const candidate of candidates) {
    if (isFile(candidate)) return candidate;
  }
  for (const command of CHROME_COMMANDS) {
    const found = searchPath(command);
    if (found) return found;
  }
  return null;
}

/**
 * Fail fast with an actionable message when no browser could be located.
 *
 * @param {string|null} executable Result of `resolveChromeExecutable`.
 * @param {string} env Name of the override environment variable, for the hint.
 */
export function requireChromeExecutable(executable, env = 'UI_CAPTURE_CHROME') {
  if (executable) return executable;
  console.error('no_chrome_executable=FAIL');
  console.error('  detail=no Chromium-family browser (Chrome / Chromium / Edge) was found in the');
  console.error('         platform default locations or on PATH');
  console.error(`  fix=install Google Chrome, or set ${env} to the browser executable path`);
  process.exit(1);
  return null;
}

/** Conventional Go SDK install roots, probed (never assumed to exist). */
const GO_SDK_CANDIDATES = {
  linux: ['/usr/local/go', '/usr/lib/go'],
  darwin: ['/usr/local/go', '/opt/homebrew/opt/go/libexec', '/usr/local/opt/go/libexec'],
  win32: ['C:/Go', 'C:/Program Files/Go'],
};

/** Parse a Go release string such as `go1.24.4` into a comparable numeric array. */
function parseGoVersion(text) {
  const match = /go(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(text || ''));
  return match ? [Number(match[1]), Number(match[2]), Number(match[3] || 0)] : null;
}

/** Compare two parsed versions. Returns -1, 0 or 1. */
function compareVersions(left, right) {
  for (let i = 0; i < 3; i += 1) {
    const a = left[i] || 0;
    const b = right[i] || 0;
    if (a !== b) return a < b ? -1 : 1;
  }
  return 0;
}

/** Read the minimum Go version this repository's `backend/go.mod` requires. */
export function requiredGoVersion(root = PROJECT_ROOT) {
  const file = path.join(root, 'backend', 'go.mod');
  try {
    const text = fs.readFileSync(file, 'utf8');
    const match = /^\s*go\s+(\d+)\.(\d+)(?:\.(\d+))?/m.exec(text);
    return match ? [Number(match[1]), Number(match[2]), Number(match[3] || 0)] : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the Go compiler for this repository.
 *
 * PATH order alone is not authoritative: a distro Go (for example Ubuntu's `/usr/bin/go`)
 * can shadow a newer SDK installed at `/usr/local/go` and break `go.mod`'s version floor.
 * Every candidate is therefore probed and `go version` is asked what it actually is, and
 * the newest toolchain that satisfies `backend/go.mod` wins. An explicit argument or the
 * `GO_EXECUTABLE` override always wins, so a caller can pin a toolchain.
 *
 * @param {object} [options]
 * @param {string|null} [options.argument] Explicit path to a go binary.
 * @param {string} [options.env] Environment variable holding an override.
 * @param {string} [options.root] Repository root whose `backend/go.mod` sets the floor.
 * @returns {string|null} Absolute path to the go executable, or null when none qualifies.
 */
export function resolveGoToolchain({ argument = null, env = 'GO_EXECUTABLE', root = PROJECT_ROOT } = {}) {
  const explicit = argument || process.env[env];
  if (explicit && isFile(explicit)) return explicit;

  const floor = requiredGoVersion(root);
  const seen = new Set();
  const candidates = [];
  const offer = (file) => {
    const resolved = path.resolve(file);
    if (!seen.has(resolved) && isFile(resolved)) {
      seen.add(resolved);
      candidates.push(resolved);
    }
  };

  // PATH first, then conventional SDK roots. Order only breaks ties among equals.
  for (const directory of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    offer(path.join(directory, 'go'));
    if (process.platform === 'win32') offer(path.join(directory, 'go.exe'));
  }
  for (const sdk of (GO_SDK_CANDIDATES[process.platform] || [])) {
    offer(path.join(sdk, 'bin', 'go'));
    if (process.platform === 'win32') offer(path.join(sdk, 'bin', 'go.exe'));
  }

  let best = null;
  let bestVersion = null;
  for (const candidate of candidates) {
    let reported;
    try {
      reported = spawnSync(candidate, ['version'], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    } catch {
      continue;
    }
    if (reported.status !== 0) continue;
    const version = parseGoVersion(reported.stdout || reported.stderr);
    if (!version) continue;
    // Reject toolchains that cannot satisfy go.mod; otherwise keep the newest seen.
    if (floor && compareVersions(version, floor) < 0) continue;
    if (!bestVersion || compareVersions(version, bestVersion) > 0) {
      best = candidate;
      bestVersion = version;
    }
  }
  return best;
}
