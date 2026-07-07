import { Document, MongoServerError } from 'mongodb';
import { getMongoCollection, mongoCollections } from '@/lib/mongo';
import type { Open5gsSubscriberDocument } from '@/types/open5gs';

export type RatingDocument = Document & {
  rating_group_id: number;
  currency: string;
  rates: string;
  rates_type: number;
};

export type RatingReferenceScan = {
  count: number;
  examples: string[];
};

function ratingsCollection() {
  return getMongoCollection<RatingDocument>(mongoCollections.ratings);
}

function subscribersCollection() {
  return getMongoCollection<Open5gsSubscriberDocument & Document>(mongoCollections.subscribers);
}

function stripMongoId<T extends Record<string, unknown>>(doc: T | null): T | null {
  if (!doc) return null;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { _id, ...rest } = doc;
  return rest as T;
}

function isDuplicateKey(error: unknown): boolean {
  return error instanceof MongoServerError && error.code === 11000;
}

export async function listRatings() {
  const collection = await ratingsCollection();
  const ratings = await collection.find({}).sort({ rating_group_id: 1 }).toArray();
  return ratings.map((rating) => stripMongoId(rating));
}

export async function getRating(id: string | number) {
  const collection = await ratingsCollection();
  return stripMongoId(await collection.findOne({ rating_group_id: Number(id) }));
}

export async function createRating(input: {
  rating_group_id: unknown;
  currency?: unknown;
  rates?: unknown;
  rates_type?: unknown;
}) {
  const collection = await ratingsCollection();
  const doc: RatingDocument = {
    rating_group_id: Number(input.rating_group_id),
    currency: String(input.currency || 'USD'),
    rates: String(input.rates || '0'),
    rates_type: Number(input.rates_type) || 1,
  };

  try {
    await collection.insertOne(doc);
    return doc;
  } catch (error) {
    if (isDuplicateKey(error)) throw new Error('RATING_EXISTS');
    throw error;
  }
}

export async function updateRating(id: string, input: {
  currency?: unknown;
  rates?: unknown;
  rates_type?: unknown;
}) {
  const collection = await ratingsCollection();
  const existing = await getRating(id);
  const updated: RatingDocument = {
    rating_group_id: Number(id),
    currency: String(input.currency || existing?.currency || 'USD'),
    rates: String(input.rates !== undefined ? input.rates : existing?.rates || '0'),
    rates_type: Number(input.rates_type !== undefined ? input.rates_type : existing?.rates_type || 1),
  };

  await collection.replaceOne({ rating_group_id: Number(id) }, updated, { upsert: true });
  return updated;
}

function ratesMapUsesRating(map: Record<string, unknown> | undefined, id: string): boolean {
  if (!map || typeof map !== 'object') return false;
  return Object.values(map).some((value) => String(value) === id);
}

export async function scanRatingReferences(id: string): Promise<RatingReferenceScan> {
  const collection = await subscribersCollection();
  const cursor = collection.find(
    { 'ocs.rating.rates_map': { $exists: true } },
    { projection: { imsi: 1, 'ocs.rating.rates_map': 1 } }
  );
  let count = 0;
  const examples: string[] = [];

  for await (const subscriber of cursor) {
    if (ratesMapUsesRating(subscriber.ocs?.rating?.rates_map, id)) {
      count++;
      if (examples.length < 5) examples.push(subscriber.imsi);
    }
  }

  return { count, examples };
}

export async function deleteRating(id: string) {
  const references = await scanRatingReferences(id);
  if (references.count > 0) {
    return { deleted: false, references };
  }

  const collection = await ratingsCollection();
  await collection.deleteOne({ rating_group_id: Number(id) });
  return { deleted: true, references };
}
