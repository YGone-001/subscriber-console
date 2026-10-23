/*
 * Deterministic geometry for the 5G reference architecture.
 *
 * The NRF service interface (`Nnrf`) is a service-based relationship, not a
 * point-to-point cable. Drawing every Nnrf link as its own line makes the
 * reference view unreadable because each line crosses the same node columns.
 * This module aggregates those links onto one shared SBI bus: each participant
 * gets a short stub to a trunk, and the selected node expands its own Nnrf
 * relationships back into individual curves.
 *
 * Pure geometry only: no React, no data fetching, no claim about deployment
 * connectivity. Point-to-point interfaces stay independent.
 */
import type {
  ArchitectureLinkEvidence,
  ArchitectureLinkView,
  ArchitectureNodeView,
} from './architecture-model';
import { NODE_HEIGHT, NODE_WIDTH } from './reference-architecture';

export type Point = { x: number; y: number };

export type ArchitectureBusPort = 'top' | 'right' | 'left';

export type ArchitectureBusSegment = {
  key: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  path: string;
};

export type ArchitectureBusStub = {
  role: string;
  port: ArchitectureBusPort;
  x: number;
  y: number;
  x2: number;
  y2: number;
  path: string;
  /** Strongest evidence among the aggregated links attached to this node. */
  evidence: ArchitectureLinkEvidence;
  links: string[];
};

export type ArchitectureExpandedLink = {
  key: string;
  source: string;
  target: string;
  peerRole: string;
  label: string;
  path: string;
  labelX: number;
  labelY: number;
  evidence: ArchitectureLinkEvidence;
};

export type ArchitectureBusLayout = {
  aggregatedKeys: string[];
  aggregatedLinkCount: number;
  participantCount: number;
  trunkSegments: ArchitectureBusSegment[];
  stubs: ArchitectureBusStub[];
  expanded: ArchitectureExpandedLink[];
  label: { x: number; y: number; text: string; count: number };
};

/** Interfaces drawn through the shared service bus instead of individually. */
export const SBI_INTERFACE_LABELS: ReadonlySet<string> = new Set(['Nnrf']);

export const SBI_TRUNK_TOP_Y = 28;
export const SBI_TRUNK_RIGHT_X = 742;
export const SBI_TRUNK_LEFT_X = 378;

const LABEL_STOPS = [0.45, 0.55, 0.35, 0.65, 0.25, 0.75, 0.15, 0.85];

/* Expanded Nnrf curves share the same two endpoints, so their labels are spread
 * across different points of the curve instead of stacking at the midpoint. */
const EXPANDED_LABEL_STOPS = [0.6, 0.45, 0.7, 0.38, 0.76, 0.32];

function pointOnQuadratic(start: Point, control: Point, end: Point, t: number): Point {
  const mt = 1 - t;
  return {
    x: mt * mt * start.x + 2 * mt * t * control.x + t * t * end.x,
    y: mt * mt * start.y + 2 * mt * t * control.y + t * t * end.y,
  };
}

const EVIDENCE_STRENGTH: Record<ArchitectureLinkEvidence, number> = {
  declared: 5,
  bound: 4,
  observed: 3,
  unresolved: 2,
  reference: 1,
};

export function isAggregatedLink(link: ArchitectureLinkView): boolean {
  return SBI_INTERFACE_LABELS.has(link.interfaceLabel);
}

export function center(node: ArchitectureNodeView): Point {
  return { x: node.x + NODE_WIDTH / 2, y: node.y + NODE_HEIGHT / 2 };
}

/** Clips a segment to the rectangle boundary so links never run under a node. */
export function clipToNode(from: Point, to: Point): Point {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (dx === 0 && dy === 0) return from;
  const halfWidth = NODE_WIDTH / 2;
  const halfHeight = NODE_HEIGHT / 2;
  const tx = dx === 0 ? Number.POSITIVE_INFINITY : halfWidth / Math.abs(dx);
  const ty = dy === 0 ? Number.POSITIVE_INFINITY : halfHeight / Math.abs(dy);
  const t = Math.min(tx, ty);
  return { x: from.x + dx * t, y: from.y + dy * t };
}

function insideNode(point: Point, nodes: ArchitectureNodeView[], padding: number): boolean {
  return nodes.some((node) => (
    point.x >= node.x - padding
    && point.x <= node.x + NODE_WIDTH + padding
    && point.y >= node.y - padding
    && point.y <= node.y + NODE_HEIGHT + padding
  ));
}

