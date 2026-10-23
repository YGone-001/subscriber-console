/*
 * Kind-only classification for the declared topology view.
 *
 * network_function and network_function_instance are network functions by
 * definition. network_element and every other Inventory kind are support
 * resources: they are hidden by default and never inflate an NF count. Role
 * tokens are used only for grouping, labels and interface suggestions.
 */
import type { ResourceProjection } from './topology-types';

export type TopologyResourceClass = 'nf' | 'support' | 'unresolved';

const NF_KINDS = new Set(['network_function', 'network_function_instance']);

const ROLE_LABELS: Record<string, string> = {
  amf: 'AMF',
  smf: 'SMF',
  upf: 'UPF',
  nrf: 'NRF',
  nssf: 'NSSF',
  bsf: 'BSF',
  udm: 'UDM',
  udr: 'UDR',
  ausf: 'AUSF',
  pcf: 'PCF',
  mme: 'MME',
  sgwc: 'SGW-C',
  sgwu: 'SGW-U',
  pgwc: 'PGW-C',
  pgwu: 'PGW-U',
  hss: 'HSS',
  pcrf: 'PCRF',
  ocs: 'OCS',
  dra: 'DRA',
  scp: 'SCP',
  sepp: 'SEPP',
  pcscf: 'P-CSCF',
  icscf: 'I-CSCF',
  scscf: 'S-CSCF',
  smsc: 'SMSC',
};

export function normalizeRoleToken(role: string | undefined): string {
  return (role ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function classifyResource(resource: ResourceProjection): TopologyResourceClass {
  if (!resource.kind) return 'unresolved';
  return NF_KINDS.has(resource.kind) ? 'nf' : 'support';
}

export function nfRoleLabel(role: string | undefined): string {
  const token = normalizeRoleToken(role);
  if (!token) return '';
  return ROLE_LABELS[token] ?? (role ?? '').trim().toUpperCase();
}
