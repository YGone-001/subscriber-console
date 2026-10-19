/*
 * Architecture projection model.
 *
 * Pure, read-only projection that joins three authorities onto the static 3GPP
 * reference skeleton:
 *
 *   1. reference skeleton  -> role, position, reference point (this repo's data)
 *   2. Inventory           -> which resource realises a role (authoritative)
 *   3. NF Health           -> monitoring association, coverage, metrics
 *   4. runtime observations-> process evidence for roles with no resource
 *
 * Truthfulness rules enforced here:
 *   - a role with no resource is `unregistered`, never `stopped`;
 *   - a role with no monitoring target is `unmonitored`, never `healthy`;
 *   - an unresolved association lookup is `unresolved`, never `unmonitored`;
 *   - an observed process is evidence of a running process only, never of an
 *     interface or a service;
 *   - a reference point is `declared` only when a connectivity relationship for
 *     the two bound resources exists in the Topology authority; otherwise it is
 *     `reference` and makes no claim about the deployment;
 *   - no value is fabricated: absent evidence becomes an explicit state.
 */
import type { MetricView, OperationalResource } from '../operations/operational-model';
import { cpuView, memoryView } from '../operations/operational-model';
import {
  ARCHITECTURE_LINKS,
  ARCHITECTURE_NODES,
  rolesForView,
  type ArchitectureDomain,
  type ArchitectureIcon,
  type ArchitectureLink,
  type ArchitectureNode,
  type ArchitectureViewMode,
} from './reference-architecture';

export type NodeTone =
  | 'unregistered'
  | 'observed'
  | 'ambiguous'
  | 'unmonitored'
  | 'unresolved'
  | 'healthy'
  | 'degraded'
  | 'unhealthy'
  | 'stale'
  | 'unknown';

/**
 * One equally-ranked Inventory candidate for a reference role.
 *
 * An ambiguous role lists every candidate instead of silently binding the first
 * one, so the operator can see what the console refused to choose.
 */
export type ArchitectureCandidate = {
  resourceId: string;
  name: string;
  lifecycleState: string;
  tone: NodeTone;
  targetId: string | null;
};

/**
 * A name-based lookalike for a role that has no explicit binding.
 *
 * This is a migration diagnostic, not an identity claim. It deliberately carries
 * no tone and no monitoring target: a suggestion can never project health, count
 * as bound or monitored, or declare a topology relationship. The operator must
 * confirm the real role and write it through the Inventory governance path.
 */
export type ArchitectureSuggestion = {
  resourceId: string;
  name: string;
  lifecycleState: string;
  /** Why the resource was suggested: exact normalized name, or a name prefix. */
  reason: 'name' | 'name_prefix';
};

export type BindingState = 'bound' | 'ambiguous' | 'unbound';
export type BindingSource = 'runtime' | 'inventory' | 'none';

export type ObservedProcess = {
  processName: string;
  status: string;
  verified: boolean;
};

export type ArchitectureNodeView = {
  role: string;
  label: string;
  domain: ArchitectureDomain;
  icon: ArchitectureIcon;
  x: number;
  y: number;
  binding: BindingState;
  bindingSource: BindingSource;
  resourceId: string | null;
  resourceName: string;
  lifecycleState: string;
  /** Number of equally-ranked Inventory candidates; 1 for a clean binding. */
  candidateCount: number;
  /**
   * Equally-ranked candidates, bounded to a small list. Populated only when the
   * binding is ambiguous: a single candidate is already named by resourceId.
   */
  candidates: ArchitectureCandidate[];
  /**
   * Name-based lookalikes for an unbound role. Diagnostic only: they never set
   * resourceId, targetId or a tone.
   */
  suggestions: ArchitectureSuggestion[];
  observed: ObservedProcess | null;
  tone: NodeTone;
  targetId: string | null;
  coverage: { l1: boolean; l2: boolean; l3: boolean } | null;
  memory: MetricView | null;
  cpu: MetricView | null;
  freshness: string;
  overallState: string;
};

export type ArchitectureLinkView = {
  key: string;
  source: string;
  target: string;
  interfaceLabel: string;
  /** A connectivity relationship is declared between the two bound resources. */
  declared: boolean;
  /** Both endpoints resolve to an Inventory resource. */
  endpointsBound: boolean;
};

