import { NextResponse } from 'next/server';
import { logAudit } from '@/lib/audit';
import { requireAnyRole } from '@/lib/authz';
import { enforceRateLimit } from '@/lib/rateLimit';
import { createSubscribersBatch } from '@/server/repositories/subscriberRepository';
import { validateBatchCreatePayload } from '@/lib/subscriberValidation';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const auth = requireAnyRole(request, ['root', 'operator']);
  if (!auth.ok) return auth.response;

  const rateLimit = await enforceRateLimit(`subscribers:batch:${auth.auth.user}`, 10, 60);
  if (!rateLimit.ok) return rateLimit.response;

  try {
    const body = await request.json();
    const validation = validateBatchCreatePayload(body);
    if (!validation.ok) return NextResponse.json({ error: validation.error }, { status: 400 });
    const payload = validation.value;

    const result = await createSubscribersBatch({
      startImsi: payload.startImsi,
      count: payload.count,
      plmn: payload.plmn,
      trafficTotal: payload.trafficTotal,
      trafficBalance: payload.trafficBalance,
      withhold: payload.withhold,
      withholdingResidue: payload.withholdingResidue,
      withholdingTime: payload.withholdingTime,
      ratingGroupId: payload.ratingGroupId,
      profileName: payload.profileName,
      currency: payload.currency,
      balance: payload.balance,
      strategy: payload.strategy,
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
          profileTemplate: payload.profileName,
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
