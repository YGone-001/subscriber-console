/*
 * Render-level contract for the template detail view (用户模板 / 查看态).
 *
 * The pure helpers already carry unit tests; what those cannot prove is what the
 * operator actually sees. Each case below pins a stated absence to its own
 * rendering: withheld material must not look like an empty field, an unavailable
 * read must not look like an empty configuration, and a missing unit must not be
 * resolved to a default one. Reference: docs/architecture/security-model.md
 * (Template Read Gate and Credential Projection) and AGENTS.md / CLAUDE.md 7.5.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ProfileViewMode from '../src/features/profiles/components/ProfileViewMode';
import { resolveUsimType, type CredentialState } from '../src/types/credential';
import { en } from '../src/lib/locales/en';
import { zh } from '../src/lib/locales/zh';

const STORED_K = '00112233445566778899aabbccddeeff';
const STORED_OP = '112233445566778899aabbccddeeff00';

const translator = (bundle: Record<string, string>) => (
  key: string,
  vars?: Record<string, string | number>,
) => {
  let text = bundle[key] ?? key;
  for (const [name, value] of Object.entries(vars ?? {})) {
    text = text.split(`{${name}}`).join(String(value));
  }
  return text;
};

interface ViewProps {
  t: (key: string, vars?: Record<string, string | number>) => string;
  authData: { k: string; opValue: string; amf: string };
  credentialState: CredentialState | null;
  rawAuth: Record<string, unknown> | null;
  usimType: 'op' | 'opc';
  ocsDefaults: Record<string, unknown>;
  tariffPlanList: unknown[];
  ratingList: unknown[];
  ratingStatus: string;
  ueAmbr: Record<string, unknown>;
  isAccessRestrictionsExpanded: boolean;
  setIsAccessRestrictionsExpanded: (next: boolean | ((prev: boolean) => boolean)) => void;
  accessRestriction: unknown;
  slices: unknown[];
  backendStats: Record<string, unknown> | null;
  statsUnavailable: boolean;
}

function renderView(overrides: Partial<ViewProps> = {}, bundle = zh): string {
  const credentialState = (overrides.credentialState ?? null) as CredentialState | null;
  return renderToStaticMarkup(
    createElement(ProfileViewMode, {
      t: translator(bundle),
      authData: { k: '', opValue: '', amf: '8000' },
      credentialState,
      /* The stored block is what the server withheld material came from; a reader
       * who may not see it must never receive it in the render tree. */
      rawAuth: credentialState?.visibility === 'plaintext'
        ? { k: STORED_K, op: STORED_OP }
        : { k: '', op: '', opc: '' },
      usimType: resolveUsimType({ credentialState: credentialState ?? undefined }),
      ocsDefaults: {},
      tariffPlanList: [],
      ratingList: [],
      ratingStatus: 'ok',
      ueAmbr: {},
      isAccessRestrictionsExpanded: true,
      setIsAccessRestrictionsExpanded: () => {},
      accessRestriction: undefined,
      slices: [],
      backendStats: null,
      statsUnavailable: false,
      ...overrides,
    } as ViewProps),
  );
}

const masked = (over: Partial<CredentialState> = {}): CredentialState => ({
  visibility: 'masked',
  k: 'not_configured',
  op: 'not_configured',
  opc: 'not_configured',
  ...over,
});

/* The security card is the only place the credential cells render, so the
 * assertions below slice a card out instead of matching page-wide copy. */
function between(markup: string, startId: string, endId: string): string {
  const start = markup.indexOf(`id="${startId}"`);
  const end = markup.indexOf(`id="${endId}"`);
  assert.notEqual(start, -1, `the ${startId} card must render`);
  assert.notEqual(end, -1, `the ${endId} card must follow ${startId}`);
  return markup.slice(start, end);
}

const securitySection = (markup: string) => between(markup, 'psec-security', 'psec-ocs-view');
const networkSection = (markup: string) => between(markup, 'psec-network', 'psec-access-restrictions');

const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

/* ------------------------------------------------------- credentials -- */

test('withheld material renders its stated condition, never a value', () => {
  const markup = renderView({
    credentialState: masked({ k: 'configured', op: 'configured' }),
    authData: { k: '', opValue: '', amf: '8000' },
  });
  const card = securitySection(markup);
  assert.ok(card.includes(zh.credential_withheld), 'the stated condition must render');
  assert.equal(count(card, zh.prof_diff_not_configured), 0, 'a configured-but-hidden key is not unconfigured');
  assert.ok(!markup.includes(STORED_K), 'no stored key may reach the render tree');
  assert.ok(!markup.includes('[MASKED]'), 'the retired placeholder must never be rendered');
});

test('an unconfigured key is not dressed up as withheld material', () => {
  const card = securitySection(renderView({ credentialState: masked() }));
  assert.ok(!card.includes(zh.credential_withheld), 'nothing is configured, so nothing is hidden');
  assert.equal(count(card, zh.prof_diff_not_configured), 2, 'K and the OP variant must each report 未配置');
});

test('a plaintext reader renders the stored value', () => {
  const markup = renderView({
    credentialState: { visibility: 'plaintext', k: 'configured', op: 'configured', opc: 'not_configured' },
    authData: { k: STORED_K, opValue: STORED_OP, amf: '8000' },
  });
  const card = securitySection(markup);
  assert.ok(card.includes(STORED_K), 'the operator who owns the material must see it');
  assert.ok(!card.includes(zh.credential_withheld), 'a visible value must not claim to be withheld');
});

/* A response from a server that predates the stated-condition projection can still
 * carry the retired placeholder; the render must report it as withheld, not as a
 * credential value an operator could copy. */
