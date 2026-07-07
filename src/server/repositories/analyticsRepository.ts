import { Document } from 'mongodb';
import { getMongoCollection, mongoCollections } from '@/lib/mongo';
import type { Open5gsSubscriberDocument } from '@/types/open5gs';

type SubscriberDoc = Open5gsSubscriberDocument & Document;

export type AnalyticsMetrics = {
  totalTraffic: number;
  plmnDist: Array<{ name: string; value: number }>;
  ratesDist: Array<{ name: string; value: number }>;
  top5: Array<{ imsi: string; balance: number }>;
  timestamp: number;
};

function subscribersCollection() {
  return getMongoCollection<SubscriberDoc>(mongoCollections.subscribers);
}

function firstRateId(doc: Open5gsSubscriberDocument): string | null {
  const map = doc.ocs?.rating?.rates_map;
  if (!map) return null;
  const first = Object.values(map)[0];
  return first === undefined || first === null || first === '' ? null : String(first);
}

export async function computeAnalyticsMetrics(): Promise<AnalyticsMetrics> {
  const docs = await subscribersCollection();
  const cursor = docs.find(
    {},
    { projection: { imsi: 1, 'ocs.traffic': 1, 'ocs.rating.rates_map': 1 } }
  );
  let totalTraffic = 0;
  const plmnMap = new Map<string, number>();
  const rateMap = new Map<string, number>();
  const leaderboard: Array<{ imsi: string; balance: number }> = [];

  for await (const doc of cursor) {
    const balance = Number(doc.ocs?.traffic?.traffic_balance || 0);
    const plmn = String(doc.ocs?.traffic?.plmn || '45400');

    if (balance > 0) {
      totalTraffic += balance;
      plmnMap.set(plmn, (plmnMap.get(plmn) || 0) + balance);
      leaderboard.push({ imsi: doc.imsi, balance });
    }

    const rateId = firstRateId(doc);
    if (rateId) rateMap.set(rateId, (rateMap.get(rateId) || 0) + 1);
  }

  leaderboard.sort((a, b) => b.balance - a.balance);

  return {
    totalTraffic,
    plmnDist: Array.from(plmnMap, ([name, value]) => ({ name, value })),
    ratesDist: Array.from(rateMap, ([name, value]) => ({ name: `Group #${name}`, value })),
    top5: leaderboard.slice(0, 5),
    timestamp: Date.now(),
  };
}

export async function computeSparklineBasis() {
  const docs = await subscribersCollection();
  const [currentSubCount, metrics] = await Promise.all([
    docs.countDocuments({}),
    computeAnalyticsMetrics(),
  ]);

  return {
    currentSubCount,
    currentTraffic: metrics.totalTraffic,
  };
}
