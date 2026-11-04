/*
 * Deterministic relationship-label placement for the declared-topology canvas.
 *
 * Every label is anchored to a point on its own cubic edge path. Collisions
 * are resolved by sliding the label along that same path, so a relationship
 * name can never drift onto an unrelated edge.
 */
import {
  ACTUAL_NODE_HEIGHT,
  ACTUAL_NODE_WIDTH,
  type ActualTopologyLink,
  type ActualTopologyNode,
} from './actual-topology-model';
import { edgeInterfaceNames } from './interface-catalog';

export type Point = { x: number; y: number };

export type EdgeGeometry = {
  path: string;
  start: Point;
  control1: Point;
  control2: Point;
  end: Point;
};

export type EdgeLabelPlacement = {
  edgeId: string;
  label: string;
  labelX: number;
  labelY: number;
  width: number;
  height: number;
  t: number;
  /* Placement quality. A label that still overlaps a node card may be dropped
   * by the caller when it is not on the focused path; the inspector keeps the
   * full text either way. */
  nodeOverlaps: number;
  labelOverlaps: number;
};

export const EDGE_LABEL_HEIGHT = 18;

/* Below this zoom the canvas is a map, not a label sheet: only labels for the
 * selected, focused or hovered path stay readable. */
export const LABEL_DETAIL_MIN_ZOOM = 0.8;

export type LabelVisibilityOptions = {
  selectedResourceId?: string;
  focusedResourceId?: string;
  hoveredResourceId?: string;
  hoveredEdgeId?: string;
  showAllInterfaceNames?: boolean;
  zoom?: number;
};

export type LabelVisibility = {
  showAll: boolean;
  visibleEdgeIds: ReadonlySet<string>;
  hiddenCount: number;
};

export function resolveLabelVisibility(
  links: readonly ActualTopologyLink[],
  options: LabelVisibilityOptions = {},
): LabelVisibility {
  const zoom = options.zoom ?? 1;
  const showAll = Boolean(options.showAllInterfaceNames) && zoom >= LABEL_DETAIL_MIN_ZOOM;
  const activeResourceIds = [
    options.selectedResourceId,
    options.focusedResourceId,
    options.hoveredResourceId,
  ].filter((value): value is string => Boolean(value));
  const visibleEdgeIds = new Set<string>();
  for (const link of links) {
    const related = activeResourceIds.some(
      (resourceId) => link.fromResourceId === resourceId || link.toResourceId === resourceId,
    );
    const annotated = edgeInterfaceNames(link).length > 0;
    if (related || link.edgeId === options.hoveredEdgeId || (showAll && annotated)) {
      visibleEdgeIds.add(link.edgeId);
    }
  }
  return { showAll, visibleEdgeIds, hiddenCount: links.length - visibleEdgeIds.size };
}

const LABEL_MIN_T = 0.16;
const LABEL_MAX_T = 0.84;
const LABEL_T_STEP = 0.045;
const LABEL_ATTEMPTS = 14;
const LABEL_GAP = 2;
const CANVAS_MARGIN = 4;
const NODE_OVERLAP_PENALTY = 12;
const LABEL_OVERLAP_PENALTY = 120;
const OUT_OF_BOUNDS_PENALTY = 400;
const T_DRIFT_PENALTY = 20;

type Rect = { left: number; right: number; top: number; bottom: number };

export function labelWidth(label: string): number {
  let width = 0;
  for (const char of label) {
    width += /[\u3400-\u9fff]/.test(char) ? 10.5 : 6.6;
  }
  return Math.ceil(width + 16);
}

function parallelOffset(link: ActualTopologyLink): number {
  return (link.parallelIndex - (link.parallelCount - 1) / 2) * 26;
}

function boundaryPoint(
  node: ActualTopologyNode,
  towardX: number,
  towardY: number,
): Point {
  const centerX = node.x + ACTUAL_NODE_WIDTH / 2;
  const centerY = node.y + ACTUAL_NODE_HEIGHT / 2;
  const deltaX = towardX - centerX;
  const deltaY = towardY - centerY;
  if (deltaX === 0 && deltaY === 0) return { x: centerX, y: centerY };
  const ratioX = deltaX !== 0 ? ACTUAL_NODE_WIDTH / 2 / Math.abs(deltaX) : Number.POSITIVE_INFINITY;
  const ratioY = deltaY !== 0 ? ACTUAL_NODE_HEIGHT / 2 / Math.abs(deltaY) : Number.POSITIVE_INFINITY;
  const ratio = Math.min(ratioX, ratioY);
  return { x: centerX + deltaX * ratio, y: centerY + deltaY * ratio };
}

