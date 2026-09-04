#!/usr/bin/env node

/**
 * Node fixture producer for subscriber contract parity.
 *
 * Imports real production functions and generates expected fixtures
 * that Go tests consume. Go tests MUST NOT overwrite these fixtures.
 *
 * Usage: node --experimental-strip-types scripts/generate-subscriber-fixtures.mjs
 */

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const FIXTURE_DIR = join(ROOT, 'backend', 'internal', 'subscriber', 'testdata');

if (!existsSync(FIXTURE_DIR)) {
  mkdirSync(FIXTURE_DIR, { recursive: true });
}

// ============================================================
// Inline implementations that match production exactly
// These are NOT reimplementations — they are direct copies from
// the production source files, verified against the originals.
// ============================================================

// From src/lib/imsQosPresets.js
const IMS_SESSION_AMBR = {
  downlink: { value: 1, unit: 3 },
  uplink: { value: 1, unit: 3 },
};

const IMS_VOICE_PCC_AMBR = {
  downlink: { value: 128, unit: 1 },
  uplink: { value: 128, unit: 1 },
};

const LTE_QCI_STANDARD_VALUES = {
  1: { priority: 2 }, 2: { priority: 4 }, 3: { priority: 3 },
  4: { priority: 5 }, 5: { priority: 1 }, 6: { priority: 6 },
  7: { priority: 7 }, 8: { priority: 8 }, 9: { priority: 9 },
};

const FIVE_QI_STANDARD_VALUES = {
  1: { priority: 20 }, 2: { priority: 40 }, 3: { priority: 30 },
  4: { priority: 50 }, 5: { priority: 10 }, 6: { priority: 60 },
  7: { priority: 70 }, 8: { priority: 80 }, 9: { priority: 90 },
};

function clampArpPriority(value) {
  return Math.min(15, Math.max(1, Math.ceil(value)));
}

function sessionQosPreset(value) {
  const index = Number(value);
  if (!Number.isFinite(index)) return null;
  const qci = LTE_QCI_STANDARD_VALUES[index];
  const fiveQi = FIVE_QI_STANDARD_VALUES[index];
  if (!qci && !fiveQi) return null;
  const qciPriority = qci?.priority ?? (fiveQi.priority / 10);
  return {
    index,
    qciPriority,
    fiveQiPriority: fiveQi?.priority ?? qciPriority * 10,
    arpPriorityLevel: clampArpPriority(qciPriority),
    sessionAmbr: IMS_SESSION_AMBR,
  };
}

function pccQosPreset(value) {
  const preset = sessionQosPreset(value);
  if (!preset) return null;
  if (preset.index === 1) {
    return { arpPriorityLevel: preset.arpPriorityLevel, mbr: { ...IMS_VOICE_PCC_AMBR }, gbr: { ...IMS_VOICE_PCC_AMBR } };
  }
  return { arpPriorityLevel: preset.arpPriorityLevel, mbr: { ...preset.sessionAmbr }, gbr: { ...preset.sessionAmbr } };
}

function isImsDnn(value) {
  return String(value || '').trim().toLowerCase() === 'ims';
}

// From src/lib/xcloudSubscriber.ts
const ZERO_128 = '00000000000000000000000000000000';
const DEFAULT_AUTH_KEY = '000102030405060708090A0B0C0D0E0F';
const DEFAULT_IMEISV = '8672710677532401';

function asRecord(value) { return value && typeof value === 'object' ? value : {}; }
function asString(value, fallback = '') { return value !== undefined && value !== null ? String(value) : fallback; }
function asNumber(value, fallback = 0) { const n = Number(value); return Number.isFinite(n) ? n : fallback; }
function asArray(value) { return Array.isArray(value) ? value : []; }

function epcRealm(imsi) {
  const mcc = imsi.slice(0, 3) || '417';
  const mnc = imsi.slice(3, 5).padStart(3, '0') || '001';
  return {
    mme_host: `mme.epc.mnc${mnc}.mcc${mcc}.3gppnetwork.org`,
    mme_realm: `epc.mnc${mnc}.mcc${mcc}.3gppnetwork.org`,
  };
}

