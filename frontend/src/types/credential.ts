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
