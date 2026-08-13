import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('interactive CSS avoids transitions that animate layout geometry', () => {
  const sources = [
    read('../src/app/(dashboard)/layout.css'),
    read('../src/app/globals.css'),
    read('../src/components/analytics.css'),
    read('../src/app/(dashboard)/subscribers/subscribers.css'),
  ].join('\n');

  assert.doesNotMatch(sources, /transition(?:-property)?\s*:[^;]*(?:width|height|max-height|padding|margin)/i);
  assert.match(sources, /transition:\s*transform 0\.5s/);
  assert.match(sources, /transform:\s*scaleX\(var\(--bar-scale/);
  assert.match(sources, /\.accordion-content\.collapsed\s*\{[\s\S]*?display:\s*none/);
});

test('large persistent surfaces no longer use decorative blur', () => {
  const globalCss = read('../src/app/globals.css');
  const healthCss = read('../src/app/(dashboard)/system-health/system-health.css');
  const loginCss = read('../src/app/login/LoginForm.css');
  const ocsCss = read('../src/app/(dashboard)/ocs/ocs.css');

  assert.doesNotMatch(globalCss.match(/\.dash-card\s*\{[\s\S]*?\}/)?.[0] ?? '', /backdrop-filter/);
  assert.doesNotMatch(globalCss.match(/\.page-action-bar\s*\{[\s\S]*?\}/)?.[0] ?? '', /backdrop-filter/);
  assert.doesNotMatch(healthCss, /backdrop-filter/);
  assert.doesNotMatch(loginCss, /filter:\s*blur|backdrop-filter/);
  assert.doesNotMatch(ocsCss.match(/\.ocs-header\s*\{[\s\S]*?\}/)?.[0] ?? '', /backdrop-filter/);

  assert.match(globalCss.match(/\.modal-overlay\s*\{[\s\S]*?\}/)?.[0] ?? '', /backdrop-filter:\s*blur\(8px\)/);
});

test('dynamic utilization bars pass ratios through compositor-friendly CSS variables', () => {
  const subscribers = read('../src/app/(dashboard)/subscribers/components/SubscriberTable.tsx');
  const balances = read('../src/components/analytics/OcsBalanceCapacityCard.tsx');
  const sessions = read('../src/components/analytics/OcsSessionTelemetryCard.tsx');

  assert.match(subscribers, /--traffic-scale/);
  assert.doesNotMatch(subscribers, /width:\s*`\$\{Math\.min\(uRatio/);
  assert.match(balances, /--bar-scale/);
  assert.match(sessions, /--bar-scale/);
});
