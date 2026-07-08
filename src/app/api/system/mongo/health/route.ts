import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/authz';
import { enforceRateLimit } from '@/lib/rateLimit';
import { getMongoHealthReport } from '@/server/repositories/mongoHealthRepository';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request) {
  const auth = requireAuth(request);
  if (!auth.ok) return auth.response;

  const rateLimit = await enforceRateLimit(`system:mongo-health:${auth.auth.user}`, 30, 60);
  if (!rateLimit.ok) return rateLimit.response;

  try {
    const report = await getMongoHealthReport();
    return NextResponse.json(report, { status: 200 });
  } catch (error) {
    console.error('MongoDB health check failed:', error);
    return NextResponse.json(
      {
        ok: false,
        database: null,
        checkedAt: new Date().toISOString(),
        latencyMs: null,
        collections: [],
        missingCollections: [],
        missingIndexes: [],
        error: 'MongoDB health check failed',
      },
      { status: 200 }
    );
  }
}
