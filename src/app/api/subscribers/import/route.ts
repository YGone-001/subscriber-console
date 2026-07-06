import { NextResponse } from 'next/server';
import { redis } from '@/lib/redis';
import { logAudit } from '@/lib/audit';
import { buildDefaultSub4G } from '@/lib/subscriberDefaults';
import { addSubscriberToIndex } from '@/lib/subscriberIndex';
import { requireAnyRole } from '@/lib/authz';
import { enforceRateLimit } from '@/lib/rateLimit';

export const dynamic = 'force-dynamic';

/**
 * POST /api/subscribers/import
 * -------------------------------------------------------
 * CSV 批量导入接口, 支持两种模式:
 *
 * 模式一: 预检 (mode=precheck)
 *   - 接收解析后的 IMSI 数组
 *   - 返回每条 IMSI 的冲突状态 (exists: true/false)
 *   - 用于前端展示冲突检测结果
 *
 * 模式二: 导入 (mode=import)
 *   - 接收完整的订阅者数组 + 覆盖策略
 *   - 原子化写入 Redis 五张关联表:
 *     SUB_4G, PCRF_4G, AUTH_4G, OCS:TRAFFIC, OCS:IMSI,
 *     OCS:ACCOUNT, OCS:IMSI:IMSI_SET
 *
 * CSV 模板字段:
 *   imsi, k, opc, amf, traffic_balance, plmn,
 *   currency, balance, access_restriction_data, withhold
 * -------------------------------------------------------
 */
export async function POST(request: Request) {
  try {
    const auth = requireAnyRole(request, ['root', 'operator']);
    if (!auth.ok) return auth.response;
    const rateLimit = await enforceRateLimit(`subscribers:import:${auth.auth.user}`, 12, 60);
    if (!rateLimit.ok) return rateLimit.response;

    const { searchParams } = new URL(request.url);
    const mode = searchParams.get('mode') || 'precheck';
    const body = await request.json();

    // ========= 模式一: 预检冲突检测 =========
    if (mode === 'precheck') {
      const { imsiList } = body;
      if (!imsiList || !Array.isArray(imsiList)) {
        return NextResponse.json({ error: 'imsiList array is required' }, { status: 400 });
      }

      // 批量检测已存在的 IMSI
      const pipeline = redis.pipeline();
      imsiList.forEach((imsi: string) => {
        pipeline.exists(`SUB_4G:${imsi}`);
      });
      const results = await pipeline.exec() || [];

      const conflicts = imsiList.map((imsi: string, i: number) => ({
        imsi,
        exists: results[i] && results[i][1] === 1
      }));

      return NextResponse.json({
        total: imsiList.length,
        existing: conflicts.filter(c => c.exists).length,
        newCount: conflicts.filter(c => !c.exists).length,
        conflicts
      });
    }

    // ========= 模式二: 执行导入 =========
    if (mode === 'import') {
      const { records, overwrite } = body;
      if (!records || !Array.isArray(records)) {
        return NextResponse.json({ error: 'records array is required' }, { status: 400 });
      }

      let imported = 0;
      let skipped = 0;

      // 先检测所有 IMSI 是否存在
      const existsPipeline = redis.pipeline();
      records.forEach((rec: any) => {
        existsPipeline.exists(`SUB_4G:${rec.imsi}`);
      });
      const existsResults = await existsPipeline.exec() || [];

      // 构建写入管道
      const writePipeline = redis.pipeline();
      const importedImsis: string[] = [];

      records.forEach((rec: any, idx: number) => {
        const exists = existsResults[idx] && existsResults[idx][1] === 1;

        // 如果已存在且不覆盖, 则跳过
        if (exists && !overwrite) {
          skipped++;
          return;
        }

        const imsi = String(rec.imsi).trim();
        if (!/^\d{15}$/.test(imsi)) {
          skipped++;
          return;
        }

        // 构造 SUB_4G 核心订阅数据
        const sub4G = buildDefaultSub4G("", undefined);
        sub4G.access_restriction_data = Number(rec.access_restriction_data) || 0;

        // 构造 AUTH_4G 鉴权数据
        const auth4G = {
          k: rec.k || "00000000000000000000000000000000",
          opc: rec.opc || "00000000000000000000000000000000",
          sqn: 1,
          amf: rec.amf || "8000"
        };

        const pcrf4G = { sliceList: sub4G.sliceList };

        // 构造 OCS 四表
        const trafficBalance = Number(rec.traffic_balance) || 10737418240;
        const ocsTraffic = {
          imsi: imsi,
          plmn: rec.plmn || "45400",
          traffic_total: trafficBalance,
          traffic_balance: trafficBalance
        };

        const ocsImsi = {
          imsi: imsi,
          withhold: Number(rec.withhold) || 100,
          withholding_residue: 0,
          withholding_time: 3600
        };

        const ocsAccount = {
          account_id: imsi,
          balance: rec.balance || "10000",
          currency: rec.currency || "USD"
        };

        const ocsImsiSet = { rates_map: {} };

        // 原子化写入七张 Redis 表
        writePipeline.set(`SUB_4G:${imsi}`, JSON.stringify(sub4G));
        writePipeline.set(`PCRF_4G:${imsi}`, JSON.stringify(pcrf4G));
        writePipeline.set(`AUTH_4G:${imsi}`, JSON.stringify(auth4G));
        writePipeline.set(`OCS:TRAFFIC:TRAFFIC_${imsi}`, JSON.stringify(ocsTraffic));
        writePipeline.set(`OCS:IMSI:IMSI_${imsi}`, JSON.stringify(ocsImsi));
        writePipeline.set(`OCS:ACCOUNT:ACCOUNT_${imsi}`, JSON.stringify(ocsAccount));
        writePipeline.set(`OCS:IMSI:IMSI_SET_${imsi}`, JSON.stringify(ocsImsiSet));
        addSubscriberToIndex(writePipeline, imsi);

        imported++;
        importedImsis.push(imsi);
      });

      await writePipeline.exec();

      // 审计日志
      if (importedImsis.length > 0) {
        logAudit('CSV_IMPORT', importedImsis.join(','), null, {
          count: imported,
          overwrite: !!overwrite
        }, request);
      }

      return NextResponse.json({
        message: `Import completed: ${imported} imported, ${skipped} skipped`,
        imported,
        skipped
      });
    }

    return NextResponse.json({ error: 'Invalid mode parameter' }, { status: 400 });

  } catch (error) {
    console.error('Import Error:', error);
    return NextResponse.json({ error: 'Internal server error during import' }, { status: 500 });
  }
}