export type ArchitectureSummary = {
  total: number;
  bound: number;
  ambiguous: number;
  unbound: number;
  observedUnmanaged: number;
  monitored: number;
  degraded: number;
  unhealthy: number;
  unmonitored: number;
  unresolved: number;
};

export type ArchitectureProjection = {
  nodes: ArchitectureNodeView[];
  links: ArchitectureLinkView[];
  summary: ArchitectureSummary;
};

const CONNECTIVITY_RELATIONSHIPS = new Set([
  'connects_to',
  'routes_to',
  'serves',
  'uses',
  'exposes',
  'depends_on',
  'registers_with',
]);

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const asList = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.map(asRecord) : [];

const str = (value: unknown): string => (typeof value === 'string' ? value : value == null ? '' : String(value));

/** Case-insensitive alphanumeric token, so `SGW-C` and `sgw_c` compare equal. */
export function normalizeToken(value: unknown): string {
  return str(value).toLowerCase().replace(/[^a-z0-9]/g, '');
}

type RuntimeMatch = {
  processName: string;
  status: string;
  verified: boolean;
  associatedResourceId: string;
};

function matchRuntimeComponent(
  node: ArchitectureNode,
  components: Record<string, unknown>[],
): RuntimeMatch | null {
  const tokens = new Set([normalizeToken(node.role), ...node.roleTokens.map(normalizeToken)]);
  for (const component of components) {
    const processName = normalizeToken(component.processName);
    const nfType = normalizeToken(component.nfType);
    const role = normalizeToken(component.role);
    if (!tokens.has(processName) && !tokens.has(nfType) && !tokens.has(role)) continue;
    const association = asRecord(component.inventoryAssociation);
    return {
      processName: str(component.processName),
      status: str(component.runtimeStatus),
      verified: component.verified === true,
      associatedResourceId: str(association.state) === 'associated' ? str(association.id) : '',
    };
  }
  return null;
}

type Candidate = { resource: OperationalResource; tier: number; domainMatch: boolean };

/** Upper bound on the candidates listed in the drawer for one ambiguous role. */
const MAX_LISTED_CANDIDATES = 5;

/**
 * The only tier that may establish a binding.
 *
 * Tier 4 is an explicit canonical `role` match on the Inventory resource. Tiers
 * 3 (exact name) and 2 (name prefix) are naming habits, not identity, so they
 * are reported as migration suggestions and never bind.
 */
const AUTHORITATIVE_TIER = 4;

function rankCandidates(node: ArchitectureNode, resources: OperationalResource[]): Candidate[] {
  const tokens = new Set([normalizeToken(node.role), ...node.roleTokens.map(normalizeToken)]);
  const candidates: Candidate[] = [];
  for (const resource of resources) {
    if (!resource.isNetworkFunction || resource.retired) continue;
    const roleToken = normalizeToken(resource.role);
    const nameToken = normalizeToken(resource.name);
    let tier = 0;
    if (roleToken && tokens.has(roleToken)) {
      tier = 4;
    } else if (nameToken && tokens.has(nameToken)) {
      tier = 3;
    } else {
      for (const token of node.nameTokens.map(normalizeToken)) {
        if (token.length >= 3 && nameToken.startsWith(token)) {
          tier = 2;
          break;
        }
      }
    }
    if (tier === 0) continue;
    candidates.push({ resource, tier, domainMatch: resource.domain === node.inventoryDomain });
  }
  return candidates.sort((left, right) => {
    if (right.tier !== left.tier) return right.tier - left.tier;
    if (left.domainMatch !== right.domainMatch) return left.domainMatch ? -1 : 1;
    return left.resource.resourceId.localeCompare(right.resource.resourceId);
  });
}

function toneForResource(resource: OperationalResource): NodeTone {
  if (resource.association === 'unresolved') return 'unresolved';
  const monitoring = resource.monitoring;
  if (resource.association === 'absent' || !monitoring) return 'unmonitored';
  switch (monitoring.overallState) {
    case 'healthy':
      return 'healthy';
    case 'degraded':
      return 'degraded';
    case 'unhealthy':
      return 'unhealthy';
    case 'stale':
      return 'stale';
    default:
      return 'unknown';
  }
}

