import { NextResponse } from 'next/server';
import { redis } from '@/lib/redis';
import { logAudit } from '@/lib/audit';
import { buildDefaultSub4G } from '@/lib/subscriberDefaults';
import { addSubscriberToIndex } from '@/lib/subscriberIndex';
import { requireAnyRole } from '@/lib/authz';
import { enforceRateLimit } from '@/lib/rateLimit';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const auth = requireAnyRole(request, ['root', 'operator']);
    if (!auth.ok) return auth.response;
    const rateLimit = await enforceRateLimit(`system:audit-heal:${auth.auth.user}`, 20, 60);
    if (!rateLimit.ok) return rateLimit.response;

    const { imsi, type, profileName } = await request.json();

    if (!imsi || !type) {
      return NextResponse.json({ error: 'imsi and type are required' }, { status: 400 });
    }

    let profileData: any = null;
    if (profileName) {
      const profileRaw = await redis.get(`PROFILE:${profileName}`);
      if (profileRaw) profileData = JSON.parse(profileRaw);
    }

    const pipeline = redis.pipeline();

    if (type === 'missing_config') {
      // 修复目标: 补齐缺失的 OCS 结构 (严格采用 NX 防覆盖已有数据)
      const ocs = profileData?.ocsDefaults || {};

      const traffic = {
        traffic_balance: Number(ocs.trafficBalance ?? 5368709120),
        imsi: imsi,
        plmn: ocs.plmn || '45400'
      };
      pipeline.setnx(`OCS:TRAFFIC:TRAFFIC_${imsi}`, JSON.stringify(traffic));

      const imsiObj = {
        account_id: imsi,
        imsi: imsi,
        withhold: Number(ocs.withhold ?? 100),
        withholding_residue: Number(ocs.withholdingResidue ?? 0),
        withholding_time: Number(ocs.withholdingTime ?? 3600)
      };
      pipeline.setnx(`OCS:IMSI:IMSI_${imsi}`, JSON.stringify(imsiObj));

      const account = {
        account_id: imsi,
        balance: String(ocs.balance ?? '10000'),
        currency: ocs.currency || 'USD'
      };
      pipeline.setnx(`OCS:ACCOUNT:ACCOUNT_${imsi}`, JSON.stringify(account));

      const ocsImsiSet = {
        rates_map: { [ocs.plmn || '45400']: Number(ocs.ratingGroupId ?? 1) },
        imsi: imsi
      };
      pipeline.setnx(`OCS:IMSI:IMSI_SET_${imsi}`, JSON.stringify(ocsImsiSet));

    } else if (type === 'orphan_ocs') {
      // 修复目标: 补全 SUB_4G 结构
      const sub4G = buildDefaultSub4G("", profileData);
      pipeline.setnx(`SUB_4G:${imsi}`, JSON.stringify(sub4G));
      addSubscriberToIndex(pipeline, imsi);

      let auth4G: any;
      if (profileData && profileData.auth) {
        auth4G = { ...profileData.auth, sqn: 1 };
      } else {
        auth4G = { k: "00000000000000000000000000000000", opc: "00000000000000000000000000000000", sqn: 1 };
      }
      pipeline.setnx(`AUTH_4G:${imsi}`, JSON.stringify(auth4G));
      pipeline.setnx(`PCRF_4G:${imsi}`, JSON.stringify({ sliceList: sub4G.sliceList }));

    } else if (type === 'balance_mismatch') {
      // 修复目标: 只修复损坏的 ACCOUNT 块，避免全量覆写
      const accountRaw = await redis.get(`OCS:ACCOUNT:ACCOUNT_${imsi}`);
      let payload: any = { account_id: imsi, balance: '10000', currency: 'USD' };
      if (accountRaw) {
        try {
          payload = JSON.parse(accountRaw);
          if (payload.balance === undefined || payload.balance === null || isNaN(Number(payload.balance))) {
             payload.balance = String(profileData?.ocsDefaults?.balance ?? '10000');
          }
        } catch {
            // Json exception fallback
        }
      }
      // Since it's corrupted, we enforce set to apply the patched object
      pipeline.set(`OCS:ACCOUNT:ACCOUNT_${imsi}`, JSON.stringify(payload));
    }

    const results = await pipeline.exec();

    if (!results) {
      throw new Error("Heal pipeline execution failed");
    }

    logAudit('HEAL', imsi, null, { type, profileName }, request);

    return NextResponse.json({
      message: `Successfully applied targeted self-healing for ${imsi}`
    }, { status: 200 });

  } catch (error) {
    console.error('Self-healing API Failed:', error);
    return NextResponse.json({ error: 'Self-healing execution failed' }, { status: 500 });
  }
}
