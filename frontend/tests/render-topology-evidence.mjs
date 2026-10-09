#!/usr/bin/env node
/*
 * Rendered Topology evidence generator.
 *
 * Renders the Topology surfaces server-side from fixtures into standalone HTML
 * documents under `topology-evidence/` so CI can retain inspectable rendered
 * output for the Stage 2 UI acceptance.
 *
 * These are RENDERED HTML DOCUMENTS, not pixel screenshots. They are produced
 * with the real production components, the real design tokens and the real
 * Topology module stylesheet, and they are labelled as test fixtures. Pixel
 * screenshot capture against a live stack is a separate obligation and is not
 * claimed by this script.
 *
 * Usage: node tests/render-topology-evidence.mjs   (from frontend/)
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cssStub = pathToFileURL(path.join(frontendRoot, 'tests', 'register-css-stub.mjs')).href;

const result = spawnSync(
  process.execPath,
  ['--import', 'tsx', '--import', cssStub, path.join('tests', 'topology-evidence.tsx')],
  {
    cwd: frontendRoot,
    stdio: 'inherit',
    env: { ...process.env, TSX_TSCONFIG_PATH: 'tsconfig.app.json' },
  },
);

process.exit(result.status ?? 1);
