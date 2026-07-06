import { NextResponse } from 'next/server';
import { redis } from '@/lib/redis';
import { logAudit } from '@/lib/audit';
import { normalizeSub4G } from '@/lib/subscriberDefaults';
import { addSubscriberToIndex, removeSubscriberFromIndex } from '@/lib/subscriberIndex';
import { requireAnyRole, requireAuth } from '@/lib/authz';
import { enforceRateLimit } from '@/lib/rateLimit';

export const dynamic = 'force-dynamic';

/**
 * GET /api/subscribers/[imsi]
 * -------------------------------------------------------
 * 获取订阅者的完整数据集 (包含核心网 + OCS 四表)
 *
 * 读取的 Redis 键列表:
 *   1. SUB_4G:[imsi]                 - 核心网订阅数据
 *   2. PCRF_4G:[imsi]                - 策略控制数据
 *   3. AUTH_4G:[imsi]                - 鉴权数据
 *   4. OCS:IMSI:IMSI_[imsi]         - OCS 配置表 (withhold等)
 *   5. OCS:TRAFFIC:TRAFFIC_[imsi]   - OCS 流量余额表
 *   6. OCS:IMSI:IMSI_SET_[imsi]     - OCS 费率映射表
 *   7. OCS:ACCOUNT:ACCOUNT_[imsi]   - OCS 账户余额表
 * -------------------------------------------------------
 */
