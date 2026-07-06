import { NextResponse } from 'next/server';
import { redis } from '@/lib/redis';
import { requireAnyRole } from '@/lib/authz';
import { enforceRateLimit } from '@/lib/rateLimit';

export const dynamic = 'force-dynamic';

/**
 * POST /api/subscribers/batch/precheck
 * -------------------------------------------------------
 * Execution pre-flight check to verify if IMSI range conflicts
 * with any existing subscriber or billing data.
 *
 * Returns:
 *  {
 *    conflictCount: number,
 *    conflictImsis: string[],
 *    totalCount: number
 *  }
 */
export async function POST(request: Request) {
  try {
    const auth = requireAnyRole(request, ['root', 'operator']);
    if (!auth.ok) return auth.response;
    const rateLimit = await enforceRateLimit(`subscribers:batch-precheck:${auth.auth.user}`, 30, 60);
    if (!rateLimit.ok) return rateLimit.response;

    const body = await request.json();
    const { startImsi, count } = body;

    if (!startImsi || !count) {
      return NextResponse.json({ error: 'startImsi and count are required' }, { status: 400 });
    }
    const numCount = Number(count);
    if (numCount <= 0 || numCount > 1000) {
      return NextResponse.json({ error: 'Count must be between 1 and 1000' }, { status: 400 });
    }
    if (!/^\d{15}$/.test(startImsi)) {
      return NextResponse.json({ error: 'startImsi must be strictly 15 digits' }, { status: 400 });
    }

    const startNum = BigInt(startImsi);
    const pipeline = redis.pipeline();
    const imsiList: string[] = [];

    // Bundle EXISTS commands directly for each target IMSI using variable arguments
    for (let i = 0; i < numCount; i++) {
      const currentImsi = (startNum + BigInt(i)).toString();
      imsiList.push(currentImsi);

      // EXISTS command returns the count of keys that exist
      pipeline.exists(
        `SUB_4G:${currentImsi}`,
        `OCS:TRAFFIC:TRAFFIC_${currentImsi}`,
        `OCS:IMSI:IMSI_${currentImsi}`,
        `OCS:ACCOUNT:ACCOUNT_${currentImsi}`,
        `OCS:IMSI:IMSI_SET_${currentImsi}`
      );
    }

    // Pipeline response: [ [error, result], [error, result], ... ]
    const results = await pipeline.exec();

    if (!results) {
      throw new Error("Pipeline execution failed");
    }

    const conflictImsis: string[] = [];

    for (let i = 0; i < results.length; i++) {
      const [err, existsCount] = results[i];
      if (err) {
        console.error("Redis pipeline error during precheck:", err);
        throw err;
      }

      // If sum of matched keys > 0, conflict logic triggered
      if (Number(existsCount) > 0) {
        conflictImsis.push(imsiList[i]);
      }
    }

    return NextResponse.json({
      conflictCount: conflictImsis.length,
      conflictImsis: conflictImsis,
      totalCount: numCount
    }, { status: 200 });

  } catch (error) {
    console.error('Error in batch precheck:', error);
    return NextResponse.json({ error: 'Pre-flight check failed' }, { status: 500 });
  }
}
