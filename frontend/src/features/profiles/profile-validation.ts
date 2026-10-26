/*
 * Draft validation for a user template. Returns the first issue found so the
 * caller can localize it; the rules mirror 3GPP field formats.
 */

export type ProfileAmbrInput = {
  downlink?: { value?: unknown; unit?: unknown } | null;
  uplink?: { value?: unknown; unit?: unknown } | null;
};

export type ProfileSliceInput = {
  sst?: unknown;
  sd?: unknown;
  session_list?: Array<{ name?: unknown; pgwIpv4?: unknown }> | null;
};

export type ProfileDraftInput = {
  name?: unknown;
  auth?: { k?: unknown; opValue?: unknown; amf?: unknown } | null;
  ambr?: ProfileAmbrInput | null;
  slices?: ProfileSliceInput[] | null;
};

export type ProfileDraftIssue =
  | { code: 'nameRequired' }
  | { code: 'kFormat' }
  | { code: 'opFormat' }
  | { code: 'amfFormat' }
  | { code: 'ambrInvalid'; direction: 'downlink' | 'uplink' }
  | { code: 'sstRange'; index: number }
  | { code: 'sdFormat'; index: number }
  | { code: 'pgwIpv4'; sessionName: string };

const HEX_32 = /^[0-9a-fA-F]{32}$/;
const HEX_4 = /^[0-9a-fA-F]{4}$/;
const HEX_6 = /^[0-9a-fA-F]{6}$/;
const IPV4 = /^(\d{1,3}\.){3}\d{1,3}$/;

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function findProfileDraftIssue(input: ProfileDraftInput): ProfileDraftIssue | null {
  if (text(input.name) === '') return { code: 'nameRequired' };

  const auth = input.auth ?? {};
  if (!HEX_32.test(text(auth.k))) return { code: 'kFormat' };
  if (!HEX_32.test(text(auth.opValue))) return { code: 'opFormat' };
  if (!HEX_4.test(text(auth.amf))) return { code: 'amfFormat' };

  for (const direction of ['downlink', 'uplink'] as const) {
    const side = input.ambr?.[direction];
    const value = Number(side?.value);
    const unit = Number(side?.unit);
    if (!Number.isFinite(value) || value < 0) return { code: 'ambrInvalid', direction };
    if (!Number.isInteger(unit) || unit < 0 || unit > 4) return { code: 'ambrInvalid', direction };
  }

  const slices = Array.isArray(input.slices) ? input.slices : [];
  for (let index = 0; index < slices.length; index += 1) {
    const slice = slices[index] ?? {};
    const sst = Number(slice.sst);
    if (!Number.isInteger(sst) || sst < 1 || sst > 255) return { code: 'sstRange', index: index + 1 };
    const sd = text(slice.sd);
    if (sd !== '' && !HEX_6.test(sd)) return { code: 'sdFormat', index: index + 1 };
    const sessions = Array.isArray(slice.session_list) ? slice.session_list : [];
    for (const session of sessions) {
      const pgwIpv4 = text(session?.pgwIpv4);
      if (pgwIpv4 !== '' && !IPV4.test(pgwIpv4)) {
        return { code: 'pgwIpv4', sessionName: text(session?.name) || 'unknown' };
      }
    }
  }

  return null;
}
