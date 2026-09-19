import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const contractsPanelSource = readFileSync(
  new URL('../src/components/ocs/contracts/OcsContractsPanel.tsx', import.meta.url),
  'utf8'
);
const balancePlaceholderSource = readFileSync(
  new URL('../src/components/ocs/balances/OcsBalancePlaceholder.tsx', import.meta.url),
  'utf8'
);
const zhLocale = readFileSync(
  new URL('../src/lib/locales/zh.ts', import.meta.url),
  'utf8'
);
const enLocale = readFileSync(
  new URL('../src/lib/locales/en.ts', import.meta.url),
  'utf8'
);

test('OcsContractsPanel uses canonical toolbar CSS contract', () => {
  assert.match(contractsPanelSource, /ocs-controls-bar/);
  assert.match(contractsPanelSource, /ocs-search-group/);
  assert.match(contractsPanelSource, /ocs-filters-group/);
  assert.match(contractsPanelSource, /ocs-select/);

  assert.doesNotMatch(contractsPanelSource, /className="ocs-controls"/);
  assert.doesNotMatch(contractsPanelSource, /className="ocs-search-wrap"/);
  assert.doesNotMatch(contractsPanelSource, /className="ocs-filter-select"/);
});

test('OcsBalancePlaceholder uses canonical toolbar CSS contract', () => {
  assert.match(balancePlaceholderSource, /ocs-controls-bar/);
  assert.match(balancePlaceholderSource, /ocs-search-group/);
  assert.match(balancePlaceholderSource, /ocs-filters-group/);
  assert.match(balancePlaceholderSource, /ocs-select/);

  assert.doesNotMatch(balancePlaceholderSource, /className="ocs-controls"/);
  assert.doesNotMatch(balancePlaceholderSource, /className="ocs-search-wrap"/);
  assert.doesNotMatch(balancePlaceholderSource, /className="ocs-filter-select"/);
});

test('Status filter label renders 全部状态 in Chinese locale', () => {
  assert.match(zhLocale, /ocs_filter_all_statuses:\s*"全部状态"/);
  assert.match(enLocale, /ocs_filter_all_statuses:\s*"All Statuses"/);

  assert.doesNotMatch(zhLocale, /ocs_filter_all_statuses:\s*"全部组建"/);
  assert.doesNotMatch(zhLocale, /ocs_filter_all_statuses:\s*"全部组件"/);
  assert.doesNotMatch(zhLocale, /ocs_filter_all_statuses:\s*"全部组"/);
});

test('OcsContractsPanel distinguishes LOADING, ERROR, EMPTY, and SUCCESS states', () => {
  assert.match(contractsPanelSource, /loading\s*\?/);
  assert.match(contractsPanelSource, /ocs-loading/);

  assert.match(contractsPanelSource, /error\s*\?/);
  assert.match(contractsPanelSource, /errorBanner/);
  assert.match(contractsPanelSource, /ocs-error-cell/);
  assert.match(contractsPanelSource, /error\s*\?\s*"—"\s*:\s*total/);

  assert.match(contractsPanelSource, /records\.length === 0/);
});

test('OcsBalancePlaceholder distinguishes LOADING, ERROR, EMPTY, and SUCCESS states', () => {
  assert.match(balancePlaceholderSource, /loading\s*\?/);
  assert.match(balancePlaceholderSource, /ocs-loading/);

  assert.match(balancePlaceholderSource, /error\s*\?/);
  assert.match(balancePlaceholderSource, /ocs-error-cell/);
  assert.match(balancePlaceholderSource, /error\s*\?\s*"—"\s*:\s*total/);

  assert.match(balancePlaceholderSource, /records\.length === 0/);
});