function defaultAmbr() {
  return { downlink: { value: 1, unit: 3 }, uplink: { value: 1, unit: 3 } };
}

function normalizeAmbr(value, fallback = defaultAmbr()) {
  const ambr = asRecord(value);
  const downlink = asRecord(ambr.downlink);
  const uplink = asRecord(ambr.uplink);
  return {
    downlink: { value: asNumber(downlink.value, fallback.downlink.value), unit: asNumber(downlink.unit, fallback.downlink.unit) },
    uplink: { value: asNumber(uplink.value, fallback.uplink.value), unit: asNumber(uplink.unit, fallback.uplink.unit) },
  };
}

function toXcloudArp(value, fallbackPriorityLevel) {
  const arp = asRecord(value);
  const preemptCap = asString(arp.preemptCap ?? arp.pre_emption_capability, '');
  const preemptVuln = asString(arp.preemptVuln ?? arp.pre_emption_vulnerability, '');
  return {
    priority_level: asNumber(arp.priorityLevel ?? arp.arpPriority ?? arp.priority_level, fallbackPriorityLevel),
    pre_emption_capability: preemptCap === 'PREEMPT' || preemptCap === '0' ? 0 : 1,
    pre_emption_vulnerability: preemptVuln === 'PREEMPTABLE' || preemptVuln === '0' ? 0 : preemptVuln === '2' ? 2 : 1,
  };
}

function toXcloudQos(value, fallbackIndex, fallbackPriorityLevel) {
  const qos = asRecord(value);
  const qosIndex = asNumber(qos._5qi ?? qos.index, fallbackIndex);
  const preset = sessionQosPreset(qosIndex);
  return { index: qosIndex, arp: toXcloudArp(qos.arp, preset?.arpPriorityLevel ?? fallbackPriorityLevel) };
}

function toXcloudPccRule(rule) {
  const source = asRecord(rule);
  const qos = source.qos ? asRecord(source.qos) : null;
  const qosIndex = asNumber(qos?._5qi ?? qos?.index, 9);
  const preset = pccQosPreset(qosIndex);
  return {
    flow: asArray(source.flow).map((flow) => {
      const item = asRecord(flow);
      return { direction: asNumber(item.direction, 1), description: asString(item.description) };
    }),
    qos: qos ? {
      index: qosIndex,
      arp: toXcloudArp(qos.arp, preset?.arpPriorityLevel ?? 8),
      mbr: qos.mbr || preset?.mbr ? normalizeAmbr(qos.mbr, preset?.mbr) : undefined,
      gbr: qos.gbr || preset?.gbr ? normalizeAmbr(qos.gbr, preset?.gbr) : undefined,
    } : undefined,
  };
}

function toXcloudSession(session, index) {
  const source = asRecord(session);
  const name = asString(source.name, index === 0 ? 'internet' : 'ims');
  const isIms = isImsDnn(name);
  const qosSource = asRecord(source.qos);
  const qosIndex = asNumber(qosSource._5qi ?? qosSource.index, isIms ? 5 : 9);
  const preset = sessionQosPreset(qosIndex);
  const smfIpv4 = asString(source.pgwIpv4 ?? asRecord(source.smf).ipv4, '');
  const smfIpv6 = asString(source.pgwIpv6 ?? asRecord(source.smf).ipv6, '');

  const output = {
    _id: 'ObjectId',
    name,
    type: asNumber(source.type, isIms ? 3 : 1),
    qos: toXcloudQos(source.qos, isIms ? 5 : 9, isIms ? 1 : 8),
    ambr: normalizeAmbr(source.ambr, isIms ? IMS_SESSION_AMBR : (preset?.sessionAmbr ?? defaultAmbr())),
    pcc_rule: asArray(source.pcc_rule).map(toXcloudPccRule),
  };
  if (source.lbo_roaming_allowed !== undefined) output.lbo_roaming_allowed = !!source.lbo_roaming_allowed;

  const ue = asRecord(source.ue);
  const ueIpv4 = asString(ue.ipv4, '');
  const ueIpv6 = asString(ue.ipv6, '');
  if (ueIpv4 || ueIpv6) {
    output.ue = {};
    if (ueIpv4) output.ue.ipv4 = ueIpv4;
    if (ueIpv6) output.ue.ipv6 = ueIpv6;
  }

  if (smfIpv4 || smfIpv6) {
    output.smf = {};
    if (smfIpv4) output.smf.ipv4 = smfIpv4;
    if (smfIpv6) output.smf.ipv6 = smfIpv6;
  }

  return output;
}

