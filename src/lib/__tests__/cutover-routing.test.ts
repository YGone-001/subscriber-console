import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRouteOwner, CUTOVER_TABLE } from '../cutover-routing';

describe('cutover-routing', () => {
  describe('CUTOVER_TABLE', () => {
    it('contains exactly 2 pilot routes', () => {
      assert.equal(CUTOVER_TABLE.length, 2);
    });

    it('Pilot A: POST /api/profiles/:name/versions/:versionId/restore is owned by Go', () => {
      const pilotA = CUTOVER_TABLE.find(
        (r) => r.path === '/api/profiles/{name}/versions/{versionId}/restore'
      );
      assert.ok(pilotA, 'Pilot A must exist');
      assert.equal(pilotA.method, 'POST');
      assert.equal(pilotA.owner, 'go');
    });

    it('Pilot B: POST /api/subscribers/:imsi/profile is owned by Go', () => {
      const pilotB = CUTOVER_TABLE.find(
        (r) => r.path === '/api/subscribers/{imsi}/profile'
      );
      assert.ok(pilotB, 'Pilot B must exist');
      assert.equal(pilotB.method, 'POST');
      assert.equal(pilotB.owner, 'go');
    });
  });

  describe('resolveRouteOwner', () => {
    // ── Pilot A: Profile Restore ──────────────────────────────────
    it('routes POST /api/profiles/{name}/versions/{id}/restore to Go', () => {
      assert.equal(
        resolveRouteOwner('POST', '/api/profiles/MyProfile/versions/abc123/restore'),
        'go'
      );
    });

    it('routes POST /api/profiles with special chars in name to Go', () => {
      assert.equal(
        resolveRouteOwner('POST', '/api/profiles/Profile_1-2/versions/v1/restore'),
        'go'
      );
    });

    // ── Pilot B: Subscriber Profile Apply ─────────────────────────
    it('routes POST /api/subscribers/{imsi}/profile to Go', () => {
      assert.equal(
        resolveRouteOwner('POST', '/api/subscribers/208930000000001/profile'),
        'go'
      );
    });

    // ── Non-cutover routes stay with Node ─────────────────────────
    it('routes GET /api/profiles to Node', () => {
      assert.equal(resolveRouteOwner('GET', '/api/profiles'), 'node');
    });

    it('routes GET /api/subscribers/:imsi to Node', () => {
      assert.equal(resolveRouteOwner('GET', '/api/subscribers/208930000000001'), 'node');
    });

    it('routes POST /api/subscribers to Node (create)', () => {
      assert.equal(resolveRouteOwner('POST', '/api/subscribers'), 'node');
    });

    it('routes PUT /api/subscribers/:imsi to Node (update)', () => {
      assert.equal(resolveRouteOwner('PUT', '/api/subscribers/208930000000001'), 'node');
    });

    it('routes DELETE /api/profiles/:name to Node', () => {
      assert.equal(resolveRouteOwner('DELETE', '/api/profiles/MyProfile'), 'node');
    });

    it('routes POST /api/approvals/:id/approve to Node', () => {
      assert.equal(resolveRouteOwner('POST', '/api/approvals/123/approve'), 'node');
    });

    // ── Method mismatch ───────────────────────────────────────────
    it('routes GET /api/profiles/:name/versions/:id/restore to Node (wrong method)', () => {
      assert.equal(
        resolveRouteOwner('GET', '/api/profiles/MyProfile/versions/abc123/restore'),
        'node'
      );
    });

    it('routes GET /api/subscribers/:imsi/profile to Node (wrong method)', () => {
      assert.equal(
        resolveRouteOwner('GET', '/api/subscribers/208930000000001/profile'),
        'node'
      );
    });

    // ── Non-API routes ────────────────────────────────────────────
    it('routes non-API paths to Node', () => {
      assert.equal(resolveRouteOwner('GET', '/dashboard'), 'node');
    });
  });
});
