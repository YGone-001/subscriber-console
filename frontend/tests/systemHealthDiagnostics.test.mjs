import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const pageSource = readFileSync(new URL('../src/app/(dashboard)/system-health/page.tsx', import.meta.url), 'utf8');
const repoSource = readFileSync(new URL('../src/server/repositories/systemHealthRepository.ts', import.meta.url), 'utf8');
const auditSource = readFileSync(new URL('../src/server/repositories/systemAuditRepository.ts', import.meta.url), 'utf8');
const enLocale = readFileSync(new URL('../src/lib/locales/en.ts', import.meta.url), 'utf8');
const zhLocale = readFileSync(new URL('../src/lib/locales/zh.ts', import.meta.url), 'utf8');

test('system health diagnostic files and routes are present', () => {
  assert.equal(existsSync(new URL('../src/server/repositories/systemHealthRepository.ts', import.meta.url)), true);
  assert.equal(existsSync(new URL('../src/app/api/system/health/route.ts', import.meta.url)), true);
  assert.equal(existsSync(new URL('../src/app/api/system/audit/batch-heal/route.ts', import.meta.url)), true);
  assert.equal(existsSync(new URL('../src/app/api/system/audit/heal/route.ts', import.meta.url)), true);
  assert.equal(existsSync(new URL('../src/app/api/system/audit/scan/route.ts', import.meta.url)), true);
  assert.equal(existsSync(new URL('../src/app/(dashboard)/system-health/page.tsx', import.meta.url)), true);
});

test('systemHealthRepository defines 4 core subsystems and diagnostic scoring', () => {
  assert.match(repoSource, /DatabaseSubsystemHealth/);
  assert.match(repoSource, /OcsSubsystemHealth/);
  assert.match(repoSource, /HssSubsystemHealth/);
  assert.match(repoSource, /SecuritySubsystemHealth/);
  assert.match(repoSource, /ComprehensiveSystemHealth/);
  assert.match(repoSource, /getComprehensiveSystemHealth/);
  assert.match(repoSource, /brokenInvariantsCount/);
  assert.match(repoSource, /orphanedReservations/);
  assert.match(repoSource, /danglingProfilesCount/);
});

test('systemAuditRepository supports expanded anomaly types, phases and batch healing', () => {
  assert.match(auditSource, /missing_config/);
  assert.match(auditSource, /balance_mismatch/);
  assert.match(auditSource, /orphan_ocs/);
  assert.match(auditSource, /orphan_reservation/);
  assert.match(auditSource, /invalid_tariff/);
  assert.match(auditSource, /dangling_profile/);
  assert.match(auditSource, /batchHealSubscriberDocuments/);
  assert.match(auditSource, /phase === 'reservation'/);
  assert.match(auditSource, /phase === 'tariff'/);
});

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
