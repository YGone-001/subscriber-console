/*
 * Draft state for a user template. Pure helpers so a stored profile maps to form
 * state, and back to a payload, without inventing values it does not carry.
 */
import { formatBytes, formatEvents, parseBytes, parseEvents } from '../../lib/unitParser';
import type { ProfileAmbrSide } from './profile-types';

export type { ProfileAmbrSide };

export type ProfileDraft = {
  title: string;
  auth: { k: string; opValue: string; amf: string };
  usimType: 'opc' | 'op';
  ueAmbr: { downlink: ProfileAmbrSide; uplink: ProfileAmbrSide };
  accessRestriction: number | null;
  slices: any[];
  ocsDefaults: Record<string, any>;
};

export const OCS_EDITABLE_KEYS = ['planId', 'trafficTotal', 'trafficBalance', 'smsTotal', 'smsBalance'] as const;

export const PROFILE_SECTION_FIELDS = [
  { key: 'title', labelKey: 'prof_title' },
  { key: 'auth', labelKey: 'sec_security_auth' },
  { key: 'ambr', labelKey: 'sec_global_network' },
  { key: 'ocsDefaults', labelKey: 'sec_billing_config' },
  { key: 'access_restriction_data', labelKey: 'sec_access_restrict' },
  { key: 'sliceList', labelKey: 'prof_sec_slices' },
] as const;

export function createEmptyDraft(): ProfileDraft {
  return {
    title: '',
    auth: { k: '', opValue: '', amf: '' },
    usimType: 'opc',
    /* The unit is part of the input pair the operator sees, so it is seeded
     * with the displayed default; the value stays absent until typed. */
    ueAmbr: { downlink: { unit: 2 }, uplink: { unit: 2 } },
    accessRestriction: null,
    slices: [],
    ocsDefaults: { planId: '', trafficTotal: '', trafficBalance: '', smsTotal: '', smsBalance: '' },
  };
}

export function createDraftFromProfile(profile: any, fallbackTitle: string): ProfileDraft {
  const draft = createEmptyDraft();
  if (!profile) return draft;

  draft.title = profile.title || fallbackTitle || '';

  if (profile.auth) {
    draft.usimType = profile.auth.op ? 'op' : 'opc';
    draft.auth = {
      k: profile.auth.k || '',
      opValue: profile.auth.opc || profile.auth.op || '',
      amf: profile.auth.amf || '',
    };
  }

  if (profile.ambr) {
    draft.ueAmbr = {
      downlink: { unit: 2, ...(profile.ambr.downlink || {}) },
      uplink: { unit: 2, ...(profile.ambr.uplink || {}) },
    };
  }

  if (Array.isArray(profile.sliceList)) draft.slices = profile.sliceList;

  if (profile.access_restriction_data !== undefined && profile.access_restriction_data !== null) {
    draft.accessRestriction = Number(profile.access_restriction_data);
  }

  if (profile.ocsDefaults) {
    const stored = profile.ocsDefaults;
    const smsTotal = stored.smsTotal ?? stored.sms_total;
    const smsBalance = stored.smsBalance ?? stored.sms_balance;
    const planId = stored.planId ?? stored.plan_id ?? stored.planID;
    draft.ocsDefaults = {
      ...stored,
      planId: planId !== undefined ? String(planId) : '',
      trafficTotal: stored.trafficTotal !== undefined
        ? formatBytes(Number(stored.trafficTotal))
        : (stored.trafficBalance !== undefined ? formatBytes(Number(stored.trafficBalance)) : ''),
      trafficBalance: stored.trafficBalance !== undefined ? formatBytes(Number(stored.trafficBalance)) : '',
      smsTotal: smsTotal !== undefined ? formatEvents(Number(smsTotal)) : '',
      smsBalance: smsBalance !== undefined ? formatEvents(Number(smsBalance)) : '',
    };
  }

  return draft;
}

export function buildOcsDefaultsPayload(ocs: Record<string, any>): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  /* Keep stored keys this form does not edit (voice, PLMN, ...). */
  for (const [key, value] of Object.entries(ocs)) {
    if (!(OCS_EDITABLE_KEYS as readonly string[]).includes(key)) payload[key] = value;
  }
  delete payload.plan_id;
  delete payload.planID;
  delete payload.sms_total;
  delete payload.sms_balance;

  const planId = String(ocs.planId ?? '').trim();
  if (planId) payload.planId = planId;
  const trafficTotal = String(ocs.trafficTotal ?? '').trim();
  if (trafficTotal) payload.trafficTotal = parseBytes(trafficTotal);
  const trafficBalance = String(ocs.trafficBalance ?? '').trim();
  if (trafficBalance) payload.trafficBalance = parseBytes(trafficBalance);
  const smsTotal = String(ocs.smsTotal ?? '').trim();
  if (smsTotal) payload.smsTotal = parseEvents(smsTotal);
  const smsBalance = String(ocs.smsBalance ?? '').trim();
  if (smsBalance) payload.smsBalance = parseEvents(smsBalance);
  return payload;
}

export function buildProfilePayload(
  draft: ProfileDraft,
  targetName: string,
  hasStoredOcsDefaults: boolean,
  /* A caller that cannot see the credential material must not write it back:
   * the stored auth block stays untouched because the endpoint merges only the
   * fields the body carries. */
  options: { includeAuth?: boolean } = {},
): Record<string, unknown> {
  const includeAuth = options.includeAuth !== false;
  const authPayload: Record<string, unknown> = { k: draft.auth.k, amf: draft.auth.amf };
  authPayload[draft.usimType] = draft.auth.opValue;

  const body: Record<string, unknown> = {
    title: draft.title || targetName,
    ambr: draft.ueAmbr,
    sliceList: draft.slices,
  };
  if (includeAuth) {
    body.auth = authPayload;
  }
  if (typeof draft.accessRestriction === 'number') {
    body.access_restriction_data = draft.accessRestriction;
  }

  const ocsPayload = buildOcsDefaultsPayload(draft.ocsDefaults);
  if (Object.keys(ocsPayload).length > 0) {
    body.ocsDefaults = ocsPayload;
  } else if (hasStoredOcsDefaults) {
    /* An explicit clear: the operator removed every billing default. */
    body.ocsDefaults = {};
  }
  return body;
}

export function draftSignature(draft: ProfileDraft): string {
  return JSON.stringify(draft);
}

/* Key order is not a change: the payload builder writes auth keys in a
 * different order than the stored document. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export function buildDraftChangeRows(
  payload: Record<string, unknown>,
  snapshot: any,
  /* Sections the write does not carry are not candidates for change: an omitted
   * auth block must not be reported as a difference the operator is about to make. */
  excludeKeys: readonly string[] = [],
): Array<{ key: string; labelKey: string; changed: boolean }> {
  const current = snapshot || {};
  return PROFILE_SECTION_FIELDS
    .filter((field) => !excludeKeys.includes(field.key))
    .map((field) => ({
      key: field.key,
      labelKey: field.labelKey,
      changed: stableStringify(current[field.key]) !== stableStringify(payload[field.key]),
    }));
}

export function buildProfileKeyFromTitle(title: string): string {
  const trimmed = title.trim();
  const asciiKey = trimmed
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9_\s-]/g, ' ')
    .trim()
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);

  if (/^[a-zA-Z0-9_\s-]+$/.test(trimmed) && trimmed.length <= 64) return trimmed;
  return `${asciiKey || 'profile'}_${Date.now().toString(36)}`;
}