/* Two nodes belong to the same lane when both their band kind and their domain
 * band match. Lanes are laid out as separate rectangles, so a relationship that
 * crosses lanes must leave its lane before travelling sideways. */
function laneKey(node: ActualTopologyNode): string {
  return `${node.band}:${node.domainBand}`;
}

/* Cross-lane routing leaves through the side of the card that faces the other
 * lane and runs through the corridor between the two rows, so an inter-domain
 * relationship does not cut across the cards of the bands in between. */
function usesCorridor(link: ActualTopologyLink): boolean {
  const sourceCenterY = link.fromNode.y + ACTUAL_NODE_HEIGHT / 2;
  const targetCenterY = link.toNode.y + ACTUAL_NODE_HEIGHT / 2;
  return laneKey(link.fromNode) !== laneKey(link.toNode)
    && Math.abs(targetCenterY - sourceCenterY) > ACTUAL_NODE_HEIGHT * 0.75;
}

function corridorGeometry(link: ActualTopologyLink): EdgeGeometry {
  const sourceCenterX = link.fromNode.x + ACTUAL_NODE_WIDTH / 2;
  const sourceCenterY = link.fromNode.y + ACTUAL_NODE_HEIGHT / 2;
  const targetCenterX = link.toNode.x + ACTUAL_NODE_WIDTH / 2;
  const targetCenterY = link.toNode.y + ACTUAL_NODE_HEIGHT / 2;
  const offset = parallelOffset(link);
  const downward = targetCenterY > sourceCenterY;
  const start = {
    x: sourceCenterX,
    y: downward ? link.fromNode.y + ACTUAL_NODE_HEIGHT : link.fromNode.y,
  };
  const end = {
    x: targetCenterX,
    y: downward ? link.toNode.y : link.toNode.y + ACTUAL_NODE_HEIGHT,
  };
  const corridorY = (start.y + end.y) / 2;
  const control1 = { x: start.x + offset, y: corridorY };
  const control2 = { x: end.x + offset, y: corridorY };
  return {
    path: `M ${start.x} ${start.y} C ${control1.x} ${control1.y}, ${control2.x} ${control2.y}, ${end.x} ${end.y}`,
    start,
    control1,
    control2,
    end,
  };
}

function directGeometry(link: ActualTopologyLink): EdgeGeometry {
  const sourceCenterX = link.fromNode.x + ACTUAL_NODE_WIDTH / 2;
  const sourceCenterY = link.fromNode.y + ACTUAL_NODE_HEIGHT / 2;
  const targetCenterX = link.toNode.x + ACTUAL_NODE_WIDTH / 2;
  const targetCenterY = link.toNode.y + ACTUAL_NODE_HEIGHT / 2;
  const offset = parallelOffset(link);
  const start = boundaryPoint(link.fromNode, targetCenterX, targetCenterY);
  const end = boundaryPoint(link.toNode, sourceCenterX, sourceCenterY);

  if (Math.abs(targetCenterX - sourceCenterX) < 1) {
    const side = offset === 0 ? 1 : Math.sign(offset);
    const bulge = 120 + Math.abs(offset);
    const control1 = { x: start.x + side * bulge, y: start.y };
    const control2 = { x: end.x + side * bulge, y: end.y };
    return {
      path: `M ${start.x} ${start.y} C ${control1.x} ${control1.y}, ${control2.x} ${control2.y}, ${end.x} ${end.y}`,
      start,
      control1,
      control2,
      end,
    };
  }

  const deltaX = Math.max(40, Math.abs(targetCenterX - sourceCenterX) * 0.42);
  const direction = targetCenterX >= sourceCenterX ? 1 : -1;
  const control1 = { x: start.x + direction * deltaX, y: start.y + offset };
  const control2 = { x: end.x - direction * deltaX, y: end.y + offset };
  return {
    path: `M ${start.x} ${start.y} C ${control1.x} ${control1.y}, ${control2.x} ${control2.y}, ${end.x} ${end.y}`,
    start,
    control1,
    control2,
    end,
  };
}

export function edgeGeometry(link: ActualTopologyLink): EdgeGeometry {
  return usesCorridor(link) ? corridorGeometry(link) : directGeometry(link);
}

