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
import {
  ambrSelectUnit,
  ambrSideView,
  ambrUnitLabel,
  formatAmbrPair,
  formatAmbrPairCompact,
  mbrSideText,
  resolveTemplateImpact,
} from '../src/features/profiles/profile-format';
import { resolveUsimType } from '../src/types/credential';

const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), 'utf8');

const LABELS: ProfileDiffLabels = {
  notConfigured: 'NOT_CONFIGURED',
  sliceUnit: 'slices',
  sessionUnit: 'sessions',
  pccUnit: 'PCC',
  accessNone: 'UNRESTRICTED',
  accessSuspended: 'SUSPENDED',
  maskedSecret: '****',
  withheld: 'WITHHELD',
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
  assert.match(source, /await putJson/);
  assert.match(source, /mutation-client/);
  assert.match(source, /setError\(err instanceof Error \? err\.message : t\('prof_err_save'\)\)/);
  assert.doesNotMatch(source, /throw new Error\(t\("prof_err_save"\)\)/);
});

/* The backend distinguishes a committed change from a submission that changed
 * nothing; the page must report what actually happened. */
test('an unchanged template save reports no effect instead of claiming a save', () => {
  const source = read('../src/features/profiles/ProfileDetailPage.tsx');
  assert.match(source, /classification === 'NO_EFFECT'/);
  assert.match(source, /committedAsNoEffect \? t\('prof_msg_no_effect'\)/);

  const en = read('../src/lib/locales/en.ts');
  const zh = read('../src/lib/locales/zh.ts');
  assert.match(en, /prof_msg_no_effect:/);
  assert.match(zh, /prof_msg_no_effect:/);
});

/* A restore rewrites the live template; it must not silently eat an in-progress
 * draft, and the create confirmation must survive the route change. */
