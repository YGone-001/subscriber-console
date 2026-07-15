import { getAppCollection, mongoCollections } from '@/lib/mongo';

type RateLimitDocument = {
  key: string;
  count: number;
  reset_at: Date;
  updated_at: Date;
};

function collection() {
  return getAppCollection<RateLimitDocument>(mongoCollections.rateLimits);
}

export async function incrementFixedWindow(key: string, resetAtSeconds: number) {
  const docs = await collection();
  const resetAt = new Date(resetAtSeconds * 1000);
  const now = new Date();
  const result = await docs.findOneAndUpdate(
    { key },
    {
      $inc: { count: 1 },
      $set: { updated_at: now },
      $setOnInsert: { key, reset_at: resetAt },
    },
    { upsert: true, returnDocument: 'after' }
  );

  return result?.count || 0;
}