/* Card occlusion is the readability blocker: a line drawn through a card hides
 * its name, while two lines crossing in open space stay traceable. The corridor
 * therefore wins only when it measurably clears more cards than the direct
 * boundary curve on this layout; otherwise the direct curve is kept. */
const ROUTE_PROBE_STEPS = 12;

function occlusionCount(
  geometry: EdgeGeometry,
  link: ActualTopologyLink,
  nodes: readonly ActualTopologyNode[],
): number {
  const endpoints = new Set([link.fromResourceId, link.toResourceId]);
  const xs = [geometry.start.x, geometry.control1.x, geometry.control2.x, geometry.end.x];
  const ys = [geometry.start.y, geometry.control1.y, geometry.control2.y, geometry.end.y];
  const bounds = {
    left: Math.min(...xs),
    right: Math.max(...xs),
    top: Math.min(...ys),
    bottom: Math.max(...ys),
  };
  const probes: Point[] = [];
  for (let step = 1; step < ROUTE_PROBE_STEPS; step += 1) {
    probes.push(pointOnGeometry(geometry, step / ROUTE_PROBE_STEPS));
  }
  let hits = 0;
  for (const node of nodes) {
    if (endpoints.has(node.resourceId)) continue;
    /* A card outside the curve's own extent cannot be crossed; the filter keeps
     * the cost proportional to what the curve actually passes over. */
    if (node.x + ACTUAL_NODE_WIDTH < bounds.left || node.x > bounds.right) continue;
    if (node.y + ACTUAL_NODE_HEIGHT < bounds.top || node.y > bounds.bottom) continue;
    const right = node.x + ACTUAL_NODE_WIDTH;
    const bottom = node.y + ACTUAL_NODE_HEIGHT;
    for (const point of probes) {
      if (point.x > node.x && point.x < right && point.y > node.y && point.y < bottom) {
        hits += 1;
        break;
      }
    }
  }
  return hits;
}

export function routeGeometry(
  link: ActualTopologyLink,
  nodes?: readonly ActualTopologyNode[],
): EdgeGeometry {
  if (!nodes || nodes.length === 0 || !usesCorridor(link)) return edgeGeometry(link);
  const corridor = corridorGeometry(link);
  const direct = directGeometry(link);
  return occlusionCount(direct, link, nodes) < occlusionCount(corridor, link, nodes) ? direct : corridor;
}

export function pointOnGeometry(geometry: EdgeGeometry, t: number): Point {
  const mt = 1 - t;
  const a = mt * mt * mt;
  const b = 3 * mt * mt * t;
  const c = 3 * mt * t * t;
  const d = t * t * t;
  return {
    x: a * geometry.start.x + b * geometry.control1.x + c * geometry.control2.x + d * geometry.end.x,
    y: a * geometry.start.y + b * geometry.control1.y + c * geometry.control2.y + d * geometry.end.y,
  };
}

function labelRect(x: number, y: number, width: number, height: number): Rect {
  return { left: x - width / 2, right: x + width / 2, top: y - height / 2, bottom: y + height / 2 };
}

function overlaps(left: Rect, right: Rect, gap = 0): boolean {
  return left.left < right.right + gap
    && left.right + gap > right.left
    && left.top < right.bottom + gap
    && left.bottom + gap > right.top;
}

function candidateT(base: number, attempt: number): number {
  if (attempt === 0) return base;
  const distance = Math.ceil(attempt / 2) * LABEL_T_STEP;
  const raw = attempt % 2 === 1 ? base + distance : base - distance;
  return Math.min(LABEL_MAX_T, Math.max(LABEL_MIN_T, raw));
}

function groupBy(links: ActualTopologyLink[], key: 'fromResourceId' | 'toResourceId'): Map<string, ActualTopologyLink[]> {
  const groups = new Map<string, ActualTopologyLink[]>();
  for (const link of links) {
    const bucket = groups.get(link[key]);
    if (bucket) bucket.push(link);
    else groups.set(link[key], [link]);
  }
  return groups;
}

function spreadPosition(
  bucket: ActualTopologyLink[],
  link: ActualTopologyLink,
  rankY: (item: ActualTopologyLink) => number,
  rankId: (item: ActualTopologyLink) => string,
): number {
  if (bucket.length === 1) return 0.5;
  const ordered = [...bucket].sort((left, right) => rankY(left) - rankY(right) || rankId(left).localeCompare(rankId(right)));
  const index = ordered.findIndex((item) => item.edgeId === link.edgeId);
  if (index < 0) return 0.5;
  return 0.32 + (0.36 * index) / (ordered.length - 1);
}

