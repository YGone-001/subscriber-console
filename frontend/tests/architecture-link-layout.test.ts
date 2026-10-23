/*
 * Deterministic SBI bus geometry for the reference architecture.
 *
 * The Nnrf service interface must be aggregated without hiding any relationship
 * and without crossing node rectangles. These tests pin the geometry so a later
 * visual change cannot silently reintroduce the line tangle or block selection.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveArchitecture, type ArchitectureNodeView } from '../src/features/topology/architecture-model';
import {
  SBI_TRUNK_LEFT_X,
  SBI_TRUNK_RIGHT_X,
  SBI_TRUNK_TOP_Y,
  buildArchitectureBusLayout,
  segmentIntersectsNode,
} from '../src/features/topology/architecture-link-layout';
import { NODE_HEIGHT, NODE_WIDTH } from '../src/features/topology/reference-architecture';

function projection() {
  return resolveArchitecture({ resources: [] });
}

function pointInsideNode(node: ArchitectureNodeView, x: number, y: number, padding = 0): boolean {
  return x >= node.x - padding
    && x <= node.x + NODE_WIDTH + padding
    && y >= node.y - padding
    && y <= node.y + NODE_HEIGHT + padding;
}

test('the Nnrf relationships collapse onto one deterministic SBI bus', () => {
  const { nodes, links } = projection();
  const first = buildArchitectureBusLayout(nodes, links);
  const second = buildArchitectureBusLayout(nodes, links);

  assert.deepEqual(first, second, 'the same projection must produce the same geometry');
  assert.equal(first.aggregatedLinkCount, 7, 'every Nnrf link belongs to the bus');
  assert.equal(first.participantCount, 7, 'amf, smf, nrf, udm, ausf, pcf and scp participate');

  const stubs = new Map(first.stubs.map((stub) => [stub.role, stub]));
  assert.deepEqual(
    [...stubs.keys()],
    ['amf', 'ausf', 'nrf', 'pcf', 'scp', 'smf', 'udm'],
    'participants are ordered deterministically',
  );
  assert.equal(stubs.get('amf')?.port, 'top');
  assert.equal(stubs.get('nrf')?.port, 'top');
  assert.equal(stubs.get('ausf')?.port, 'right');
  assert.equal(stubs.get('pcf')?.port, 'right');
  assert.equal(stubs.get('scp')?.port, 'left');

  assert.deepEqual(
    first.trunkSegments.map((segment) => segment.path),
    [
      `M ${SBI_TRUNK_LEFT_X} ${SBI_TRUNK_TOP_Y} L ${SBI_TRUNK_RIGHT_X} ${SBI_TRUNK_TOP_Y}`,
      `M ${SBI_TRUNK_RIGHT_X} ${SBI_TRUNK_TOP_Y} L ${SBI_TRUNK_RIGHT_X} 418`,
      `M ${SBI_TRUNK_LEFT_X} ${SBI_TRUNK_TOP_Y} L ${SBI_TRUNK_LEFT_X} 418`,
    ],
    'the bus snapshot is stable',
  );
  assert.equal(first.label.text, 'Nnrf');
  assert.equal(first.label.count, 7);
});

test('every bus stub and trunk segment avoids unrelated node rectangles', () => {
  const { nodes, links } = projection();
  const layout = buildArchitectureBusLayout(nodes, links);
  const byRole = new Map(nodes.map((node) => [node.role, node]));

  for (const stub of layout.stubs) {
    const owner = byRole.get(stub.role);
    assert.ok(owner, `${stub.role} must exist`);
    assert.ok(owner.x <= stub.x && stub.x <= owner.x + NODE_WIDTH);
    assert.ok(owner.y <= stub.y && stub.y <= owner.y + NODE_HEIGHT);
    for (const node of nodes) {
      if (node.role === stub.role) continue;
      assert.equal(
        segmentIntersectsNode(stub.x, stub.y, stub.x2, stub.y2, node),
        false,
        `${stub.role} stub must not cross ${node.role}`,
      );
    }
  }

  for (const segment of layout.trunkSegments) {
    for (const node of nodes) {
      assert.equal(
        segmentIntersectsNode(segment.x1, segment.y1, segment.x2, segment.y2, node),
        false,
        `${segment.key} must not cross ${node.role}`,
      );
    }
  }
});

test('selecting a node expands only its own Nnrf relationships', () => {
  const { nodes, links } = projection();
  const nrf = buildArchitectureBusLayout(nodes, links, 'nrf');
  assert.equal(nrf.expanded.length, 6, 'NRF expands all six Nnrf neighbours');
  assert.ok(nrf.expanded.every((link) => link.source === 'nrf' || link.target === 'nrf'));

  const amf = buildArchitectureBusLayout(nodes, links, 'amf');
  assert.equal(amf.expanded.length, 1, 'AMF expands only its Nnrf relationship');
  assert.equal(amf.expanded[0].peerRole, 'nrf');

  const upf = buildArchitectureBusLayout(nodes, links, 'upf');
  assert.equal(upf.expanded.length, 0, 'a non-participant has nothing to expand');

  for (const link of nrf.expanded) {
    for (const node of nodes) {
      assert.equal(
        pointInsideNode(node, link.labelX, link.labelY, 4),
        false,
        `${link.key} label must not sit on ${node.role}`,
      );
    }
  }
});
