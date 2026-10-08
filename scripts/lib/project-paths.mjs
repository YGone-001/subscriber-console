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
 *
 * All Windows-style paths below are written with forward slashes: Node normalises them,
 * and it keeps the module readable and free of escape sequences.
 */
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