/** Chooses a deterministic label anchor that avoids node rectangles. */
export function placeLinkLabel(
  from: Point,
  to: Point,
  nodes: ArchitectureNodeView[],
): Point {
  for (const stop of LABEL_STOPS) {
    const point = {
      x: from.x + (to.x - from.x) * stop,
      y: from.y + (to.y - from.y) * stop,
    };
    if (!insideNode(point, nodes, 6)) return point;
  }
  return { x: from.x + (to.x - from.x) * 0.45, y: from.y + (to.y - from.y) * 0.45 };
}

function rangesOverlap(start: number, end: number, min: number, max: number): boolean {
  return Math.max(start, end) > min && Math.min(start, end) < max;
}

/**
 * True when an axis-aligned segment crosses a node interior.
 *
 * A segment that only touches an edge (the owning node's own port) does not
 * count as an intersection, so a stub can leave its own node cleanly.
 */
export function segmentIntersectsNode(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  node: ArchitectureNodeView,
  padding = 1,
): boolean {
  const left = node.x - padding;
  const right = node.x + NODE_WIDTH + padding;
  const top = node.y - padding;
  const bottom = node.y + NODE_HEIGHT + padding;
  if (x1 === x2) {
    return x1 > left && x1 < right && rangesOverlap(y1, y2, top, bottom);
  }
  if (y1 === y2) {
    return y1 > top && y1 < bottom && rangesOverlap(x1, x2, left, right);
  }
  return false;
}

function segmentHitsAnyNode(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  nodes: ArchitectureNodeView[],
  ownRole: string,
): boolean {
  return nodes.some((node) => node.role !== ownRole && segmentIntersectsNode(x1, y1, x2, y2, node));
}

function linePath(x1: number, y1: number, x2: number, y2: number): string {
  return `M ${x1} ${y1} L ${x2} ${y2}`;
}

type PortCandidate = {
  port: ArchitectureBusPort;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  hits: number;
};

function portCandidate(
  node: ArchitectureNodeView,
  port: ArchitectureBusPort,
  nodes: ArchitectureNodeView[],
): PortCandidate {
  const cx = node.x + NODE_WIDTH / 2;
  const cy = node.y + NODE_HEIGHT / 2;
  if (port === 'top') {
    const x = cx;
    return {
      port,
      x1: x,
      y1: node.y,
      x2: x,
      y2: SBI_TRUNK_TOP_Y,
      hits: segmentHitsAnyNode(x, node.y, x, SBI_TRUNK_TOP_Y, nodes, node.role) ? 1 : 0,
    };
  }
  if (port === 'right') {
    const y = cy;
    return {
      port,
      x1: node.x + NODE_WIDTH,
      y1: y,
      x2: SBI_TRUNK_RIGHT_X,
      y2: y,
      hits: segmentHitsAnyNode(node.x + NODE_WIDTH, y, SBI_TRUNK_RIGHT_X, y, nodes, node.role) ? 1 : 0,
    };
  }
  const y = cy;
  return {
    port,
    x1: node.x,
    y1: y,
    x2: SBI_TRUNK_LEFT_X,
    y2: y,
    hits: segmentHitsAnyNode(node.x, y, SBI_TRUNK_LEFT_X, y, nodes, node.role) ? 1 : 0,
  };
}

function strongestEvidence(links: ArchitectureLinkView[]): ArchitectureLinkEvidence {
  let strongest: ArchitectureLinkEvidence = 'reference';
  for (const link of links) {
    if (EVIDENCE_STRENGTH[link.evidence] > EVIDENCE_STRENGTH[strongest]) {
      strongest = link.evidence;
    }
  }
  return strongest;
}

/**
 * Builds the SBI bus, its stubs and the expanded Nnrf relationships of the
 * selected role. The port order is fixed (top, right, left), so the layout is
 * deterministic for the same node set and view.
 */
