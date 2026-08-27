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
  const [facet] = await docs.aggregate<{
    logs: StoredAuditLog[];
    summary: Array<{ matched: number; failed: number; denied: number; highRisk: number }>;
  }>([
    { $match: filter },
    { $facet: {
      logs: [
        { $sort: { timestamp: -1 } },
        { $skip: (query.page - 1) * query.pageSize },
        { $limit: query.pageSize },
        { $project: {
          _id: 0, id: 1, eventId: 1, timestamp: 1, level: 1, action: 1,
          targetId: 1, actor: 1, operatorIp: 1, correlationId: 1, approvalId: 1,
          reason: 1, actorContext: 1, module: 1, resource: 1, riskLevel: 1,
          result: 1, 'source.ip': 1, request: 1,
        } },
      ],
      summary: [{ $group: {
        _id: null,
        matched: { $sum: 1 },
        failed: { $sum: { $cond: [{ $eq: ['$result', 'failed'] }, 1, 0] } },
        denied: { $sum: { $cond: [{ $eq: ['$result', 'denied'] }, 1, 0] } },
        highRisk: { $sum: { $cond: [{ $in: ['$riskLevel', ['high', 'critical']] }, 1, 0] } },
      } }],
    } },
  ]).toArray();
  const metrics = facet?.summary[0] ?? { matched: 0, failed: 0, denied: 0, highRisk: 0 };
  const logs = facet?.logs ?? [];
  const total = metrics.matched;
  const totalPages = Math.max(1, Math.ceil(total / query.pageSize));
  return {
    logs: logs.map(sanitizeAuditRecord).map(({ oldData, newData, metadata, error, ...summary }) => {
      void oldData; void newData; void metadata; void error;
      return summary;
    }),
    pagination: { page: Math.min(query.page, totalPages), pageSize: query.pageSize, total, totalPages },
    summary: metrics,
  };
}

export async function getAuditLog(id: string): Promise<AuditLogRecord | null> {
  const docs = await collection();
  const log = await docs.findOne({ id });
  return log ? sanitizeAuditRecord(log) : null;
}

export class AuditExportTooLargeError extends Error {
  constructor(public readonly matched: number, public readonly limit: number) {
    super(`Audit export matched ${matched} rows, exceeding the ${limit} row limit`);
    this.name = 'AuditExportTooLargeError';
  }
}

export async function exportAuditLogs(query: AuditQuery, maxRows: number): Promise<{ logs: AuditLogRecord[]; matched: number }> {
  const docs = await collection();
  const filter = buildAuditFilter(query) as Filter<StoredAuditLog>;
  const matched = await docs.countDocuments(filter);
  if (matched > maxRows) throw new AuditExportTooLargeError(matched, maxRows);
  const logs = await docs.find(filter).sort({ timestamp: -1 }).limit(maxRows + 1).toArray();
  if (logs.length > maxRows) throw new AuditExportTooLargeError(logs.length, maxRows);
  return { logs: logs.map(sanitizeAuditRecord), matched };
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