test('a restore asks before discarding unsaved template edits', () => {
  const source = read('../src/features/profiles/ProfileDetailPage.tsx');
  assert.match(source, /const requestRestore = \(target: ProfileVersionDetail\) => \{/);
  assert.match(source, /setPendingRestore\(target\)/);
  assert.match(source, /setDiscardTarget\('restore'\)/);
  assert.match(source, /onRestore=\{requestRestore\}/);
  assert.ok(!source.includes('onRestore={setRestoreTarget}'), 'the ungated restore entry point is retired');
});

test('the create confirmation travels as a query flag across the route change', () => {
  const source = read('../src/features/profiles/ProfileDetailPage.tsx');
  assert.match(source, /useAppSearchParam\('created'\)/);
  assert.match(source, /t\('prof_msg_created'\)/);
  assert.match(source, /\?created=1`/);
});

// Contract registration: every wired template operation must be declared.
test('the template mutation and read contracts list clone, drift precheck and export', () => {
  const mutations = JSON.parse(read('../mutation-contract.json')) as Array<{
    route: string;
    operations?: Array<{ request: string }>;
    preflightOperations?: string[];
  }>;
  const detail = mutations.find((entry) => entry.route === '/profile/:name');
  assert.ok(detail, 'the detail route owns a mutation contract entry');
  assert.ok(
    (detail?.operations ?? []).some((op) => op.request === 'POST /api/profiles/{name}/clone'),
    'clone is a governed write and must be contracted',
  );
  assert.ok(
    (detail?.preflightOperations ?? []).includes('POST /api/profiles/{name}/drift-precheck'),
    'the drift probe is a semantic read and must be contracted as preflight',
  );

  const requests = JSON.parse(read('../mutation-request-contract.json')) as Array<{
    path: string;
    responseSemantics: string;
  }>;
  const clone = requests.find((entry) => entry.path === '/api/profiles/{name}/clone');
  assert.ok(clone && clone.responseSemantics === 'mutation-result', 'clone carries a request contract');
  const drift = requests.find((entry) => entry.path === '/api/profiles/{name}/drift-precheck');
  assert.ok(drift && drift.responseSemantics === 'preflight-result', 'the drift probe is never a mutation result');

  const reads = JSON.parse(read('../read-contract.json')) as Array<{ route: string; readEndpoints: string[] }>;
  assert.ok(
    (reads.find((entry) => entry.route === '/profile/:name')?.readEndpoints ?? []).includes('GET /api/profiles/{name}/export'),
    'export is a read and belongs to the detail route',
  );
  const subscriberReads = reads.find((entry) => entry.route === '/subscribers')?.readEndpoints ?? [];
  assert.ok(subscriberReads.includes('GET /api/profiles'), 'the subscriber page reads the template list');
  assert.ok(subscriberReads.includes('GET /api/profiles/{name}'), 'the create form reads one template');
});

/* Writing credential material needs both authorities; when the caller cannot
 * see it, the block leaves the payload so the stored one survives. */
test('a caller who cannot see credentials never writes them back', () => {
  const draft = createDraftFromProfile(BASE_PROFILE, 'template');
  const payload = buildProfilePayload(draft, 'template', true, { includeAuth: false });
  assert.ok(!('auth' in payload), 'the auth block must be absent so the stored material is preserved');

  /* A withheld block arrives with no values at all, plus the server's stated
   * condition; the reader is not asked to format keys they never received. */
  const withheldAuth = { k: '', opValue: '', amf: '8000' };
  assert.equal(
    findProfileDraftIssue({ name: 'template', auth: withheldAuth, ambr: draft.ueAmbr, slices: draft.slices, validateAuth: false }),
    null,
  );
  assert.deepEqual(
    findProfileDraftIssue({ name: 'template', auth: withheldAuth, ambr: draft.ueAmbr, slices: draft.slices }),
    { code: 'kFormat' },
  );

  const rows = buildDraftChangeRows(payload, BASE_PROFILE, ['auth']);
  assert.ok(!rows.some((row) => row.key === 'auth'), 'an unwritten section is not a pending change');
  assert.ok(rows.some((row) => row.key === 'title'));
});

test('the editor locks the credential block when the material is not visible', () => {
  const editMode = read('../src/features/profiles/components/ProfileEditMode.tsx');
  assert.match(editMode, /const credentialsEditable = canEditCredentials !== false;/);
  assert.match(editMode, /disabled=\{!credentialsEditable\}/);
  assert.match(editMode, /t\("prof_credential_not_editable"\)/);

  const detail = read('../src/features/profiles/ProfileDetailPage.tsx');
  assert.match(detail, /capabilities\.canEditCredentials/);
  assert.match(detail, /includeAuth: canEditCredentials/);
});

test('rating vocabulary and AMBR units each have one definition', () => {
  for (const file of ['components/ProfileViewMode.tsx', 'components/ProfileEditMode.tsx']) {
    const source = read(`../src/features/profiles/${file}`);
    assert.ok(!/function ratingTypeLabel/.test(source), `${file} still defines its own rating labels`);
    assert.match(source, /ratingTypeLabel, ratingUnitLabel } from '..\/profile-format'/);
  }
  const pccEditor = read('../src/features/profiles/components/ProfilePccRuleEditor.tsx');
  assert.ok(!/const AMBR_UNITS =/.test(pccEditor), 'the PCC editor must reuse the shared unit table');
});

test('creating a template is one governed write, not a default followed by an update', () => {
  const source = read('../src/features/profiles/ProfileDetailPage.tsx');
  assert.match(source, /await postJson\('\/api\/profiles', \{ \.\.\.payload, name: targetName \}\)/);
  assert.ok(!source.includes("postJson('/api/profiles', { name: targetName })"), 'the two-step create is retired');
  assert.ok(!source.includes('prof_err_create_partial'), 'the partial-create wording is retired');
});

test('saving a template never claims it changes subscribers already provisioned', () => {
  const en = read('../src/lib/locales/en.ts');
  const zh = read('../src/lib/locales/zh.ts');
  assert.match(en, /prof_detail_subtitle: "[^"]*subscribers already provisioned from this template keep their current values/);
  assert.match(en, /prof_change_confirm_desc: "\{count\} subscriber\(s\) were provisioned from this template\. Saving changes the template only\."/);
  assert.ok(!/prof_detail_subtitle: "[^"]*affects subscribers/.test(en), 'the old claim still stands in English');
  assert.ok(!/prof_change_confirm_desc: "[^"]*This update affects/.test(en), 'the confirm panel still claims impact');
  /* The mechanics note is now actually rendered instead of sitting unused. */
  assert.match(read('../src/features/profiles/ProfileDetailPage.tsx'), /t\('prof_change_confirm_note'\)/);
  assert.ok(zh.includes('prof_change_confirm_desc') && zh.includes('prof_detail_subtitle'));
});

test('the template list renders a retryable error instead of an empty state', () => {
  const source = read('../src/features/profiles/ProfilesPage.tsx');
  assert.match(source, /const \{ data, isLoading, error, mutate \}/);
  assert.match(source, /<ErrorState/);
  assert.match(source, /onRetry=/);
});

test('the list action renders view or edit by template permission', () => {
  const source = read('../src/features/profiles/ProfilesPage.tsx');
  assert.match(source, /canEditTemplates \? <Pencil/);
  assert.match(source, /: <Eye size=/);
});

test('credential display is driven by the server-stated condition, not a client guess', () => {
  const detail = read('../src/features/profiles/ProfileDetailPage.tsx');
  assert.match(detail, /capabilities\.credentialVisibility/);
  assert.match(detail, /credentialState=\{profile\?\.auth\?\.credentialState/);

  const view = read('../src/features/profiles/components/ProfileViewMode.tsx');
  assert.match(view, /credentialDisplay\(authData\.k, 'k'\)/);
  assert.match(view, /credentialState\[field\] === 'configured' \? t\("credential_withheld"\)/);
  assert.match(view, /isWithheldPlaceholder\(rawAuth\?\.\[field\]\)/);
});

/* Withheld material and unconfigured material are two different facts, and the
 * response carries no placeholder value for the first one. */
test('the diff reports the stated condition of withheld material', () => {
  const withheld = {
    ...BASE_PROFILE,
    auth: {
      amf: '8000',
      credentialState: { visibility: 'masked', k: 'configured', op: 'not_configured', opc: 'configured' },
    },
  };
  const sections = buildProfileVersionDiff(withheld, withheld, LABELS);
  assert.equal(row(sections, 'auth', 'k').versionValue, LABELS.withheld);
  assert.equal(row(sections, 'auth', 'opc').versionValue, LABELS.withheld);
  assert.equal(row(sections, 'auth', 'op').versionValue, LABELS.notConfigured);

  // A reader who can see the material gets a shortened value, never the key.
  const visible = buildProfileVersionDiff(BASE_PROFILE, BASE_PROFILE, LABELS);
  assert.equal(row(visible, 'auth', 'k').versionValue, '0011…eeff');
});

/* Responses from a server that predates the stated-condition projection can
 * still carry the retired placeholder; nothing may render or store it as a key. */
test('the retired placeholder is never treated as a credential value', () => {
  const draft = createDraftFromProfile(
    { ...BASE_PROFILE, auth: { k: '[MASKED]', opc: '[MASKED]', amf: '8000' } },
    'template',
  );
  assert.equal(draft.auth.k, '');
  assert.equal(draft.auth.opValue, '');
  assert.ok(!JSON.stringify(buildProfilePayload(draft, 'template', false)).includes('[MASKED]'));

  const staleVersion = { ...BASE_PROFILE, auth: { k: '[MASKED]', opc: BASE_PROFILE.auth.opc } };
  const sections = buildProfileVersionDiff(staleVersion, BASE_PROFILE, LABELS);
  assert.equal(row(sections, 'auth', 'k').versionValue, LABELS.withheld);
  assert.equal(row(sections, 'auth', 'opc').versionValue, 'ffee…1100');
});

/* Which OP variant a document carries is a property of the credential block, so
 * a reader who cannot see the values must still get the right label. */
test('the USIM variant comes from the stated condition, not from the value', () => {
  assert.equal(resolveUsimType({
    credentialState: { visibility: 'masked', k: 'configured', op: 'configured', opc: 'not_configured' },
  }), 'op');
  assert.equal(resolveUsimType({
    credentialState: { visibility: 'masked', k: 'configured', op: 'not_configured', opc: 'configured' },
  }), 'opc');
  // Older responses carry no state, so the value decides, as before.
  assert.equal(resolveUsimType({ op: 'aabb' }), 'op');
  assert.equal(resolveUsimType({ opc: 'aabb' }), 'opc');
  assert.equal(resolveUsimType(undefined), 'opc');

  const draft = createDraftFromProfile({
    title: 'template',
    auth: { amf: '8000', credentialState: { visibility: 'masked', k: 'configured', op: 'configured', opc: 'not_configured' } },
  }, 'template');
  assert.equal(draft.usimType, 'op');
  assert.equal(draft.auth.opValue, '', 'a withheld value stays empty in the form');
});

/* An absent unit is reported as no unit. Resolving it to an index would display
 * and persist a value nobody stored, and bps (index 0) is a legal choice. */
test('an absent AMBR unit is never resolved to a default', () => {
  assert.equal(ambrUnitLabel(0), 'bps');
  assert.equal(ambrUnitLabel(2), 'Mbps');
  assert.equal(ambrUnitLabel(undefined), '');
  assert.equal(ambrUnitLabel(9), '');
  assert.deepEqual(ambrSideView({ value: 100 }, 'N'), { text: '100', unit: '' });
  assert.deepEqual(ambrSideView({ value: 100, unit: 2 }, 'N'), { text: '100', unit: 'Mbps' });
  assert.deepEqual(ambrSideView(undefined, 'N'), { text: 'N', unit: '' });
  assert.equal(mbrSideText({ value: 512, unit: 0 }, 'N'), '512 bps');
  assert.equal(mbrSideText({ value: 512 }, 'N'), '512');
  assert.equal(mbrSideText({}, 'N'), 'N');
});

/* A failed attribution read is unknown, not zero — the confirmations in front of
 * a write must not turn it into a count. */
test('an unavailable impact is reported as unknown rather than zero', () => {
  assert.deepEqual(resolveTemplateImpact(7, true), { kind: 'known', count: 7 });
  assert.deepEqual(resolveTemplateImpact(0, true), { kind: 'known', count: 0 });
  assert.deepEqual(resolveTemplateImpact(0, false), { kind: 'unknown' });
  assert.deepEqual(resolveTemplateImpact(undefined, true), { kind: 'unknown' });
  assert.deepEqual(resolveTemplateImpact(null, true), { kind: 'unknown' });

  const page = read('../src/features/profiles/ProfileDetailPage.tsx');
  assert.match(page, /prof_change_confirm_desc_unknown/);
  assert.match(page, /prof_del_in_use_unknown_desc/);
  assert.ok(!/impactedSubscribers \|\| 1/.test(page), 'the force-delete fallback must not invent one subscriber');
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

test('the compact AMBR pair drops the direction words the column heading already carries', () => {
  assert.equal(formatAmbrPairCompact(null, 'N/A'), 'N/A');
  assert.equal(formatAmbrPairCompact({ downlink: null, uplink: null }, 'N/A'), 'N/A');
  assert.equal(
    formatAmbrPairCompact({ downlink: { unit: 3, value: 1000 }, uplink: { unit: 3, value: 300 } }, 'N/A'),
    '1000 Gbps / 300 Gbps',
  );
  assert.equal(formatAmbrPairCompact({ downlink: { unit: 2, value: 10 } }, 'N/A'), '10 Mbps / N/A');
});

test('the template table pins its column grid so the identifier cannot be starved', () => {
  const page = read('../src/features/profiles/ProfilesPage.tsx');
  const css = read('../src/styles/profile.css');
  assert.match(page, /<colgroup>/);
  assert.match(page, /profile-col-template/);
  assert.match(css, /\.profile-governance-table \{[^}]*table-layout: fixed/);
  assert.match(css, /\.profile-col-template \{ width: 20%/);
  assert.match(page, /formatAmbrPairCompact\(/);
});

test('the template filter row wraps instead of scrolling chips out of reach', () => {
  const css = read('../src/styles/globals.css');
  assert.match(css, /\.profile-domain-filters \{[^}]*flex-wrap: wrap/);
  assert.doesNotMatch(css, /\.profile-domain-filters \{[^}]*overflow-x: auto/);
  assert.match(css, /\.profile-action-bar \{[^}]*minmax\(0, auto\)/);
  /* Between the stacked breakpoint and 1180px the filter group takes its own row,
   * which is where three tracks starved it to 351px against 694px of chips. */
  assert.match(css, /@media \(max-width: 1180px\) \{[\s\S]*?\.profile-domain-filters \{\s*grid-column: 1 \/ -1;/);
});

test('the column grid follows the responsive hiding of supplementary columns', () => {
  const css = read('../src/styles/profile.css');
  /* The shared rule hides supplementary columns at 980px; the surviving columns
   * must absorb their share or the fixed grid leaves dead space. */
  assert.match(css, /@media \(max-width: 980px\) \{[\s\S]*?\.profile-col-ambr,\s*\.profile-col-owner \{ width: 0; \}/);
  assert.match(css, /\.profile-col-template \{ width: 20%; \}/);
});

test('the aggregate breakdown wraps through an opt-in class instead of editing the shared strip', () => {
  const strip = read('../src/components/ui/MetricStrip.tsx');
  const page = read('../src/features/profiles/ProfilesPage.tsx');
  const css = read('../src/styles/profile.css');
  assert.match(strip, /detailClassName\?: string/);
  assert.match(strip, /detailClass\(item, styles\.metricDetail\)/);
  assert.match(page, /detailClassName: "profile-metric-detail"/);
  assert.match(css, /\.profile-page-container \.profile-metric-detail \{[^}]*white-space: normal/);
  /* The primitive must keep clipping by default for its other consumers. */
  assert.match(read('../src/styles/modules/ConsolePrimitives.module.css'), /\.metricDetail \{[^}]*white-space: nowrap/);
});

test('the empty template list offers one create affordance, not two', () => {
  const page = read('../src/features/profiles/ProfilesPage.tsx');
  const emptyIndex = page.indexOf('<EmptyState');
  assert.ok(emptyIndex > 0, 'the list must keep its empty state');
  assert.ok(!page.slice(emptyIndex).includes('/profile/new'), 'the empty state must not repeat the create button');
  assert.match(page, /onClick=\{\(\) => router\.push\('\/profile\/new'\)\}/);
});

test('an AMBR unit of zero is a real unit, not an absent one', () => {
  const utils = read('../src/features/subscribers/components/subscriber/utils.tsx');
  assert.match(utils, /ambr\.downlink\?\.unit \?\? 1/);
  assert.match(utils, /ambr\.uplink\?\.unit \?\? 1/);
  assert.doesNotMatch(utils, /ambr\.downlink\?\.unit \|\| 1/);
});

test('the version history sits below the workspace and starts collapsed', () => {
  const detailPage = read('../src/features/profiles/ProfileDetailPage.tsx');
  const card = read('../src/features/profiles/components/ProfileVersionsCard.tsx');
  const contentIndex = detailPage.indexOf('<ProfileViewMode');
  const historyIndex = detailPage.indexOf('<ProfileVersionsCard');
  assert.ok(contentIndex > 0 && historyIndex > contentIndex, 'the history card must follow the template content');
  assert.match(card, /const \[open, setOpen\] = useState\(false\)/);
  assert.match(card, /aria-controls="psec-versions-body"/);
  assert.match(card, /\{open && \(\s*<div className="dash-card-body pm-card-body" id="psec-versions-body"/);
});

test('the template workspace offers a jump target per section', () => {
  const detailPage = read('../src/features/profiles/ProfileDetailPage.tsx');
  const nav = read('../src/features/profiles/components/ProfileSectionNav.tsx');
  assert.match(detailPage, /const VIEW_SECTIONS/);
  assert.match(detailPage, /const EDIT_SECTIONS/);
  assert.match(detailPage, /scrollIntoView\(\{ behavior: .smooth., block: .start. \}\)/);
  assert.match(nav, /aria-label=\{label\}/);
  /* The nav must precede the content it points at. */
  assert.ok(detailPage.indexOf('<ProfileSectionNav') < detailPage.indexOf('{isEditing ? ('));
});

test('confirming a save shows stored versus pending values, not a section boolean', () => {
  const detailPage = read('../src/features/profiles/ProfileDetailPage.tsx');
  assert.match(detailPage, /buildProfileVersionDiff\(profile, draftPayload/);
  assert.match(detailPage, /rows: section\.rows\.filter\(\(row\) => row\.changed\)/);
  assert.match(detailPage, /prof_diff_stored_col/);
  assert.match(detailPage, /prof_diff_pending_col/);
  assert.match(detailPage, /className="pm-confirm-diff-to"/);
  /* The old section-level boolean list must be gone from the panel. */
  assert.doesNotMatch(detailPage, /draftChangeRows\.map/);
});

test('a save with no pending change is not offered', () => {
  const detailPage = read('../src/features/profiles/ProfileDetailPage.tsx');
  assert.match(detailPage, /\(!isCreate && changedDraftRows\.length === 0\)/);
});

test('the access restriction column keeps absent, zero and restricted apart', () => {
  const page = read('../src/features/profiles/ProfilesPage.tsx');
  assert.match(page, /access === 0\s*\?\s*t\("prof_access_unrestricted"\)\s*:\s*t\("prof_access_limited"\)/);
  assert.match(page, /profile-chip profile-chip-neutral/);
  assert.match(read('../src/styles/profile.css'), /\.profile-chip-neutral \{/);
  /* The two-state wording that read as "restriction present" is retired. */
  for (const file of ['../src/lib/locales/en.ts', '../src/lib/locales/zh.ts']) {
    const source = read(file);
    assert.ok(!source.includes('prof_access_configured'), `${file} still offers the two-state label`);
    assert.match(source, /prof_access_unrestricted: /);
    assert.match(source, /prof_access_limited: /);
  }
});

test('the create route carries its own breadcrumb label in both locales', () => {
  const navigation = read('../src/lib/navigation.ts');
  const newRoute = navigation.split('\n').find((line) => line.includes("route: '/profile/new'"));
  assert.ok(newRoute && newRoute.includes("labelKey: 'nav_profile_new'"), 'the create route must not reuse the list label');
  for (const file of ['../src/lib/locales/en.ts', '../src/lib/locales/zh.ts']) {
    assert.match(read(file), /nav_profile_new: /);
  }
});

test('the template editor collapses slices like the subscriber form does', () => {
  const detailPage = read('../src/features/profiles/ProfileDetailPage.tsx');
  const editMode = read('../src/features/profiles/components/ProfileEditMode.tsx');
  assert.match(detailPage, /const \[expandedSlices, setExpandedSlices\] = useState<number\[\]>\(\[0\]\)/);
  assert.match(editMode, /isExpanded=\{\(expandedSlices \?\? \[\]\)\.includes\(sIdx\)\}/);
  assert.match(editMode, /onToggleExpand=\{\(\) => toggleSliceExpanded\(sIdx\)\}/);
  /* The shared editor keeps its expand props optional, so the subscriber call
   * site that never passed them stays valid. */
  assert.match(
    read('../src/features/profiles/components/ProfileSliceEditor.tsx'),
    /isExpanded\?: boolean;\n\s*onToggleExpand\?: \(\) => void;/,
  );
});

test('a template save and delete precondition on the revision that was loaded', () => {
  const detailPage = read('../src/features/profiles/ProfileDetailPage.tsx');
  const types = read('../src/features/profiles/profile-types.ts');
  assert.match(types, /revision\?: number/);
  assert.match(types, /statsCompleteness\?: 'complete' \| 'unavailable'/);
  assert.match(types, /profileExists\?: boolean/);
  assert.match(detailPage, /storedRevision === null \? payload : \{ \.\.\.payload, expectedRevision: storedRevision \}/);
  assert.match(detailPage, /params\.set\('expectedRevision', String\(storedRevision\)\)/);
  /* A create has no counter to precondition on. */
  assert.match(detailPage, /await postJson\('\/api\/profiles', \{ \.\.\.payload, name: targetName \}\)/);
});

test('a revision conflict keeps the draft and says so in both locales', () => {
  const detailPage = read('../src/features/profiles/ProfileDetailPage.tsx');
  assert.match(detailPage, /err\.code === 'PROFILE_REVISION_CONFLICT'/);
  assert.match(detailPage, /setError\(t\('prof_err_revision_conflict'\)\)/);
  /* The draft survives: the conflict path must not reset it or leave edit mode. */
  const conflictBlock = detailPage.slice(detailPage.indexOf("err.code === 'PROFILE_REVISION_CONFLICT'"), detailPage.indexOf("err.code === 'PROFILE_REVISION_CONFLICT'") + 320);
  assert.ok(!conflictBlock.includes('setIsEditing(false)'), 'a conflict must not drop the operator out of editing');
  assert.ok(!conflictBlock.includes('createDraftFromProfile'), 'a conflict must not rebuild the draft');
  for (const file of ['../src/lib/locales/en.ts', '../src/lib/locales/zh.ts']) {
    assert.match(read(file), /prof_err_revision_conflict: /);
  }
});

test('an unavailable subscriber attribution is reported as unavailable', () => {
  const viewMode = read('../src/features/profiles/components/ProfileViewMode.tsx');
  const detailPage = read('../src/features/profiles/ProfileDetailPage.tsx');
  assert.match(detailPage, /detail\?\.statsCompleteness === 'unavailable'/);
  assert.match(detailPage, /statsUnavailable=\{statsUnavailable\}/);
  assert.match(viewMode, /\{\(backendStats \|\| statsUnavailable\) && \(/);
  assert.match(viewMode, /t\("prof_stats_unavailable"\)/);
});

test('the drift probe asks the server and renders only what it answers', () => {
  const card = read('../src/features/profiles/components/ProfileDriftCard.tsx');
  const detailPage = read('../src/features/profiles/ProfileDetailPage.tsx');
  assert.match(card, /\/api\/profiles\/\$\{encodeURIComponent\(profileName\)\}\/drift-precheck/);
  assert.match(card, /postJson<ProfileDriftReport>/);
  /* The client never derives drift from stored fields; it only reports states. */
  assert.ok(!/webui_meta|access_restriction_data\s*!==/.test(card), 'the card must not compute drift locally');
  assert.match(card, /entry\.state !== 'in_sync'/);
  assert.match(card, /report\.truncated/);
  /* The panel follows the subscriber capability, not the template one. */
  assert.match(detailPage, /canApplyTemplates && profileName && \(\s*<ProfileDriftCard/);
});

test('clone and export are wired to their endpoints and stay permission-gated', () => {
  const detailPage = read('../src/features/profiles/ProfileDetailPage.tsx');
  assert.match(detailPage, /\/api\/profiles\/\$\{encodeURIComponent\(profileName\)\}\/clone/);
  assert.match(detailPage, /getBlob\(`\/api\/profiles\/\$\{encodeURIComponent\(profileName\)\}\/export`\)/);
  assert.match(detailPage, /import \{ getBlob \} from '\.\.\/\.\.\/lib\/api\/read-client'/);
  /* Clone is a write and sits behind canWrite; export is a read and does not. */
  const cloneGuard = detailPage.indexOf('{canWrite && (\n              <button');
  const cloneButton = detailPage.indexOf("t('prof_clone_btn')");
  const exportButton = detailPage.indexOf("t('prof_export_btn')");
  assert.ok(cloneGuard >= 0 && cloneButton > cloneGuard, 'the clone action must be gated on profiles.write');
  assert.ok(exportButton > cloneButton, 'the export action must follow');
  const between = detailPage.slice(cloneButton, exportButton);
  assert.ok(!between.includes('{canWrite &&'), 'export must not hide behind the write gate');
});

test('both locales carry the same template keys', () => {
  const keys = (source: string) => new Set((source.match(/^\s+(prof_[a-z0-9_]+):/gm) ?? []).map((line) => line.trim().split(':')[0]));
  const en = keys(read('../src/lib/locales/en.ts'));
  const zh = keys(read('../src/lib/locales/zh.ts'));
  const onlyEn = [...en].filter((key) => !zh.has(key));
  const onlyZh = [...zh].filter((key) => !en.has(key));
  assert.deepEqual(onlyEn, [], 'keys missing from zh');
  assert.deepEqual(onlyZh, [], 'keys missing from en');
  assert.ok(en.size >= 190, `expected the template vocabulary to be present, got ${en.size} keys`);
});

test('the shared editors emit the stable anchors the subscriber form already asks for', () => {
  const sliceEditor = read('../src/features/profiles/components/ProfileSliceEditor.tsx');
  const sessionEditor = read('../src/features/profiles/components/ProfileSessionEditor.tsx');
  const pccEditor = read('../src/features/profiles/components/ProfilePccRuleEditor.tsx');
  const subscriberForm = read('../src/features/subscribers/useSubscriberForm.ts');

  /* useSubscriberForm has always scrolled to `slice-card-N`; the editor never
   * produced that id, so the affordance was dead for both consumers. */
  assert.match(subscriberForm, /scrollTo\(`slice-card-\$\{newIdx\}`\)/);
  assert.match(sliceEditor, /id=\{`slice-card-\$\{sliceIndex\}`\}/);
  assert.match(sessionEditor, /<div id=\{anchorId\} className="session-editor-card"/);
  assert.match(pccEditor, /<div id=\{anchorId\} className="pcc-rule-box"/);
  /* The anchors reach the deeper levels through optional props, so no existing
   * call site has to pass them. */
  assert.match(sliceEditor, /anchorId=\{`slice-card-\$\{sliceIndex\}-session-\$\{sessIdx\}`\}/);
  assert.match(sessionEditor, /anchorId=\{anchorId \? `\$\{anchorId\}-rule-\$\{pccIdx\}` : undefined\}/);
  assert.match(sessionEditor, /anchorId\?: string/);
  assert.match(pccEditor, /anchorId\?: string/);
});

test('the hierarchy rail describes the draft shape and jumps into it', () => {
  const rail = read('../src/features/profiles/components/ProfileHierarchyRail.tsx');
  const editMode = read('../src/features/profiles/components/ProfileEditMode.tsx');
  const detailPage = read('../src/features/profiles/ProfileDetailPage.tsx');
  /* Every visible string comes from a locale key or a 3GPP token. */
  assert.match(rail, /t\('prof_content_sessions'/);
  assert.match(rail, /t\('prof_content_pcc'/);
  assert.match(rail, /t\('slice_rule_idx'/);
  assert.match(rail, /typeLabel\(/);
  assert.match(rail, /if \(entries\.length === 0\) return null/);
  assert.match(editMode, /<ProfileHierarchyRail slices=\{slices\} onJump=\{jumpToAnchor\} \/>/);
  /* A collapsed slice owns its sessions, so the jump must expand it first. */
  assert.match(detailPage, /setExpandedSlices\(\(current\) => \(current\.includes\(index\) \? current : \[\.\.\.current, index\]\)\)/);
  assert.match(detailPage, /el\.classList\.add\('profile-anchor-flash'\)/);
  assert.match(read('../src/styles/profile.css'), /\.profile-anchor-flash \{/);
});

test('bps is a selectable unit and the resolver never invents one', () => {
  assert.equal(ambrSelectUnit(0), 0);
  assert.equal(ambrSelectUnit(4), 4);
  assert.equal(ambrSelectUnit(undefined), '');
  assert.equal(ambrSelectUnit(null), '');
  assert.equal(ambrSelectUnit(''), '');
  assert.equal(ambrSelectUnit(5), '');
});

test('a cleared AMBR value stays absent and is rejected instead of stored as zero', () => {
  const cleared = { downlink: { unit: 2 }, uplink: VALID_AMBR.uplink };
  assert.deepEqual(
    findProfileDraftIssue({ name: 'template', auth: VALID_AUTH, ambr: cleared, slices: [] }),
    { code: 'ambrInvalid', direction: 'downlink' },
  );
  const payload = buildProfilePayload(
    { ...createEmptyDraft(), ueAmbr: cleared as never },
    'template',
    false,
  ) as { ambr: { downlink: Record<string, unknown> } };
  assert.ok(!('value' in payload.ambr.downlink), 'an absent value must not be written as 0');
});

test('a stored bps unit survives the draft round trip', () => {
  const draft = createDraftFromProfile(
    { ...BASE_PROFILE, ambr: { downlink: { value: 512000, unit: 0 }, uplink: { value: 512000, unit: 0 } } },
    'template',
  );
  assert.equal(draft.ueAmbr.downlink.unit, 0);
  const payload = buildProfilePayload(draft, 'template', false) as { ambr: { downlink: { unit: number } } };
  assert.equal(payload.ambr.downlink.unit, 0);
});

/* Lint stand-in: the two coercions that made the editor lie about AMBR. */
test('template editors resolve units through the shared select, not a local default', () => {
  for (const file of ['ProfileEditMode.tsx', 'ProfilePccRuleEditor.tsx']) {
    const source = read(`../src/features/profiles/components/${file}`);
    assert.match(source, /<AmbrUnitSelect /);
    assert.ok(!/\.unit \|\| 1/.test(source), `${file} still defaults an absent unit to Kbps`);
    assert.ok(!/=== "" \? 0\b/.test(source), `${file} still defaults a cleared number input to zero`);
  }
});

