import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRouteOwner, CUTOVER_TABLE } from '../src/lib/cutover-routing.ts';

describe('cutover-routing', () => {
  describe('CUTOVER_TABLE', () => {
    it('contains exactly 5 cutover routes', () => {
      assert.equal(CUTOVER_TABLE.length, 5);
    });

    it('Pilot A: POST /api/profiles/{name}/versions/{versionId}/restore is owned by Go', () => {
      const pilotA = CUTOVER_TABLE.find(
        (r) => r.path === '/api/profiles/{name}/versions/{versionId}/restore'
      );
      assert.ok(pilotA, 'Pilot A must exist');
      assert.equal(pilotA.method, 'POST');
      assert.equal(pilotA.owner, 'go');
    });

    it('Pilot B: POST /api/subscribers/{imsi}/profile is owned by Go', () => {
      const pilotB = CUTOVER_TABLE.find(
        (r) => r.path === '/api/subscribers/{imsi}/profile'
      );
      assert.ok(pilotB, 'Pilot B must exist');
      assert.equal(pilotB.method, 'POST');
      assert.equal(pilotB.owner, 'go');
    });

    it('Phase 4.5: POST /api/profiles is owned by Go', () => {
      const create = CUTOVER_TABLE.find(
        (r) => r.path === '/api/profiles' && r.method === 'POST'
      );
      assert.ok(create, 'Profile Create must exist');
      assert.equal(create.owner, 'go');
    });

    it('Phase 4.5: PUT /api/profiles/{name} is owned by Go', () => {
      const update = CUTOVER_TABLE.find(
        (r) => r.path === '/api/profiles/{name}' && r.method === 'PUT'
      );
      assert.ok(update, 'Profile Update must exist');
      assert.equal(update.owner, 'go');
    });

    it('Phase 4.5: DELETE /api/profiles/{name} is owned by Go', () => {
      const del = CUTOVER_TABLE.find(
        (r) => r.path === '/api/profiles/{name}' && r.method === 'DELETE'
      );
      assert.ok(del, 'Profile Delete must exist');
      assert.equal(del.owner, 'go');
    });
  });

  describe('resolveRouteOwner - Go-owned routes', () => {
    it('routes POST /api/profiles to Go (Profile Create)', () => {
      assert.equal(resolveRouteOwner('POST', '/api/profiles'), 'go');
    });

    it('routes PUT /api/profiles/MyProfile to Go (Profile Update)', () => {
      assert.equal(resolveRouteOwner('PUT', '/api/profiles/MyProfile'), 'go');
    });

    it('routes DELETE /api/profiles/MyProfile to Go (Profile Delete)', () => {
      assert.equal(resolveRouteOwner('DELETE', '/api/profiles/MyProfile'), 'go');
    });

    it('routes POST /api/profiles/MyProfile/versions/v1/restore to Go (Profile Restore)', () => {
      assert.equal(
        resolveRouteOwner('POST', '/api/profiles/MyProfile/versions/v1/restore'),
        'go'
      );
    });

    it('routes POST /api/subscribers/208930000000001/profile to Go (Subscriber Profile Apply)', () => {
      assert.equal(
        resolveRouteOwner('POST', '/api/subscribers/208930000000001/profile'),
        'go'
      );
    });
  });

  describe('resolveRouteOwner - METHOD isolation', () => {
    it('routes GET /api/profiles to Node (not in cutover table)', () => {
      assert.equal(resolveRouteOwner('GET', '/api/profiles'), 'node');
    });

    it('routes GET /api/profiles/MyProfile to Node (not in cutover table)', () => {
      assert.equal(resolveRouteOwner('GET', '/api/profiles/MyProfile'), 'node');
    });

    it('routes POST /api/profiles/MyProfile to Node (not in cutover table)', () => {
      assert.equal(resolveRouteOwner('POST', '/api/profiles/MyProfile'), 'node');
    });

    it('routes PATCH /api/profiles/MyProfile to Node (not in cutover table)', () => {
      assert.equal(resolveRouteOwner('PATCH', '/api/profiles/MyProfile'), 'node');
    });

    it('routes GET /api/profiles/MyProfile/versions/v1/restore to Node (wrong method)', () => {
      assert.equal(
        resolveRouteOwner('GET', '/api/profiles/MyProfile/versions/v1/restore'),
        'node'
      );
    });
  });

  describe('resolveRouteOwner - Remaining Phase 4 Node ownership', () => {
    it('routes POST /api/subscribers to Node (Subscriber Create)', () => {
      assert.equal(resolveRouteOwner('POST', '/api/subscribers'), 'node');
    });

    it('routes PUT /api/subscribers/208930000000001 to Node (Subscriber Update)', () => {
      assert.equal(resolveRouteOwner('PUT', '/api/subscribers/208930000000001'), 'node');
    });

    it('routes DELETE /api/subscribers/208930000000001 to Node (Subscriber Delete)', () => {
      assert.equal(resolveRouteOwner('DELETE', '/api/subscribers/208930000000001'), 'node');
    });

    it('routes POST /api/subscribers/batch to Node (Batch Create)', () => {
      assert.equal(resolveRouteOwner('POST', '/api/subscribers/batch'), 'node');
    });

    it('routes POST /api/subscribers/batch-update to Node (Batch Update)', () => {
      assert.equal(resolveRouteOwner('POST', '/api/subscribers/batch-update'), 'node');
    });

    it('routes POST /api/subscribers/bulk-delete to Node (Bulk Delete)', () => {
      assert.equal(resolveRouteOwner('POST', '/api/subscribers/bulk-delete'), 'node');
    });

    it('routes POST /api/subscribers/import to Node (Import)', () => {
      assert.equal(resolveRouteOwner('POST', '/api/subscribers/import'), 'node');
    });
  });

  describe('resolveRouteOwner - Unmatched routes default to Node', () => {
    it('routes POST /api/approvals/123/approve to Node', () => {
      assert.equal(resolveRouteOwner('POST', '/api/approvals/123/approve'), 'node');
    });

    it('routes GET /dashboard to Node', () => {
      assert.equal(resolveRouteOwner('GET', '/dashboard'), 'node');
    });

    it('routes POST /api/unknown-operation to Node', () => {
      assert.equal(resolveRouteOwner('POST', '/api/unknown-operation'), 'node');
    });
  });
});
