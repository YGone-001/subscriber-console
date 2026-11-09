import { getJson } from '../../lib/api/read-client';
import { postJson, putJson } from '../../lib/api/mutation-client';

export type AgentScope = {
  networkKey: string;
  operatorName: string;
  siteResourceId: string;
  hostResourceId: string;
  plmns: string[];
};
export type AgentMetadata = { name: string; scope: AgentScope };
export type AgentMetrics = {
  cpuPercent: number | null;
  memoryTotalBytes: number | null;
  memoryAvailableBytes: number | null;
  diskTotalBytes: number | null;
  diskAvailableBytes: number | null;
  uptimeSeconds: number | null;
};
export type AgentComponent = {
  componentId: string;
  runtimeStatus: string;
  verified: boolean;
  primaryPid: number;
  workerCount: number;
  cpuPercent: number | null;
  memoryRssBytes: number | null;
};
export type AgentObservation = {
  collectedAt: string;
  hostName: string;
  platform: string;
  version: string;
  visibility: string;
  scanComplete: boolean;
  metrics: AgentMetrics;
  components: AgentComponent[];
};
export type Agent = AgentMetadata & {
  agentId: string;
  enabled: boolean;
  revision: number;
  createdAt: string;
  updatedAt: string;
  lastReceivedAt: string | null;
  connectionState: 'pending' | 'online' | 'stale' | 'offline' | 'disabled';
  evidenceFreshness: 'fresh' | 'stale' | 'unavailable';
  observation: AgentObservation | null;
};
export type AgentSummary = { total: number; online: number; stale: number; offline: number; pending: number; disabled: number };
export type AgentList = {
  controller: {
    role: 'controller';
    transport: 'in_process';
    hostName: string;
    hostId: string;
    observation: AgentObservation | null;
    evidenceFreshness: 'fresh' | 'stale' | 'unavailable';
  };
  agents: Agent[];
  summary: AgentSummary | null;
  completeness: 'complete' | 'unavailable';
  nextCursor: string | null;
  hasMore: boolean;
  protocolVersion: number;
  staleAfterSeconds: number;
  offlineAfterSeconds: number;
};
export type AgentCredential = { agent: Agent; token: string };
export type UpdateAgentRequest = AgentMetadata & { expectedRevision: number; enabled: boolean };

export function fetchAgents(q = '', cursor = ''): Promise<AgentList> {
  const query = new URLSearchParams({ limit: '50' });
  if (q) query.set('q', q);
  if (cursor) query.set('cursor', cursor);
  return getJson<AgentList>(`/api/agents?${query}`);
}
export function fetchAgent(agentId: string): Promise<Agent> {
  return getJson<Agent>(`/api/agents/${encodeURIComponent(agentId)}`);
}
export function createAgent(payload: AgentMetadata): Promise<AgentCredential> {
  return postJson<AgentCredential>('/api/agents', payload);
}
export function updateAgent(agentId: string, payload: UpdateAgentRequest): Promise<Agent> {
  return putJson<Agent>(`/api/agents/${encodeURIComponent(agentId)}`, payload);
}
export function rotateAgentCredential(agentId: string, expectedRevision: number): Promise<AgentCredential> {
  return postJson<AgentCredential>(`/api/agents/${encodeURIComponent(agentId)}/credentials`, { expectedRevision });
}
