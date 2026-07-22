import { Document, Long } from 'mongodb';
import { getOpen5gsCollection, mongoCollections } from '@/lib/mongo';
import { firstActiveRatingPolicy } from '@/server/repositories/ocsBillingRepository';
import type { Open5gsSubscriberDocument } from '@/types/xcloud';

type SubscriberDoc = Open5gsSubscriberDocument & Document;

export type AnalyticsMetrics = {
  totalTraffic: number;
  plmnDist: Array<{ name: string; value: number }>;
  ratesDist: Array<{ name: string; value: number }>;
  top5: Array<{ imsi: string; balance: number; voiceBalance: number; smsBalance: number }>;
  timestamp: number;
};

function subscribersCollection() {
  return getOpen5gsCollection<SubscriberDoc>(mongoCollections.subscribers);
}

function balancesCollection() {
  return getOpen5gsCollection<Document & {
    imsi: string;
    data_available?: Long | number;
    voice_available?: Long | number;
    sms_available?: Long | number;
  }>(mongoCollections.ocsBalances);
}

function numericValue(value: unknown): number {
  if (Long.isLong(value)) return value.toNumber();
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export async function computeAnalyticsMetrics(): Promise<AnalyticsMetrics> {
  const balances = await balancesCollection();
  const policy = await firstActiveRatingPolicy();
  const cursor = balances.find({}, { projection: { imsi: 1, data_available: 1, voice_available: 1, sms_available: 1 } });
  let totalTraffic = 0;
  const plmnMap = new Map<string, number>();
  const policyCount = policy ? await balances.estimatedDocumentCount() : 0;
  const leaderboard: Array<{ imsi: string; balance: number; voiceBalance: number; smsBalance: number }> = [];

  for await (const balanceDoc of cursor) {
    const balance = numericValue(balanceDoc.data_available);
    const voiceBalance = numericValue(balanceDoc.voice_available);
    const smsBalance = numericValue(balanceDoc.sms_available);
    const plmn = balanceDoc.imsi.slice(0, 5) || '45400';

    if (balance > 0) {
      totalTraffic += balance;
      plmnMap.set(plmn, (plmnMap.get(plmn) || 0) + balance);
      leaderboard.push({ imsi: balanceDoc.imsi, balance, voiceBalance, smsBalance });
    }
  }

  leaderboard.sort((a, b) => b.balance - a.balance);

  return {
    totalTraffic,
    plmnDist: Array.from(plmnMap, ([name, value]) => ({ name, value })),
    ratesDist: policy ? [{ name: `Group #${policy.rating_group_id}`, value: policyCount }] : [],
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
