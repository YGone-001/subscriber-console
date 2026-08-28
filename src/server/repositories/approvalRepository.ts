import { Document, Filter } from 'mongodb';
import { sanitizeAuditPayload, sanitizeAuditText, type AuditValue } from '@/lib/audit/sanitize';
import { getAppCollection, mongoCollections } from '@/lib/mongo';
import { assessApprovalRisk, type ApprovalRiskAssessment } from '@/server/approvalRiskPolicy';
import type { GovernanceActor, GovernanceEvent, RiskLevel, ApprovalStatus } from '@/types/governance';

export type ApprovalAction =
  | 'POLICY_CHANGE'
  | 'TRAFFIC_ADJUSTMENT'
  | 'TARIFF_PLAN_CREATE'
  | 'TARIFF_PLAN_UPDATE'
  | 'TARIFF_PLAN_DELETE'
  | 'TARIFF_PLAN_RULE_CREATE'
  | 'TARIFF_PLAN_RULE_UPDATE'
  | 'TARIFF_PLAN_RULE_DELETE'
  | 'TARIFF_PLAN_RULE_TOGGLE'
  | 'RATING_CREATE'
  | 'RATING_UPDATE'
  | 'RATING_DELETE'
  | 'TARIFF_PLAN_MIGRATE'
  | 'PROFILE_RESTORE'
  | 'SYSTEM_HEAL'
  | 'SUBSCRIBER_BATCH_CREATE'
  | 'SUBSCRIBER_BATCH_UPDATE'
  | 'SUBSCRIBER_CREATE'
  | 'SUBSCRIBER_UPDATE'
  | 'SUBSCRIBER_DELETE'
  | 'SUBSCRIBER_IMPORT'
  | 'SUBSCRIBER_IMPORT_OVERWRITE'
  | 'SUBSCRIBER_BULK_DELETE'
  | 'SUBSCRIBER_PROFILE_APPLY'
  | 'ACCESS_REQUEST';

export type { ApprovalStatus } from '@/types/governance';

export type ApprovalOperation = {
  resourceType: string;
  resourceId: string;
};

export type ApprovalMaintenanceWindow = {
  start: string;
  end: string;
  timeZone?: string;
};

export type ApprovalDecision = {
  outcome: 'approved' | 'rejected';
  comment?: string;
  decidedAt: string;
};

export type ApprovalExecution = {
  id?: string;
  startedAt?: string;
  completedAt?: string;
  success?: boolean;
  error?: { code: string; message: string };
};

export type ApprovalDocument = {
  id: string;
  changeId?: string;
  title: string;
  description?: string;
  action: ApprovalAction;
  status: ApprovalStatus;
  operation: ApprovalOperation;
  operationFingerprint?: string;
  riskLevel: RiskLevel;
  riskAssessment: ApprovalRiskAssessment;
  requester: string;
  requesterContext?: GovernanceActor;
  reviewer?: string;
  reviewerContext?: GovernanceActor;
  targetId: string;
  summary: string;
  reason?: string;
  note?: string;
  ticketId?: string;
  maintenanceWindow?: ApprovalMaintenanceWindow;
  before?: AuditValue;
  after?: AuditValue;
  payload: Record<string, unknown>;
  decision?: ApprovalDecision;
  execution?: ApprovalExecution;
  events: GovernanceEvent[];
  result?: unknown;
  error?: string;
  createdAt: string;
  reviewedAt?: string;
  executedAt?: string;
  updatedAt: string;
  expiresAt?: string;
  legacyStatus?: 'executed';
};

export type CreateApprovalInput = {
  action: ApprovalAction;
  requester: string;
  requesterContext?: GovernanceActor;
  targetId: string;
  summary: string;
  title?: string;
  description?: string;
  operation?: ApprovalOperation;
  operationFingerprint?: string;
  reason?: string;
  ticketId?: string;
  maintenanceWindow?: ApprovalMaintenanceWindow;
  before?: unknown;
  after?: unknown;
  payload: Record<string, unknown>;
  expiresAt?: string;
};