export function buildArchitectureBusLayout(
  nodes: ArchitectureNodeView[],
  links: ArchitectureLinkView[],
  selectedRole?: string,
): ArchitectureBusLayout {
  const aggregated = links.filter(isAggregatedLink);
  const byRole = new Map(nodes.map((node) => [node.role, node]));
  const linksByRole = new Map<string, ArchitectureLinkView[]>();
  for (const link of aggregated) {
    for (const role of [link.source, link.target]) {
      if (!byRole.has(role)) continue;
      const bucket = linksByRole.get(role);
      if (bucket) bucket.push(link);
      else linksByRole.set(role, [link]);
    }
  }

  const stubs: ArchitectureBusStub[] = [];
  const roles = [...linksByRole.keys()].sort((left, right) => left.localeCompare(right));
  for (const role of roles) {
    const node = byRole.get(role);
    if (!node) continue;
    const roleLinks = linksByRole.get(role) ?? [];
    const candidates = [
      portCandidate(node, 'top', nodes),
      portCandidate(node, 'right', nodes),
      portCandidate(node, 'left', nodes),
    ];
    const chosen = candidates.reduce((best, candidate) => (
      candidate.hits < best.hits ? candidate : best
    ), candidates[0]);
    stubs.push({
      role,
      port: chosen.port,
      x: chosen.x1,
      y: chosen.y1,
      x2: chosen.x2,
      y2: chosen.y2,
      path: linePath(chosen.x1, chosen.y1, chosen.x2, chosen.y2),
      evidence: strongestEvidence(roleLinks),
      links: roleLinks.map((link) => link.key).sort(),
    });
  }

  const topXs = stubs.filter((stub) => stub.port === 'top').map((stub) => stub.x);
  const rightYs = stubs.filter((stub) => stub.port === 'right').map((stub) => stub.y);
  const leftYs = stubs.filter((stub) => stub.port === 'left').map((stub) => stub.y);
  const trunkSegments: ArchitectureBusSegment[] = [];
  if (stubs.length > 0) {
    const leftEdge = leftYs.length > 0 ? SBI_TRUNK_LEFT_X : Math.min(...topXs, SBI_TRUNK_RIGHT_X);
    trunkSegments.push({
      key: 'trunk-top',
      x1: leftEdge,
      y1: SBI_TRUNK_TOP_Y,
      x2: SBI_TRUNK_RIGHT_X,
      y2: SBI_TRUNK_TOP_Y,
      path: linePath(leftEdge, SBI_TRUNK_TOP_Y, SBI_TRUNK_RIGHT_X, SBI_TRUNK_TOP_Y),
    });
    if (rightYs.length > 0) {
      const bottom = Math.max(...rightYs);
      trunkSegments.push({
        key: 'trunk-right',
        x1: SBI_TRUNK_RIGHT_X,
        y1: SBI_TRUNK_TOP_Y,
        x2: SBI_TRUNK_RIGHT_X,
        y2: bottom,
        path: linePath(SBI_TRUNK_RIGHT_X, SBI_TRUNK_TOP_Y, SBI_TRUNK_RIGHT_X, bottom),
      });
    }
    if (leftYs.length > 0) {
      const bottom = Math.max(...leftYs);
      trunkSegments.push({
        key: 'trunk-left',
        x1: SBI_TRUNK_LEFT_X,
        y1: SBI_TRUNK_TOP_Y,
        x2: SBI_TRUNK_LEFT_X,
        y2: bottom,
        path: linePath(SBI_TRUNK_LEFT_X, SBI_TRUNK_TOP_Y, SBI_TRUNK_LEFT_X, bottom),
      });
    }
  }

  const expanded: ArchitectureExpandedLink[] = [];
  if (selectedRole) {
    const selected = byRole.get(selectedRole);
    if (selected) {
      const selectedLinks = aggregated.filter((link) => (
        link.source === selectedRole || link.target === selectedRole
      ));
      selectedLinks.forEach((link, index) => {
        const peerRole = link.source === selectedRole ? link.target : link.source;
        const peer = byRole.get(peerRole);
        if (!peer) return;
        const start = clipToNode(center(selected), center(peer));
        const end = clipToNode(center(peer), center(selected));
        const dx = end.x - start.x;
        const dy = end.y - start.y;
        const length = Math.hypot(dx, dy) || 1;
        const offset = (index % 2 === 0 ? 1 : -1) * (18 + Math.floor(index / 2) * 6);
        const control = {
          x: (start.x + end.x) / 2 - (dy / length) * offset,
          y: (start.y + end.y) / 2 + (dx / length) * offset,
        };
        const baseT = EXPANDED_LABEL_STOPS[index % EXPANDED_LABEL_STOPS.length];
        const labelCandidates = [
          baseT,
          ...EXPANDED_LABEL_STOPS.filter((value) => value !== baseT),
        ];
        const labelPoint = labelCandidates
          .map((value) => pointOnQuadratic(start, control, end, value))
          .find((point) => !insideNode(point, nodes, 6))
          ?? placeLinkLabel(start, end, nodes);
        expanded.push({
          key: link.key,
          source: link.source,
          target: link.target,
          peerRole,
          label: link.interfaceLabel,
          path: `M ${start.x} ${start.y} Q ${control.x} ${control.y} ${end.x} ${end.y}`,
          labelX: labelPoint.x,
          labelY: labelPoint.y - 5,
          evidence: link.evidence,
        });
      });
    }
  }

  return {
    aggregatedKeys: aggregated.map((link) => link.key),
    aggregatedLinkCount: aggregated.length,
    participantCount: stubs.length,
    trunkSegments,
    stubs,
    expanded,
    label: {
      x: SBI_TRUNK_RIGHT_X - 6,
      y: SBI_TRUNK_TOP_Y - 8,
      text: [...SBI_INTERFACE_LABELS].join(' / '),
      count: aggregated.length,
    },
  };
}
