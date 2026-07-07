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
  SubscriberOcsData,
} from '@/types/open5gs';

type UnknownRecord = Record<string, unknown>;

const ZERO_128 = '00000000000000000000000000000000';
const DEFAULT_PLMN = '45400';

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
    pre_emption_vulnerability: preemptVuln === 'PREEMPTABLE' || preemptVuln === '0' ? 0 : 2,
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
    lbo_roaming_allowed: !!source.lbo_roaming_allowed,
  };

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

  return {
    _id: new ObjectId(),
    sst: asNumber(source.sst, 1),
    sd: asString(source.sd, '000001'),
    default_indicator: source.default_indicator !== undefined ? !!source.default_indicator : true,
    session: sessionList.length > 0
      ? sessionList.map(toOpen5gsSession)
      : [toOpen5gsSession({ name: 'internet', type: 3 }, 0)],
  };
}

function toOpen5gsSecurity(auth4G: unknown, existing?: Open5gsSecurity): Open5gsSecurity {
  const auth = asRecord(auth4G);
  const op = auth.op !== undefined ? asString(auth.op) : existing?.op ?? null;
  const opc = auth.opc !== undefined ? asString(auth.opc) : existing?.opc ?? ZERO_128;

  return {
    k: asString(auth.k, existing?.k || ZERO_128),
    op: op || null,
    opc: opc || null,
    amf: asString(auth.amf, existing?.amf || '8000'),
    sqn: toLong(auth.sqn ?? existing?.sqn ?? 1),
  };
}

function defaultOcs(imsi: string): SubscriberOcsData {
  return {
    traffic: {
      traffic_total: 0,
      traffic_balance: 0,
      imsi,
      plmn: DEFAULT_PLMN,
    },
    imsi: {
      account_id: imsi,
      imsi,
      withhold: 0,
      withholding_residue: 0,
      withholding_time: 3600,
    },
    account: {
      account_id: imsi,
      balance: '0',
      currency: 'USD',
    },
    rating: {
      rates_map: {},
      imsi,
    },
  };
}

function mergeOcs(imsi: string, existing: SubscriberOcsData | undefined, input: {
  ocsTraffic?: unknown;
  ocsImsi?: unknown;
  ocsImsiSet?: unknown;
  ocsAccount?: unknown;
}): SubscriberOcsData {
  const defaults = defaultOcs(imsi);
  const traffic = asRecord(input.ocsTraffic);
  const ocsImsi = asRecord(input.ocsImsi);
  const rating = asRecord(input.ocsImsiSet);
  const account = asRecord(input.ocsAccount);

  return {
    traffic: {
      ...defaults.traffic,
      ...existing?.traffic,
      ...traffic,
      imsi,
    },
    imsi: {
      ...defaults.imsi,
      ...existing?.imsi,
      ...ocsImsi,
      imsi,
      account_id: asString(ocsImsi.account_id ?? existing?.imsi?.account_id, imsi),
    },
    account: {
      ...defaults.account,
      ...existing?.account,
      ...account,
      account_id: asString(account.account_id ?? existing?.account?.account_id, imsi),
    },
    rating: {
      ...defaults.rating,
      ...existing?.rating,
      ...rating,
      imsi,
    },
  };
}

export function buildDefaultOpen5gsSubscriber(imsi: string, profileData?: unknown): Open5gsSubscriberDocument {
  const sub4G = buildDefaultSub4G('', profileData);
  const now = new Date();

  return {
    schema_version: 1,
    imsi,
    msisdn: asArray<{ msisdn?: unknown }>(sub4G.msisdnList).map((item) => asString(item.msisdn)).filter(Boolean),
    imeisv: [],
    mme_host: [],
    mme_realm: [],
    purge_flag: [],
    security: toOpen5gsSecurity({}),
    ambr: normalizeAmbr(sub4G.ambr),
    slice: asArray(sub4G.sliceList).map(toOpen5gsSlice),
    access_restriction_data: 32,
    subscriber_status: 0,
    operator_determined_barring: 0,
    network_access_mode: 0,
    subscribed_rau_tau_timer: 12,
    ocs: defaultOcs(imsi),
    webui_meta: {
      created_at: now,
      updated_at: now,
    },
    created_at: now,
    updated_at: now,
  };
}

export function buildOpen5gsSubscriberFromLegacy(
  imsi: string,
  input: {
    sub4G?: unknown;
    auth4G?: unknown;
    ocsTraffic?: unknown;
    ocsImsi?: unknown;
    ocsImsiSet?: unknown;
    ocsAccount?: unknown;
  },
  existing?: Open5gsSubscriberDocument | null
): Open5gsSubscriberDocument {
  const normalizedSub4G = input.sub4G ? normalizeSub4G(input.sub4G) : null;
  const now = new Date();
  const base = existing || buildDefaultOpen5gsSubscriber(imsi);
  const msisdn = normalizedSub4G
    ? asArray<{ msisdn?: unknown }>(normalizedSub4G.msisdnList).map((item) => asString(item.msisdn)).filter(Boolean)
    : base.msisdn || [];

  return {
    ...base,
    schema_version: 1,
    imsi,
    msisdn,
    security: input.auth4G ? toOpen5gsSecurity(input.auth4G, base.security) : base.security,
    ambr: normalizedSub4G ? normalizeAmbr(normalizedSub4G.ambr, base.ambr) : base.ambr,
    slice: normalizedSub4G ? asArray(normalizedSub4G.sliceList).map(toOpen5gsSlice) : base.slice,
    access_restriction_data: normalizedSub4G
      ? asNumber(normalizedSub4G.access_restriction_data, base.access_restriction_data)
      : base.access_restriction_data,
    network_access_mode: normalizedSub4G
      ? asNumber(normalizedSub4G.network_access_mode, base.network_access_mode)
      : base.network_access_mode,
    ocs: mergeOcs(imsi, base.ocs, input),
    webui_meta: {
      ...base.webui_meta,
      profile_name: asString(asRecord(input.sub4G).profile_name ?? base.webui_meta?.profile_name, ''),
      updated_at: now,
      created_at: base.webui_meta?.created_at || base.created_at || now,
    },
    created_at: base.created_at || now,
    updated_at: now,
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
    pcc_rule: session.pcc_rule || [],
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
    ocsImsi: doc.ocs?.imsi || null,
    ocsTraffic: doc.ocs?.traffic || null,
    ocsImsiSet: doc.ocs?.rating || null,
    ocsAccount: doc.ocs?.account || null,
  };
}