export type ListApprovalOptions = {
  limit?: number;
  maxLimit?: number;
  page?: number;
  pageSize?: number;
  q?: string;
  status?: ApprovalStatus | 'all';
  risk?: RiskLevel;
  action?: ApprovalAction;
  resourceType?: string;
  resourceId?: string;
  requester?: string;
  reviewer?: string;
  fromTime?: number | null;
  toTime?: number | null;
  actor?: { user: string; canApprove: boolean };
};

type ApprovalSlaTone = 'ok' | 'warning' | 'danger';
type StoredApprovalDocument = Omit<ApprovalDocument, 'status'> & { status: ApprovalStatus | 'executed' };

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
  return getAppCollection<StoredApprovalDocument & Document>(mongoCollections.approvals);
}

function sequenceCollection() {
  return getAppCollection<{ _id: string; value: number; updatedAt: string } & Document>(mongoCollections.sequences);
}

function stripMongoId<T extends Record<string, unknown>>(doc: T | null): T | null {
  if (!doc) return null;
  const output = { ...doc };
  delete output._id;
  return output;
}

function resourceType(targetId: string): string {
  const prefix = targetId.split(':', 1)[0]?.trim();
  return prefix && prefix !== targetId ? prefix : 'approval-target';
}

function normalizeApproval(doc: (StoredApprovalDocument & Document) | null): ApprovalDocument | null {
  const clean = stripMongoId(doc);
  if (!clean) return null;
  const legacyExecuted = clean.status === 'executed';
  const riskAssessment = clean.riskAssessment || assessApprovalRisk(clean.action);
  return {
    ...clean,
    title: clean.title || clean.summary,
    operation: clean.operation || { resourceType: resourceType(clean.targetId), resourceId: clean.targetId },
    riskLevel: clean.riskLevel || riskAssessment.level,
    riskAssessment,
    payload: sanitizeAuditPayload(clean.payload) as Record<string, unknown>,
    before: clean.before === undefined ? undefined : sanitizeAuditPayload(clean.before),
    after: clean.after === undefined ? undefined : sanitizeAuditPayload(clean.after),
    result: clean.result === undefined ? undefined : sanitizeAuditPayload(clean.result),
    events: Array.isArray(clean.events) ? clean.events : [],
    status: legacyExecuted ? 'completed' : clean.status,
    legacyStatus: legacyExecuted ? 'executed' : clean.legacyStatus,
  } as ApprovalDocument;
}

function dateKey(date: Date): string {
  return date.toISOString().slice(0, 10).replaceAll('-', '');
}

export async function nextChangeId(now = new Date()): Promise<string> {
  const key = dateKey(now);
  const sequences = await sequenceCollection();
  const sequence = await sequences.findOneAndUpdate(
    { _id: `approval:${key}` },
    { $inc: { value: 1 }, $set: { updatedAt: now.toISOString() } },
    { upsert: true, returnDocument: 'after' }
  );
  if (!sequence || !Number.isSafeInteger(sequence.value) || sequence.value < 1) {
    throw new Error('APPROVAL_SEQUENCE_UNAVAILABLE');
  }
  return `CHG-${key}-${String(sequence.value).padStart(5, '0')}`;
}

export function isApprovalStatus(value: unknown): value is ApprovalStatus {
  return ['pending', 'approved', 'rejected', 'cancelled', 'expired', 'executing', 'completed', 'failed'].includes(String(value));
}

