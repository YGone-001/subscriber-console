import { Document, Filter } from 'mongodb';
import { getAppCollection, mongoCollections } from '@/lib/mongo';

export type ApprovalAction =
  | 'POLICY_CHANGE'
  | 'TRAFFIC_ADJUSTMENT'
  | 'RATING_CREATE'
  | 'RATING_UPDATE'
  | 'RATING_DELETE'
  | 'TARIFF_PLAN_MIGRATE'
  | 'PROFILE_RESTORE'
  | 'SYSTEM_HEAL'
  | 'SUBSCRIBER_BATCH_CREATE'
  | 'SUBSCRIBER_IMPORT'
  | 'SUBSCRIBER_BULK_DELETE';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'executed' | 'failed';

export type ApprovalDocument = {
  id: string;
  action: ApprovalAction;
  status: ApprovalStatus;
  requester: string;
  reviewer?: string;
  targetId: string;
  summary: string;
  payload: Record<string, unknown>;
  note?: string;
  result?: unknown;
  error?: string;
  createdAt: string;
  reviewedAt?: string;
  executedAt?: string;
  updatedAt: string;
};

type CreateApprovalInput = {
  action: ApprovalAction;
  requester: string;
  targetId: string;
  summary: string;
  payload: Record<string, unknown>;
};

type ListApprovalOptions = {
  limit?: number;
  maxLimit?: number;
  status?: ApprovalStatus | 'all';
  requester?: string;
  fromTime?: number | null;
  toTime?: number | null;
};

type ApprovalSlaTone = 'ok' | 'warning' | 'danger';

function getApprovalAgeHours(createdAt: string, now = Date.now()) {
  const created = new Date(createdAt).getTime();
  if (!Number.isFinite(created)) return 0;
  return Math.max(0, Math.floor((now - created) / 3600000));
}

function getApprovalSlaTone(createdAt: string, now = Date.now()): ApprovalSlaTone {
  const hours = getApprovalAgeHours(createdAt, now);
  if (hours >= 48) return 'danger';
  if (hours >= 24) return 'warning';
  return 'ok';
}

function collection() {
  return getAppCollection<ApprovalDocument & Document>(mongoCollections.approvals);
}

function stripMongoId<T extends Record<string, unknown>>(doc: T | null): T | null {
  if (!doc) return null;
  const output = { ...doc };
  delete output._id;
  return output;
}

export function isApprovalStatus(value: unknown): value is ApprovalStatus {
  return ['pending', 'approved', 'rejected', 'executed', 'failed'].includes(String(value));
}

export async function createApprovalRequest(input: CreateApprovalInput): Promise<ApprovalDocument> {
  const docs = await collection();
  const now = new Date().toISOString();
  const approval: ApprovalDocument = {
    id: crypto.randomUUID(),
    action: input.action,
    status: 'pending',
    requester: input.requester,
    targetId: input.targetId,
    summary: input.summary,
    payload: input.payload,
    createdAt: now,
    updatedAt: now,
  };

  await docs.insertOne(approval);
  return approval;
}

export async function listApprovals(options: ListApprovalOptions = {}) {
  const docs = await collection();
  const maxLimit = Math.max(1, Math.min(Number(options.maxLimit || 200), 1000));
  const limit = Math.max(1, Math.min(Number(options.limit || 100), maxLimit));
  const filter: Filter<ApprovalDocument> = {};

  if (options.status && options.status !== 'all') filter.status = options.status;
  if (options.requester) filter.requester = options.requester;
  if (options.fromTime !== null || options.toTime !== null) {
    filter.createdAt = {};
    if (options.fromTime !== null && options.fromTime !== undefined) {
      filter.createdAt.$gte = new Date(options.fromTime).toISOString();
    }
    if (options.toTime !== null && options.toTime !== undefined) {
      filter.createdAt.$lte = new Date(options.toTime).toISOString();
    }
  }

  const pendingFilter: Filter<ApprovalDocument> = { status: 'pending' };
  if (options.requester) pendingFilter.requester = options.requester;

  const [approvals, total, pendingApprovals] = await Promise.all([
    docs.find(filter).sort({ createdAt: -1 }).limit(limit).toArray(),
    docs.countDocuments(filter),
    docs.find(pendingFilter).project<Pick<ApprovalDocument, 'createdAt'>>({ createdAt: 1, _id: 0 }).toArray(),
  ]);
  const now = Date.now();
  const sla = pendingApprovals.reduce(
    (acc, item) => {
      const hours = getApprovalAgeHours(item.createdAt, now);
      const tone = getApprovalSlaTone(item.createdAt, now);
      acc[tone] += 1;
      acc.oldestHours = Math.max(acc.oldestHours, hours);
      return acc;
    },
    { ok: 0, warning: 0, danger: 0, oldestHours: 0 }
  );

  return {
    approvals: approvals.map((item) => stripMongoId(item)) as ApprovalDocument[],
    total,
    pending: pendingApprovals.length,
    sla,
  };
}

export async function getApproval(id: string): Promise<ApprovalDocument | null> {
  const docs = await collection();
  const doc = await docs.findOne({ id });
  return stripMongoId(doc) as ApprovalDocument | null;
}

export async function transitionApproval(
  id: string,
  status: ApprovalStatus,
  reviewer: string,
  patch: Partial<Pick<ApprovalDocument, 'note' | 'result' | 'error'>> = {}
): Promise<ApprovalDocument | null> {
  const docs = await collection();
  const now = new Date().toISOString();
  const setPayload: Partial<ApprovalDocument> = {
    status,
    reviewer,
    updatedAt: now,
    ...patch,
  };

  if (status === 'approved' || status === 'rejected') setPayload.reviewedAt = now;
  if (status === 'executed' || status === 'failed') setPayload.executedAt = now;

  const result = await docs.findOneAndUpdate(
    { id },
    { $set: setPayload },
    { returnDocument: 'after' }
  );

  return stripMongoId(result) as ApprovalDocument | null;
}
