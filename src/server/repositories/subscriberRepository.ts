import { Document, Filter, MongoServerError } from 'mongodb';
import { getMongoCollection, mongoCollections } from '@/lib/mongo';
import {
  buildDefaultOpen5gsSubscriber,
  buildOpen5gsSubscriberFromLegacy,
  open5gsToLegacyState,
} from '@/lib/open5gsSubscriber';
import type { LegacySubscriberState, Open5gsSubscriberDocument } from '@/types/open5gs';

type SubscriberDoc = Open5gsSubscriberDocument & Document;

export type SubscriberListResult<T> = {
  subscribers: T[];
  total: number;
  page: number;
  limit: number;
};

export type SubscriberRow = {
  imsi: string;
  status: string;
  ard: number;
  plmn: string;
  profile: string;
  policy: string;
  traffic: {
    total: number;
    used: number;
    balance: number;
  };
  lastActive: string;
};

type RatingDoc = {
  rating_group_id: number;
  currency?: string;
  rates?: string | number;
  rates_type?: number;
};

function isDuplicateKey(error: unknown): boolean {
  return error instanceof MongoServerError && error.code === 11000;
}

function safePage(page: number): number {
  return Math.max(1, Number.isFinite(page) ? page : 1);
}

function safeLimit(limit: number): number {
  return Math.min(Math.max(1, Number.isFinite(limit) ? limit : 50), 200);
}

function subscriberFilter(query = ''): Filter<SubscriberDoc> | null {
  const trimmed = query.trim();
  if (!trimmed) return {};
  if (!/^\d{1,15}$/.test(trimmed)) return null;
  return { imsi: { $regex: `^${trimmed}` } };
}

function ratingTypeLabel(type: unknown): string {
  const value = Number(type);
  if (value === 1) return 'Time';
  if (value === 2) return 'Vol';
  if (value === 3) return 'Event';
  return 'Flat';
}

function firstRatingGroupId(doc: Open5gsSubscriberDocument): string | null {
  const ratesMap = doc.ocs?.rating?.rates_map;
  if (!ratesMap) return null;
  const first = Object.values(ratesMap)[0];
  return first === undefined || first === null || first === '' ? null : String(first);
}

function normalizedTraffic(doc: Open5gsSubscriberDocument) {
  const traffic = doc.ocs?.traffic || {};
  const balance = Number(traffic.traffic_balance) || 0;
  let total = Number(traffic.traffic_total);

  if (!Number.isFinite(total)) total = balance;
  if (total < balance) total = balance;

  return {
    total,
    balance,
    used: Math.max(0, total - balance),
  };
}