export async function createApprovalRequest(input: CreateApprovalInput): Promise<ApprovalDocument> {
  const docs = await collection();
  const now = new Date();
  const timestamp = now.toISOString();
  const id = crypto.randomUUID();
  const riskAssessment = assessApprovalRisk(input.action);
  const operation = input.operation || { resourceType: resourceType(input.targetId), resourceId: input.targetId };
  const reason = sanitizeAuditText(input.reason ?? (typeof input.payload.reason === 'string' ? input.payload.reason : '')).trim() || undefined;
  const approval: StoredApprovalDocument = {
    id,
    changeId: await nextChangeId(now),
    title: sanitizeAuditText(input.title || input.summary),
    description: input.description ? sanitizeAuditText(input.description) : undefined,
    action: input.action,
    status: 'pending',
    operation: { resourceType: sanitizeAuditText(operation.resourceType), resourceId: sanitizeAuditText(operation.resourceId) },
    operationFingerprint: input.operationFingerprint ? sanitizeAuditText(input.operationFingerprint) : undefined,
    riskLevel: riskAssessment.level,
    riskAssessment,
    requester: sanitizeAuditText(input.requester),
    requesterContext: input.requesterContext,
    targetId: sanitizeAuditText(input.targetId),
    summary: sanitizeAuditText(input.summary),
    reason,
    ticketId: input.ticketId ? sanitizeAuditText(input.ticketId) : undefined,
    maintenanceWindow: input.maintenanceWindow,
    before: input.before === undefined ? undefined : sanitizeAuditPayload(input.before),
    after: input.after === undefined ? undefined : sanitizeAuditPayload(input.after),
    payload: sanitizeAuditPayload(input.payload) as Record<string, unknown>,
    events: [{ id: crypto.randomUUID(), timestamp, type: 'created', actor: input.requester, message: 'Change request created' }],
    createdAt: timestamp,
    updatedAt: timestamp,
    expiresAt: input.expiresAt,
  };

  await docs.insertOne(approval);
  return normalizeApproval(approval as StoredApprovalDocument & Document) as ApprovalDocument;
}

export async function getPendingAccessRequest(requester: string): Promise<ApprovalDocument | null> {
  const docs = await collection();
  return normalizeApproval(await docs.findOne({ requester, action: 'ACCESS_REQUEST', status: 'pending' }));
}

export async function listApprovals(options: ListApprovalOptions = {}) {
  const docs = await collection();
  const maxLimit = Math.max(1, Math.min(Number(options.maxLimit || 200), 1000));
  const requestedPageSize = options.pageSize ?? options.limit ?? 20;
  const pageSize = Math.max(1, Math.min(Number(requestedPageSize), maxLimit));
  const requestedPage = Math.max(1, Number(options.page || 1));
  const filter: Filter<StoredApprovalDocument> = {};

  if (options.status && options.status !== 'all') {
    filter.status = options.status === 'completed' ? { $in: ['completed', 'executed'] } : options.status;
  }
  if (options.risk) filter.riskLevel = options.risk;
  if (options.action) filter.action = options.action;
  if (options.requester) filter.requester = options.requester;
  if (options.reviewer) filter.reviewer = options.reviewer;
  if (options.resourceType) filter['operation.resourceType'] = options.resourceType;
  if (options.resourceId) filter['operation.resourceId'] = options.resourceId;
  if (options.q) {
    const escaped = options.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = { $regex: escaped, $options: 'i' };
    filter.$or = [
      { changeId: pattern }, { id: pattern }, { title: pattern }, { summary: pattern },
      { targetId: pattern }, { requester: pattern }, { reviewer: pattern }, { action: pattern },
    ];
  }
  if (options.fromTime !== null || options.toTime !== null) {
    filter.createdAt = {};
    if (options.fromTime !== null && options.fromTime !== undefined) filter.createdAt.$gte = new Date(options.fromTime).toISOString();
    if (options.toTime !== null && options.toTime !== undefined) filter.createdAt.$lte = new Date(options.toTime).toISOString();
  }

  const pendingFilter: Filter<StoredApprovalDocument> = { status: 'pending' };
  if (options.requester) pendingFilter.requester = options.requester;
  const total = await docs.countDocuments(filter);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(requestedPage, totalPages);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const withFilter = (extra: Filter<StoredApprovalDocument>): Filter<StoredApprovalDocument> => ({ $and: [filter, extra] });
  const canReviewFilter: Filter<StoredApprovalDocument> = withFilter({
    status: 'pending',
    $or: [
      { riskLevel: { $in: ['low', 'medium'] } },
      { riskLevel: { $in: ['high', 'critical'] }, requester: { $ne: options.actor?.user } },
      { riskLevel: { $exists: false }, requester: { $ne: options.actor?.user } },
    ],
  });
  const [approvals, pendingApprovals, awaiting, todayApproved, highRiskPending, canReview] = await Promise.all([
    docs.find(filter).sort({ createdAt: -1 }).skip((page - 1) * pageSize).limit(pageSize).toArray(),
    docs.find(pendingFilter).project<Pick<StoredApprovalDocument, 'createdAt'>>({ createdAt: 1, _id: 0 }).toArray(),
    docs.countDocuments(withFilter({ status: 'pending' })),
    docs.countDocuments(withFilter({ 'decision.outcome': 'approved', 'decision.decidedAt': { $gte: today.toISOString() } })),
    docs.countDocuments(withFilter({ status: 'pending', riskLevel: { $in: ['high', 'critical'] } })),
    options.actor?.canApprove ? docs.countDocuments(canReviewFilter) : Promise.resolve(0),
  ]);
  const now = Date.now();
  const sla = pendingApprovals.reduce((acc, item) => {
    const hours = getApprovalAgeHours(item.createdAt, now);
    const tone = getApprovalSlaTone(item.createdAt, now);
    acc[tone] += 1;
    acc.oldestHours = Math.max(acc.oldestHours, hours);
    return acc;
  }, { ok: 0, warning: 0, danger: 0, oldestHours: 0 });

  return {
    approvals: approvals.map((item) => normalizeApproval(item) as ApprovalDocument),
    pagination: { page, pageSize, total, totalPages },
    summary: { canReview, awaiting, todayApproved, highRiskPending },
    total, pending: pendingApprovals.length, sla,
  };
}

