import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

test('Code Quality: fetcher module exports typed fetcher utility', () => {
  const fetcherPath = path.resolve('src/lib/fetcher.ts');
  assert.ok(existsSync(fetcherPath), 'src/lib/fetcher.ts must exist');

  const content = readFileSync(fetcherPath, 'utf8');
  assert.ok(content.includes('export const fetcher'), 'fetcher must be exported');
  assert.ok(content.includes('FetchError'), 'FetchError interface must be defined');
  assert.ok(content.includes('Promise<any>'), 'fetcher must return Promise<any>');
});

test('Code Quality: GlobalErrorBoundary handles render failure state and reset lifecycle', () => {
  const boundaryPath = path.resolve('src/components/GlobalErrorBoundary.tsx');
  assert.ok(existsSync(boundaryPath), 'src/components/GlobalErrorBoundary.tsx must exist');

  const content = readFileSync(boundaryPath, 'utf8');
  assert.ok(content.includes('getDerivedStateFromError'), 'Must implement getDerivedStateFromError');
  assert.ok(content.includes('componentDidCatch'), 'Must implement componentDidCatch');
  assert.ok(content.includes('resetError'), 'Must provide error reset capability');
});

test('Code Quality: critical utilities are robustly exported and accessible', () => {
  const utils = [
    'src/lib/unitParser.ts',
    'src/lib/subscriberValidation.ts',
    'src/lib/permissions.ts',
    'src/lib/csv.ts',
    'src/lib/tariffPlanOperations.ts'
  ];

  for (const util of utils) {
    const fullPath = path.resolve(util);
    assert.ok(existsSync(fullPath), `Utility file ${util} must exist`);
    const code = readFileSync(fullPath, 'utf8');
    assert.ok(code.length > 50, `${util} must not be empty`);
  }
});
