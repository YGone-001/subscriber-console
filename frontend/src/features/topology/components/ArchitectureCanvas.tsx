/*
 * 3GPP reference architecture canvas.
 *
 * A deterministic SVG rendering of the static reference skeleton with the
 * projected Inventory binding and NF Health state overlaid. It is deliberately
 * not a graph layout engine: the coordinates come from the reference data, so
 * the same deployment always renders the same picture and the canvas can be
 * verified by counting nodes and links.
 *
 * The canvas is never the only representation: the detail panel beside it
 * carries the same facts as text, and every node is keyboard reachable.
 */
import { useI18n } from '../../../providers/I18nProvider';
import {
  CANVAS_HEIGHT,
  CANVAS_WIDTH,
  NODE_HEIGHT,
  NODE_WIDTH,
} from '../reference-architecture';
import {
  domainLabelKey,
  stateLabelKey,
  type ArchitectureLinkView,
  type ArchitectureNodeView,
  type NodeTone,
} from '../architecture-model';
import styles from '../../../styles/modules/architecture.module.css';

const TONE_CLASS: Record<NodeTone, string> = {
  unregistered: styles.toneUnregistered,
  observed: styles.toneObserved,
  unmonitored: styles.toneUnmonitored,
  unresolved: styles.toneUnresolved,
  healthy: styles.toneHealthy,
  degraded: styles.toneDegraded,
  unhealthy: styles.toneUnhealthy,
  stale: styles.toneStale,
  unknown: styles.toneUnknown,
};

const DOMAIN_CLASS: Record<string, string> = {
  cp: styles.domainCp,
  sp: styles.domainSp,
  up: styles.domainUp,
  dm: styles.domainDm,
  legacy: styles.domainLegacy,
};

type Point = { x: number; y: number };

function center(node: ArchitectureNodeView): Point {
  return { x: node.x + NODE_WIDTH / 2, y: node.y + NODE_HEIGHT / 2 };
}

/** Clips a segment to the rectangle boundary so links never run under a node. */
function clipToNode(from: Point, to: Point): Point {
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

const LABEL_STOPS = [0.45, 0.55, 0.35, 0.65, 0.25, 0.75, 0.15, 0.85];

function insideNode(point: Point, nodes: ArchitectureNodeView[], padding: number): boolean {
  return nodes.some((node) => (
    point.x >= node.x - padding
    && point.x <= node.x + NODE_WIDTH + padding
    && point.y >= node.y - padding
    && point.y <= node.y + NODE_HEIGHT + padding
  ));
}

/**
 * Chooses a label anchor along the segment that does not sit on top of a node.
 *
 * The candidates are deterministic, so the same layout always produces the same
 * label positions and the placement can be asserted in tests.
 */
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

export function ArchitectureCanvas({
  nodes,
  links,
  selectedRole,
  onSelect,
}: {
  nodes: ArchitectureNodeView[];
  links: ArchitectureLinkView[];
  selectedRole?: string;
  onSelect?: (role: string) => void;
}) {
  const { t } = useI18n();
  const byRole = new Map(nodes.map((node) => [node.role, node]));

  return (
    <div className={styles.canvasWrap}>
      <svg
        className={styles.canvas}
        viewBox={`0 0 ${CANVAS_WIDTH} ${CANVAS_HEIGHT}`}
        role="img"
        aria-label={t('arch_canvas_aria')}
        preserveAspectRatio="xMidYMid meet"
      >
        <title>{t('arch_canvas_aria')}</title>
        <desc>{t('arch_canvas_desc')}</desc>

        <g aria-hidden="true">
          {links.map((link) => {
            const source = byRole.get(link.source);
            const target = byRole.get(link.target);
            if (!source || !target) return null;
            const from = clipToNode(center(source), center(target));
            const to = clipToNode(center(target), center(source));
            const anchor = placeLinkLabel(from, to, nodes);
            const labelX = anchor.x;
            const labelY = anchor.y - 5;
            const width = link.interfaceLabel.length * 5.6 + 8;
            return (
              <g key={link.key}>
                <line
                  x1={from.x}
                  y1={from.y}
                  x2={to.x}
                  y2={to.y}
                  className={link.declared ? styles.linkDeclared : styles.linkReference}
                />
                <rect
                  x={labelX - width / 2}
                  y={labelY - 9}
                  width={width}
                  height={13}
                  rx={3}
                  className={styles.linkLabelBackdrop}
                />
                <text x={labelX} y={labelY} textAnchor="middle" className={styles.linkLabel}>
                  {link.interfaceLabel}
                </text>
              </g>
            );
          })}
        </g>

        {nodes.map((node) => {
          const selected = node.role === selectedRole;
          const stateText = t(stateLabelKey(node.tone));
          const ariaLabel = `${node.label} ${t(domainLabelKey(node.domain))}: ${stateText}`;
          const activate = () => onSelect?.(node.role);
          return (
            <g
              key={node.role}
              role="button"
              tabIndex={0}
              aria-label={ariaLabel}
              aria-pressed={selected}
              className={`${styles.node} ${TONE_CLASS[node.tone]} ${DOMAIN_CLASS[node.domain]} ${selected ? styles.nodeSelected : ''}`}
              onClick={activate}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  activate();
                }
              }}
            >
              <rect
                x={node.x}
                y={node.y}
                width={NODE_WIDTH}
                height={NODE_HEIGHT}
                rx={10}
                className={styles.nodeRect}
              />
              <rect
                x={node.x}
                y={node.y + 8}
                width={3.5}
                height={NODE_HEIGHT - 16}
                rx={1.75}
                className={styles.nodeBar}
              />
              <text x={node.x + 14} y={node.y + 23} className={styles.nodeLabel}>
                {node.label}
              </text>
              <text x={node.x + 14} y={node.y + 41} className={styles.nodeState}>
                {stateText}
              </text>
              <circle cx={node.x + NODE_WIDTH - 14} cy={node.y + 16} r={4} className={styles.nodeDot} />
            </g>
          );
        })}
      </svg>
    </div>
  );
}

export default ArchitectureCanvas;
