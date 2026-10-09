/**
 * Client-side guards for Discovery source forms and candidate link operations.
 *
 * These checks mirror the Go validation contract for early feedback only.
 * The backend remains the authorization and validation authority.
 */

import type {
  CreateDiscoverySourceRequest,
  DiscoveryAdapterType,
  DiscoveryTransportMode,
  MutableSourceForm,
  UpdateDiscoverySourceRequest,
} from './discovery-types';

export const CANONICAL_ADAPTER_TYPES: DiscoveryAdapterType[] = ['nrf'];
export const CANONICAL_TRANSPORT_MODES: DiscoveryTransportMode[] = ['h2c', 'h2_tls'];

const NAME_MAX = 128;

export function validateSourceName(value: string): string | null {
  const name = value.trim();
  if (!name) return 'discovery_validation_name_required';
  if (name.length > NAME_MAX) return 'discovery_validation_name_too_long';
  return null;
}

export function validateBaseUrl(value: string): string | null {
  const raw = value.trim();
  if (!raw) return 'discovery_validation_url_required';
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return 'discovery_validation_url_invalid';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return 'discovery_validation_url_scheme';
  }
  if (parsed.username || parsed.password) return 'discovery_validation_url_credentials';
  if (parsed.hash) return 'discovery_validation_url_fragment';
  if (parsed.search) return 'discovery_validation_url_query';
  return null;
}

export function validateAdapterType(value: string): string | null {
  return CANONICAL_ADAPTER_TYPES.includes(value as DiscoveryAdapterType)
    ? null
    : 'discovery_validation_adapter';
}

export function validateTransportMode(value: string): string | null {
  return CANONICAL_TRANSPORT_MODES.includes(value as DiscoveryTransportMode)
    ? null
    : 'discovery_validation_transport';
}

export function validateResourceId(value: string): string | null {
  const id = value.trim();
  if (!id) return 'discovery_validation_resource_required';
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!uuid.test(id)) return 'discovery_validation_resource_invalid';
  return null;
}

export function buildCreateSourceRequest(input: {
  name: string;
  adapterType: string;
  baseUrl: string;
  transportMode: string;
  enabled?: boolean;
}): CreateDiscoverySourceRequest {
  const nameError = validateSourceName(input.name);
  if (nameError) throw new Error(nameError);
  const adapterError = validateAdapterType(input.adapterType);
  if (adapterError) throw new Error(adapterError);
  const urlError = validateBaseUrl(input.baseUrl);
  if (urlError) throw new Error(urlError);
  const transportError = validateTransportMode(input.transportMode);
  if (transportError) throw new Error(transportError);

  const request: CreateDiscoverySourceRequest = {
    name: input.name.trim(),
    adapterType: input.adapterType as DiscoveryAdapterType,
    baseUrl: input.baseUrl.trim(),
    transportMode: input.transportMode as DiscoveryTransportMode,
  };
  if (typeof input.enabled === 'boolean') request.enabled = input.enabled;
  return request;
}

export function buildUpdateSourceRequest(
  expectedRevision: number,
  form: MutableSourceForm,
): UpdateDiscoverySourceRequest {
  if (!Number.isInteger(expectedRevision) || expectedRevision <= 0) {
    throw new Error('discovery_validation_revision');
  }
  const nameError = validateSourceName(form.name);
  if (nameError) throw new Error(nameError);
  const urlError = validateBaseUrl(form.baseUrl);
  if (urlError) throw new Error(urlError);
  const transportError = validateTransportMode(form.transportMode);
  if (transportError) throw new Error(transportError);

  return {
    expectedRevision,
    source: {
      name: form.name.trim(),
      baseUrl: form.baseUrl.trim(),
      transportMode: form.transportMode,
      enabled: form.enabled,
    },
  };
}
