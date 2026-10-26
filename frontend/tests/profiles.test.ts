/*
 * User-template surface tests.
 *
 * Two invariants: the version comparison reports only what the two stored
 * documents contain (no fabricated quota, AMBR or access defaults), and the
 * version/restore path stays wired to the contract the backend implements.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  buildProfileVersionDiff,
  type ProfileDiffLabels,
  type ProfileDiffSection,
} from '../src/features/profiles/profile-version-diff';

const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), 'utf8');

const LABELS: ProfileDiffLabels = {
  notConfigured: 'NOT_CONFIGURED',
  sliceUnit: 'slices',
  sessionUnit: 'sessions',
  pccUnit: 'PCC',
  accessNone: 'UNRESTRICTED',
  accessSuspended: 'SUSPENDED',
  maskedSecret: '****',
};

const BASE_PROFILE = {
  title: 'Balanced 5G',
  auth: { k: '00112233445566778899aabbccddeeff', opc: 'ffeeddccbbaa99887766554433221100', amf: '8000' },
  ambr: { downlink: { unit: 2, value: 100 }, uplink: { unit: 2, value: 50 } },
  access_restriction_data: 0,
  ocsDefaults: {
    planId: 'plan_default_10gb',
    trafficTotal: 10737418240,
    trafficBalance: 10737418240,
    smsTotal: 100,
    smsBalance: 100,
  },
  sliceList: [
    { sst: 1, sd: '000001', session_list: [{ name: 'internet', pcc_rule: [{}, {}] }] },
  ],
};

function section(sections: ProfileDiffSection[], key: string): ProfileDiffSection {
  const found = sections.find((entry) => entry.key === key);
  assert.ok(found, `missing diff section: ${key}`);
  return found as ProfileDiffSection;
}

function row(sections: ProfileDiffSection[], sectionKey: string, rowKey: string) {
  const found = section(sections, sectionKey).rows.find((entry) => entry.key === rowKey);
  assert.ok(found, `missing diff row: ${sectionKey}/${rowKey}`);
  return found as ProfileDiffSection['rows'][number];
}

test('an unchanged snapshot reports no changed section', () => {
  const sections = buildProfileVersionDiff(BASE_PROFILE, BASE_PROFILE, LABELS);
  assert.equal(sections.filter((entry) => entry.changed).length, 0);
  assert.equal(row(sections, 'sliceList', 'sliceCount').versionValue, '1 slices');
  assert.equal(row(sections, 'ocsDefaults', 'trafficTotal').versionValue, '10 GB');
});

test('a changed title stays scoped to its own section', () => {
  const current = { ...BASE_PROFILE, title: 'Balanced 5G v2' };
  const sections = buildProfileVersionDiff(BASE_PROFILE, current, LABELS);
  assert.equal(section(sections, 'title').changed, true);
  assert.equal(section(sections, 'auth').changed, false);
  assert.equal(row(sections, 'title', 'title').currentValue, 'Balanced 5G v2');
});

test('missing billing defaults stay not configured instead of inheriting a quota', () => {
  const withoutOcs = { ...BASE_PROFILE, ocsDefaults: undefined };
  const sections = buildProfileVersionDiff(withoutOcs, withoutOcs, LABELS);
  for (const key of ['planId', 'trafficTotal', 'trafficBalance', 'smsTotal', 'smsBalance']) {
    const target = row(sections, 'ocsDefaults', key);
    assert.equal(target.versionValue, 'NOT_CONFIGURED');
    assert.equal(target.currentValue, 'NOT_CONFIGURED');
    assert.equal(target.changed, false);
  }
});

test('slice growth surfaces as a real count and per-slice difference', () => {
  const current = {
    ...BASE_PROFILE,
    sliceList: [...BASE_PROFILE.sliceList, { sst: 2, sd: '000002', session_list: [] }],
  };
  const sections = buildProfileVersionDiff(BASE_PROFILE, current, LABELS);
  assert.equal(section(sections, 'sliceList').changed, true);
  assert.equal(row(sections, 'sliceList', 'sliceCount').versionValue, '1 slices');
  assert.equal(row(sections, 'sliceList', 'sliceCount').currentValue, '2 slices');
  assert.equal(row(sections, 'sliceList', 'slice-1').versionValue, 'NOT_CONFIGURED');
  assert.equal(row(sections, 'sliceList', 'slice-1').currentValue, 'SST 2 / SD 000002 · 0 sessions · 0 PCC');
});

test('credential differences are shown masked and never in full', () => {
  const current = { ...BASE_PROFILE, auth: { ...BASE_PROFILE.auth, k: 'aaaabbbbccccddddeeeeffff00001111' } };
  const sections = buildProfileVersionDiff(BASE_PROFILE, current, LABELS);
  const target = row(sections, 'auth', 'k');
  assert.equal(target.changed, true);
  assert.equal(target.versionValue, '0011…eeff');
  assert.equal(target.currentValue, 'aaaa…1111');
  const serialized = JSON.stringify(sections);
  assert.ok(!serialized.includes('00112233445566778899aabbccddeeff'));
  assert.ok(!serialized.includes('aaaabbbbccccddddeeeeffff00001111'));
});

test('access restriction keeps the 3GPP sentinel values readable', () => {
  const suspended = { ...BASE_PROFILE, access_restriction_data: 255 };
  const sections = buildProfileVersionDiff(BASE_PROFILE, suspended, LABELS);
  const target = row(sections, 'access_restriction_data', 'access');
  assert.equal(target.versionValue, 'UNRESTRICTED');
  assert.equal(target.currentValue, 'SUSPENDED');
  assert.equal(target.changed, true);
});

test('a missing AMBR side is not rendered as zero', () => {
  const withoutAmbr = { ...BASE_PROFILE, ambr: {} };
  const sections = buildProfileVersionDiff(withoutAmbr, withoutAmbr, LABELS);
  assert.equal(row(sections, 'ambr', 'downlink').versionValue, 'NOT_CONFIGURED');
  assert.equal(row(sections, 'ambr', 'uplink').versionValue, 'NOT_CONFIGURED');
});

test('the version panel requests the detail branch the backend serves', () => {
  const source = read('../src/components/ProfileModal.tsx');
  assert.match(source, /versions\?versionId=/);
  assert.match(source, /data\.version/);
});

test('a failed template write surfaces the server message instead of a generic failure', () => {
  const source = read('../src/components/ProfileModal.tsx');
  assert.match(source, /readError\(res, t\("prof_err_save"\)\)/);
  assert.doesNotMatch(source, /throw new Error\(t\("prof_err_save"\)\)/);
  assert.match(source, /prof_err_create_partial/);
});

test('the template list renders a retryable error instead of an empty state', () => {
  const source = read('../src/features/profiles/ProfilesPage.tsx');
  assert.match(source, /const \{ data, isLoading, error, mutate \}/);
  assert.match(source, /<ErrorState/);
  assert.match(source, /onRetry=/);
});