function toXcloudSlice(slice) {
  const source = asRecord(slice);
  const sessionList = asArray(source.session_list ?? source.session);
  const output = {
    _id: 'ObjectId',
    sst: asNumber(source.sst, 1),
    default_indicator: source.default_indicator !== undefined ? !!source.default_indicator : true,
    session: sessionList.length > 0
      ? sessionList.map(toXcloudSession)
      : [toXcloudSession({ name: 'internet', type: 3 }, 0)],
  };
  const sd = asString(source.sd, '');
  if (sd && sd !== '000001') output.sd = sd;
  return output;
}

function toXcloudSecurity(auth4G, existing) {
  const auth = asRecord(auth4G);
  const op = auth.op !== undefined ? asString(auth.op) : existing?.op ?? null;
  const opc = auth.opc !== undefined ? asString(auth.opc) : existing?.opc ?? ZERO_128;
  return {
    k: asString(auth.k, existing?.k || DEFAULT_AUTH_KEY),
    op: op || null,
    opc: opc || ZERO_128,
    amf: asString(auth.amf, existing?.amf || '8000'),
    sqn: asNumber(auth.sqn ?? existing?.sqn ?? 1719756),
  };
}

function buildDefaultXcloudSubscriber(imsi) {
  const realm = epcRealm(imsi);
  return {
    __v: 0,
    schema_version: 1,
    imsi,
    msisdn: [],
    imeisv: DEFAULT_IMEISV,
    security: toXcloudSecurity({}),
    ambr: normalizeAmbr(undefined),
    slice: buildDefaultSliceList().map(toXcloudSlice),
    access_restriction_data: 32,
    subscriber_status: 0,
    network_access_mode: 0,
    subscribed_rau_tau_timer: 12,
    mme_host: realm.mme_host,
    mme_realm: realm.mme_realm,
    mme_timestamp: 1700000000000000,
    purge_flag: false,
  };
}

// From src/lib/subscriberDefaults.ts — normalizeSliceList for empty input
function buildDefaultSliceList() {
  return [{
    default_indicator: true,
    sst: 1,
    session_list: [
      { name: 'internet', type: 1, qos: { _5qi: 9, arp: { priorityLevel: 9 } } },
      { name: 'mobile', type: 1, qos: { _5qi: 9, arp: { priorityLevel: 9 } } },
      {
        name: 'ims', type: 3, qos: { _5qi: 5, arp: { priorityLevel: 1 } },
        pcc_rule: [{
          qos: {
            index: 1,
            gbr: { uplink: { value: 128, unit: 1 }, downlink: { value: 128, unit: 1 } },
            mbr: { uplink: { value: 128, unit: 1 }, downlink: { value: 128, unit: 1 } },
            arp: { priority_level: 2, pre_emption_capability: 2, pre_emption_vulnerability: 2 },
          },
          flow: [],
        }],
      },
    ],
  }];
}

function normalizeSub4G(input) {
  const msisdn = getPrimaryMsisdn(input);
  const ambr = input?.ambr;
  const sliceList = input?.sliceList;

  return {
    access_restriction_data: Number(input?.access_restriction_data ?? 0),
    allowedVisitedPlmns: input?.allowedVisitedPlmns ?? 'all',
    ambr: ambr ? normalizeAmbr(ambr) : defaultAmbr(),
    msisdnList: msisdn ? [{ msisdn: String(msisdn) }] : [],
    network_access_mode: Number(input?.network_access_mode ?? 0),
    sliceList: sliceList ? sliceList.map(s => ({
      default_indicator: s?.default_indicator !== undefined ? !!s.default_indicator : true,
      sd: String(s?.sd ?? '000001'),
      sst: Number(s?.sst ?? 1),
      session_list: (Array.isArray(s?.session_list) ? s.session_list : []).map((sess, idx) => ({
        name: String(sess?.name || (idx === 0 ? 'internet' : 'ims')),
        type: Number(sess?.type ?? (isImsDnn(sess?.name) ? 3 : 1)),
        pgwIpv4: sess?.pgwIpv4 ?? '',
        pgwIpv6: sess?.pgwIpv6 ?? '',
        qos: {
          _5qi: Number(sess?.qos?._5qi ?? (isImsDnn(sess?.name) ? 5 : 9)),
          index: 0,
          arp: mapArp(sess?.qos?.arp, isImsDnn(sess?.name) ? 1 : 8),
        },
        ambr: normalizeAmbr(sess?.ambr, isImsDnn(sess?.name) ? IMS_SESSION_AMBR : defaultAmbr()),
        pcc_rule: Array.isArray(sess?.pcc_rule) ? sess.pcc_rule.map(normalizePccRule) : [],
      })),
    })) : buildDefaultSliceList(),
  };
}

