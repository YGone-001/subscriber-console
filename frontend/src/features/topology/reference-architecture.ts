/*
 * Static 3GPP reference architecture.
 *
 * This module is REFERENCE DATA, not topology data. It describes where a
 * network function sits in a 3GPP reference architecture and which reference
 * point connects two roles. It never asserts that a deployment has that
 * interface configured, and it is never written to the Topology collection.
 *
 * Coordinates are a fixed layout on a 960 x 680 virtual canvas. Node width is
 * 140 and height is 56; the layout is deterministic so the canvas can be
 * verified by counting nodes and links rather than by comparing pixels.
 */

export type ArchitectureDomain = 'cp' | 'sp' | 'up' | 'dm' | 'legacy';

export type ArchitectureIcon = 'server' | 'database' | 'router';

export type ArchitectureNode = {
  /** Stable role key used by the projection model and by tests. */
  role: string;
  /** Short 3GPP role label rendered on the canvas. */
  label: string;
  domain: ArchitectureDomain;
  icon: ArchitectureIcon;
  x: number;
  y: number;
  /**
   * Accepted Inventory `role` values for this reference role. Compared after
   * token normalization, so `SGW-C`, `sgw_c` and `sgwc` are equivalent.
   */
  roleTokens: string[];
  /**
   * Accepted resource-name prefixes. A prefix match is only considered when the
   * token is at least three characters long, and a prefix match is always
   * weaker than an explicit role match.
   */
  nameTokens: string[];
  /** Expected Inventory domain. Used only to break ties, never to bind alone. */
  inventoryDomain: string;
};

export type ArchitectureLink = {
  source: string;
  target: string;
  /** 3GPP reference point label (N11, S6a, Gx, ...). */
  interfaceLabel: string;
};

export type ArchitectureViewMode = 'all' | 'epc' | '5gc-sa' | '5gc-nsa';

export const ARCHITECTURE_VIEW_MODES: ArchitectureViewMode[] = ['all', 'epc', '5gc-sa', '5gc-nsa'];

export const NODE_WIDTH = 140;
export const NODE_HEIGHT = 56;
export const CANVAS_WIDTH = 960;
export const CANVAS_HEIGHT = 680;

export const ARCHITECTURE_NODES: ArchitectureNode[] = [
  { role: 'amf', label: 'AMF', domain: 'cp', icon: 'server', x: 40, y: 60, roleTokens: ['amf'], nameTokens: ['amf', 'amfd'], inventoryDomain: '5gc' },
  { role: 'mme', label: 'MME', domain: 'cp', icon: 'server', x: 40, y: 170, roleTokens: ['mme'], nameTokens: ['mme', 'mmed'], inventoryDomain: 'epc' },

  { role: 'smf', label: 'SMF', domain: 'sp', icon: 'server', x: 220, y: 60, roleTokens: ['smf'], nameTokens: ['smf', 'smfd'], inventoryDomain: '5gc' },
  { role: 'sgw-c', label: 'SGW-C', domain: 'sp', icon: 'server', x: 220, y: 170, roleTokens: ['sgw-c', 'sgwc'], nameTokens: ['sgwc', 'sgwcd'], inventoryDomain: 'epc' },
  { role: 'pgw-c', label: 'PGW-C', domain: 'sp', icon: 'server', x: 220, y: 280, roleTokens: ['pgw-c', 'pgwc'], nameTokens: ['pgwc', 'pgwcd'], inventoryDomain: 'epc' },

  { role: 'nrf', label: 'NRF', domain: 'sp', icon: 'server', x: 400, y: 60, roleTokens: ['nrf'], nameTokens: ['nrf', 'nrfd'], inventoryDomain: '5gc' },
  { role: 'nssf', label: 'NSSF', domain: 'sp', icon: 'server', x: 400, y: 170, roleTokens: ['nssf'], nameTokens: ['nssf', 'nssfd'], inventoryDomain: '5gc' },
  { role: 'bsf', label: 'BSF', domain: 'sp', icon: 'server', x: 400, y: 280, roleTokens: ['bsf'], nameTokens: ['bsf', 'bsfd'], inventoryDomain: '5gc' },
  { role: 'scp', label: 'SCP', domain: 'sp', icon: 'server', x: 400, y: 390, roleTokens: ['scp'], nameTokens: ['scp', 'scpd'], inventoryDomain: '5gc' },

  { role: 'udm', label: 'UDM', domain: 'dm', icon: 'database', x: 580, y: 60, roleTokens: ['udm'], nameTokens: ['udm', 'udmd'], inventoryDomain: '5gc' },
  { role: 'udr', label: 'UDR', domain: 'dm', icon: 'database', x: 580, y: 170, roleTokens: ['udr'], nameTokens: ['udr', 'udrd'], inventoryDomain: '5gc' },
  { role: 'ausf', label: 'AUSF', domain: 'dm', icon: 'server', x: 580, y: 280, roleTokens: ['ausf'], nameTokens: ['ausf', 'ausfd'], inventoryDomain: '5gc' },
  { role: 'pcf', label: 'PCF', domain: 'dm', icon: 'server', x: 580, y: 390, roleTokens: ['pcf'], nameTokens: ['pcf', 'pcfd'], inventoryDomain: '5gc' },
  { role: 'hss', label: 'HSS', domain: 'dm', icon: 'database', x: 580, y: 500, roleTokens: ['hss'], nameTokens: ['hss', 'hssd'], inventoryDomain: 'epc' },

  { role: 'ocs', label: 'OCS', domain: 'legacy', icon: 'database', x: 760, y: 280, roleTokens: ['ocs'], nameTokens: ['ocs', 'ocsd'], inventoryDomain: 'charging' },
  { role: 'dra', label: 'DRA', domain: 'legacy', icon: 'server', x: 760, y: 390, roleTokens: ['dra'], nameTokens: ['dra', 'drad'], inventoryDomain: 'epc' },
  { role: 'pcrf', label: 'PCRF', domain: 'legacy', icon: 'server', x: 760, y: 500, roleTokens: ['pcrf'], nameTokens: ['pcrf', 'pcrfd'], inventoryDomain: 'epc' },

  { role: 'upf', label: 'UPF', domain: 'up', icon: 'router', x: 220, y: 580, roleTokens: ['upf'], nameTokens: ['upf', 'upfd'], inventoryDomain: '5gc' },
  { role: 'sgw-u', label: 'SGW-U', domain: 'up', icon: 'router', x: 400, y: 580, roleTokens: ['sgw-u', 'sgwu'], nameTokens: ['sgwu', 'sgwud'], inventoryDomain: 'epc' },
  { role: 'pgw-u', label: 'PGW-U', domain: 'up', icon: 'router', x: 580, y: 580, roleTokens: ['pgw-u', 'pgwu'], nameTokens: ['pgwu', 'pgwud'], inventoryDomain: 'epc' },
];

