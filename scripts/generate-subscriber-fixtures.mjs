#!/usr/bin/env node

/**
 * Node fixture producer for subscriber contract parity.
 *
 * Imports REAL production functions — does NOT contain inline copies.
 * Go tests consume these fixtures as READ-ONLY expected values.
 *
 * Usage: node --import ./scripts/register-paths.mjs --experimental-strip-types scripts/generate-subscriber-fixtures.mjs
 */

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const FIXTURE_DIR = join(ROOT, 'backend', 'internal', 'subscriber', 'testdata');

if (!existsSync(FIXTURE_DIR)) {
  mkdirSync(FIXTURE_DIR, { recursive: true });
}

// ============================================================
// Import REAL production functions
// ============================================================

const { buildDefaultXcloudSubscriber, buildXcloudSubscriberFromLegacy } = await import('../src/lib/xcloudSubscriber.ts');
const { normalizeSub4G, buildDefaultSub4G, normalizeSliceList } = await import('../src/lib/subscriberDefaults.ts');
const { subscriberSafeSnapshot, stable, hash } = await import('../src/lib/subscriberContract.ts');

// ============================================================
// Fixture helpers
// ============================================================

function writeFixture(name, data) {
  const path = join(FIXTURE_DIR, name);
  const content = typeof data === 'string' ? data : JSON.stringify(data, null, 2) + '\n';
  writeFileSync(path, content, 'utf8');
  console.log(`  wrote ${name} (${content.length} bytes)`);
}

const METADATA = {
  producer: 'node',
  source: 'production-functions',
  contract: 'subscriber-single-write-v1',
};

const IMSI = '310260123456789';

console.log('Generating subscriber contract fixtures from REAL production code...\n');

// ============================================================
// 1. default-subscriber
// ============================================================
const defaultSub = buildDefaultXcloudSubscriber(IMSI);
writeFixture('fixture_default_subscriber.json', { metadata: { ...METADATA, fixture: 'default-subscriber' }, raw: defaultSub });

// ============================================================
// 2. legacy-update
// ============================================================
const legacyPayload = {
  sub4G: {
    ambr: { downlink: { value: 200000000, unit: 0 }, uplink: { value: 100000000, unit: 0 } },
    msisdnList: [{ msisdn: '9876543210' }],
    access_restriction_data: 49,
    network_access_mode: 2,
  },
};
const legacyUpdate = buildXcloudSubscriberFromLegacy(IMSI, legacyPayload, defaultSub);
writeFixture('fixture_legacy_update.json', { metadata: { ...METADATA, fixture: 'legacy-update' }, raw: legacyUpdate });

// ============================================================
// 3. safe-before (SafeSnapshot of default)
// ============================================================
const safeBefore = subscriberSafeSnapshot(defaultSub);
writeFixture('fixture_safe_before.json', { metadata: { ...METADATA, fixture: 'safe-before' }, snapshot: safeBefore });

// ============================================================
// 4. safe-after (SafeSnapshot after update)
// ============================================================
const safeAfter = subscriberSafeSnapshot(legacyUpdate);
writeFixture('fixture_safe_after.json', { metadata: { ...METADATA, fixture: 'safe-after' }, snapshot: safeAfter });

// ============================================================
// 5. frozen-update
// ============================================================
writeFixture('fixture_frozen_update.json', {
  metadata: { ...METADATA, fixture: 'frozen-update' },
  frozen: { version: 'subscriber-update-v1', imsi: IMSI, before: safeBefore, after: safeAfter },
});

// ============================================================
// 6. frozen-delete
// ============================================================
writeFixture('fixture_frozen_delete.json', {
  metadata: { ...METADATA, fixture: 'frozen-delete' },
  frozen: { version: 'subscriber-delete-v1', imsi: IMSI, before: safeBefore },
});

// ============================================================
// 7. update-canonical-string
// ============================================================
const updateCanonical = stable({ operation: 'SUBSCRIBER_UPDATE', imsi: IMSI, before: safeBefore, after: safeAfter });
writeFixture('fixture_update_canonical_string.txt', updateCanonical);

// ============================================================
// 8. delete-canonical-string
// ============================================================
const deleteCanonical = stable({ operation: 'SUBSCRIBER_DELETE', imsi: IMSI, before: safeBefore });
writeFixture('fixture_delete_canonical_string.txt', deleteCanonical);

// ============================================================
// 9. update-fingerprint
// ============================================================
const updateFingerprint = hash({ operation: 'SUBSCRIBER_UPDATE', imsi: IMSI, before: safeBefore, after: safeAfter });
writeFixture('fixture_update_fingerprint.txt', updateFingerprint);

// ============================================================
// 10. delete-fingerprint
// ============================================================
const deleteFingerprint = hash({ operation: 'SUBSCRIBER_DELETE', imsi: IMSI, before: safeBefore });
writeFixture('fixture_delete_fingerprint.txt', deleteFingerprint);

// ============================================================
// Verify SafeSnapshot shape
// ============================================================
const snapKeys = Object.keys(safeBefore).sort();
const expectedKeys = ['accessRestrictionData', 'ambr', 'imsi', 'msisdn', 'networkAccessMode', 'slices'];
if (JSON.stringify(snapKeys) !== JSON.stringify(expectedKeys)) {
  console.error(`\nERROR: SafeSnapshot keys mismatch!\n  got:      ${snapKeys}\n  expected: ${expectedKeys}`);
  process.exit(1);
}
if (!Array.isArray(safeBefore.msisdn)) {
  console.error('\nERROR: msisdn must be array');
  process.exit(1);
}
if (!Array.isArray(safeBefore.slices)) {
  console.error('\nERROR: slices must be array');
  process.exit(1);
}

console.log('\nDone. All fixtures generated from REAL production functions.');
console.log('Go tests MUST only READ these fixtures — never overwrite.');
