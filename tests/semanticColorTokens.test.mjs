import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('global themes define the complete xCloud semantic color contract', () => {
  const css = read('../src/app/globals.css');
  const requiredTokens = [
    '--status-info',
    '--status-success',
    '--status-warning',
    '--status-danger',
    '--selection-soft',
    '--diff-added',
    '--diff-modified',
    '--diff-removed',
    '--chart-1',
    '--chart-6',
    '--login-canvas',
    '--login-primary',
    '--login-on-primary',
  ];

  for (const token of requiredTokens) {
    assert.equal(css.match(new RegExp(`${token}:`, 'g'))?.length, 2, `${token} must be mapped in both themes`);
  }
});

test('operational status, diff, chart, and login surfaces consume semantic roles', () => {
  const targets = [
    '../src/components/analytics.css',
    '../src/components/AnalyticsCockpit.tsx',
    '../src/app/(dashboard)/system-health/system-health.css',
    '../src/components/diff-viewer.css',
    '../src/components/OperationFeedback.css',
    '../src/components/rating/rating.css',
    '../src/app/login/LoginForm.css',
  ].map(read).join('\n');

  for (const token of [
    'var(--status-success)',
    'var(--status-warning)',
    'var(--status-danger)',
    'var(--status-info)',
    'var(--diff-added)',
    'var(--diff-modified)',
    'var(--diff-removed)',
    'var(--login-primary)',
  ]) {
    assert.match(targets, new RegExp(token.replace(/[()]/g, '\\$&')));
  }
});

test('legacy dashboard palette is absent from application source', () => {
  const sources = [
    '../src/app/globals.css',
    '../src/components/analytics.css',
    '../src/components/AnalyticsCockpit.tsx',
    '../src/components/analytics/TopConsumerChart.tsx',
    '../src/components/analytics/TariffPlanDistributionChart.tsx',
    '../src/components/analytics/PlmnDistributionChart.tsx',
    '../src/app/login/LoginForm.css',
  ].map(read).join('\n').toLowerCase();

  for (const legacyColor of ['#4e73df', '#1cc88a', '#f6c23e', '#e74a3b']) {
    assert.doesNotMatch(sources, new RegExp(legacyColor), `legacy color remains: ${legacyColor}`);
  }
});
