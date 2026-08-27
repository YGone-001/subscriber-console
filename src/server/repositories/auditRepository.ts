import { Filter, MongoServerError, ObjectId } from 'mongodb';
import { getAppCollection, mongoCollections } from '@/lib/mongo';
import type { AuditLogRecord, AuditListResponse } from '@/types/audit';
import { sanitizeAuditRecord } from '@/lib/audit/record';
import { buildTariffPlanAuditFilter as buildTariffPlanAuditFilterBase } from '@/lib/tariffPlanOperations';
import { buildAuditFilter, type AuditQuery } from '@/lib/auditQuery';

export type { AuditLogRecord } from '@/types/audit';

type StoredAuditLog = AuditLogRecord & { _id: ObjectId | string };

function collection() {
  return getAppCollection<StoredAuditLog>(mongoCollections.auditLogs);
}

export function buildTariffPlanAuditFilter(planId: string): Filter<StoredAuditLog> {
  return buildTariffPlanAuditFilterBase(planId) as Filter<StoredAuditLog>;
}

export async function appendAuditLog(log: AuditLogRecord) {
  const docs = await collection();
  // Stable _id makes retries idempotent without an update/upsert of audit evidence.
  // Historical ObjectId records remain readable; retention is an independent policy.
  try {
    await docs.insertOne({ ...sanitizeAuditRecord(log), _id: log.id });
  } catch (error) {
    if (error instanceof MongoServerError && error.code === 11000
      && error.keyPattern?._id === 1 && error.keyValue?._id === log.id) return;
    throw error;
  }
}

export async function listAuditLogs(query: AuditQuery): Promise<AuditListResponse> {
  const docs = await collection();
  const filter = buildAuditFilter(query) as Filter<StoredAuditLog>;
  const [logs, total] = await Promise.all([
    docs.find(filter).sort({ timestamp: -1 }).skip((query.page - 1) * query.pageSize).limit(query.pageSize).toArray(),
    docs.countDocuments(filter),
  ]);
  const totalPages = Math.max(1, Math.ceil(total / query.pageSize));
  return {
    logs: logs.map(sanitizeAuditRecord).map(({ oldData, newData, metadata, error, ...summary }) => {
      void oldData; void newData; void metadata; void error;
      return summary;
    }),
    pagination: { page: Math.min(query.page, totalPages), pageSize: query.pageSize, total, totalPages },
  };
}

export async function listAuditLogsForApproval(approvalId: string) {
  const docs = await collection();
  const filter = {
    $or: [
      { targetId: `approval:${approvalId}` },
      { approvalId },
      { 'oldData.approvalId': approvalId },
      { 'newData.approvalId': approvalId },
    ],
  } as Filter<StoredAuditLog>;

  const logs = await docs.find(filter).sort({ timestamp: 1 }).limit(100).toArray();
  return logs.map(sanitizeAuditRecord);
}

export async function listAuditLogsForUser(username: string) {
  const docs = await collection();
  const logs = await docs.find({ $or: [{ actor: username }, { 'actorContext.username': username }, { 'resource.type': 'user', 'resource.id': username }, { targetId: `SYS_USER:${username}` }] })
    .sort({ timestamp: -1 }).limit(10).toArray();
  // Activity needs only presentation fields, never unrelated resource snapshots.
  return logs.map(sanitizeAuditRecord).map(({ id, timestamp, action, result, actor, targetId }) => ({ id, timestamp, action, result, actor, targetId }));
}

export async function listAuditLogsForTariffPlan(planId: string, limitInput = 12) {
  const docs = await collection();
  const limit = Math.min(Math.max(Number(limitInput) || 12, 1), 50);
  const filter = buildTariffPlanAuditFilter(planId);
  const logs = await docs.find(filter).sort({ timestamp: -1 }).limit(limit).toArray();
  return logs.map(sanitizeAuditRecord);
}
