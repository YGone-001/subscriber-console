import { Filter } from 'mongodb';
import { getAppCollection, mongoCollections } from '@/lib/mongo';
import type { AuditAction } from '@/lib/audit';

export type AuditLogRecord = {
  id: string;
  timestamp: string;
  level: 'info' | 'warning';
  action: AuditAction;
  targetId: string;
  operatorIp: string;
  oldData: unknown;
  newData: unknown;
};

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

const AUDIT_LIMIT = 50000;

function collection() {
  return getAppCollection<AuditLogRecord>(mongoCollections.auditLogs);
}

function stripMongoId<T extends Record<string, unknown>>(doc: T): T {
  const output = { ...doc };
  delete output._id;
  return output;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function queryFilter(input: AuditQuery): Filter<AuditLogRecord> {
  const filter: Filter<AuditLogRecord> = {};

  if (input.action && input.action !== 'ALL') filter.action = input.action as AuditAction;
  if (input.level && input.level !== 'ALL') filter.level = input.level as 'info' | 'warning';
  if (input.target) filter.targetId = { $regex: escapeRegex(input.target) };
  if (input.operator) filter.operatorIp = { $regex: escapeRegex(input.operator) };

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
    filter.$or = [
      { id: regex },
      { action: regex },
      { level: regex },
      { targetId: regex },
      { operatorIp: regex },
      { timestamp: regex },
    ];
  }

  return filter;
}

export async function appendAuditLog(log: AuditLogRecord) {
  const docs = await collection();
  await docs.insertOne(log);

  const stale = await docs
    .find({}, { projection: { id: 1 } })
    .sort({ timestamp: -1 })
    .skip(AUDIT_LIMIT)
    .toArray();

  if (stale.length > 0) {
    await docs.deleteMany({ id: { $in: stale.map((item) => item.id) } });
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
    logs: logs.map(stripMongoId),
    filteredTotal,
    totalScanned: Math.min(totalScanned, AUDIT_LIMIT),
  };
}

export async function listAuditLogsForApproval(approvalId: string) {
  const docs = await collection();
  const filter = {
    $or: [
      { targetId: `approval:${approvalId}` },
      { 'oldData.approvalId': approvalId },
      { 'newData.approvalId': approvalId },
    ],
  } as Filter<AuditLogRecord>;

  const logs = await docs.find(filter).sort({ timestamp: 1 }).limit(100).toArray();
  return logs.map(stripMongoId);
}

export async function listAuditLogsForTariffPlan(planId: string, limitInput = 12) {
  const docs = await collection();
  const limit = Math.min(Math.max(Number(limitInput) || 12, 1), 50);
  const escapedPlanId = escapeRegex(planId);
  const targetRegex = { $regex: `tariff-plan:.*${escapedPlanId}`, $options: 'i' };
  const filter = {
    $or: [
      { targetId: targetRegex },
      { 'oldData.plan_id': planId },
      { 'newData.plan_id': planId },
      { 'oldData.sourcePlanId': planId },
      { 'newData.sourcePlanId': planId },
      { 'oldData.targetPlanId': planId },
      { 'newData.targetPlanId': planId },
    ],
  } as Filter<AuditLogRecord>;

  const logs = await docs.find(filter).sort({ timestamp: -1 }).limit(limit).toArray();
  return logs.map(stripMongoId);
}
