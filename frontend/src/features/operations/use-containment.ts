/*
 * Bounded declared-containment tree projection.
 *
 * The tree must describe the population, not one cursor page of the resource
 * table. The server composes Inventory nodes with active declared contains
 * edges; this hook only maps the payload into the presentation model.
 */
import { useRead } from '../../lib/api/use-read';
import { normalizeDomain, type OperationalResource } from './operational-model';

export type ContainmentCoverage = 'complete' | 'partial' | 'unavailable';

export type ContainmentResourceDto = {
  resourceId: string;
  name: string;
  displayName?: string;
  domain: string;
  kind: string;
  role?: string;
  lifecycleState: string;
};

export type ContainmentEdgeDto = {
  fromResourceId: string;
  toResourceId: string;
};

export type ContainmentResponse = {
  generatedAt: string;
  coverage: ContainmentCoverage;
  truncated: boolean;
  resources: ContainmentResourceDto[];
  edges: ContainmentEdgeDto[];
};

export function useContainment() {
  return useRead<ContainmentResponse>('/api/operations/containment');
}

/** Maps a tree node onto the same presentation model the table uses. */
export function toContainmentResources(
  resources: ContainmentResourceDto[] | undefined,
): OperationalResource[] {
  return (resources ?? []).map((resource) => ({
    resourceId: resource.resourceId,
    name: resource.name || resource.displayName || resource.resourceId,
    domain: normalizeDomain(resource.domain),
    kind: resource.kind,
    role: resource.role ?? '',
    nfType: resource.role ?? '',
    typeLabel: resource.role || resource.kind,
    lifecycleState: resource.lifecycleState,
    retired: resource.lifecycleState === 'retired',
    isNetworkFunction: resource.kind === 'network_function' || resource.kind === 'network_function_instance',
    isInstance: resource.kind === 'network_function_instance',
    monitoring: null,
    association: 'absent',
  }));
}
