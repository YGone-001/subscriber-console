/*
 * One-hop topology visualization.
 *
 * A deterministic SVG layout is used instead of a heavyweight graph framework:
 * the root resource sits in the centre, inbound neighbors are laid out on the
 * left and outbound neighbors on the right, and every directed edge is drawn
 * from the relationships returned by the Topology API. No multi-hop engine, no
 * automatic discovery and no fabricated node exists here.
 *
 * The relationship table rendered beside this graph is the primary equivalent
 * semantic representation; this visualization is decorative-but-informative,
 * never the only way to reach the data.
 */
import { useMemo } from 'react';
import { useI18n } from '../../../providers/I18nProvider';
import type { Neighbor, ResourceProjection } from '../topology-types';
import { RELATIONSHIP_PRESENTATION } from '../topology-types';
import styles from '../../../styles/modules/topology.module.css';

const VIEW_WIDTH = 720;
const NODE_WIDTH = 152;
const NODE_HEIGHT = 56;
const COLUMN_GAP = 36;
const ROW_GAP = 74;
const PADDING_TOP = 56;
const MAX_PER_SIDE = 6;

interface TopologyGraphProps {
  root: ResourceProjection;
  neighbors: Neighbor[];
  selectedEdgeId?: string;
  onSelectEdge?: (edgeId: string) => void;
  onSelectResource?: (resourceId: string) => void;
}

interface PlacedNode {
  neighbor: Neighbor;
  x: number;
  y: number;
  side: 'inbound' | 'outbound';
}

function truncate(value: string, max = 18): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export function TopologyGraph({
  root,
  neighbors,
  selectedEdgeId,
  onSelectEdge,
  onSelectResource,
}: TopologyGraphProps) {
  const { t } = useI18n();

  const { placed, inboundOverflow, outboundOverflow, height, rootY } = useMemo(() => {
    const inbound = neighbors.filter((n) => n.direction === 'inbound');
    const outbound = neighbors.filter((n) => n.direction === 'outbound');
    const shownInbound = inbound.slice(0, MAX_PER_SIDE);
    const shownOutbound = outbound.slice(0, MAX_PER_SIDE);
    const rows = Math.max(shownInbound.length, shownOutbound.length, 1);
    const graphHeight = Math.max(320, PADDING_TOP * 2 + (rows - 1) * ROW_GAP + NODE_HEIGHT);
    const centerY = graphHeight / 2;
    const leftX = COLUMN_GAP;
    const rightX = VIEW_WIDTH - COLUMN_GAP - NODE_WIDTH;
    const columnStartY = centerY - ((rows - 1) * ROW_GAP) / 2;

    const nodes: PlacedNode[] = [];
    shownInbound.forEach((neighbor, index) => {
      nodes.push({ neighbor, x: leftX, y: columnStartY + index * ROW_GAP, side: 'inbound' });
    });
    shownOutbound.forEach((neighbor, index) => {
      nodes.push({ neighbor, x: rightX, y: columnStartY + index * ROW_GAP, side: 'outbound' });
    });

    return {
      placed: nodes,
      inboundOverflow: inbound.length - shownInbound.length,
      outboundOverflow: outbound.length - shownOutbound.length,
      height: graphHeight,
      rootY: centerY - NODE_HEIGHT / 2,
    };
  }, [neighbors]);

  const rootName = root.displayName || root.name || root.resourceId;
  const rootX = VIEW_WIDTH / 2 - NODE_WIDTH / 2;

  const relationshipLabel = (value: string) => {
    const presentation = RELATIONSHIP_PRESENTATION[value];
    return presentation ? t(presentation.labelKey) : value;
  };

  return (
    <div className={styles.graphWrap}>
      <svg
        className={styles.graph}
        viewBox={`0 0 ${VIEW_WIDTH} ${height}`}
        role="img"
        aria-label={t('topology_graph_aria', { name: rootName })}
        preserveAspectRatio="xMidYMid meet"
      >
        <defs>
          <marker
            id="topology-arrow"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" className={styles.arrowHead} />
          </marker>
          <marker
            id="topology-arrow-selected"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" className={styles.arrowHeadSelected} />
          </marker>
        </defs>

        {placed.map(({ neighbor, x, y, side }) => {
          const selected = neighbor.edge.edgeId === selectedEdgeId;
          const fromX = side === 'outbound' ? rootX + NODE_WIDTH : x + NODE_WIDTH;
          const toX = side === 'outbound' ? x : rootX;
          const fromY = rootY + NODE_HEIGHT / 2;
          const toY = y + NODE_HEIGHT / 2;
          const midX = (fromX + toX) / 2;
          return (
            <g key={neighbor.edge.edgeId}>
              <line
                x1={fromX}
                y1={fromY}
                x2={toX}
                y2={toY}
                className={selected ? styles.edgeSelected : styles.edge}
                markerEnd={`url(#${selected ? 'topology-arrow-selected' : 'topology-arrow'})`}
              />
              <text
                x={midX}
                y={(fromY + toY) / 2 - 8}
                className={selected ? styles.edgeLabelSelected : styles.edgeLabel}
                textAnchor="middle"
              >
                {relationshipLabel(neighbor.edge.relationshipType)}
              </text>
            </g>
          );
        })}

        <g
          className={styles.nodeRoot}
          role="button"
          tabIndex={0}
          aria-label={`${t('topology_graph_root')}: ${rootName}`}
          onClick={() => onSelectResource?.(root.resourceId)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              onSelectResource?.(root.resourceId);
            }
          }}
        >
          <rect x={rootX} y={rootY} width={NODE_WIDTH} height={NODE_HEIGHT} rx="10" className={styles.rootBox} />
          <text x={rootX + NODE_WIDTH / 2} y={rootY + 23} className={styles.nodeTitle} textAnchor="middle">
            {truncate(rootName)}
          </text>
          <text x={rootX + NODE_WIDTH / 2} y={rootY + 41} className={styles.nodeMeta} textAnchor="middle">
            {root.kind} · {root.domain}
          </text>
        </g>

        {placed.map(({ neighbor, x, y }) => {
          const selected = neighbor.edge.edgeId === selectedEdgeId;
          const name = neighbor.neighborResource.displayName || neighbor.neighborResource.name || neighbor.neighborResource.resourceId;
          return (
            <g
              key={`node-${neighbor.edge.edgeId}`}
              className={styles.node}
              role="button"
              tabIndex={0}
              aria-label={`${relationshipLabel(neighbor.edge.relationshipType)}: ${name}`}
              onClick={() => {
                onSelectEdge?.(neighbor.edge.edgeId);
                onSelectResource?.(neighbor.neighborResource.resourceId);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onSelectEdge?.(neighbor.edge.edgeId);
                }
              }}
            >
              <rect
                x={x}
                y={y}
                width={NODE_WIDTH}
                height={NODE_HEIGHT}
                rx="10"
                className={selected ? styles.nodeBoxSelected : styles.nodeBox}
              />
              <text x={x + 12} y={y + 23} className={styles.nodeTitle} textAnchor="start">
                {truncate(name)}
              </text>
              <text x={x + 12} y={y + 41} className={styles.nodeMeta} textAnchor="start">
                {neighbor.neighborResource.kind} · {neighbor.neighborResource.domain}
              </text>
            </g>
          );
        })}
      </svg>

      {inboundOverflow > 0 || outboundOverflow > 0 ? (
        <p className={styles.graphOverflow} role="status">
          {t('topology_graph_overflow', {
            inbound: inboundOverflow,
            outbound: outboundOverflow,
          })}
        </p>
      ) : null}
    </div>
  );
}

export default TopologyGraph;