function viewForNode(
  node: ArchitectureNode,
  resources: OperationalResource[],
  components: Record<string, unknown>[],
): ArchitectureNodeView {
  const runtime = matchRuntimeComponent(node, components);
  const candidates = rankCandidates(node, resources);
  const authoritative = candidates.filter((candidate) => candidate.tier === AUTHORITATIVE_TIER);
  const diagnostic = candidates.filter((candidate) => candidate.tier < AUTHORITATIVE_TIER);
  const base = {
    role: node.role,
    label: node.label,
    domain: node.domain,
    icon: node.icon,
    x: node.x,
    y: node.y,
  };

  // An authoritative runtime association outranks name-based matching: the
  // scanner resolved the process to a canonical resourceId on the server.
  const runtimeBound = runtime?.associatedResourceId
    ? resources.find((resource) => resource.resourceId === runtime.associatedResourceId)
    : undefined;
  const chosen = runtimeBound ?? authoritative[0]?.resource;

  // A runtime association outranks everything, so only a pure explicit-role tie
  // is ambiguous. An ambiguous role is never bound to the first candidate: the
  // console cannot tell which resource the role actually runs.
  const ambiguous = !runtimeBound && authoritative.length > 1
    && authoritative[1].domainMatch === authoritative[0].domainMatch;

  if (!chosen) {
    const observed = runtime && runtime.verified && runtime.status === 'running' ? runtime : null;
    return {
      ...base,
      binding: 'unbound',
      bindingSource: 'none',
      resourceId: null,
      resourceName: '',
      lifecycleState: '',
      candidateCount: 0,
      candidates: [],
      suggestions: diagnostic.slice(0, MAX_LISTED_CANDIDATES).map((candidate) => ({
        resourceId: candidate.resource.resourceId,
        name: candidate.resource.name,
        lifecycleState: candidate.resource.lifecycleState,
        reason: candidate.tier === 3 ? 'name' : 'name_prefix',
      })),
      observed: observed
        ? { processName: observed.processName, status: observed.status, verified: observed.verified }
        : null,
      tone: observed ? 'observed' : 'unregistered',
      targetId: null,
      coverage: null,
      memory: null,
      cpu: null,
      freshness: '',
      overallState: '',
    };
  }

  if (ambiguous) {
    const observed = runtime && runtime.verified && runtime.status === 'running' ? runtime : null;
    return {
      ...base,
      binding: 'ambiguous',
      bindingSource: 'inventory',
      // No identity is claimed: the role has several equally-ranked resources.
      resourceId: null,
      resourceName: '',
      lifecycleState: '',
      candidateCount: authoritative.length,
      candidates: authoritative.slice(0, MAX_LISTED_CANDIDATES).map((candidate) => ({
        resourceId: candidate.resource.resourceId,
        name: candidate.resource.name,
        lifecycleState: candidate.resource.lifecycleState,
        tone: toneForResource(candidate.resource),
        targetId: candidate.resource.monitoring?.targetId ?? null,
      })),
      suggestions: [],
      observed: observed
        ? { processName: observed.processName, status: observed.status, verified: observed.verified }
        : null,
      tone: 'ambiguous',
      targetId: null,
      coverage: null,
      memory: null,
      cpu: null,
      freshness: '',
      overallState: '',
    };
  }

  const monitoring = chosen.monitoring;

  return {
    ...base,
    binding: ambiguous ? 'ambiguous' : 'bound',
    bindingSource: runtimeBound ? 'runtime' : 'inventory',
    resourceId: chosen.resourceId,
    resourceName: chosen.name,
    lifecycleState: chosen.lifecycleState,
    candidateCount: runtimeBound ? 1 : authoritative.length,
    candidates: [],
    suggestions: [],
    observed: runtime
      ? { processName: runtime.processName, status: runtime.status, verified: runtime.verified }
      : null,
    tone: toneForResource(chosen),
    targetId: monitoring?.targetId ?? null,
    coverage: monitoring
      ? {
        l1: monitoring.coverage.l1Measured,
        l2: monitoring.coverage.l2Measured,
        l3: monitoring.coverage.l3Measured,
      }
      : null,
    memory: memoryView(monitoring),
    cpu: cpuView(monitoring),
    freshness: monitoring?.freshnessState ?? '',
    overallState: monitoring?.overallState ?? '',
  };
}

function declaredPairs(edges: unknown): Set<string> {
  const pairs = new Set<string>();
  for (const edge of asList(edges)) {
    if (str(edge.lifecycleState) === 'retired') continue;
    if (!CONNECTIVITY_RELATIONSHIPS.has(str(edge.relationshipType))) continue;
    const from = str(edge.fromResourceId);
    const to = str(edge.toResourceId);
    if (!from || !to || from === to) continue;
    pairs.add(`${from}|${to}`);
    pairs.add(`${to}|${from}`);
  }
  return pairs;
}

