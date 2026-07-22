import { Long, ObjectId } from 'mongodb';
import { buildDefaultSub4G, normalizeSub4G } from '@/lib/subscriberDefaults';
import type {
  LegacySubscriberState,
  Open5gsAmbr,
  Open5gsArp,
  Open5gsPccRule,
  Open5gsQos,
  Open5gsSecurity,
  Open5gsSession,
  Open5gsSlice,
  Open5gsSubscriberDocument,
} from '@/types/xcloud';

type UnknownRecord = Record<string, unknown>;

const ZERO_128 = '00000000000000000000000000000000';
const DEFAULT_AUTH_KEY = '000102030405060708090A0B0C0D0E0F';
const DEFAULT_IMEISV = '8672710677532401';

function asRecord(value: unknown): UnknownRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : {};
}

function asString(value: unknown, fallback = ''): string {
  if (value === undefined || value === null) return fallback;
  return String(value);
}

function asNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function asArray<T = unknown>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : [];
}

function longToNumber(value: unknown): number {
  if (Long.isLong(value)) return value.toNumber();
  return asNumber(value, 0);
}

function toLong(value: unknown): Long {
  return Long.fromNumber(asNumber(value, 1));
}

function epcRealm(imsi: string) {
  const mcc = imsi.slice(0, 3) || '417';
  const mnc = imsi.slice(3, 5).padStart(3, '0') || '001';
  return {
    mme_host: `mme.epc.mnc${mnc}.mcc${mcc}.3gppnetwork.org`,
    mme_realm: `epc.mnc${mnc}.mcc${mcc}.3gppnetwork.org`,
  };
}

function normalizeAmbr(value: unknown, fallback: Open5gsAmbr = defaultAmbr()): Open5gsAmbr {
  const ambr = asRecord(value);
  const downlink = asRecord(ambr.downlink);
  const uplink = asRecord(ambr.uplink);

  return {
    downlink: {
      value: asNumber(downlink.value, fallback.downlink.value),
      unit: asNumber(downlink.unit, fallback.downlink.unit),
    },
    uplink: {
      value: asNumber(uplink.value, fallback.uplink.value),
      unit: asNumber(uplink.unit, fallback.uplink.unit),
    },
  };
}

function defaultAmbr(): Open5gsAmbr {
  return {
    downlink: { value: 1, unit: 3 },
    uplink: { value: 1, unit: 3 },
  };
}

function toOpen5gsArp(value: unknown, fallbackPriorityLevel: number): Open5gsArp {
  const arp = asRecord(value);
  const preemptCap = asString(arp.preemptCap ?? arp.pre_emption_capability, '');
  const preemptVuln = asString(arp.preemptVuln ?? arp.pre_emption_vulnerability, '');

  return {
    priority_level: asNumber(arp.priorityLevel ?? arp.arpPriority ?? arp.priority_level, fallbackPriorityLevel),
    pre_emption_capability: preemptCap === 'PREEMPT' || preemptCap === '0' ? 0 : 1,
    pre_emption_vulnerability: preemptVuln === 'PREEMPTABLE' || preemptVuln === '0'
      ? 0
      : preemptVuln === '2'
        ? 2
        : 1,
  };
}

function toLegacyArp(value: unknown, fallbackPriorityLevel: number) {
  const arp = asRecord(value);
  const cap = asNumber(arp.pre_emption_capability, 1);
  const vuln = asNumber(arp.pre_emption_vulnerability, 2);

  return {
    priorityLevel: asNumber(arp.priority_level, fallbackPriorityLevel),
    preemptCap: cap === 0 ? 'PREEMPT' : 'NOT_PREEMPT',
    preemptVuln: vuln === 0 ? 'PREEMPTABLE' : 'NOT_PREEMPTABLE',
  };
}

function toOpen5gsQos(value: unknown, fallbackIndex: number, fallbackPriorityLevel: number): Open5gsQos {
  const qos = asRecord(value);
  return {
    index: asNumber(qos._5qi ?? qos.index, fallbackIndex),
    arp: toOpen5gsArp(qos.arp, fallbackPriorityLevel),
  };
}

