import { NextResponse } from 'next/server';
import { redis } from '@/lib/redis';
import { enforceRateLimit } from '@/lib/rateLimit';
import { logAudit } from '@/lib/audit';
import { buildDefaultSub4G } from '@/lib/subscriberDefaults';
import { addSubscriberToIndex, listSubscriberImsis } from '@/lib/subscriberIndex';
import { requireAnyRole, requireAuth } from '@/lib/authz';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const auth = requireAuth(request);
    if (!auth.ok) return auth.response;

    // Rate limiting: 100 requests per minute per user
    const rateLimit = await enforceRateLimit(`subscribers:list:${auth.auth.user}`, 120, 60);
    if (!rateLimit.ok) return rateLimit.response;

    const { searchParams } = new URL(request.url);
    const detail = searchParams.get('detail') === 'true';
    const page = parseInt(searchParams.get('page') || '1', 10);
    const limit = parseInt(searchParams.get('limit') || '50', 10);
    const query = searchParams.get('q') || '';
    const { imsis: subscribers, total, page: safePage, limit: safeLimit } = await listSubscriberImsis(page, limit, query);

    if (!detail) {
      return NextResponse.json({ subscribers, total, page: safePage, limit: safeLimit });
    }

    // Detail mode: enrich with OCS data
    // Pipeline Step 1: Fetch core + OCS tables for each subscriber
    const pipeline = redis.pipeline();
    for (const imsi of subscribers) {
      pipeline.get(`SUB_4G:${imsi}`);                        // idx+0: Core subscription
      pipeline.get(`OCS:TRAFFIC:TRAFFIC_${imsi}`);           // idx+1: OCS traffic (JSON string)
      pipeline.get(`OCS:IMSI:IMSI_${imsi}`);                 // idx+2: OCS IMSI config (JSON string)
      pipeline.get(`OCS:IMSI:IMSI_SET_${imsi}`);             // idx+3: OCS rating mapping (JSON string)
    }
    const results = await pipeline.exec() || [];

    // Pipeline Step 2: Collect unique rating_group_ids to batch-fetch rating details
    const ratingIdsNeeded = new Set<string>();
    const subDataList = subscribers.map((imsi, index) => {
      const idx = index * 4;
      let sub4g: any = {};
      try { sub4g = JSON.parse((results[idx] && results[idx][1]) as string || '{}'); } catch(e){}

      let trafficObj: any = {};
      try { trafficObj = JSON.parse((results[idx + 1] && results[idx + 1][1]) as string || '{}'); } catch(e){}

      let ocsImsi: any = {};
      try { ocsImsi = JSON.parse((results[idx + 2] && results[idx + 2][1]) as string || '{}'); } catch(e){}

      let imsiSet: any = {};
      try { imsiSet = JSON.parse((results[idx + 3] && results[idx + 3][1]) as string || '{}'); } catch(e){}

      // Extract rating_group_id from the rates_map
      let ratingGroupId: string | null = null;
      if (imsiSet.rates_map) {
        const vals = Object.values(imsiSet.rates_map);
        if (vals.length > 0) {
          ratingGroupId = String(vals[0]);
          ratingIdsNeeded.add(ratingGroupId);
        }
      }

      return { imsi, sub4g, trafficObj, ocsImsi, ratingGroupId };
    });

    // Pipeline Step 3: Batch-fetch all unique rating group details
    const ratingMap = new Map<string, any>();
    if (ratingIdsNeeded.size > 0) {
      const ratePipeline = redis.pipeline();
      const rateIds = Array.from(ratingIdsNeeded);
      rateIds.forEach(id => ratePipeline.get(`OCS:RATES:RATES_${id}`));
      const rateResults = await ratePipeline.exec() || [];
      rateIds.forEach((id, i) => {
        try {
          const data = JSON.parse((rateResults[i] && rateResults[i][1]) as string || '{}');
          ratingMap.set(id, data);
        } catch(e) {}
      });
    }

    // Assemble enriched output
    const enriched = subDataList.map(({ imsi, sub4g, trafficObj, ocsImsi, ratingGroupId }) => {
      let balance = Number(trafficObj.traffic_balance) || 0;
      let total = Number(trafficObj.traffic_total);

      // If traffic_total is not defined in Redis, assume the current balance IS the total (0% usage state)
      if (isNaN(total) || (!trafficObj.traffic_total && trafficObj.traffic_total !== 0)) {
        total = balance;
      }

      // If total is 0, we avoid negative or Infinity logic by ensuring it's at least the balance limit.
      if (total < balance) {
         total = balance;
      }

      let used = total - balance;
      if (used < 0) used = 0;

      // Build policy display string from rating group
      let policyLabel = '';
      if (ratingGroupId && ratingMap.has(ratingGroupId)) {
        const r = ratingMap.get(ratingGroupId);
        const typeLabel = r.rates_type === 1 ? 'Time' : r.rates_type === 2 ? 'Vol' : r.rates_type === 3 ? 'Event' : 'Flat';
        policyLabel = `${r.currency || 'USD'} ${r.rates || '0'} (${typeLabel})`;
      }

      let statusLabel = 'Active';
      const ard = sub4g.access_restriction_data !== undefined ? Number(sub4g.access_restriction_data) : 0;

      if (ard === 255) {
        statusLabel = 'Suspended';
      } else if (ard > 0 && ard !== 32) {
        // bit 32 (Non-3GPP HO Not Allowed) is considered "Active" for display purposes per user request
        statusLabel = 'Partial Restricted';
      }

      return {
        imsi,
        status: statusLabel,
        ard: ard,
        plmn: trafficObj.plmn || '45400',
        profile: sub4g.profile_name || '',
        policy: policyLabel,
        traffic: { total, used, balance },
        lastActive: ocsImsi.last_update_time ? new Date(ocsImsi.last_update_time).toISOString() : new Date().toISOString()
      };
    });

    return NextResponse.json({ subscribers: enriched, total, page: safePage, limit: safeLimit });

  } catch (error) {
    console.error('Error fetching subscribers:', error);
    return NextResponse.json({ error: 'Failed to fetch subscribers' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const auth = requireAnyRole(request, ['root', 'operator']);
    if (!auth.ok) return auth.response;

    // Rate limiting: 100 requests per minute per user
    const rateLimit = await enforceRateLimit(`subscribers:create:${auth.auth.user}`, 30, 60);
    if (!rateLimit.ok) return rateLimit.response;

    const data = await request.json();
    const { imsi } = data;

    if (!imsi) {
      return NextResponse.json({ error: 'IMSI is required' }, { status: 400 });
    }
    if (!/^\d{15}$/.test(imsi)) return NextResponse.json({ error: 'Invalid IMSI format' }, { status: 400 });

    // Default structure for new subscriber
    const defaultSub4G = buildDefaultSub4G();

    const defaultPcrf4G = {
      sliceList: defaultSub4G.sliceList
    };

    const defaultAuth4G = {
      k: "00000000000000000000000000000000",
      opc: "00000000000000000000000000000000",
      sqn: 1
    };

    const pipeline = redis.pipeline();
    pipeline.set(`SUB_4G:${imsi}`, JSON.stringify(defaultSub4G));
    pipeline.set(`PCRF_4G:${imsi}`, JSON.stringify(defaultPcrf4G));
    pipeline.set(`AUTH_4G:${imsi}`, JSON.stringify(defaultAuth4G));
    addSubscriberToIndex(pipeline, imsi);

    await pipeline.exec();

    logAudit('CREATE', imsi, null, { sub: defaultSub4G, pcrf: defaultPcrf4G, auth: defaultAuth4G }, request);

    return NextResponse.json({ message: 'Subscriber created successfully', imsi }, { status: 201 });
  } catch (error) {
    console.error('Error creating subscriber:', error);
    return NextResponse.json({ error: 'Failed to create subscriber' }, { status: 500 });
  }
}
