/*
 * Wire types for the read-only live topology projection.
 *
 * The server joins the current runtime snapshot with operator-owned NF_ETC
 * config sources. Reference links are not part of this payload; they remain a
 * separate architecture view.
 */
export type LiveEndpoint = {
  protocol: string;
  address?: string;
  port?: number;
  sourceFile?: string;
};

export type LiveNode = {
  componentId: string;
  displayName: string;
  processName: string;
  role?: string;
  nfType?: string;
  domain?: string;
  runtimeStatus: string;
  statusReason?: string;
  inventoryResourceId?: string;
  listeners?: LiveEndpoint[];
};

export type LiveEdge = {
  edgeId: string;
  fromComponentId: string;
  toComponentId: string;
  relationshipType: string;
  interfaceNames: string[];
  protocol: string;
  evidence: 'configured' | string;
  state: 'active' | 'partial' | 'inactive' | 'unknown' | string;
  fromEndpoint: LiveEndpoint;
  toEndpoint: LiveEndpoint;
  sourceFiles: string[];
};

export type LiveUnavailableSource = {
  componentId?: string;
  file?: string;
  reason: string;
};

export type LiveConfigStatus = {
  manifestConfigured: boolean;
  sourceCount: number;
  availableSources: number;
  unavailable?: LiveUnavailableSource[];
  complete: boolean;
};

export type LiveRuntimeSummary = {
  total: number;
  running: number;
  stopped: number;
  unverified: number;
  permissionDenied: number;
  unknown: number;
  stale: number;
  notDetected: number;
  expected: number;
};

export type LiveUnresolvedPeer = {
  componentId: string;
  protocol: string;
  peer: string;
  reason: string;
};

/*
 * Advisory diff between the persisted relationship ledger and the configured
 * evidence in this projection. An entry never claims a relationship is wrong:
 * a declaration may cover a link this manifest does not describe, and a
 * configured link may be deliberately undeclared or retired.
 */
export type LiveReconciliationItem = {
  fromResourceId: string;
  toResourceId: string;
  fromComponentId?: string;
  toComponentId?: string;
  configuredEdgeId?: string;
  edgeId?: string;
  relationshipType?: string;
  interfaceNames?: string[];
  declaredInterfaceNames?: string[];
  interfaceMatch?: 'agrees' | 'differs' | 'unannotated' | string;
  protocol?: string;
  sourceFiles?: string[];
  retired?: boolean;
};

export type LiveReconciliation = {
  available: boolean;
  reason?: string;
  complete: boolean;
  configuredLinks: number;
  declaredEdges: number;
  matchedCount: number;
  matched: LiveReconciliationItem[];
  undeclaredEvidence: LiveReconciliationItem[];
  unevidencedDeclarations: LiveReconciliationItem[];
};

export type LiveTopologyResponse = {
  generatedAt: string;
  host: { hostId: string; hostName?: string };
  runtime: LiveRuntimeSummary;
  config: LiveConfigStatus;
  nodes: LiveNode[];
  edges: LiveEdge[];
  unresolvedPeers?: LiveUnresolvedPeer[];
  reconciliation?: LiveReconciliation;
  summary: {
    nodeCount: number;
    edgeCount: number;
    configuredEdgeCount: number;
    unresolvedPeerCount: number;
  };
};