function toOpen5gsPccRule(rule: unknown): Open5gsPccRule {
  const source = asRecord(rule);
  const qos = source.qos ? asRecord(source.qos) : null;

  return {
    flow: asArray(source.flow).map((flow) => {
      const item = asRecord(flow);
      return {
        direction: asNumber(item.direction, 1),
        description: asString(item.description),
      };
    }),
    qos: qos
      ? {
          index: asNumber(qos._5qi ?? qos.index, 9),
          arp: toOpen5gsArp(qos.arp, 8),
          mbr: qos.mbr ? normalizeAmbr(qos.mbr) : undefined,
          gbr: qos.gbr ? normalizeAmbr(qos.gbr) : undefined,
        }
      : undefined,
  };
}

function toOpen5gsSession(session: unknown, index: number): Open5gsSession {
  const source = asRecord(session);
  const name = asString(source.name, index === 0 ? 'internet' : 'ims');
  const isIms = name === 'ims';
  const smfIpv4 = asString(source.pgwIpv4 ?? asRecord(source.smf).ipv4, '');
  const smfIpv6 = asString(source.pgwIpv6 ?? asRecord(source.smf).ipv6, '');

  const output: Open5gsSession = {
    _id: new ObjectId(),
    name,
    type: asNumber(source.type, isIms ? 3 : 1),
    qos: toOpen5gsQos(source.qos, isIms ? 5 : 9, isIms ? 1 : 8),
    ambr: normalizeAmbr(source.ambr),
    pcc_rule: asArray(source.pcc_rule).map(toOpen5gsPccRule),
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

function toOpen5gsSlice(slice: unknown): Open5gsSlice {
  const source = asRecord(slice);
  const sessionList = asArray(source.session_list ?? source.session);

  const output: Open5gsSlice = {
    _id: new ObjectId(),
    sst: asNumber(source.sst, 1),
    default_indicator: source.default_indicator !== undefined ? !!source.default_indicator : true,
    session: sessionList.length > 0
      ? sessionList.map(toOpen5gsSession)
      : [toOpen5gsSession({ name: 'internet', type: 3 }, 0)],
  };
  const sd = asString(source.sd, '');
  if (sd && sd !== '000001') output.sd = sd;
  return output;
}

function toOpen5gsSecurity(auth4G: unknown, existing?: Open5gsSecurity): Open5gsSecurity {
  const auth = asRecord(auth4G);
  const op = auth.op !== undefined ? asString(auth.op) : existing?.op ?? null;
  const opc = auth.opc !== undefined ? asString(auth.opc) : existing?.opc ?? ZERO_128;
  const output: Open5gsSecurity = {
    k: asString(auth.k, existing?.k || DEFAULT_AUTH_KEY),
    op: op || null,
    opc: opc || DEFAULT_AUTH_KEY,
    amf: asString(auth.amf, existing?.amf || '8000'),
  };

  output.sqn = toLong(auth.sqn ?? existing?.sqn ?? 1719756);
  return output;
}

export function buildDefaultOpen5gsSubscriber(imsi: string, profileData?: unknown): Open5gsSubscriberDocument {
  const sub4G = buildDefaultSub4G('', profileData);
  const realm = epcRealm(imsi);

  return {
    __v: 0,
    schema_version: 1,
    imsi,
    msisdn: [],
    imeisv: DEFAULT_IMEISV,
    security: toOpen5gsSecurity({}),
    ambr: normalizeAmbr(sub4G.ambr),
    slice: asArray(sub4G.sliceList).map(toOpen5gsSlice),
    access_restriction_data: 32,
    subscriber_status: 0,
    network_access_mode: 0,
    subscribed_rau_tau_timer: 12,
    mme_host: realm.mme_host,
    mme_realm: realm.mme_realm,
    mme_timestamp: Date.now() * 1000,
    purge_flag: false,
  };
}

export function buildOpen5gsSubscriberFromLegacy(
  imsi: string,
  input: {
    sub4G?: unknown;
    auth4G?: unknown;
    ocsTraffic?: unknown;
  },
  existing?: Open5gsSubscriberDocument | null
): Open5gsSubscriberDocument {
  const normalizedSub4G = input.sub4G ? normalizeSub4G(input.sub4G) : null;
  const base = existing || buildDefaultOpen5gsSubscriber(imsi);
  const realm = epcRealm(imsi);

  return {
    ...base,
    schema_version: 1,
    imsi,
    msisdn: [],
    security: input.auth4G ? toOpen5gsSecurity(input.auth4G, base.security) : base.security,
    ambr: normalizedSub4G ? normalizeAmbr(normalizedSub4G.ambr, base.ambr) : base.ambr,
    slice: normalizedSub4G ? asArray(normalizedSub4G.sliceList).map(toOpen5gsSlice) : base.slice,
    access_restriction_data: normalizedSub4G
      ? asNumber(normalizedSub4G.access_restriction_data, base.access_restriction_data)
      : base.access_restriction_data,
    network_access_mode: normalizedSub4G
      ? asNumber(normalizedSub4G.network_access_mode, base.network_access_mode)
      : base.network_access_mode,
    imeisv: base.imeisv || DEFAULT_IMEISV,
    mme_host: base.mme_host || realm.mme_host,
    mme_realm: base.mme_realm || realm.mme_realm,
    mme_timestamp: base.mme_timestamp || Date.now() * 1000,
    purge_flag: base.purge_flag ?? false,
  };
}

function legacySession(session: Open5gsSession, index: number) {
  const name = session.name || (index === 0 ? 'internet' : 'ims');
  const isIms = name === 'ims';

  return {
    name,
    type: session.type ?? (isIms ? 3 : 1),
    pgwIpv4: session.smf?.ipv4 || '',
    pgwIpv6: session.smf?.ipv6 || '',
    qos: {
      _5qi: session.qos?.index ?? (isIms ? 5 : 9),
      index: 0,
      arp: toLegacyArp(session.qos?.arp, isIms ? 1 : 8),
    },
    ambr: normalizeAmbr(session.ambr),
    pcc_rule: (session.pcc_rule || []).map(legacyPccRule),
  };
}

function legacyPccRule(rule: Open5gsPccRule) {
  const qos = rule.qos;

  return {
    ...rule,
    flow: rule.flow || [],
    qos: qos
      ? {
          _5qi: qos.index ?? 1,
          index: qos.index ?? 1,
          arp: toLegacyArp(qos.arp, 2),
          mbr: qos.mbr ? normalizeAmbr(qos.mbr) : undefined,
          gbr: qos.gbr ? normalizeAmbr(qos.gbr) : undefined,
        }
      : undefined,
  };
}

export function open5gsToLegacyState(doc: Open5gsSubscriberDocument | null): LegacySubscriberState | null {
  if (!doc) return null;

  const sub4G = {
    access_restriction_data: doc.access_restriction_data ?? 32,
    allowedVisitedPlmns: 'all',
    ambr: normalizeAmbr(doc.ambr),
    msisdnList: (doc.msisdn || []).map((msisdn) => ({ msisdn })),
    network_access_mode: doc.network_access_mode ?? 0,
    profile_name: doc.webui_meta?.profile_name || '',
    sliceList: (doc.slice || []).map((slice) => ({
      default_indicator: slice.default_indicator !== undefined ? !!slice.default_indicator : true,
      sd: slice.sd || '000001',
      sst: slice.sst ?? 1,
      session_list: (slice.session || []).map(legacySession),
    })),
  };

  const auth4G = {
    k: doc.security?.k || '',
    op: doc.security?.op || undefined,
    opc: doc.security?.opc || undefined,
    sqn: longToNumber(doc.security?.sqn),
    amf: doc.security?.amf || '8000',
  };

  return {
    sub4G,
    pcrf4G: { sliceList: sub4G.sliceList },
    auth4G,
    ocsImsi: null,
    ocsTraffic: null,
  };
}
