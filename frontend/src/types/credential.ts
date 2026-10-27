/*
 * The condition of credential material as the server states it.
 *
 * A reader who may not see a permanent key receives no value for it at all: the
 * response says instead whether the field carries material. Withheld and
 * unconfigured are two different facts, and both are different from a value.
 */
export type CredentialVisibility = 'plaintext' | 'masked';

export type CredentialFieldState = 'configured' | 'not_configured';

export interface CredentialState {
  visibility: CredentialVisibility;
  k: CredentialFieldState;
  op: CredentialFieldState;
  opc: CredentialFieldState;
}

/*
 * A response from a server that predates the stated-condition projection can
 * still carry this placeholder in place of withheld material. It was never a
 * credential value, so no surface may render it as one: it is normalised to
 * "withheld" at the edge instead.
 */
export const RETIRED_MASKED_PLACEHOLDER = '[MASKED]';

export function isWithheldPlaceholder(value: unknown): boolean {
  return typeof value === 'string' && value.trim() === RETIRED_MASKED_PLACEHOLDER;
}

export type UsimType = 'op' | 'opc';

export interface UsimTypeSource {
  op?: unknown;
  opc?: unknown;
  credentialState?: CredentialState;
}

/*
 * Which OP variant a document carries is a fact about the credential block, and
 * a reader who cannot see the material still receives its stated condition.
 * Inferring the variant from the value alone made that reader's label wrong: the
 * condition wins whenever it is available, the value only serves older responses.
 */
export function resolveUsimType(auth: UsimTypeSource | null | undefined): UsimType {
  if (!auth) return 'opc';
  if (auth.credentialState) {
    if (auth.credentialState.op === 'configured') return 'op';
    if (auth.credentialState.opc === 'configured') return 'opc';
  }
  return typeof auth.op === 'string' && auth.op !== '' ? 'op' : 'opc';
}
