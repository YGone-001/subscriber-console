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

export type LiveTopologyResponse = {
  generatedAt: string;
  host: { hostId: string; hostName?: string };
  runtime: LiveRuntimeSummary;
  config: LiveConfigStatus;
  nodes: LiveNode[];
  edges: LiveEdge[];
  unresolvedPeers?: LiveUnresolvedPeer[];
  summary: {
    nodeCount: number;
    edgeCount: number;
    configuredEdgeCount: number;
    unresolvedPeerCount: number;
  };
};