test('the retired placeholder is normalised to withheld at render', () => {
  const markup = renderView({
    rawAuth: { k: '[MASKED]', op: '[MASKED]', opc: '[MASKED]' },
  });
  assert.ok(markup.includes(zh.credential_withheld), 'a placeholder is a stated condition, not a value');
  assert.ok(!markup.includes('[MASKED]'), 'the placeholder text itself must not render');
});

/* --------------------------------------------------------- OP variant -- */

/* The label the operator reads is the one item the subscriber form also trusts,
 * and a read-only role receives no value to derive it from. The assertions name
 * the rendered text, not the class carrying it, so they keep holding whether the
 * styling lives in a global sheet or in a CSS module. */
test('an OP-based template labels the field OP for a reader who cannot see it', () => {
  const markup = renderView({
    credentialState: masked({ k: 'configured', op: 'configured' }),
    usimType: resolveUsimType({ credentialState: masked({ k: 'configured', op: 'configured' }) }),
  });
  assert.match(markup, />OP<\/div>/);
  assert.doesNotMatch(markup, />OPc<\/div>/);
});

test('an OPc-based template keeps the OPc label', () => {
  const state = masked({ k: 'configured', opc: 'configured' });
  const markup = renderView({ credentialState: state, usimType: resolveUsimType({ credentialState: state }) });
  assert.match(markup, />OPc<\/div>/);
});

/* -------------------------------------------------------------- AMBR -- */

const AMBR_UNITS = ['bps', 'Kbps', 'Mbps', 'Gbps'];

test('a stored AMBR without a unit renders the number alone, not a guessed unit', () => {
  const card = networkSection(renderView({ ueAmbr: { downlink: { value: 100 }, uplink: { value: 50 } } }));
  for (const unit of AMBR_UNITS) {
    assert.ok(!card.includes(unit), `no unit was stored, so ${unit} may not be displayed`);
  }
  assert.ok(card.includes('100') && card.includes('50'), 'both stored values must survive');
});

test('bps is a real unit and must render even though its index is zero', () => {
  const card = networkSection(renderView({ ueAmbr: { downlink: { value: 1024, unit: 0 } } }));
  assert.ok(card.includes('bps'), 'the stored bps unit must display, not be dropped as a falsy index');
});

test('a missing UE-AMBR is reported as unconfigured in both directions', () => {
  const card = networkSection(renderView({ ueAmbr: {} }));
  assert.equal(count(card, zh.prof_diff_not_configured), 2, 'downlink and uplink must each state the absence');
});

/* ----------------------------------------------------------- absence -- */

test('failed attribution renders unavailable, never a screenful of zeroes', () => {
  const card = between(renderView({ backendStats: null, statsUnavailable: true }), 'psec-stats', 'psec-security');
  assert.ok(card.includes(zh.prof_stats_unavailable), 'the attribution failure must be stated');
  assert.ok(!card.includes('>0<'), 'a failed read must not be dressed up as zero users');
});

test('successful attribution renders the counts it received', () => {
  const card = between(renderView({
    backendStats: { totalSubscribers: 3, activeSubscribers: 2, suspendedSubscribers: 1, sampleImsis: ['460020000000001'] },
  }), 'psec-stats', 'psec-security');
  assert.ok(card.includes('>3<'), 'the total must render');
  assert.ok(card.includes('>2<'), 'the active count must render');
  assert.ok(card.includes('460020000000001'), 'the sample IMSIs must render when supplied');
  assert.ok(!card.includes(zh.prof_stats_unavailable), 'a complete read must not claim failure');
});

test('an unavailable tariff read is not reported as having no rules', () => {
  const markup = renderView({
    ocsDefaults: { planId: 'plan_gold' },
    ratingStatus: 'unavailable',
  });
  assert.ok(markup.includes(zh.prof_rules_unavailable), 'the read failure must be named');
  assert.ok(!markup.includes(zh.prof_no_tariff_rules), 'a failed read must not be presented as an empty configuration');
});

test('an absent access restriction is unconfigured rather than unrestricted', () => {
  const unconfigured = renderView({ accessRestriction: undefined });
  const unrestricted = renderView({ accessRestriction: 0 });
  const suspended = renderView({ accessRestriction: 255 });
  assert.ok(unconfigured.includes(zh.prof_diff_not_configured));
  assert.ok(unrestricted.includes(zh.prof_diff_access_none));
  assert.ok(suspended.includes(zh.prof_diff_access_suspended));
});

test('a template without slices renders the empty state instead of a blank table', () => {
  const markup = renderView({ slices: [] });
  assert.ok(markup.includes(zh.prof_no_slices), 'the absence must be stated');
});

/* ------------------------------------------------------------ locale -- */

/* The stated condition has to survive both bundles, or the English console renders
 * an empty cell where the Chinese one says the key is configured but hidden. */
test('the English bundle carries the same withheld and unconfigured pair', () => {
  const hidden = securitySection(renderView({
    credentialState: masked({ k: 'configured', op: 'configured' }),
    usimType: 'op',
  }, en));
  const absent = securitySection(renderView({ credentialState: masked() }, en));
  assert.equal(count(hidden, en.credential_withheld), 2, 'both hidden keys must state their condition in English');
  assert.equal(count(hidden, en.prof_diff_not_configured), 0, 'a configured key must not read as unconfigured');
  assert.equal(count(absent, en.prof_diff_not_configured), 2, 'absent keys must read as unconfigured');
  assert.equal(count(absent, en.credential_withheld), 0, 'an absent key must not claim to be withheld');
});
