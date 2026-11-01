/*
 * Controlled interface vocabulary helpers.
 *
 * Interface names are persisted as an exact array from the server catalog.
 * The UI never accepts free text and never infers a name from endpoints.
 */
import type { InterfaceEntry } from './topology-types';

export const MAX_INTERFACE_NAMES = 8;
export const UNANNOTATED_INTERFACE_FILTER = '__unannotated__';

const KNOWN_DOMAINS = new Set(['5gc', 'epc', 'ims', 'charging']);

export function edgeInterfaceNames(value: unknown): string[] {
  if (!value || typeof value !== 'object') return [];
  const raw = (value as { interfaceNames?: unknown }).interfaceNames;
  if (!Array.isArray(raw)) return [];
  return raw.filter((name): name is string => typeof name === 'string' && name.trim().length > 0);
}

export function normalizeInterfaceNames(names: string[] | undefined): string[] | undefined {
  if (names === undefined) return undefined;
  const normalized: string[] = [];
  for (const raw of names) {
    if (typeof raw !== 'string') continue;
    const name = raw.trim();
    if (!name || normalized.includes(name)) continue;
    normalized.push(name);
  }
  if (normalized.length > MAX_INTERFACE_NAMES) {
    throw new Error(`At most ${MAX_INTERFACE_NAMES} interface names can be selected.`);
  }
  return normalized;
}

export function formatInterfaceNames(names: readonly string[]): string {
  return names.join(' / ');
}

export function interfaceCoverage(edges: readonly unknown[]): { annotated: number; total: number } {
  return {
    annotated: edges.filter((edge) => edgeInterfaceNames(edge).length > 0).length,
    total: edges.length,
  };
}

export function filterEdgesByInterface<T>(edges: T[], filter: string): T[] {
  if (!filter) return edges;
  if (filter === UNANNOTATED_INTERFACE_FILTER) {
    return edges.filter((edge) => edgeInterfaceNames(edge).length === 0);
  }
  return edges.filter((edge) => edgeInterfaceNames(edge).includes(filter));
}

export function interfaceNamesInEdges(edges: readonly unknown[]): string[] {
  return [...new Set(edges.flatMap((edge) => edgeInterfaceNames(edge)))].sort((left, right) => left.localeCompare(right));
}

export function interfaceUsageCounts(edges: readonly unknown[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const edge of edges) {
    for (const name of new Set(edgeInterfaceNames(edge))) {
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  return counts;
}

export function interfaceCategoryLabelKey(category: string): string {
  return category === 'sbi'
    ? 'topology_interface_category_sbi'
    : 'topology_interface_category_reference_point';
}

export function interfacePlaneLabelKey(plane: string): string {
  if (plane === 'user') return 'topology_interface_plane_user';
  if (plane === 'both') return 'topology_interface_plane_both';
  return 'topology_interface_plane_control';
}

export function interfaceDomainLabelKey(domain: string): string {
  return KNOWN_DOMAINS.has(domain) ? `topology_domain_${domain}` : 'topology_domain_unclassified';
}

export function interfaceEndpointRoles(entry: InterfaceEntry): string[] {
  if (entry.producerRole) return [entry.producerRole];
  return [...new Set((entry.endpoints ?? []).flat().filter(Boolean))];
}

export function interfaceSearchText(entry: InterfaceEntry): string {
  return [
    entry.name,
    entry.category,
    entry.plane,
    entry.spec,
    entry.description,
    ...entry.domains,
    entry.producerRole ?? '',
    ...(entry.endpoints ?? []).flat(),
  ].join(' ').toLowerCase();
}

/**
 * Interfaces that plausibly connect two resources.
 *
 * The recommendation only narrows what is shown first; it never blocks any
 * catalog entry and never invents a reference point. A pair whose endpoints are
 * unknown yields no recommendation at all, so the form falls back to the full
 * catalog instead of guessing.
 */
export function recommendInterfaces(
  catalog: InterfaceEntry[],
  from?: { domain?: string; role?: string } | null,
  to?: { domain?: string; role?: string } | null,
): string[] {
  if (!from || !to) return [];
  const fromDomain = (from.domain ?? '').trim().toLowerCase();
  const toDomain = (to.domain ?? '').trim().toLowerCase();
  if (!fromDomain || !toDomain) return [];
  const domains = [fromDomain, toDomain];
  const roles = [(from.role ?? '').trim().toLowerCase(), (to.role ?? '').trim().toLowerCase()];
  const recommended: string[] = [];

  for (const entry of catalog) {
    const covers = domains.every((domain) => entry.domains.some((candidate) => candidate.toLowerCase() === domain));
    if (!covers) continue;
    /* A producer-style service entry names one role, not the pair this form is
     * creating. Only entries that declare both endpoint roles can be suggested;
     * everything else stays selectable through the full catalog. */
    const pairs = entry.endpoints ?? [];
    const roleMatch = pairs.some((pair) => {
      const [left, right] = pair.map((role) => (role ?? '').trim().toLowerCase());
      return (left === roles[0] && right === roles[1]) || (left === roles[1] && right === roles[0]);
    });
    if (!roleMatch) continue;
    recommended.push(entry.name);
  }

  return recommended;
}