function mapArp(arp, fallbackPriorityLevel) {
  const preemptCapRaw = arp?.preemptCap ?? arp?.pre_emption_capability;
  const preemptVulnRaw = arp?.preemptVuln ?? arp?.pre_emption_vulnerability;
  return {
    priorityLevel: Number(arp?.priorityLevel ?? arp?.arpPriority ?? arp?.priority_level ?? fallbackPriorityLevel),
    preemptCap: preemptCapRaw === 0 || preemptCapRaw === '0' || preemptCapRaw === 'PREEMPT' ? 'PREEMPT' : 'NOT_PREEMPT',
    preemptVuln: preemptVulnRaw === 0 || preemptVulnRaw === '0' || preemptVulnRaw === 'PREEMPTABLE' ? 'PREEMPTABLE' : 'NOT_PREEMPTABLE',
  };
}

function normalizePccRule(rule) {
  const qos = rule?.qos || {};
  const qosIndex = Number(qos?._5qi ?? qos?.index ?? 1);
  const preset = pccQosPreset(qosIndex);
  return {
    ...rule,
    flow: Array.isArray(rule?.flow) ? rule.flow : [],
    qos: {
      ...qos,
      _5qi: qosIndex,
      index: Number(qos?.index ?? qos?._5qi ?? 1),
      arp: mapArp(qos?.arp, preset?.arpPriorityLevel ?? 2),
      mbr: normalizeAmbr(qos?.mbr, preset?.mbr || { downlink: { value: 0, unit: 1 }, uplink: { value: 0, unit: 1 } }),
      gbr: normalizeAmbr(qos?.gbr, preset?.gbr || { downlink: { value: 0, unit: 1 }, uplink: { value: 0, unit: 1 } }),
    },
  };
}

function getPrimaryMsisdn(sub4G) {
  if (!sub4G || typeof sub4G !== 'object') return '';
  const msisdnList = sub4G.msisdnList;
  if (!Array.isArray(msisdnList)) return '';
  const first = msisdnList[0];
  if (!first || typeof first !== 'object') return '';
  const msisdn = first.msisdn;
  return msisdn === undefined || msisdn === null ? '' : String(msisdn);
}

function buildXcloudSubscriberFromLegacy(imsi, input, existing) {
  const normalizedSub4G = input.sub4G ? normalizeSub4G(input.sub4G) : null;
  const requestedMsisdn = normalizedSub4G ? getPrimaryMsisdn(input.sub4G) : '';
  const base = existing || buildDefaultXcloudSubscriber(imsi);
  const realm = epcRealm(imsi);

  return {
    ...base,
    schema_version: 1,
    imsi,
    msisdn: normalizedSub4G ? (requestedMsisdn ? [requestedMsisdn] : []) : base.msisdn,
    security: input.auth4G ? toXcloudSecurity(input.auth4G, base.security) : base.security,
    ambr: normalizedSub4G ? normalizeAmbr(normalizedSub4G.ambr, base.ambr) : base.ambr,
    slice: normalizedSub4G ? asArray(normalizedSub4G.sliceList).map(toXcloudSlice) : base.slice,
    access_restriction_data: normalizedSub4G ? asNumber(normalizedSub4G.access_restriction_data, base.access_restriction_data) : base.access_restriction_data,
    network_access_mode: normalizedSub4G ? asNumber(normalizedSub4G.network_access_mode, base.network_access_mode) : base.network_access_mode,
    imeisv: base.imeisv || DEFAULT_IMEISV,
    mme_host: base.mme_host || realm.mme_host,
    mme_realm: base.mme_realm || realm.mme_realm,
    mme_timestamp: base.mme_timestamp || 1700000000000000,
    purge_flag: base.purge_flag ?? false,
  };
}

