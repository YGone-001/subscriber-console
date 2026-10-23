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

export type ArchitectureLane = {
  key: string;
  labelKey: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

export const ARCHITECTURE_VIEW_MODES: ArchitectureViewMode[] = ['all', 'epc', '5gc-sa', '5gc-nsa'];

export const NODE_WIDTH = 140;
export const NODE_HEIGHT = 56;
export const CANVAS_WIDTH = 960;
export const CANVAS_HEIGHT = 680;

export const ARCHITECTURE_NODES: ArchitectureNode[] = [
  { role: 'amf', label: 'AMF', domain: 'cp', icon: 'server', x: 40, y: 60, roleTokens: ['amf'], nameTokens: ['amf', 'amfd'], inventoryDomain: '5gc' },
  { role: 'mme', label: 'MME', domain: 'cp', icon: 'server', x: 40, y: 170, roleTokens: ['mme'], nameTokens: ['mme', 'mmed'], inventoryDomain: 'epc' },

  { role: 'smf', label: 'SMF', domain: 'sp', icon: 'server', x: 220, y: 60, roleTokens: ['smf'], nameTokens: ['smf', 'smfd'], inventoryDomain: '5gc' },
  { role: 'sgwc', label: 'SGW-C', domain: 'sp', icon: 'server', x: 220, y: 170, roleTokens: ['sgwc', 'sgw-c'], nameTokens: ['sgwc', 'sgwcd'], inventoryDomain: 'epc' },
  { role: 'pgwc', label: 'PGW-C', domain: 'sp', icon: 'server', x: 220, y: 280, roleTokens: ['pgwc', 'pgw-c'], nameTokens: ['pgwc', 'pgwcd'], inventoryDomain: 'epc' },

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
  { role: 'sgwu', label: 'SGW-U', domain: 'up', icon: 'router', x: 400, y: 580, roleTokens: ['sgwu', 'sgw-u'], nameTokens: ['sgwu', 'sgwud'], inventoryDomain: 'epc' },
  { role: 'pgwu', label: 'PGW-U', domain: 'up', icon: 'router', x: 580, y: 580, roleTokens: ['pgwu', 'pgw-u'], nameTokens: ['pgwu', 'pgwud'], inventoryDomain: 'epc' },
];

export const ARCHITECTURE_LINKS: ArchitectureLink[] = [
  // 5GC service based architecture
  { source: 'amf', target: 'smf', interfaceLabel: 'N11' },
  { source: 'amf', target: 'ausf', interfaceLabel: 'N12' },
  { source: 'amf', target: 'udm', interfaceLabel: 'N8' },
  { source: 'amf', target: 'pcf', interfaceLabel: 'N15' },
  { source: 'amf', target: 'nrf', interfaceLabel: 'Nnrf' },
  { source: 'amf', target: 'nssf', interfaceLabel: 'Nnssf' },
  { source: 'smf', target: 'upf', interfaceLabel: 'N4' },
  { source: 'smf', target: 'pcf', interfaceLabel: 'N7' },
  { source: 'smf', target: 'udm', interfaceLabel: 'N10' },
  { source: 'smf', target: 'nrf', interfaceLabel: 'Nnrf' },
  { source: 'smf', target: 'bsf', interfaceLabel: 'Nbsf' },
  { source: 'pcf', target: 'udr', interfaceLabel: 'N36' },
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
  { source: 'mme', target: 'sgwc', interfaceLabel: 'S11' },
  { source: 'mme', target: 'dra', interfaceLabel: 'S6a' },
  { source: 'sgwc', target: 'pgwc', interfaceLabel: 'S5' },
  { source: 'sgwc', target: 'sgwu', interfaceLabel: 'Sxa' },
  { source: 'pgwc', target: 'pgwu', interfaceLabel: 'Sxb' },
  { source: 'pgwc', target: 'pcrf', interfaceLabel: 'Gx' },
  { source: 'pgwc', target: 'ocs', interfaceLabel: 'Gy' },
  { source: 'pcrf', target: 'ocs', interfaceLabel: 'Sy' },
  { source: 'hss', target: 'dra', interfaceLabel: 'S6a' },
  { source: 'pgwc', target: 'dra', interfaceLabel: 'Gx' },
  { source: 'hss', target: 'udr', interfaceLabel: 'Ud' },

  // Interworking
  { source: 'amf', target: 'mme', interfaceLabel: 'N26' },
];

const EPC_ROLES = new Set(['mme', 'sgwc', 'sgwu', 'pgwc', 'pgwu', 'hss', 'pcrf', 'dra', 'ocs']);

const SA_ROLES = new Set([
  'amf', 'smf', 'upf', 'udm', 'udr', 'ausf', 'pcf', 'nssf', 'nrf', 'scp', 'bsf',
]);

const NSA_ROLES = new Set(['amf', 'mme', 'smf', 'pgwc', 'pgwu', 'upf', 'hss', 'udm']);

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

type NodePosition = { x: number; y: number };

const EPC_LAYOUT: Record<string, NodePosition> = {
  mme: { x: 44, y: 110 },
  sgwc: { x: 244, y: 100 },
  pgwc: { x: 424, y: 100 },
  pcrf: { x: 244, y: 220 },
  dra: { x: 604, y: 220 },
  sgwu: { x: 604, y: 420 },
  pgwu: { x: 424, y: 420 },
  hss: { x: 784, y: 420 },
  ocs: { x: 784, y: 110 },
};

const NSA_LAYOUT: Record<string, NodePosition> = {
  mme: { x: 44, y: 120 },
  pgwc: { x: 244, y: 120 },
  pgwu: { x: 44, y: 300 },
  hss: { x: 244, y: 300 },
  amf: { x: 500, y: 120 },
  smf: { x: 700, y: 120 },
  upf: { x: 500, y: 300 },
  udm: { x: 700, y: 300 },
};

const SA_LAYOUT: Record<string, NodePosition> = Object.fromEntries(
  ARCHITECTURE_NODES
    .filter((node) => SA_ROLES.has(node.role))
    .map((node) => [node.role, { x: node.x, y: node.y }]),
);

const EPC_LANES: ArchitectureLane[] = [
  { key: 'epc-access', labelKey: 'arch_lane_access', x: 24, y: 60, width: 180, height: 560 },
  { key: 'epc-control', labelKey: 'arch_lane_control', x: 224, y: 60, width: 520, height: 260 },
  { key: 'epc-user', labelKey: 'arch_lane_user', x: 224, y: 340, width: 520, height: 280 },
  { key: 'epc-data', labelKey: 'arch_lane_data', x: 764, y: 340, width: 172, height: 280 },
  { key: 'epc-external', labelKey: 'arch_lane_external', x: 764, y: 60, width: 172, height: 260 },
];

const NSA_LANES: ArchitectureLane[] = [
  { key: 'nsa-interworking', labelKey: 'arch_lane_interworking', x: 24, y: 24, width: 912, height: 30 },
  { key: 'nsa-lte', labelKey: 'arch_lane_lte_anchor', x: 24, y: 64, width: 440, height: 556 },
  { key: 'nsa-nr', labelKey: 'arch_lane_nr_access', x: 480, y: 64, width: 456, height: 556 },
];

/**
 * Returns the canonical nodes with the deterministic coordinates of one view.
 *
 * `all` has no merged canvas; it is rendered as an overview of the three
 * single-domain templates.
 */
export function architectureNodesForView(view: Exclude<ArchitectureViewMode, 'all'>): ArchitectureNode[] {
  const layout = view === 'epc' ? EPC_LAYOUT : view === '5gc-nsa' ? NSA_LAYOUT : SA_LAYOUT;
  return ARCHITECTURE_NODES.map((node) => {
    const position = layout[node.role];
    return position ? { ...node, ...position } : node;
  });
}

export function architectureLanesForView(view: Exclude<ArchitectureViewMode, 'all'>): ArchitectureLane[] {
  if (view === 'epc') return EPC_LANES;
  if (view === '5gc-nsa') return NSA_LANES;
  return [];
}

export function nodeByRole(role: string): ArchitectureNode | undefined {
  return ARCHITECTURE_NODES.find((node) => node.role === role);
}