export async function getApproval(id: string): Promise<ApprovalDocument | null> {
  const docs = await collection();
  return normalizeApproval(await docs.findOne({ id }));
}

/** Active governed subscriber changes are intentionally small (the batch target
 * cap is 100), so the route can compare their frozen target/field summaries
 * without introducing a separate lock service. */
export async function listActiveSubscriberBatchApprovals() {
  const docs = await collection();
  const values = await docs.find({
    action: 'SUBSCRIBER_BATCH_UPDATE',
    status: { $in: ['pending', 'approved', 'executing'] },
  }).project<StoredApprovalDocument>({ _id: 0 }).toArray();
  return values.map((item) => normalizeApproval(item as StoredApprovalDocument & Document) as ApprovalDocument);
}

const ALLOWED_TRANSITIONS: Readonly<Record<ApprovalStatus, readonly ApprovalStatus[]>> = {
  pending: ['approved', 'rejected', 'cancelled', 'expired'],
  approved: ['executing', 'cancelled'],
  executing: ['completed', 'failed'],
  rejected: [], cancelled: [], expired: [], completed: [], failed: [],
};

export type ApprovalTransitionPatch = Pick<ApprovalDocument, never> & {
  reviewer?: string;
  reviewerContext?: GovernanceActor;
  note?: string;
  decision?: ApprovalDecision;
  execution?: ApprovalExecution;
  result?: unknown;
  error?: string;
  reviewedAt?: string;
  executedAt?: string;
};

export type ApprovalTransitionResult =
  | { ok: true; approval: ApprovalDocument }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'conflict'; approval: ApprovalDocument };

/** The only approval status writer. Status and its evidence event share one CAS update. */
export async function transitionApproval(input: {
  id: string;
  expectedStatus: ApprovalStatus;
  nextStatus: ApprovalStatus;
  actor: string;
  eventType: string;
  eventMessage: string;
  expectedExecutionId?: string;
  patch?: ApprovalTransitionPatch;
}): Promise<ApprovalTransitionResult> {
  if (!ALLOWED_TRANSITIONS[input.expectedStatus].includes(input.nextStatus)) {
    throw new Error(`APPROVAL_TRANSITION_NOT_ALLOWED:${input.expectedStatus}:${input.nextStatus}`);
  }
  const docs = await collection();
  const now = new Date().toISOString();
  const result = await docs.findOneAndUpdate(
    { id: input.id, status: input.expectedStatus, ...(input.expectedExecutionId ? { 'execution.id': input.expectedExecutionId } : {}) },
    ({
      $set: { status: input.nextStatus, updatedAt: now, ...input.patch },
      $push: { events: { id: crypto.randomUUID(), timestamp: now, type: input.eventType, actor: input.actor, message: input.eventMessage } },
    }) as Document,
    { returnDocument: 'after' }
  );
  if (result) return { ok: true, approval: normalizeApproval(result) as ApprovalDocument };
  const current = await docs.findOne({ id: input.id });
  if (!current) return { ok: false, reason: 'not_found' };
  return { ok: false, reason: 'conflict', approval: normalizeApproval(current) as ApprovalDocument };
}