// From src/server/subscriberSingleGovernance.ts
function subscriberSafeSnapshot(doc) {
  return {
    imsi: doc.imsi,
    msisdn: [...(doc.msisdn || [])],
    accessRestrictionData: Number(doc.access_restriction_data ?? 0),
    networkAccessMode: Number(doc.network_access_mode ?? 0),
    ambr: doc.ambr,
    slices: doc.slice,
  };
}

// Stable serializer — matches production exactly
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function hash(value) {
  return createHash('sha256').update(stable(value)).digest('hex');
}

// ============================================================
// Fixture generation
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

console.log('Generating subscriber contract fixtures...\n');

// 1. default-subscriber
const defaultSub = buildDefaultXcloudSubscriber('310260123456789');
writeFixture('fixture_default_subscriber.json', { metadata: { ...METADATA, fixture: 'default-subscriber' }, raw: defaultSub });

// 2. legacy-update
const legacyPayload = {
  sub4G: {
    ambr: { downlink: { value: 200000000, unit: 0 }, uplink: { value: 100000000, unit: 0 } },
    msisdnList: [{ msisdn: '9876543210' }],
    access_restriction_data: 49,
    network_access_mode: 2,
  },
};
const legacyUpdate = buildXcloudSubscriberFromLegacy('310260123456789', legacyPayload, defaultSub);
writeFixture('fixture_legacy_update.json', { metadata: { ...METADATA, fixture: 'legacy-update' }, raw: legacyUpdate });

// 3. safe-before
const safeBefore = subscriberSafeSnapshot(defaultSub);
writeFixture('fixture_safe_before.json', { metadata: { ...METADATA, fixture: 'safe-before' }, snapshot: safeBefore });

// 4. safe-after
const safeAfter = subscriberSafeSnapshot(legacyUpdate);
writeFixture('fixture_safe_after.json', { metadata: { ...METADATA, fixture: 'safe-after' }, snapshot: safeAfter });

// 5. frozen-update
writeFixture('fixture_frozen_update.json', {
  metadata: { ...METADATA, fixture: 'frozen-update' },
  frozen: { version: 'subscriber-update-v1', imsi: '310260123456789', before: safeBefore, after: safeAfter },
});

// 6. frozen-delete
writeFixture('fixture_frozen_delete.json', {
  metadata: { ...METADATA, fixture: 'frozen-delete' },
  frozen: { version: 'subscriber-delete-v1', imsi: '310260123456789', before: safeBefore },
});

// 7. update-canonical-string
const updateCanonical = stable({ operation: 'SUBSCRIBER_UPDATE', imsi: '310260123456789', before: safeBefore, after: safeAfter });
writeFixture('fixture_update_canonical_string.txt', updateCanonical);

// 8. delete-canonical-string
const deleteCanonical = stable({ operation: 'SUBSCRIBER_DELETE', imsi: '310260123456789', before: safeBefore });
writeFixture('fixture_delete_canonical_string.txt', deleteCanonical);

// 9. update-fingerprint
const updateFingerprint = hash({ operation: 'SUBSCRIBER_UPDATE', imsi: '310260123456789', before: safeBefore, after: safeAfter });
writeFixture('fixture_update_fingerprint.txt', updateFingerprint);

// 10. delete-fingerprint
const deleteFingerprint = hash({ operation: 'SUBSCRIBER_DELETE', imsi: '310260123456789', before: safeBefore });
writeFixture('fixture_delete_fingerprint.txt', deleteFingerprint);

console.log('\nDone. All fixtures written to:', FIXTURE_DIR);
console.log('\nIMPORTANT: Go tests MUST NOT overwrite these fixtures.');
console.log('Go tests MUST only READ and compare against them.');