export async function GET(request: Request, { params }: { params: Promise<{ imsi: string }> }) {
  const { imsi } = await params;
  const auth = requireAuth(request);
  if (!auth.ok) return auth.response;
  const rateLimit = await enforceRateLimit(`subscribers:detail:${auth.auth.user}`, 180, 60);
  if (!rateLimit.ok) return rateLimit.response;

  if (!/^\d{15}$/.test(imsi)) return NextResponse.json({ error: 'Invalid IMSI format' }, { status: 400 });
  try {
    const pipeline = redis.pipeline();
    // 核心网三表
    pipeline.get(`SUB_4G:${imsi}`);
    pipeline.get(`PCRF_4G:${imsi}`);
    pipeline.get(`AUTH_4G:${imsi}`);
    // OCS 四表中与 IMSI 关联的三表
    pipeline.get(`OCS:IMSI:IMSI_${imsi}`);
    pipeline.get(`OCS:TRAFFIC:TRAFFIC_${imsi}`);
    pipeline.get(`OCS:IMSI:IMSI_SET_${imsi}`);
    pipeline.get(`OCS:ACCOUNT:ACCOUNT_${imsi}`);

    const results = await pipeline.exec();
    if (!results) {
        return NextResponse.json({ error: 'Subscriber not found' }, { status: 404 });
    }

    const sub4G = results[0][1] ? JSON.parse(results[0][1] as string) : null;
    const pcrf4G = results[1][1] ? JSON.parse(results[1][1] as string) : null;
    const auth4G = results[2][1] ? JSON.parse(results[2][1] as string) : null;
    // OCS 相关数据
    const ocsImsi = results[3][1] ? JSON.parse(results[3][1] as string) : null;
    const ocsTraffic = results[4][1] ? JSON.parse(results[4][1] as string) : null;
    const ocsImsiSet = results[5][1] ? JSON.parse(results[5][1] as string) : null;
    const ocsAccount = results[6][1] ? JSON.parse(results[6][1] as string) : null;

    if (!sub4G && !pcrf4G && !auth4G) {
      return NextResponse.json({ error: 'Subscriber not found' }, { status: 404 });
    }

    return NextResponse.json({ sub4G, pcrf4G, auth4G, ocsImsi, ocsTraffic, ocsImsiSet, ocsAccount });
  } catch (error) {
    console.error('Error fetching subscriber:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

async function fetchOldState(imsi: string) {
  const p = redis.pipeline();
  p.get(`SUB_4G:${imsi}`);
  p.get(`PCRF_4G:${imsi}`);
  p.get(`AUTH_4G:${imsi}`);
  p.get(`OCS:IMSI:IMSI_${imsi}`);
  p.get(`OCS:TRAFFIC:TRAFFIC_${imsi}`);
  p.get(`OCS:IMSI:IMSI_SET_${imsi}`);
  p.get(`OCS:ACCOUNT:ACCOUNT_${imsi}`);
  const r = await p.exec();
  if (!r) return null;
  return {
    sub4G: r[0][1] ? JSON.parse(r[0][1] as string) : null,
    pcrf4G: r[1][1] ? JSON.parse(r[1][1] as string) : null,
    auth4G: r[2][1] ? JSON.parse(r[2][1] as string) : null,
    ocsImsi: r[3][1] ? JSON.parse(r[3][1] as string) : null,
    ocsTraffic: r[4][1] ? JSON.parse(r[4][1] as string) : null,
    ocsImsiSet: r[5][1] ? JSON.parse(r[5][1] as string) : null,
    ocsAccount: r[6][1] ? JSON.parse(r[6][1] as string) : null,
  };
}

/**
 * DELETE /api/subscribers/[imsi]
 * -------------------------------------------------------
 * 删除订阅者的全部关联数据 (核心网 + OCS 四表)
 * 原子批量删除确保数据一致性
 * -------------------------------------------------------
 */
export async function DELETE(request: Request, { params }: { params: Promise<{ imsi: string }> }) {
  const { imsi } = await params;
  const auth = requireAnyRole(request, ['root', 'operator']);
  if (!auth.ok) return auth.response;
  const rateLimit = await enforceRateLimit(`subscribers:delete:${auth.auth.user}`, 30, 60);
  if (!rateLimit.ok) return rateLimit.response;

  try {
    const oldState = await fetchOldState(imsi);

    const pipeline = redis.pipeline();
    // 核心网三表
    pipeline.del(`SUB_4G:${imsi}`);
    pipeline.del(`PCRF_4G:${imsi}`);
    pipeline.del(`AUTH_4G:${imsi}`);
    // OCS 关联四表
    pipeline.del(`OCS:IMSI:IMSI_${imsi}`);
    pipeline.del(`OCS:TRAFFIC:TRAFFIC_${imsi}`);
    pipeline.del(`OCS:IMSI:IMSI_SET_${imsi}`);
    pipeline.del(`OCS:ACCOUNT:ACCOUNT_${imsi}`);
    removeSubscriberFromIndex(pipeline, imsi);

    await pipeline.exec();

    logAudit('DELETE', imsi, oldState, null, request);

    return NextResponse.json({ message: 'Subscriber deleted successfully' });
  } catch (error) {
    console.error('Error deleting subscriber:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

/**
 * PUT /api/subscribers/[imsi]
 * -------------------------------------------------------
 * 更新订阅者数据 (原子化写入核心网 + OCS 四表)
 *
 * 请求体字段:
 *   sub4G:       核心网订阅数据 (sliceList, ambr 等)
 *   auth4G:      鉴权数据 (k, opc/op, sqn, amf)
 *   ocsImsi:     OCS 配置表数据 (withhold, withholding_residue, withholding_time)
 *   ocsTraffic:  OCS 流量余额数据 (traffic_balance, plmn)
 *   ocsImsiSet:  OCS 费率映射数据 (rates_map)
 *   ocsAccount:  OCS 账户余额数据 (account_id, balance, currency)
 *
 * Redis 写入四表联动逻辑:
 *   SUB_4G -> PCRF_4G      : 自动同步 sliceList
 *   ocsImsi   -> OCS:IMSI:IMSI_[imsi]
 *   ocsTraffic-> OCS:TRAFFIC:TRAFFIC_[imsi]
 *   ocsImsiSet-> OCS:IMSI:IMSI_SET_[imsi]
 *   ocsAccount-> OCS:ACCOUNT:ACCOUNT_[imsi]
 * -------------------------------------------------------
 */
export async function PUT(request: Request, { params }: { params: Promise<{ imsi: string }> }) {
  const { imsi } = await params;
  const auth = requireAnyRole(request, ['root', 'operator']);
  if (!auth.ok) return auth.response;
  const rateLimit = await enforceRateLimit(`subscribers:update:${auth.auth.user}`, 60, 60);
  if (!rateLimit.ok) return rateLimit.response;

  try {
    const body = await request.json();
    const { sub4G, auth4G, ocsImsi, ocsTraffic, ocsImsiSet, ocsAccount } = body;

    const pipeline = redis.pipeline();

    // --- 核心网数据写入 ---
    if (sub4G) {
      const normalizedSub4G = normalizeSub4G(sub4G);
      pipeline.set(`SUB_4G:${imsi}`, JSON.stringify(normalizedSub4G));
      addSubscriberToIndex(pipeline, imsi);
      // 自动同步 PCRF: sliceList 一份即可, 同步过去
      if (normalizedSub4G.sliceList) {
        const pcrf4G = { sliceList: normalizedSub4G.sliceList };
        pipeline.set(`PCRF_4G:${imsi}`, JSON.stringify(pcrf4G));
      }
    }

    if (auth4G) {
      pipeline.set(`AUTH_4G:${imsi}`, JSON.stringify(auth4G));
    }

    // --- OCS 四表联动写入 ---

    // 表1: OCS:IMSI:IMSI_[IMSI] - 配置表 (withhold 扣款参数)
    if (ocsImsi) {
      pipeline.set(`OCS:IMSI:IMSI_${imsi}`, JSON.stringify(ocsImsi));
    }

    // 表2: OCS:TRAFFIC:TRAFFIC_[IMSI] - 流量余额表
    if (ocsTraffic) {
      pipeline.set(`OCS:TRAFFIC:TRAFFIC_${imsi}`, JSON.stringify(ocsTraffic));
    }

    // 表4: OCS:IMSI:IMSI_SET_[IMSI] - 费率映射表 (引用 RATES 的 rating_group_id)
    if (ocsImsiSet) {
      pipeline.set(`OCS:IMSI:IMSI_SET_${imsi}`, JSON.stringify(ocsImsiSet));
    }

    // 表5: OCS:ACCOUNT:ACCOUNT_[IMSI] - 账户余额表
    if (ocsAccount) {
      pipeline.set(`OCS:ACCOUNT:ACCOUNT_${imsi}`, JSON.stringify(ocsAccount));
    }

    const oldState = await fetchOldState(imsi);

    await pipeline.exec();

    logAudit('UPDATE', imsi, oldState, { sub4G, auth4G, ocsImsi, ocsTraffic, ocsImsiSet, ocsAccount }, request);

    return NextResponse.json({ message: 'Subscriber updated successfully' });
  } catch (error) {
    console.error('Error updating subscriber:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
