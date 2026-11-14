/*
 * Bounded declared-containment tree projection.
 *
 * The tree must describe the population, not one cursor page of the resource
 * table. The server composes Inventory nodes with active declared contains
 * edges; this hook only maps the payload into the presentation model.
 *
 * The tree is read one level at a time. The root level carries the roots and
 * each node's exact declared child count; a node's children are fetched only
 * when it is expanded. A large hierarchy therefore costs one small request
 * plus one request per expanded node, instead of the whole graph up front.
 */
import { useCallback, useMemo, useState } from 'react';
import { useRead } from '../../lib/api/use-read';
import { getJson } from '../../lib/api/read-client';
import { normalizeDomain, type OperationalResource, type TreeNode } from './operational-model';

export type ContainmentCoverage = 'complete' | 'partial' | 'unavailable';

export type ContainmentResourceDto = {
  resourceId: string;
  name: string;
  displayName?: string;
  domain: string;
  kind: string;
  role?: string;
  lifecycleState: string;
  /** Number of direct declared contains children. */
  childCount: number;
};

export type ContainmentEdgeDto = {
  fromResourceId: string;
  toResourceId: string;
};

export type ContainmentResponse = {
  generatedAt: string;
  coverage: ContainmentCoverage;
  truncated: boolean;
  /** Exact count of non-retired resources with no active relationship. */
  unlinkedCount: number;
  /** The same population as unlinkedCount, bounded to a readable sample. */
  unlinkedResources: ContainmentResourceDto[];
  resources: ContainmentResourceDto[];
  edges: ContainmentEdgeDto[];
};

/**
 * Reads one level of the containment tree. Without a parentId the response
 * carries the root-level nodes; with a parentId it carries that node's direct
 * children. Each resource reports its own childCount so the tree can render an
 * expand affordance without loading the next level.
 */
export function useContainment(parentId?: string) {
  const path = parentId
    ? `/api/operations/containment?parentId=${encodeURIComponent(parentId)}`
    : '/api/operations/containment';
  return useRead<ContainmentResponse>(path);
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

/** Converts one containment level into tree nodes. */
export function toContainmentNodes(
  resources: ContainmentResourceDto[] | undefined,
): TreeNode[] {
  return (resources ?? []).map((resource) => ({
    id: resource.resourceId,
    label: resource.displayName || resource.name || resource.resourceId,
    kind: resource.kind,
    domain: normalizeDomain(resource.domain),
    resourceId: resource.resourceId,
    children: [],
    childCount: resource.childCount ?? 0,
    childrenLoaded: false,
    virtual: false,
  }));
}

export type ContainmentTree = {
  /** Root-level nodes. */
  nodes: TreeNode[];
  /** Exact count of resources referenced by no active contains edge. */
  unlinkedCount: number;
  coverage: ContainmentCoverage;
  truncated: boolean;
  loading: boolean;
  error: boolean;
  /** Loads the direct children of a node that has not been expanded yet. */
  loadChildren: (resourceId: string) => void;
  /** The loaded children of a node, or an empty list when not loaded yet. */
  childrenOf: (resourceId: string) => TreeNode[];
  /** True when the node's children have already been loaded. */
  isLoaded: (resourceId: string) => boolean;
  /** Reloads the root level and drops every loaded child level. */
  refresh: () => void;
};

/**
 * Loads the containment tree lazily. The root level is read once; each node's
 * children are read the first time that node is expanded.
 */
export function useContainmentTree(): ContainmentTree {
  const root = useContainment();
  const [children, setChildren] = useState<Record<string, TreeNode[]>>({});
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [failed, setFailed] = useState<Record<string, boolean>>({});

  const loadChildren = useCallback((resourceId: string) => {
    if (children[resourceId] || pending[resourceId] || failed[resourceId]) return;
    setPending((current) => ({ ...current, [resourceId]: true }));
    void getJson<ContainmentResponse>(
      `/api/operations/containment?parentId=${encodeURIComponent(resourceId)}`,
    )
      .then((res) => {
        setChildren((current) => ({
          ...current,
          [resourceId]: toContainmentNodes(res.resources),
        }));
        setFailed((current) => ({ ...current, [resourceId]: false }));
      })
      .catch(() => {
        setFailed((current) => ({ ...current, [resourceId]: true }));
      })
      .finally(() => {
        setPending((current) => ({ ...current, [resourceId]: false }));
      });
  }, [children, pending, failed]);

  const childrenOf = useCallback(
    (resourceId: string) => children[resourceId] ?? [],
    [children],
  );
  const isLoaded = useCallback((resourceId: string) => Boolean(children[resourceId]), [children]);

  /* The refresh handle must stay referentially stable: the page wires it into
   * a polling interval, and a new identity on every render would restart that
   * interval forever. SWR's mutate is stable, so only it is captured. */
  const mutateRoot = root.mutate;
  const refresh = useCallback(() => {
    setChildren({});
    setFailed({});
    void mutateRoot();
  }, [mutateRoot]);

  const nodes = useMemo(
    () => (root.data?.resources ?? []).map((resource) => {
      const node = toContainmentNodes([resource])[0];
      const loaded = children[resource.resourceId];
      return {
        ...node,
        children: loaded ?? [],
        childrenLoaded: Boolean(loaded),
      };
    }),
    [root.data, children],
  );

  return useMemo(() => ({
    nodes,
    unlinkedCount: root.data?.unlinkedCount ?? 0,
    coverage: root.data?.coverage ?? (root.error ? 'unavailable' : 'partial'),
    truncated: Boolean(root.data?.truncated),
    loading: root.isLoading,
    error: Boolean(root.error),
    loadChildren,
    childrenOf,
    isLoaded,
    refresh,
  }), [
    nodes,
    root.data,
    root.error,
    root.isLoading,
    loadChildren,
    childrenOf,
    isLoaded,
    refresh,
  ]);
}
