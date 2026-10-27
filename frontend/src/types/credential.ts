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
