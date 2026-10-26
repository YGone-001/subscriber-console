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
import { findProfileDraftIssue } from '../src/features/profiles/profile-validation';
import {
  buildDraftChangeRows,
  buildProfilePayload,
  createDraftFromProfile,
  createEmptyDraft,
} from '../src/features/profiles/profile-draft';
import {
  countProfilesWithoutBilling,
  filterProfileList,
  profileFilterFromParam,
  profileFilterToParam,
} from '../src/features/profiles/profile-list-model';
import { formatAmbrPair } from '../src/features/profiles/profile-format';

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
  const source = read('../src/features/profiles/components/ProfileVersionsCard.tsx');
  assert.match(source, /versions\?versionId=/);
  assert.match(source, /data\.version/);
});

test('a failed template write surfaces the server message instead of a generic failure', () => {
  const source = read('../src/features/profiles/ProfileDetailPage.tsx');
  assert.match(source, /putJson\(/);
  assert.match(source, /mutation-client/);
  assert.match(source, /prof_err_create_partial/);
  assert.doesNotMatch(source, /throw new Error\(t\("prof_err_save"\)\)/);
});

test('the template list renders a retryable error instead of an empty state', () => {
  const source = read('../src/features/profiles/ProfilesPage.tsx');
  assert.match(source, /const \{ data, isLoading, error, mutate \}/);
  assert.match(source, /<ErrorState/);
  assert.match(source, /onRetry=/);
});

const VALID_AUTH = { k: 'a'.repeat(32), opValue: 'b'.repeat(32), amf: '8000' };
const VALID_AMBR = { downlink: { value: 100, unit: 2 }, uplink: { value: 50, unit: 2 } };
const VALID_DRAFT = {
  name: 'template',
  auth: VALID_AUTH,
  ambr: VALID_AMBR,
  slices: [{ sst: 1, sd: '000001', session_list: [] }],
};

test('a complete draft passes validation', () => {
  assert.equal(findProfileDraftIssue(VALID_DRAFT), null);
});

test('malformed credentials and slice identifiers are rejected', () => {
  assert.deepEqual(findProfileDraftIssue({ ...VALID_DRAFT, auth: { ...VALID_AUTH, k: 'xyz' } }), { code: 'kFormat' });
  assert.deepEqual(findProfileDraftIssue({ ...VALID_DRAFT, auth: { ...VALID_AUTH, opValue: '00' } }), { code: 'opFormat' });
  assert.deepEqual(findProfileDraftIssue({ ...VALID_DRAFT, auth: { ...VALID_AUTH, amf: '800' } }), { code: 'amfFormat' });
  assert.deepEqual(
    findProfileDraftIssue({ ...VALID_DRAFT, slices: [{ sst: 0, sd: '000001', session_list: [] }] }),
    { code: 'sstRange', index: 1 },
  );
  assert.deepEqual(
    findProfileDraftIssue({ ...VALID_DRAFT, slices: [{ sst: 1, sd: '12345', session_list: [] }] }),
    { code: 'sdFormat', index: 1 },
  );
});

test('an AMBR without a value is rejected instead of defaulting to zero', () => {
  assert.deepEqual(
    findProfileDraftIssue({ ...VALID_DRAFT, ambr: { downlink: {}, uplink: VALID_AMBR.uplink } }),
    { code: 'ambrInvalid', direction: 'downlink' },
  );
});

test('an invalid session PGW address reports the session name', () => {
  assert.deepEqual(
    findProfileDraftIssue({
      ...VALID_DRAFT,
      slices: [{ sst: 1, sd: '000001', session_list: [{ name: 'internet', pgwIpv4: '10.0.0' }] }],
    }),
    { code: 'pgwIpv4', sessionName: 'internet' },
  );
});

const LIST_ENTRIES = [
  { name: 'alpha_profile', title: 'Balanced 5G', ocsDefaultsConfigured: true, subscriberCount: 5 },
  { name: 'beta_profile', title: 'Legacy', ocsDefaultsConfigured: false, subscriberCount: 0 },
];

test('list filters read backend fields only', () => {
  assert.deepEqual(filterProfileList(LIST_ENTRIES, '', 'withBilling').map((entry) => entry.name), ['alpha_profile']);
  assert.deepEqual(filterProfileList(LIST_ENTRIES, '', 'withoutBilling').map((entry) => entry.name), ['beta_profile']);
  assert.deepEqual(filterProfileList(LIST_ENTRIES, '', 'unassigned').map((entry) => entry.name), ['beta_profile']);
  assert.equal(filterProfileList(LIST_ENTRIES, '', 'all').length, 2);
});

test('list search matches the display title as well as the key', () => {
  assert.deepEqual(filterProfileList(LIST_ENTRIES, 'legacy', 'all').map((entry) => entry.name), ['beta_profile']);
  assert.deepEqual(filterProfileList(LIST_ENTRIES, 'ALPHA', 'all').map((entry) => entry.name), ['alpha_profile']);
  assert.equal(countProfilesWithoutBilling(LIST_ENTRIES), 1);
});

test('an absent AMBR is reported as not configured, never as zero', () => {
  const labels = { downlink: 'DL', uplink: 'UL' };
  assert.equal(formatAmbrPair(null, 'N/A', labels), 'N/A');
  assert.equal(formatAmbrPair({ downlink: { unit: 2, value: 100 } }, 'N/A', labels), 'DL 100 Mbps / UL N/A');
  assert.equal(
    formatAmbrPair({ downlink: { unit: 2, value: 100 }, uplink: { unit: 2, value: 50 } }, 'N/A', labels),
    'DL 100 Mbps / UL 50 Mbps',
  );
});

test('the template surface no longer fabricates defaults or classifications', () => {
  const files = [
    '../src/features/profiles/ProfileDetailPage.tsx',
    '../src/features/profiles/profile-draft.ts',
    '../src/features/profiles/components/ProfileEditMode.tsx',
    '../src/features/profiles/components/ProfileViewMode.tsx',
    '../src/features/profiles/ProfilesPage.tsx',
  ];
  for (const file of files) {
    const source = read(file);
    assert.ok(!source.includes('plan_default_10gb'), `${file} still hardcodes a plan id`);
    assert.ok(!source.includes("'10 GB'") && !source.includes('"10 GB"'), `${file} still hardcodes a quota`);
  }
  const page = read('../src/features/profiles/ProfilesPage.tsx');
  assert.ok(!page.includes('inferProfileDomain'), 'the list still infers a business domain');
  assert.ok(!page.includes('getRiskLevel'), 'the list still scores risk');
});

test('the fabricated governance vocabulary is gone from both locales', () => {
  for (const file of ['../src/lib/locales/zh.ts', '../src/lib/locales/en.ts']) {
    const source = read(file);
    for (const key of ['prof_domain_', 'prof_risk_', 'prof_preview_', 'prof_governance_high_risk', 'prof_governance_recent']) {
      assert.ok(!source.includes(key), `${file} still defines ${key}`);
    }
  }
});

test('a draft without billing defaults emits no billing object', () => {
  const payload = buildProfilePayload(createEmptyDraft(), 'template', false);
  assert.equal(payload.ocsDefaults, undefined);
});

test('clearing billing defaults is explicit only when the template had them', () => {
  const payload = buildProfilePayload(createEmptyDraft(), 'template', true);
  assert.deepEqual(payload.ocsDefaults, {});
});

test('stored billing keys the form does not edit survive a save', () => {
  const draft = createDraftFromProfile(
    { ocsDefaults: { planId: 'plan_a', voiceTotal: 3600, plmn: '00101' } },
    'template',
  );
  const payload = buildProfilePayload(draft, 'template', true) as { ocsDefaults: Record<string, unknown> };
  assert.equal(payload.ocsDefaults.planId, 'plan_a');
  assert.equal(payload.ocsDefaults.voiceTotal, 3600);
  assert.equal(payload.ocsDefaults.plmn, '00101');
});

test('a template without AMBR or access restriction keeps those drafts empty', () => {
  const draft = createDraftFromProfile({ name: 'bare' }, 'bare');
  assert.deepEqual(draft.ueAmbr, { downlink: { unit: 2 }, uplink: { unit: 2 } });
  assert.equal(draft.accessRestriction, null);
  const payload = buildProfilePayload(draft, 'bare', false) as Record<string, unknown>;
  assert.equal(payload.access_restriction_data, undefined);
});

test('typing an AMBR value is enough because the unit is part of the draft', () => {
  const draft = createEmptyDraft();
  draft.auth = { k: 'a'.repeat(32), opValue: 'b'.repeat(32), amf: '8000' };
  draft.ueAmbr = { downlink: { unit: 2, value: 100 }, uplink: { unit: 2, value: 50 } };
  const issue = findProfileDraftIssue({ name: 'template', auth: draft.auth, ambr: draft.ueAmbr, slices: [] });
  assert.equal(issue, null);
});

test('the billing filter round-trips through the URL value', () => {
  assert.equal(profileFilterToParam('all'), '');
  assert.equal(profileFilterToParam('withBilling'), 'configured');
  assert.equal(profileFilterFromParam('configured'), 'withBilling');
  assert.equal(profileFilterFromParam('missing'), 'withoutBilling');
  assert.equal(profileFilterFromParam('unlinked'), 'unassigned');
  assert.equal(profileFilterFromParam('garbage'), 'all');
});

test('section change detection ignores object key order', () => {
  const payload = { auth: { k: 'a', amf: '8000', opc: 'b' } };
  const snapshot = { auth: { k: 'a', opc: 'b', amf: '8000' } };
  const rows = buildDraftChangeRows(payload, snapshot);
  assert.equal(rows.find((row) => row.key === 'auth')?.changed, false);
});

test('a genuinely different section is still detected', () => {
  const payload = { auth: { k: 'a', amf: '8000', opc: 'b' } };
  const snapshot = { auth: { k: 'c', opc: 'b', amf: '8000' } };
  const rows = buildDraftChangeRows(payload, snapshot);
  assert.equal(rows.find((row) => row.key === 'auth')?.changed, true);
});

test('template apply is wired to the governed endpoint from both surfaces', () => {
  const detailPage = read('../src/features/profiles/ProfileDetailPage.tsx');
  assert.match(detailPage, /import \{ buildProfileApplyRequest \} from '\.\.\/subscribers\/mutation-contract'/);
  assert.match(detailPage, /buildProfileApplyRequest\(profileName\)/);
  assert.match(detailPage, /\/api\/subscribers\/\$\{encodeURIComponent\(imsi\)\}\/profile/);
  assert.match(detailPage, /subscribers\.write/);

  const subscribersPage = read('../src/features/subscribers/SubscribersPage.tsx');
  assert.match(subscribersPage, /buildProfileApplyRequest\(profileName\)/);
  assert.match(subscribersPage, /\/api\/subscribers\/\$\{encodeURIComponent\(targetImsi\)\}\/profile/);
});

test('the client-side template merge is create-only; existing subscribers use the governed endpoint', () => {
  const editMode = read('../src/features/subscribers/components/subscriber/SubscriberEditMode.tsx');
  const guardIndex = editMode.indexOf('{isNewSubscriber && (');
  const loadIndex = editMode.indexOf('loadFromProfile(e.target.value)');
  assert.ok(guardIndex >= 0 && loadIndex > guardIndex, 'the template select must sit inside the create-only guard');
});

test('template detail drills down into linked subscribers through the profile filter', () => {
  const detailPage = read('../src/features/profiles/ProfileDetailPage.tsx');
  assert.match(detailPage, /\/subscribers\?profile=\$\{encodeURIComponent\(profileName\)\}/);

  const subscribersPage = read('../src/features/subscribers/SubscribersPage.tsx');
  assert.match(subscribersPage, /searchParams\.get\('profile'\)/);
  assert.match(subscribersPage, /filterParams\.set\('profile', profileDrillDown\)/);
});
