import { logAudit } from '@/lib/audit';
import {
  validateBatchCreatePayload,
  validateImsi,
  validateImsiList,
  validateImportRecords,
  validatePolicyChangePayload,
  validateTrafficAdjustmentPayload,
} from '@/lib/subscriberValidation';
import { asRecord } from '@/lib/typeGuards';
import type { ApprovalDocument } from '@/server/repositories/approvalRepository';
import { adjustOcsTrafficBalance, changeOcsPolicyForSubscribers, migrateTariffPlanSubscribers } from '@/server/repositories/ocsBillingRepository';
import { restoreProfileVersion } from '@/server/repositories/profileRepository';
import { createRating, deleteRating, updateRating } from '@/server/repositories/ratingRepository';
import {
  createSubscribersBatch,
  deleteSubscriber,
  importSubscribersFromRecords,
} from '@/server/repositories/subscriberRepository';
import { batchHealSubscriberDocuments, healSubscriberDocument } from '@/server/repositories/systemAuditRepository';
import { getUser, safeUser, updateUser } from '@/server/repositories/userRepository';

function auditActionForMode(mode: string) {
  if (mode === 'recharge') return 'TRAFFIC_RECHARGE';
  if (mode === 'reset') return 'TRAFFIC_RESET';
  return 'TRAFFIC_ADJUST';
}

