/*
 * Pure comparison between a stored profile snapshot and the current profile.
 * Every human-readable fragment is supplied by the caller so the panel renders
 * only values the two documents actually contain.
 */
import { formatBytes, formatEvents } from '../../lib/unitParser';
import { formatAmbrSide } from './profile-format';
import { isWithheldPlaceholder } from '../../types/credential';

export type ProfileDiffLabels = {
  notConfigured: string;
  sliceUnit: string;
  sessionUnit: string;
  pccUnit: string;
  accessNone: string;
  accessSuspended: string;
  maskedSecret: string;
  withheld: string;
};

export type ProfileDiffRow = {
  key: string;
  labelKey: string;
  labelParams?: Record<string, string | number>;
  versionValue: string;
  currentValue: string;
  changed: boolean;
};

export type ProfileDiffSection = {
  key: string;
  labelKey: string;
  changed: boolean;
  changedRows: number;
  rows: ProfileDiffRow[];
};

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): UnknownRecord {
  return isRecord(value) ? value : {};
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function toText(value: unknown, fallback: string): string {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? fallback : trimmed;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return fallback;
}

function formatByteValue(value: unknown, fallback: string): string {
  const bytes = toNumber(value);
  return bytes === null ? fallback : formatBytes(bytes);
}

function formatEventValue(value: unknown, fallback: string): string {
  const events = toNumber(value);
  return events === null ? fallback : formatEvents(events);
}

/*
 * A reader who may not see credential material gets no value at all, only the
 * stated condition of each key. The comparison therefore works on the condition
 * for withheld material and on a shortened form of the value when the reader can
 * see it — never on a placeholder string that could be mistaken for a key.
 */
function credentialCell(auth: unknown, field: 'k' | 'op' | 'opc', labels: ProfileDiffLabels): string {
  const record = asRecord(auth);
  const state = asRecord(record.credentialState);
  const value = typeof record[field] === 'string' ? record[field] as string : '';
  if (isWithheldPlaceholder(value)) return labels.withheld;
  if (state.visibility === 'masked') {
    return state[field] === 'configured' ? labels.withheld : labels.notConfigured;
  }
  const secret = value.trim();
  if (secret === '') return labels.notConfigured;
  if (secret.length <= 8) return `${labels.maskedSecret}${secret.slice(-2)}`;
  return `${secret.slice(0, 4)}…${secret.slice(-4)}`;
}

function formatAccess(value: unknown, labels: ProfileDiffLabels): string {
  const raw = toNumber(value);
  if (raw === null) return labels.notConfigured;
  if (raw === 0) return labels.accessNone;
  if (raw === 255) return labels.accessSuspended;
  return String(raw);
}

function describeSlice(slice: unknown, labels: ProfileDiffLabels): string {
  const record = asRecord(slice);
  const sst = toNumber(record.sst);
  const sd = typeof record.sd === 'string' ? record.sd : '';
  const sessions = Array.isArray(record.session_list) ? record.session_list : [];
  const pccRules = sessions.reduce((total, session) => {
    const rules = asRecord(session).pcc_rule;
    return total + (Array.isArray(rules) ? rules.length : 0);
  }, 0);
  const nssai = [
    sst === null ? '' : `SST ${sst}`,
    sd && sd !== '000000' ? `SD ${sd}` : '',
  ].filter(Boolean).join(' / ');
  return `${nssai || '—'} · ${sessions.length} ${labels.sessionUnit} · ${pccRules} ${labels.pccUnit}`;
}

function buildRow(
  key: string,
  labelKey: string,
  versionValue: string,
  currentValue: string,
  labelParams?: Record<string, string | number>,
): ProfileDiffRow {
  return { key, labelKey, labelParams, versionValue, currentValue, changed: versionValue !== currentValue };
}

export function buildProfileVersionDiff(
  versionProfile: unknown,
  currentProfile: unknown,
  labels: ProfileDiffLabels,
): ProfileDiffSection[] {
  const version = asRecord(versionProfile);
  const current = asRecord(currentProfile);
  const sections: ProfileDiffSection[] = [];

  const push = (key: string, labelKey: string, rows: ProfileDiffRow[]) => {
    sections.push({
      key,
      labelKey,
      changed: rows.some((row) => row.changed),
      changedRows: rows.filter((row) => row.changed).length,
      rows,
    });
  };

  push('title', 'prof_title', [
    buildRow('title', 'prof_title', toText(version.title, labels.notConfigured), toText(current.title, labels.notConfigured)),
  ]);

  const versionAuth = asRecord(version.auth);
  const currentAuth = asRecord(current.auth);
  push('auth', 'sec_security_auth', [
    buildRow('k', 'prof_diff_k', credentialCell(version.auth, 'k', labels), credentialCell(current.auth, 'k', labels)),
    buildRow('opc', 'prof_diff_opc', credentialCell(version.auth, 'opc', labels), credentialCell(current.auth, 'opc', labels)),
    buildRow('op', 'prof_diff_op', credentialCell(version.auth, 'op', labels), credentialCell(current.auth, 'op', labels)),
    buildRow('amf', 'prof_diff_amf', toText(versionAuth.amf, labels.notConfigured), toText(currentAuth.amf, labels.notConfigured)),
  ]);

  const versionOcs = asRecord(version.ocsDefaults);
  const currentOcs = asRecord(current.ocsDefaults);
  const plan = (ocs: UnknownRecord) => toText(ocs.planId ?? ocs.plan_id ?? ocs.planID, labels.notConfigured);
  push('ocsDefaults', 'sec_billing_config', [
    buildRow('planId', 'prof_diff_plan', plan(versionOcs), plan(currentOcs)),
    buildRow('trafficTotal', 'prof_diff_traffic_total', formatByteValue(versionOcs.trafficTotal, labels.notConfigured), formatByteValue(currentOcs.trafficTotal, labels.notConfigured)),
    buildRow('trafficBalance', 'prof_diff_traffic_balance', formatByteValue(versionOcs.trafficBalance, labels.notConfigured), formatByteValue(currentOcs.trafficBalance, labels.notConfigured)),
    buildRow('smsTotal', 'prof_diff_sms_total', formatEventValue(versionOcs.smsTotal, labels.notConfigured), formatEventValue(currentOcs.smsTotal, labels.notConfigured)),
    buildRow('smsBalance', 'prof_diff_sms_balance', formatEventValue(versionOcs.smsBalance, labels.notConfigured), formatEventValue(currentOcs.smsBalance, labels.notConfigured)),
  ]);

  const versionAmbr = asRecord(version.ambr);
  const currentAmbr = asRecord(current.ambr);
  push('ambr', 'sec_global_network', [
    buildRow('downlink', 'prof_diff_ambr_dl', formatAmbrSide(versionAmbr.downlink, labels.notConfigured), formatAmbrSide(currentAmbr.downlink, labels.notConfigured)),
    buildRow('uplink', 'prof_diff_ambr_ul', formatAmbrSide(versionAmbr.uplink, labels.notConfigured), formatAmbrSide(currentAmbr.uplink, labels.notConfigured)),
  ]);

  push('access_restriction_data', 'sec_access_restrict', [
    buildRow('access', 'prof_diff_access', formatAccess(version.access_restriction_data, labels), formatAccess(current.access_restriction_data, labels)),
  ]);

  const versionSlices = Array.isArray(version.sliceList) ? version.sliceList : [];
  const currentSlices = Array.isArray(current.sliceList) ? current.sliceList : [];
  const sliceRows: ProfileDiffRow[] = [
    buildRow('sliceCount', 'prof_diff_slice_count', `${versionSlices.length} ${labels.sliceUnit}`, `${currentSlices.length} ${labels.sliceUnit}`),
  ];
  const sliceTotal = Math.max(versionSlices.length, currentSlices.length);
  for (let index = 0; index < sliceTotal; index += 1) {
    sliceRows.push(buildRow(
      `slice-${index}`,
      'prof_diff_slice_row',
      index < versionSlices.length ? describeSlice(versionSlices[index], labels) : labels.notConfigured,
      index < currentSlices.length ? describeSlice(currentSlices[index], labels) : labels.notConfigured,
      { index: index + 1 },
    ));
  }
  push('sliceList', 'prof_sec_slices', sliceRows);

  return sections;
}
