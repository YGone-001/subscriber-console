#!/usr/bin/env node
/*
 * Frontend test runner.
 *
 * Two things the plain `tsx --test` invocation cannot do, and this wrapper exists
 * only to supply them:
 *
 *   1. Components import `*.css` / `*.module.css`, which Vite resolves and Node
 *      cannot. `tests/register-css-stub.mjs` installs a loader hook that answers
 *      stylesheet imports with an empty module whose default export echoes the
 *      requested class name — exactly what a CSS module yields for a real class.
 *   2. tsx needs to be told which tsconfig carries `jsx: react-jsx`. The
 *      solution-style `tsconfig.json` (`files: []` plus project references) is
 *      not honoured, so the application config is selected explicitly through
 *      TSX_TSCONFIG_PATH — set here rather than in the npm script so the command
 *      stays shell-agnostic on Windows.
 *
 * Usage: node tests/run-tests.mjs <test-file> [...]
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testFiles = process.argv.slice(2);

if (testFiles.length === 0) {
  console.error('run-tests: no test files given');
  process.exit(2);
}

/* `--import` requires a URL, not a Windows drive path. */
const cssStub = pathToFileURL(path.join(frontendRoot, 'tests', 'register-css-stub.mjs')).href;

const result = spawnSync(process.execPath, [
  '--import', 'tsx',
  '--import', cssStub,
  '--test',
  ...testFiles,
], {
  cwd: frontendRoot,
  stdio: 'inherit',
  env: { ...process.env, TSX_TSCONFIG_PATH: 'tsconfig.app.json' },
});

process.exit(result.status ?? 1);
