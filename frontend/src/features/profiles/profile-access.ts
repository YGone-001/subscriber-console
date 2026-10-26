/*
 * 3GPP access_restriction_data vocabulary. The server serves the authoritative
 * bit list; the local copy only covers a degraded meta read.
 */

export type AccessRestrictionBit = { value: number; key: string };

export const DEFAULT_ACCESS_RESTRICTION_BITS: AccessRestrictionBit[] = [
  { value: 128, key: 'nr' },
  { value: 16, key: 'eutran' },
  { value: 1, key: 'utran' },
  { value: 2, key: 'geran' },
  { value: 32, key: 'non3gpp' },
  { value: 4, key: 'gan' },
  { value: 8, key: 'ihspa' },
  { value: 64, key: 'nbiot' },
];

const LABEL_KEYS: Record<string, string> = {
  nr: 'sub_acc_nr',
  eutran: 'sub_acc_eutran',
  utran: 'sub_acc_utran',
  geran: 'sub_acc_geran',
  non3gpp: 'sub_acc_non3gpp',
  gan: 'sub_acc_gan',
  ihspa: 'sub_acc_ihspa',
  nbiot: 'sub_acc_nbiot',
};

export function accessBitLabel(t: (key: string) => string, bit: AccessRestrictionBit): string {
  const key = LABEL_KEYS[bit.key];
  return key ? t(key) : String(bit.value);
}