export async function executeApproval(approval: ApprovalDocument, request: Request) {
  if (approval.action === 'ACCESS_REQUEST') {
    const payload = asRecord(approval.payload);
    const requestedRole = String(payload.requestedRole || '');
    if (approval.targetId !== approval.requester || requestedRole !== 'operator') {
      throw new Error('Invalid access request payload');
    }

    const currentUser = await getUser(approval.targetId);
    if (!currentUser || currentUser.status !== 'active') throw new Error('Access request target is unavailable');
    if (currentUser.role !== 'viewer') throw new Error('Access request is no longer applicable');

    const updated = await updateUser(currentUser.username, { role: 'operator' });
    if (!updated) throw new Error('Access request target is unavailable');
    logAudit(
      'UPDATE',
      `SYS_USER:${currentUser.username}`,
      safeUser(updated.existing),
      { ...safeUser(updated.next), approvalId: approval.id },
      request
    );
    return { username: currentUser.username, previousRole: 'viewer', role: 'operator' };
  }

  if (approval.action === 'POLICY_CHANGE') {
    const validation = validatePolicyChangePayload(approval.payload);
    if (!validation.ok) throw new Error(validation.error);

    const result = await changeOcsPolicyForSubscribers(validation.value);
    logAudit(
      'UPDATE',
      `policy:${result.planId}`,
      { status: 'approved' },
      {
        approvalId: approval.id,
        imsiList: validation.value.imsiList,
        requested: result.requested,
        subscriberModified: result.subscriberModified,
        balanceModified: result.balanceModified,
        status: result.status,
        resetBalances: result.resetBalances,
      },
      request
    );

    return result;
  }

  if (approval.action === 'TARIFF_PLAN_MIGRATE') {
    const payload = asRecord(approval.payload);
    const result = await migrateTariffPlanSubscribers({
      sourcePlanId: payload.sourcePlanId || payload.source_plan_id,
      targetPlanId: payload.targetPlanId || payload.target_plan_id,
      resetBalances: payload.resetBalances === true,
    });
    logAudit(
      'UPDATE',
      `tariff-plan:${result.sourcePlanId}`,
      { status: 'approved' },
      { ...result, approvalId: approval.id },
      request
    );

    return result;
  }

  if (approval.action === 'TRAFFIC_ADJUSTMENT') {
    const payload = asRecord(approval.payload);
    const imsiResult = validateImsi(payload.imsi);
    if (!imsiResult.ok) throw new Error(imsiResult.error);

    const validation = validateTrafficAdjustmentPayload(payload.adjustment);
    if (!validation.ok) throw new Error(validation.error);

    const result = await adjustOcsTrafficBalance(imsiResult.value, validation.value);
    logAudit(
      auditActionForMode(result.mode),
      imsiResult.value,
      result.before,
      {
        ...result.after,
        approvalId: approval.id,
        mode: result.mode,
        reason: result.reason,
      },
      request
    );

    return result;
  }

  if (approval.action === 'RATING_CREATE') {
    if (approval.payload.rating_group_id === undefined || approval.payload.rating_group_id === null || approval.payload.rating_group_id === '') {
      throw new Error('rating_group_id is required');
    }
    const payload = approval.payload as { rating_group_id: unknown; planId?: unknown; plan_id?: unknown } & Record<string, unknown>;
    const result = await createRating(payload, payload.planId || payload.plan_id);
    logAudit('CREATE', `rating:${result.rating_group_id}`, null, { ...result, approvalId: approval.id }, request);
    return result;
  }

  if (approval.action === 'RATING_UPDATE') {
    const payload = asRecord(approval.payload);
    const id = String(payload.id || '');
    if (!/^\d+$/.test(id)) throw new Error('Invalid rating ID format');

    const result = await updateRating(id, asRecord(payload.changes), payload.planId || asRecord(payload.changes).planId || asRecord(payload.changes).plan_id);
    logAudit('UPDATE', `rating:${id}`, null, { ...result, approvalId: approval.id }, request);
    return result;
  }

  if (approval.action === 'RATING_DELETE') {
    const payload = asRecord(approval.payload);
    const id = String(payload.id || '');
    if (!/^\d+$/.test(id)) throw new Error('Invalid rating ID format');

    const result = await deleteRating(id, payload.planId || payload.plan_id);
    if (!result.deleted) {
      throw new Error(`Cannot delete: Rating group is currently used by ${result.references.count} subscribers`);
    }

    logAudit('DELETE', `rating:${id}`, { id, approvalId: approval.id }, null, request);
    return result;
  }

  if (approval.action === 'PROFILE_RESTORE') {
    const payload = asRecord(approval.payload);
    const name = String(payload.name || '');
    const versionId = String(payload.versionId || '');
    const requester = String(payload.requester || approval.requester);
    if (!/^[a-zA-Z0-9_\s-]+$/.test(name)) throw new Error('Invalid profile name format');
    if (!versionId) throw new Error('versionId is required');

    const result = await restoreProfileVersion(name, versionId, requester);
    if (!result) throw new Error('Version not found');

    logAudit(
      'PROFILE_UPDATE',
      name,
      result.current,
      { ...result.restored, approvalId: approval.id },
      request
    );
    return { profile: result.restored, version: result.version };
  }

  if (approval.action === 'SYSTEM_HEAL') {
    const payload = asRecord(approval.payload);
    const profileName = payload.profileName ? String(payload.profileName) : undefined;

    if (Array.isArray(payload.anomalies) && payload.anomalies.length > 0) {
      const result = await batchHealSubscriberDocuments(
        payload.anomalies as Array<{ imsi: string; type: string }>,
        profileName
      );
      logAudit('HEAL', `batch:${payload.anomalies.length}`, null, { ...result, approvalId: approval.id }, request);
      return result;
    }

    const imsi = String(payload.imsi || '');
    const type = String(payload.type || '');
    if (!/^\d{15}$|^UNKNOWN$/.test(imsi)) throw new Error('IMSI must be exactly 15 digits or UNKNOWN');
    if (!type) throw new Error('type is required');

    await healSubscriberDocument(imsi, type, profileName);
    const result = { imsi, type, profileName };
    logAudit('HEAL', imsi, null, { ...result, approvalId: approval.id }, request);
    return result;
  }

  if (approval.action === 'SUBSCRIBER_BATCH_CREATE') {
    const validation = validateBatchCreatePayload(approval.payload);
    if (!validation.ok) throw new Error(validation.error);
    const payload = validation.value;

    const frozen = asRecord(approval.payload);
    const expectedAbsentImsis = Array.isArray(frozen.expectedAbsentImsis)
      ? frozen.expectedAbsentImsis.map((imsi) => String(imsi))
      : [];
    if (frozen.version === 'subscriber-batch-create-v1') {
      if (expectedAbsentImsis.length !== payload.count) throw new Error('INVALID_SUBSCRIBER_BATCH_CREATE_PAYLOAD');
      const { precheckSubscriberImsis } = await import('@/server/repositories/subscriberRepository');
      const precheck = await precheckSubscriberImsis(expectedAbsentImsis);
      if (precheck.some((item) => item.exists)) throw new Error('SUBSCRIBER_CREATE_PRECONDITION_CHANGED');
    }

    const result = await createSubscribersBatch({
      startImsi: payload.startImsi,
      count: payload.count,
      trafficTotal: payload.trafficTotal,
      trafficBalance: payload.trafficBalance,
      smsTotal: payload.smsTotal,
      smsBalance: payload.smsBalance,
      profileName: payload.profileName,
      planId: payload.planId,
      strategy: 'skip',
    });
    const { createdImsis, skippedImsis, failedImsis, metrics } = result;

    if (createdImsis.length > 0) {
      logAudit(
        'BATCH_CREATE',
        `${createdImsis[0]} ~ ${createdImsis[createdImsis.length - 1]}`,
        null,
        {
          approvalId: approval.id,
          batchSize: createdImsis.length,
          skipped: skippedImsis.length,
          failed: failedImsis.length,
          profileTemplate: payload.profileName,
          batchMetrics: metrics,
        },
        request
      );
    }

    if (frozen.version === 'subscriber-batch-create-v1' && (result.createdImsis.length !== payload.count || result.skippedImsis.length > 0 || result.failedImsis.length > 0)) {
      throw new Error('SUBSCRIBER_BATCH_CREATE_PARTIAL_WRITE');
    }
    return result;
  }

  if (approval.action === 'SUBSCRIBER_IMPORT' || approval.action === 'SUBSCRIBER_IMPORT_OVERWRITE') {
    const payload = asRecord(approval.payload);
    const validation = validateImportRecords(payload.records);
    if (!validation.ok) throw new Error(validation.error);

    const result = await importSubscribersFromRecords(validation.value, payload.overwrite === true);
    if (result.importedImsis.length > 0) {
      logAudit(
        'CSV_IMPORT',
        result.importedImsis.join(','),
        null,
        {
          approvalId: approval.id,
          count: result.imported,
          overwrite: payload.overwrite === true,
          skipped: result.skipped,
          failed: result.failed,
        },
        request
      );
    }
    return result;
  }

  if (approval.action === 'SUBSCRIBER_BULK_DELETE') {
    const validation = validateImsiList(approval.payload.imsiList);
    if (!validation.ok) throw new Error(validation.error);
    const imsiList = validation.value;
    if (imsiList.length === 0) throw new Error('imsiList cannot be empty');

    const results = await Promise.all(imsiList.map(async (imsi) => ({ imsi, deleted: await deleteSubscriber(imsi) })));
    const deletedImsis = results.filter((item) => item.deleted).map((item) => item.imsi);
    logAudit(
      'BATCH_DELETE',
      deletedImsis.length > 0 ? `${deletedImsis[0]} ~ ${deletedImsis[deletedImsis.length - 1]}` : 'subscriber:bulk-delete',
      { requested: imsiList },
      { approvalId: approval.id, deleted: deletedImsis.length, deletedImsis },
      request
    );

    return { requested: imsiList.length, deleted: deletedImsis.length, deletedImsis };
  }

  throw new Error('Unsupported approval action');
}