function basePositions(links: ActualTopologyLink[]): Map<string, number> {
  const bySource = groupBy(links, 'fromResourceId');
  const byTarget = groupBy(links, 'toResourceId');
  const bases = new Map<string, number>();
  for (const link of links) {
    const siblings = bySource.get(link.fromResourceId) ?? [];
    if (siblings.length > 1) {
      bases.set(link.edgeId, spreadPosition(siblings, link, (item) => item.toNode.y, (item) => item.toResourceId));
      continue;
    }
    const converging = byTarget.get(link.toResourceId) ?? [];
    bases.set(link.edgeId, spreadPosition(converging, link, (item) => item.fromNode.y, (item) => item.fromResourceId));
  }
  return bases;
}

export function placeEdgeLabels(
  links: ActualTopologyLink[],
  labels: ReadonlyMap<string, string>,
  nodes: ActualTopologyNode[],
  canvasWidth: number,
  canvasHeight: number,
  /* Lower rank wins the earliest placement choice. The canvas ranks the
   * selected, focused and hovered path first, so a crowded graph keeps the
   * labels the operator is actually reading. Omitted, every label is equal. */
  rank?: (link: ActualTopologyLink) => number,
  /* Labels sit on the path the canvas actually drew, so a routed relationship
   * never carries its name on a line that is not on screen. */
  geometryOf: (link: ActualTopologyLink) => EdgeGeometry = edgeGeometry,
): EdgeLabelPlacement[] {
  const rankOf = (link: ActualTopologyLink) => (rank ? rank(link) : 0);
  const ordered = [...links].sort(
    (left, right) => rankOf(left) - rankOf(right)
      || left.fromResourceId.localeCompare(right.fromResourceId)
      || left.toResourceId.localeCompare(right.toResourceId)
      || left.edgeId.localeCompare(right.edgeId),
  );
  const bases = basePositions(ordered);
  const nodeRects = nodes.map((node) => ({
    left: node.x,
    right: node.x + ACTUAL_NODE_WIDTH,
    top: node.y,
    bottom: node.y + ACTUAL_NODE_HEIGHT,
  }));
  const placements: EdgeLabelPlacement[] = [];
  const placedRects: Rect[] = [];

  for (const link of ordered) {
    const label = labels.get(link.edgeId);
    if (!label) continue;
    const width = labelWidth(label);
    const height = EDGE_LABEL_HEIGHT;
    const geometry = geometryOf(link);
    const base = bases.get(link.edgeId) ?? 0.5;
    let best: {
      t: number;
      x: number;
      y: number;
      rect: Rect;
      score: number;
      nodeOverlaps: number;
      labelOverlaps: number;
    } | undefined;

    for (let attempt = 0; attempt < LABEL_ATTEMPTS; attempt += 1) {
      const t = candidateT(base, attempt);
      const point = pointOnGeometry(geometry, t);
      const rect = labelRect(point.x, point.y, width, height);
      const outOfBounds = rect.left < CANVAS_MARGIN
        || rect.right > canvasWidth - CANVAS_MARGIN
        || rect.top < CANVAS_MARGIN
        || rect.bottom > canvasHeight - CANVAS_MARGIN;
      const nodeOverlaps = nodeRects.filter((nodeRect) => overlaps(rect, nodeRect)).length;
      const labelOverlaps = placedRects.filter((placed) => overlaps(rect, placed, LABEL_GAP)).length;
      const score = (outOfBounds ? OUT_OF_BOUNDS_PENALTY : 0)
        + nodeOverlaps * NODE_OVERLAP_PENALTY
        + labelOverlaps * LABEL_OVERLAP_PENALTY
        + Math.abs(t - base) * T_DRIFT_PENALTY;
      if (!best || score < best.score) {
        best = { t, x: point.x, y: point.y, rect, score, nodeOverlaps, labelOverlaps };
      }
      if (score === 0) break;
    }

    if (!best) continue;
    placements.push({
      edgeId: link.edgeId,
      label,
      labelX: best.x,
      labelY: best.y,
      width,
      height,
      t: best.t,
      nodeOverlaps: best.nodeOverlaps,
      labelOverlaps: best.labelOverlaps,
    });
    placedRects.push(best.rect);
  }

  return placements;
}
