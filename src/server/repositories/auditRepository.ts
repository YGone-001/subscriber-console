import { Filter, MongoServerError, ObjectId } from 'mongodb';
import { getAppCollection, mongoCollections } from '@/lib/mongo';
import type { AuditAction, AuditLogRecord } from '@/types/audit';
import { sanitizeAuditRecord } from '@/lib/audit/record';
import { buildTariffPlanAuditFilter as buildTariffPlanAuditFilterBase } from '@/lib/tariffPlanOperations';

export type { AuditLogRecord } from '@/types/audit';

type StoredAuditLog = AuditLogRecord & { _id: ObjectId | string };

type AuditQuery = {
  action?: string;
  target?: string;
  operator?: string;
  level?: string;
  query?: string;
  fromTime?: number | null;
  toTime?: number | null;
  limit: number;
};

function collection() {
  return getAppCollection<StoredAuditLog>(mongoCollections.auditLogs);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function queryFilter(input: AuditQuery): Filter<StoredAuditLog> {
  const filter: Filter<StoredAuditLog> = {};

  if (input.action && input.action !== 'ALL') filter.action = input.action as AuditAction;
  if (input.level && input.level !== 'ALL') filter.level = input.level as 'info' | 'warning';
  if (input.target) filter.targetId = { $regex: escapeRegex(input.target) };
  if (input.operator) {
    const operatorRegex = { $regex: escapeRegex(input.operator), $options: 'i' };
    filter.$or = [{ actor: operatorRegex }, { operatorIp: operatorRegex }];
  }

  if (input.fromTime !== null || input.toTime !== null) {
    filter.timestamp = {};
    if (input.fromTime !== null && input.fromTime !== undefined) {
      filter.timestamp.$gte = new Date(input.fromTime).toISOString();
    }
    if (input.toTime !== null && input.toTime !== undefined) {
      filter.timestamp.$lte = new Date(input.toTime).toISOString();
    }
  }

  if (input.query) {
    const regex = { $regex: escapeRegex(input.query), $options: 'i' };
    const queryMatches: Filter<StoredAuditLog>[] = [
      { id: regex },
      { action: regex },
      { level: regex },
      { targetId: regex },
      { actor: regex },
      { operatorIp: regex },
      { correlationId: regex },
      { approvalId: regex },
      { timestamp: regex },
    ];
    if (filter.$or) {
      filter.$and = [{ $or: filter.$or }, { $or: queryMatches }];
      delete filter.$or;
    } else {
      filter.$or = queryMatches;
    }
  }

  return filter;
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

export async function listAuditLogs(query: AuditQuery) {
  const docs = await collection();
  const filter = queryFilter(query);
  const [logs, filteredTotal, totalScanned] = await Promise.all([
    docs.find(filter).sort({ timestamp: -1 }).limit(query.limit).toArray(),
    docs.countDocuments(filter),
    docs.countDocuments({}),
  ]);

  return {
    logs: logs.map(sanitizeAuditRecord),
    filteredTotal,
    totalScanned,
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