function viewForLink(
  link: ArchitectureLink,
  byRole: Map<string, ArchitectureNodeView>,
  pairs: Set<string>,
): ArchitectureLinkView {
  const source = byRole.get(link.source);
  const target = byRole.get(link.target);
  const sourceId = source?.resourceId ?? '';
  const targetId = target?.resourceId ?? '';
  const endpointsBound = Boolean(sourceId && targetId);
  return {
    key: `${link.source}->${link.target}`,
    source: link.source,
    target: link.target,
    interfaceLabel: link.interfaceLabel,
    endpointsBound,
    declared: endpointsBound && pairs.has(`${sourceId}|${targetId}`),
  };
}

/** Projects the whole reference architecture for the loaded data page. */
export function resolveArchitecture(input: {
  resources: OperationalResource[];
  runtimeComponents?: unknown;
  edges?: unknown;
  nodes?: ArchitectureNode[];
  links?: ArchitectureLink[];
}): ArchitectureProjection {
  const nodes = input.nodes ?? ARCHITECTURE_NODES;
  const links = input.links ?? ARCHITECTURE_LINKS;
  const components = asList(input.runtimeComponents);
  const nodeViews = nodes.map((node) => viewForNode(node, input.resources, components));
  const byRole = new Map(nodeViews.map((view) => [view.role, view]));
  const pairs = declaredPairs(input.edges);
  const linkViews = links.map((link) => viewForLink(link, byRole, pairs));
  return { nodes: nodeViews, links: linkViews, summary: summarizeArchitecture(nodeViews) };
}

export function summarizeArchitecture(nodes: ArchitectureNodeView[]): ArchitectureSummary {
  const summary: ArchitectureSummary = {
    total: nodes.length,
    bound: 0,
    ambiguous: 0,
    unbound: 0,
    observedUnmanaged: 0,
    monitored: 0,
    degraded: 0,
    unhealthy: 0,
    unmonitored: 0,
    unresolved: 0,
  };
  for (const node of nodes) {
    if (node.binding === 'ambiguous') summary.ambiguous += 1;
    if (node.binding === 'bound') summary.bound += 1;
    if (node.binding === 'unbound') summary.unbound += 1;
    if (node.tone === 'observed') summary.observedUnmanaged += 1;
    if (node.targetId) summary.monitored += 1;
    if (node.tone === 'degraded') summary.degraded += 1;
    if (node.tone === 'unhealthy') summary.unhealthy += 1;
    if (node.tone === 'unmonitored') summary.unmonitored += 1;
    if (node.tone === 'unresolved') summary.unresolved += 1;
  }
  return summary;
}

/** Applies the architecture view filter. Hidden roles are not faults. */
export function filterArchitecture(
  projection: ArchitectureProjection,
  view: ArchitectureViewMode,
): { nodes: ArchitectureNodeView[]; links: ArchitectureLinkView[]; hiddenCount: number } {
  const roles = rolesForView(view);
  if (!roles) {
    return { nodes: projection.nodes, links: projection.links, hiddenCount: 0 };
  }
  const nodes = projection.nodes.filter((node) => roles.has(node.role));
  const visible = new Set(nodes.map((node) => node.role));
  const links = projection.links.filter((link) => visible.has(link.source) && visible.has(link.target));
  return { nodes, links, hiddenCount: projection.nodes.length - nodes.length };
}

/** i18n key for a node tone. Measured tones reuse the shared state vocabulary. */
export function stateLabelKey(tone: NodeTone): string {
  if (tone === 'unregistered') return 'arch_state_unregistered';
  if (tone === 'observed') return 'arch_state_observed';
  if (tone === 'ambiguous') return 'arch_state_ambiguous';
  if (tone === 'unmonitored') return 'arch_state_unmonitored';
  if (tone === 'unresolved') return 'ops_state_unresolved';
  return `ops_state_${tone}`;
}

export function domainLabelKey(domain: ArchitectureDomain): string {
  return `arch_domain_${domain}`;
}

export function bindingLabelKey(binding: BindingState): string {
  if (binding === 'ambiguous') return 'arch_binding_ambiguous';
  if (binding === 'bound') return 'arch_binding_bound';
  return 'arch_binding_unbound';
}
