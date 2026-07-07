import { NextResponse } from 'next/server';
import { logAudit } from '@/lib/audit';
import { requireAnyRole } from '@/lib/authz';
import { enforceRateLimit } from '@/lib/rateLimit';
import { createSubscribersBatch } from '@/server/repositories/subscriberRepository';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const auth = requireAnyRole(request, ['root', 'operator']);
  if (!auth.ok) return auth.response;

  const rateLimit = await enforceRateLimit(`subscribers:batch:${auth.auth.user}`, 10, 60);
  if (!rateLimit.ok) return rateLimit.response;

  try {
    const body = await request.json();
    const {
      startImsi,
      count,
      plmn,
      trafficTotal,
      trafficBalance,
      withhold,
      withholdingResidue,
      withholdingTime,
      ratingGroupId,
      profileName,
      currency,
      balance,
      strategy,
    } = body;

    if (!startImsi || !count) {
      return NextResponse.json({ error: 'startImsi and count are required' }, { status: 400 });
    }
    if (!/^\d{15}$/.test(startImsi)) {
      return NextResponse.json({ error: 'Invalid startImsi format (must be 15 digits)' }, { status: 400 });
    }

    const numCount = Number(count);
    if (numCount <= 0 || numCount > 1000) {
      return NextResponse.json({ error: 'Count must be between 1 and 1000' }, { status: 400 });
    }

    const result = await createSubscribersBatch({
      startImsi,
      count: numCount,
      plmn,
      trafficTotal,
      trafficBalance,
      withhold,
      withholdingResidue,
      withholdingTime,
      ratingGroupId,
      profileName,
      currency,
      balance,
      strategy: strategy === 'skip' ? 'skip' : 'overwrite',
    });
    const { createdImsis, skippedImsis, metrics } = result;

    if (createdImsis.length > 0) {
      logAudit(
        'BATCH_CREATE',
        `${createdImsis[0]} ~ ${createdImsis[createdImsis.length - 1]}`,
        null,
        {
          batchSize: createdImsis.length,
          skipped: skippedImsis.length,
          profileTemplate: profileName,
          batchMetrics: metrics,
        },
        request
      );
    }

    return NextResponse.json(
      {
        message: `Successfully created ${createdImsis.length} subscribers${skippedImsis.length > 0 ? ` (Skipped ${skippedImsis.length})` : ''}`,
        count: createdImsis.length,
        skippedCount: skippedImsis.length,
        range: createdImsis.length > 0 ? { from: createdImsis[0], to: createdImsis[createdImsis.length - 1] } : null,
      },
      { status: 201 }
    );
  } catch (error) {
    console.error('Error in batch creation:', error);
    return NextResponse.json({ error: 'Batch creation failed' }, { status: 500 });
  }
}
