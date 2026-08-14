import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

const globalCss = read('../src/app/globals.css');

test('reduced motion no longer globally collapses every animation and transition', () => {
  assert.match(globalCss, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  assert.doesNotMatch(globalCss, /animation-duration:\s*0\.01ms/);
  assert.doesNotMatch(globalCss, /transition-duration:\s*0\.01ms/);
  assert.doesNotMatch(globalCss, /\*\s*,\s*\*::before,\s*\*::after/);
});

test('reduced motion preserves non-spatial feedback and stops continuous movement', () => {
  assert.match(globalCss, /animation:\s*reducedFade 120ms ease-out both/);
  assert.match(globalCss, /transition-property:\s*background-color, color, border-color, box-shadow, opacity/);
  assert.match(globalCss, /\.pill-active-pulse,[\s\S]*?\.progress-bar-value,[\s\S]*?animation:\s*none\s*!important/);
  assert.match(globalCss, /\.skeleton-loader,[\s\S]*?animation:\s*none\s*!important/);
  assert.match(globalCss, /\.toast-card:hover,[\s\S]*?transform:\s*none\s*!important/);
});

test('component motion policies cover overlays, tickers, loaders, and live indicators', () => {
  const loginCss = read('../src/app/login/LoginForm.css');
  const sources = [
    loginCss,
    read('../src/app/(dashboard)/layout.css'),
    read('../src/app/(dashboard)/ocs/ocs.css'),
    read('../src/components/CommandPalette.css'),
    read('../src/components/NocSentinel.css'),
    read('../src/components/OperationFeedback.css'),
    read('../src/components/datahub.css'),
    read('../src/components/analytics.css'),
    read('../src/components/users/ApprovalCenterPanel.css'),
    read('../src/app/(dashboard)/users/users.css'),
  ].join('\n');

  assert.doesNotMatch(sources, /0\.01ms/);
  assert.match(loginCss, /\.login-submit-btn,[\s\S]*?transition-duration:\s*120ms/);
  assert.match(sources, /\.noc-critical-ticker > div\s*\{[\s\S]*?animation:\s*none/);
  assert.match(sources, /\.dh-spinner,[\s\S]*?\.dh-progress-bar-fill\s*\{[\s\S]*?animation:\s*none/);
  assert.match(sources, /\.analytics-ocs-badge-danger,[\s\S]*?\.live-pulse-dot\s*\{[\s\S]*?animation:\s*none/);
  assert.match(sources, /\.ocs-drawer-content\s*\{[\s\S]*?animation:\s*reducedFade 120ms/);
  assert.match(sources, /\.approvals-spin\s*\{[\s\S]*?animation:\s*none/);
  assert.match(sources, /\.users-spin\s*\{[\s\S]*?animation:\s*none/);
});