export const ARCHITECTURE_LINKS: ArchitectureLink[] = [
  // 5GC service based architecture
  { source: 'amf', target: 'smf', interfaceLabel: 'N11' },
  { source: 'amf', target: 'ausf', interfaceLabel: 'N12' },
  { source: 'amf', target: 'udm', interfaceLabel: 'N8' },
  { source: 'amf', target: 'pcf', interfaceLabel: 'N8' },
  { source: 'amf', target: 'nrf', interfaceLabel: 'Nnrf' },
  { source: 'amf', target: 'nssf', interfaceLabel: 'Nnssf' },
  { source: 'smf', target: 'upf', interfaceLabel: 'N4' },
  { source: 'smf', target: 'pcf', interfaceLabel: 'N7' },
  { source: 'smf', target: 'udm', interfaceLabel: 'N10' },
  { source: 'smf', target: 'nrf', interfaceLabel: 'Nnrf' },
  { source: 'smf', target: 'bsf', interfaceLabel: 'Nbsf' },
  { source: 'pcf', target: 'udr', interfaceLabel: 'N5' },
  { source: 'pcf', target: 'bsf', interfaceLabel: 'Nbsf' },
  { source: 'pcf', target: 'nrf', interfaceLabel: 'Nnrf' },
  { source: 'ausf', target: 'udm', interfaceLabel: 'N13' },
  { source: 'ausf', target: 'nrf', interfaceLabel: 'Nnrf' },
  { source: 'udm', target: 'udr', interfaceLabel: 'Nudr' },
  { source: 'udm', target: 'nrf', interfaceLabel: 'Nnrf' },
  { source: 'nrf', target: 'scp', interfaceLabel: 'Nnrf' },
  { source: 'smf', target: 'scp', interfaceLabel: 'Nnrf' },

  // EPC / legacy interfaces
  { source: 'mme', target: 'hss', interfaceLabel: 'S6a' },
  { source: 'mme', target: 'sgw-c', interfaceLabel: 'S11' },
  { source: 'mme', target: 'dra', interfaceLabel: 'S6a' },
  { source: 'sgw-c', target: 'pgw-c', interfaceLabel: 'S5' },
  { source: 'sgw-c', target: 'sgw-u', interfaceLabel: 'Sxa' },
  { source: 'pgw-c', target: 'pgw-u', interfaceLabel: 'Sxb' },
  { source: 'pgw-c', target: 'pcrf', interfaceLabel: 'Gx' },
  { source: 'pgw-c', target: 'ocs', interfaceLabel: 'Gy' },
  { source: 'pcrf', target: 'ocs', interfaceLabel: 'Sy' },
  { source: 'hss', target: 'dra', interfaceLabel: 'S6a' },
  { source: 'pgw-c', target: 'dra', interfaceLabel: 'Gx' },
  { source: 'hss', target: 'udr', interfaceLabel: 'Ud' },

  // Interworking
  { source: 'amf', target: 'mme', interfaceLabel: 'N26' },
];

const EPC_ROLES = new Set(['mme', 'sgw-c', 'sgw-u', 'pgw-c', 'pgw-u', 'hss', 'pcrf', 'dra', 'ocs']);

const SA_ROLES = new Set([
  'amf', 'smf', 'upf', 'udm', 'udr', 'ausf', 'pcf', 'nssf', 'nrf', 'scp', 'bsf',
]);

const NSA_ROLES = new Set(['amf', 'mme', 'smf', 'pgw-c', 'pgw-u', 'upf', 'hss', 'udm']);

/** Roles visible in a view. A role absent from the view is not a fault. */
/**
 * Every canonical role token the skeleton can bind to.
 *
 * The architecture canvas reads `/api/operations/resources?roles=` with exactly
 * this set, so the projection returns the resources relevant to the reference
 * layout instead of an arbitrary first page of Inventory.
 */
export const ARCHITECTURE_ROLE_TOKENS: string[] = Array.from(
  new Set(ARCHITECTURE_NODES.flatMap((node) => [node.role, ...node.roleTokens])),
).sort();

export function rolesForView(view: ArchitectureViewMode): Set<string> | null {
  if (view === 'epc') return EPC_ROLES;
  if (view === '5gc-sa') return SA_ROLES;
  if (view === '5gc-nsa') return NSA_ROLES;
  return null;
}

export function nodeByRole(role: string): ArchitectureNode | undefined {
  return ARCHITECTURE_NODES.find((node) => node.role === role);
}
