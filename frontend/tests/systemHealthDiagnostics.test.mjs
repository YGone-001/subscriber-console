import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const pageSource = readFileSync(new URL('../src/app/(dashboard)/system-health/page.tsx', import.meta.url), 'utf8');
const enLocale = readFileSync(new URL('../src/lib/locales/en.ts', import.meta.url), 'utf8');
const zhLocale = readFileSync(new URL('../src/lib/locales/zh.ts', import.meta.url), 'utf8');

test('system health page UI implements subsystem matrix, category tabs and batch heal modal', () => {
  assert.match(pageSource, /health_subsystems_title/);
  assert.match(pageSource, /health_subsystem_db/);
  assert.match(pageSource, /health_subsystem_ocs/);
  assert.match(pageSource, /health_subsystem_hss/);
  assert.match(pageSource, /health_subsystem_security/);
  assert.match(pageSource, /health_btn_batch_heal/);
  assert.match(pageSource, /exportDiagnosticReport/);
  assert.match(pageSource, /SCAN_TARIFF/);
  assert.match(pageSource, /SCAN_RESERVATIONS/);
  assert.match(pageSource, /activeCategoryTab/);
});

test('i18n locales contain comprehensive translation keys for health diagnostics', () => {
  const requiredKeys = [
    'health_subsystem_db',
    'health_subsystem_ocs',
    'health_subsystem_hss',
    'health_subsystem_security',
    'health_subsystems_title',
    'health_btn_batch_heal',
    'health_batch_modal_title',
    'health_err_orphan_reservation',
    'health_err_invalid_tariff',
    'health_err_dangling_profile',
  ];

  for (const key of requiredKeys) {
    assert.match(enLocale, new RegExp(`${key}:`));
    assert.match(zhLocale, new RegExp(`${key}:`));
  }
});