function lastActive(doc: Open5gsSubscriberDocument): string {
  const raw = doc.ocs?.imsi?.last_update_time || doc.updated_at || doc.created_at;
  const date = raw ? new Date(raw) : new Date();
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function statusFromAccessRestriction(accessRestriction: unknown): string {
  const ard = Number(accessRestriction);
  if (ard === 255) return 'Suspended';
  if (ard > 0 && ard !== 32) return 'Partial Restricted';
  return 'Active';
}

async function subscribersCollection() {
  return getMongoCollection<SubscriberDoc>(mongoCollections.subscribers);
}

async function ratingsCollection() {
  return getMongoCollection<RatingDoc & Document>(mongoCollections.ratings);
}

async function ratingMapFor(docs: Open5gsSubscriberDocument[]): Promise<Map<string, RatingDoc>> {
  const ids = Array.from(new Set(docs.map(firstRatingGroupId).filter((id): id is string => !!id)));
  const ratings = new Map<string, RatingDoc>();
  if (ids.length === 0) return ratings;

  const collection = await ratingsCollection();
  const rows = await collection
    .find({ rating_group_id: { $in: ids.map((id) => Number(id)) } })
    .toArray();

  rows.forEach((row) => ratings.set(String(row.rating_group_id), row));
  return ratings;
}

function toSubscriberRow(doc: Open5gsSubscriberDocument, ratings: Map<string, RatingDoc>): SubscriberRow {
  const ratingGroupId = firstRatingGroupId(doc);
  const rating = ratingGroupId ? ratings.get(ratingGroupId) : null;
  const policy = rating
    ? `${rating.currency || 'USD'} ${rating.rates || '0'} (${ratingTypeLabel(rating.rates_type)})`
    : '';
  const traffic = normalizedTraffic(doc);
  const ard = Number(doc.access_restriction_data ?? 32);

  return {
    imsi: doc.imsi,
    status: statusFromAccessRestriction(ard),
    ard,
    plmn: doc.ocs?.traffic?.plmn || '45400',
    profile: doc.webui_meta?.profile_name || '',
    policy,
    traffic,
    lastActive: lastActive(doc),
  };
}

export async function listSubscriberImsis(
  page: number,
  limit: number,
  query = ''
): Promise<SubscriberListResult<string>> {
  const filter = subscriberFilter(query);
  const pageValue = safePage(page);
  const limitValue = safeLimit(limit);

  if (!filter) {
    return { subscribers: [], total: 0, page: pageValue, limit: limitValue };
  }

  const collection = await subscribersCollection();
  const [total, docs] = await Promise.all([
    collection.countDocuments(filter),
    collection
      .find(filter, { projection: { imsi: 1 } })
      .sort({ imsi: 1 })
      .skip((pageValue - 1) * limitValue)
      .limit(limitValue)
      .toArray(),
  ]);

  return {
    subscribers: docs.map((doc) => doc.imsi),
    total,
    page: pageValue,
    limit: limitValue,
  };
}

export async function listSubscriberRows(
  page: number,
  limit: number,
  query = ''
): Promise<SubscriberListResult<SubscriberRow>> {
  const filter = subscriberFilter(query);
  const pageValue = safePage(page);
  const limitValue = safeLimit(limit);

  if (!filter) {
    return { subscribers: [], total: 0, page: pageValue, limit: limitValue };
  }

  const collection = await subscribersCollection();
  const [total, docs] = await Promise.all([
    collection.countDocuments(filter),
    collection
      .find(filter)
      .sort({ imsi: 1 })
      .skip((pageValue - 1) * limitValue)
      .limit(limitValue)
      .toArray(),
  ]);
  const ratings = await ratingMapFor(docs);

  return {
    subscribers: docs.map((doc) => toSubscriberRow(doc, ratings)),
    total,
    page: pageValue,
    limit: limitValue,
  };
}

export async function findSubscriberDocument(imsi: string): Promise<Open5gsSubscriberDocument | null> {
  const collection = await subscribersCollection();
  return collection.findOne({ imsi });
}

export async function findSubscriberLegacyState(imsi: string): Promise<LegacySubscriberState | null> {
  const doc = await findSubscriberDocument(imsi);
  return open5gsToLegacyState(doc);
}

export async function createDefaultSubscriber(imsi: string): Promise<Open5gsSubscriberDocument> {
  const collection = await subscribersCollection();
  const doc = buildDefaultOpen5gsSubscriber(imsi);

  try {
    await collection.insertOne(doc as SubscriberDoc);
    return doc;
  } catch (error) {
    if (isDuplicateKey(error)) {
      throw new Error('SUBSCRIBER_EXISTS');
    }
    throw error;
  }
}

export async function updateSubscriberFromLegacy(
  imsi: string,
  payload: {
    sub4G?: unknown;
    auth4G?: unknown;
    ocsImsi?: unknown;
    ocsTraffic?: unknown;
    ocsImsiSet?: unknown;
    ocsAccount?: unknown;
  }
): Promise<Open5gsSubscriberDocument> {
  const collection = await subscribersCollection();
  const existing = await collection.findOne({ imsi });
  const next = buildOpen5gsSubscriberFromLegacy(imsi, payload, existing);

  await collection.replaceOne(
    { imsi },
    next as SubscriberDoc,
    { upsert: true }
  );

  return next;
}

export async function deleteSubscriber(imsi: string): Promise<boolean> {
  const collection = await subscribersCollection();
  const result = await collection.deleteOne({ imsi });
  return result.deletedCount > 0;
}
