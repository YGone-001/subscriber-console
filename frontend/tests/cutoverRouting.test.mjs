import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRouteOwner, CUTOVER_TABLE } from '../src/lib/cutover-routing.ts';

describe('cutover-routing', () => {
  describe('CUTOVER_TABLE', () => {
    it('contains exactly 23 cutover routes', () => {
      assert.equal(CUTOVER_TABLE.length, 23);
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

    it('Phase 4.6: POST /api/subscribers is owned by Go', () => {
      const create = CUTOVER_TABLE.find(
        (r) => r.path === '/api/subscribers' && r.method === 'POST'
      );
      assert.ok(create, 'Subscriber Create must exist');
      assert.equal(create.owner, 'go');
    });

    it('Phase 4.6: PUT /api/subscribers/{imsi} is owned by Go', () => {
      const update = CUTOVER_TABLE.find(
        (r) => r.path === '/api/subscribers/{imsi}' && r.method === 'PUT'
      );
      assert.ok(update, 'Subscriber Update must exist');
      assert.equal(update.owner, 'go');
    });

    it('Phase 4.6: DELETE /api/subscribers/{imsi} is owned by Go', () => {
      const del = CUTOVER_TABLE.find(
        (r) => r.path === '/api/subscribers/{imsi}' && r.method === 'DELETE'
      );
      assert.ok(del, 'Subscriber Delete must exist');
      assert.equal(del.owner, 'go');
    });

    it('Phase 4.7: POST /api/subscribers/batch is owned by Go', () => {
      const batch = CUTOVER_TABLE.find(
        (r) => r.path === '/api/subscribers/batch' && r.method === 'POST'
      );
      assert.ok(batch, 'Subscriber Batch Create must exist');
      assert.equal(batch.owner, 'go');
    });

    it('Phase 4.7: POST /api/subscribers/batch-update is owned by Go', () => {
      const batchUpdate = CUTOVER_TABLE.find(
        (r) => r.path === '/api/subscribers/batch-update' && r.method === 'POST'
      );
      assert.ok(batchUpdate, 'Subscriber Batch Update must exist');
      assert.equal(batchUpdate.owner, 'go');
    });

    it('Phase 4.7: POST /api/subscribers/import is owned by Go', () => {
      const importRoute = CUTOVER_TABLE.find(
        (r) => r.path === '/api/subscribers/import' && r.method === 'POST'
      );
      assert.ok(importRoute, 'Subscriber Import must exist');
      assert.equal(importRoute.owner, 'go');
    });

    it('Phase 4.7: POST /api/subscribers/bulk-delete is owned by Go', () => {
      const bulkDelete = CUTOVER_TABLE.find(
        (r) => r.path === '/api/subscribers/bulk-delete' && r.method === 'POST'
      );
      assert.ok(bulkDelete, 'Subscriber Bulk Delete must exist');
      assert.equal(bulkDelete.owner, 'go');
    });

    it('Tariff: POST /api/tariff-plans is owned by Go', () => {
      const create = CUTOVER_TABLE.find(
        (r) => r.path === '/api/tariff-plans' && r.method === 'POST'
      );
      assert.ok(create, 'Tariff Plan Create must exist');
      assert.equal(create.owner, 'go');
    });

    it('Tariff: PUT /api/tariff-plans/{planId} is owned by Go', () => {
      const update = CUTOVER_TABLE.find(
        (r) => r.path === '/api/tariff-plans/{planId}' && r.method === 'PUT'
      );
      assert.ok(update, 'Tariff Plan Update must exist');
      assert.equal(update.owner, 'go');
    });

    it('Tariff: DELETE /api/tariff-plans/{planId} is owned by Go', () => {
      const del = CUTOVER_TABLE.find(
        (r) => r.path === '/api/tariff-plans/{planId}' && r.method === 'DELETE'
      );
      assert.ok(del, 'Tariff Plan Delete must exist');
      assert.equal(del.owner, 'go');
    });

    it('Tariff: POST /api/tariff-plans/{planId}/clone is owned by Go', () => {
      const clone = CUTOVER_TABLE.find(
        (r) => r.path === '/api/tariff-plans/{planId}/clone' && r.method === 'POST'
      );
      assert.ok(clone, 'Tariff Plan Clone must exist');
      assert.equal(clone.owner, 'go');
    });

    it('Tariff: POST /api/tariff-plans/{planId}/enable is owned by Go', () => {
      const enable = CUTOVER_TABLE.find(
        (r) => r.path === '/api/tariff-plans/{planId}/enable' && r.method === 'POST'
      );
      assert.ok(enable, 'Tariff Plan Enable must exist');
      assert.equal(enable.owner, 'go');
    });

    it('Tariff: POST /api/tariff-plans/{planId}/disable is owned by Go', () => {
      const disable = CUTOVER_TABLE.find(
        (r) => r.path === '/api/tariff-plans/{planId}/disable' && r.method === 'POST'
      );
      assert.ok(disable, 'Tariff Plan Disable must exist');
      assert.equal(disable.owner, 'go');
    });

    it('OCS Sub: POST /api/ocs/subscribers is owned by Go', () => {
      const create = CUTOVER_TABLE.find(
        (r) => r.path === '/api/ocs/subscribers' && r.method === 'POST'
      );
      assert.ok(create, 'OCS Subscriber Create must exist');
      assert.equal(create.owner, 'go');
    });

    it('OCS Sub: PATCH /api/ocs/subscribers/{imsi} is owned by Go', () => {
      const update = CUTOVER_TABLE.find(
        (r) => r.path === '/api/ocs/subscribers/{imsi}' && r.method === 'PATCH'
      );
      assert.ok(update, 'OCS Subscriber Update Tariff must exist');
      assert.equal(update.owner, 'go');
    });

    it('OCS Sub: POST /api/ocs/subscribers/{imsi}/suspend is owned by Go', () => {
      const suspend = CUTOVER_TABLE.find(
        (r) => r.path === '/api/ocs/subscribers/{imsi}/suspend' && r.method === 'POST'
      );
      assert.ok(suspend, 'OCS Subscriber Suspend must exist');
      assert.equal(suspend.owner, 'go');
    });

    it('OCS Sub: POST /api/ocs/subscribers/{imsi}/resume is owned by Go', () => {
      const resume = CUTOVER_TABLE.find(
        (r) => r.path === '/api/ocs/subscribers/{imsi}/resume' && r.method === 'POST'
      );
      assert.ok(resume, 'OCS Subscriber Resume must exist');
      assert.equal(resume.owner, 'go');
    });

    it('OCS Sub: DELETE /api/ocs/subscribers/{imsi} is owned by Go', () => {
      const terminate = CUTOVER_TABLE.find(
        (r) => r.path === '/api/ocs/subscribers/{imsi}' && r.method === 'DELETE'
      );
      assert.ok(terminate, 'OCS Subscriber Terminate must exist');
      assert.equal(terminate.owner, 'go');
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

    it('routes POST /api/subscribers to Go (Subscriber Create)', () => {
      assert.equal(resolveRouteOwner('POST', '/api/subscribers'), 'go');
    });

    it('routes PUT /api/subscribers/208930000000001 to Go (Subscriber Update)', () => {
      assert.equal(resolveRouteOwner('PUT', '/api/subscribers/208930000000001'), 'go');
    });

    it('routes DELETE /api/subscribers/208930000000001 to Go (Subscriber Delete)', () => {
      assert.equal(resolveRouteOwner('DELETE', '/api/subscribers/208930000000001'), 'go');
    });

    it('routes POST /api/subscribers/batch to Go (Batch Create)', () => {
      assert.equal(resolveRouteOwner('POST', '/api/subscribers/batch'), 'go');
    });

    it('routes POST /api/subscribers/batch-update to Go (Batch Update)', () => {
      assert.equal(resolveRouteOwner('POST', '/api/subscribers/batch-update'), 'go');
    });

    it('routes POST /api/subscribers/import to Go (Import)', () => {
      assert.equal(resolveRouteOwner('POST', '/api/subscribers/import'), 'go');
    });

    it('routes POST /api/subscribers/bulk-delete to Go (Bulk Delete)', () => {
      assert.equal(resolveRouteOwner('POST', '/api/subscribers/bulk-delete'), 'go');
    });

    it('routes POST /api/tariff-plans to Go (Tariff Plan Create)', () => {
      assert.equal(resolveRouteOwner('POST', '/api/tariff-plans'), 'go');
    });

    it('routes PUT /api/tariff-plans/plan_10gb to Go (Tariff Plan Update)', () => {
      assert.equal(resolveRouteOwner('PUT', '/api/tariff-plans/plan_10gb'), 'go');
    });

    it('routes DELETE /api/tariff-plans/plan_10gb to Go (Tariff Plan Delete)', () => {
      assert.equal(resolveRouteOwner('DELETE', '/api/tariff-plans/plan_10gb'), 'go');
    });

    it('routes POST /api/tariff-plans/plan_10gb/clone to Go (Tariff Plan Clone)', () => {
      assert.equal(resolveRouteOwner('POST', '/api/tariff-plans/plan_10gb/clone'), 'go');
    });

    it('routes POST /api/tariff-plans/plan_10gb/enable to Go (Tariff Plan Enable)', () => {
      assert.equal(resolveRouteOwner('POST', '/api/tariff-plans/plan_10gb/enable'), 'go');
    });

    it('routes POST /api/tariff-plans/plan_10gb/disable to Go (Tariff Plan Disable)', () => {
      assert.equal(resolveRouteOwner('POST', '/api/tariff-plans/plan_10gb/disable'), 'go');
    });

    it('routes POST /api/ocs/subscribers to Go (OCS Subscriber Create)', () => {
      assert.equal(resolveRouteOwner('POST', '/api/ocs/subscribers'), 'go');
    });

    it('routes PATCH /api/ocs/subscribers/208930000000001 to Go (OCS Subscriber Update Tariff)', () => {
      assert.equal(resolveRouteOwner('PATCH', '/api/ocs/subscribers/208930000000001'), 'go');
    });

    it('routes POST /api/ocs/subscribers/208930000000001/suspend to Go (OCS Subscriber Suspend)', () => {
      assert.equal(resolveRouteOwner('POST', '/api/ocs/subscribers/208930000000001/suspend'), 'go');
    });

    it('routes POST /api/ocs/subscribers/208930000000001/resume to Go (OCS Subscriber Resume)', () => {
      assert.equal(resolveRouteOwner('POST', '/api/ocs/subscribers/208930000000001/resume'), 'go');
    });

    it('routes DELETE /api/ocs/subscribers/208930000000001 to Go (OCS Subscriber Terminate)', () => {
      assert.equal(resolveRouteOwner('DELETE', '/api/ocs/subscribers/208930000000001'), 'go');
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

    it('routes GET /api/subscribers to Node (not in cutover table)', () => {
      assert.equal(resolveRouteOwner('GET', '/api/subscribers'), 'node');
    });

    it('routes GET /api/subscribers/208930000000001 to Node (not in cutover table)', () => {
      assert.equal(resolveRouteOwner('GET', '/api/subscribers/208930000000001'), 'node');
    });

    it('routes PATCH /api/subscribers/208930000000001 to Node (not in cutover table)', () => {
      assert.equal(resolveRouteOwner('PATCH', '/api/subscribers/208930000000001'), 'node');
    });

    it('routes GET /api/tariff-plans to Node (read not in cutover table)', () => {
      assert.equal(resolveRouteOwner('GET', '/api/tariff-plans'), 'node');
    });

    it('routes GET /api/tariff-plans/plan_10gb to Node (read not in cutover table)', () => {
      assert.equal(resolveRouteOwner('GET', '/api/tariff-plans/plan_10gb'), 'node');
    });

    it('routes GET /api/ocs/subscribers to Node (read not in cutover table)', () => {
      assert.equal(resolveRouteOwner('GET', '/api/ocs/subscribers'), 'node');
    });

    it('routes PUT /api/ocs/subscribers/208930000000001 to Node (PUT not in cutover table)', () => {
      assert.equal(resolveRouteOwner('PUT', '/api/ocs/subscribers/208930000000001'), 'node');
    });
  });

  describe('resolveRouteOwner - Remaining Phase 4 Node ownership', () => {
    it('routes GET /api/subscribers to Node (Subscriber List)', () => {
      assert.equal(resolveRouteOwner('GET', '/api/subscribers'), 'node');
    });

    it('routes GET /api/subscribers/208930000000001 to Node (Subscriber Detail)', () => {
      assert.equal(resolveRouteOwner('GET', '/api/subscribers/208930000000001'), 'node');
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
