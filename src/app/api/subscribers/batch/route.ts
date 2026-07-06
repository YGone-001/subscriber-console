import { NextResponse } from 'next/server';
import { redis } from '@/lib/redis';
import { logAudit } from '@/lib/audit';
import { buildDefaultSub4G } from '@/lib/subscriberDefaults';
import { addSubscriberToIndex } from '@/lib/subscriberIndex';
import { requireAnyRole } from '@/lib/authz';
import { enforceRateLimit } from '@/lib/rateLimit';

export const dynamic = 'force-dynamic';

function assertPipelineSucceeded(results: Awaited<ReturnType<ReturnType<typeof redis.pipeline>['exec']>>, context: string) {
  if (!results) {
    throw new Error(`${context} pipeline execution failed`);
  }

  const failed = results.find(([err]) => err);
  if (failed?.[0]) {
    throw failed[0];
  }
}

/**
 * POST /api/subscribers/batch
 * -------------------------------------------------------
 * 批量创建订阅者 (对应脚本中的递增循环插入逻辑)
 *
 * 请求体:
 *   startImsi: str       - 起始 IMSI (必填)
 *   count: int           - 创建数量, 1-1000 (必填)
 *   plmn: str            - PLMN 标识 (如 "45400")
 *   trafficBalance: int  - 初始流量余额 (字节, 默认 5368709120 = 5GB)
 *   withhold: int        - 扣款金额 (默认 100)
 *   withholdingResidue: int - 扣款剩余 (默认 0)
 *   withholdingTime: int - 扣款时间间隔 (默认 3600 秒)
 *   ratingGroupId: int   - 关联的费率模板 ID (可选)
 *   profileName: str     - 关联的 Profile 模板名 (可选)
 *   currency: str        - 账户币种 (默认 "USD")
 *   balance: str         - 初始账户余额 (默认 "10000")
 *
 * 每个 IMSI 原子化写入以下 Redis 键:
 *   1. SUB_4G:[imsi]                 - 核心网订阅
 *   2. PCRF_4G:[imsi]                - 策略控制
 *   3. AUTH_4G:[imsi]                - 鉴权
 *   4. OCS:IMSI:IMSI_[imsi]         - OCS 配置 (withhold)
 *   5. OCS:TRAFFIC:TRAFFIC_[imsi]   - OCS 流量余额
 *   6. OCS:IMSI:IMSI_SET_[imsi]     - OCS 费率映射
 *   7. OCS:ACCOUNT:ACCOUNT_[imsi]   - OCS 账户余额
 * -------------------------------------------------------
 */
export async function POST(request: Request) {
  const auth = requireAnyRole(request, ['root', 'operator']);
  if (!auth.ok) return auth.response;
  const rateLimit = await enforceRateLimit(`subscribers:batch:${auth.auth.user}`, 10, 60);
  if (!rateLimit.ok) return rateLimit.response;

  try {
    const body = await request.json();
    const {
      startImsi, count, plmn, trafficTotal, trafficBalance,
      withhold, withholdingResidue, withholdingTime,
      ratingGroupId, profileName, currency, balance,
      strategy
    } = body;

    // --- 参数校验 ---
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

    // --- 预加载 Profile 模板 (如果指定了 profileName) ---
    let profileData: any = null;
    if (profileName) {
      const profileRaw = await redis.get(`PROFILE:${profileName}`);
      if (profileRaw) {
        profileData = JSON.parse(profileRaw);
      }
    }

    // --- 预加载 Rating 模板 (如果指定了 ratingGroupId, 或 Profile 包含 ratingGroupId) ---
    let ratingData: any = null;
    let effectiveRatingGroupId = ratingGroupId;

    // 如果没有显式传 ratingGroupId, 尝试从 profile 中取
    if (effectiveRatingGroupId === undefined || effectiveRatingGroupId === null || effectiveRatingGroupId === '') {
      if (profileData && profileData.ocsDefaults && profileData.ocsDefaults.ratingGroupId) {
        effectiveRatingGroupId = profileData.ocsDefaults.ratingGroupId;
      }
    }

    if (effectiveRatingGroupId !== undefined && effectiveRatingGroupId !== null && effectiveRatingGroupId !== '') {
      const ratingRaw = await redis.get(`OCS:RATES:RATES_${effectiveRatingGroupId}`);
      if (ratingRaw) {
        ratingData = JSON.parse(ratingRaw);
      }
    }

    // 将起始 IMSI 转换为 BigInt 以支持 15 位超长 IMSI 自增
    const ocs = profileData?.ocsDefaults || {};
    const effectivePlmn = plmn || ocs.plmn || '45400';
    const initialTotal = Number(trafficTotal ?? ocs.trafficTotal ?? trafficBalance ?? ocs.trafficBalance ?? 5368709120);
    const initialBalance = Number(trafficBalance ?? ocs.trafficBalance ?? initialTotal);
    const withholdValue = Number(withhold ?? ocs.withhold ?? 100);
    const withholdingResidueValue = Number(withholdingResidue ?? ocs.withholdingResidue ?? 0);
    const withholdingTimeValue = Number(withholdingTime ?? ocs.withholdingTime ?? 3600);
    const accountBalance = String(balance ?? ocs.balance ?? '10000');
    const accountCurrency = currency || ocs.currency || 'USD';
    const ratingMapValue = ratingData ? ratingData.rating_group_id : Number(effectiveRatingGroupId);

    const sub4GTemplate = buildDefaultSub4G("", profileData);
    const pcrf4GTemplate = { sliceList: sub4GTemplate.sliceList };
    const auth4GTemplate = profileData?.auth
      ? { ...profileData.auth, sqn: 1 }
      : { k: "00000000000000000000000000000000", opc: "00000000000000000000000000000000", sqn: 1 };

    const sub4GPayload = JSON.stringify(sub4GTemplate);
    const pcrf4GPayload = JSON.stringify(pcrf4GTemplate);
    const auth4GPayload = JSON.stringify(auth4GTemplate);

    const startNum = BigInt(startImsi);

    // --- Strategy Analysis (Skip Evaluation) ---
    const conflictBlacklist = new Set<string>();
    if (strategy === 'skip') {
      const skipPipeline = redis.pipeline();
      const evalImsiList: string[] = [];
      for (let i = 0; i < numCount; i++) {
        const tempImsi = (startNum + BigInt(i)).toString();
        evalImsiList.push(tempImsi);
        skipPipeline.exists(
          `SUB_4G:${tempImsi}`,
          `OCS:TRAFFIC:TRAFFIC_${tempImsi}`,
          `OCS:IMSI:IMSI_${tempImsi}`,
          `OCS:ACCOUNT:ACCOUNT_${tempImsi}`,
          `OCS:IMSI:IMSI_SET_${tempImsi}`
        );
      }
      const evalResults = await skipPipeline.exec();
      assertPipelineSucceeded(evalResults, 'Batch conflict check');
      if (evalResults) {
        for (let i = 0; i < evalResults.length; i++) {
          const [, existMatch] = evalResults[i];
          if (Number(existMatch) > 0) {
            conflictBlacklist.add(evalImsiList[i]);
          }
        }
      }
    }

    const pipeline = redis.pipeline();
    const createdImsis: string[] = [];
    const skippedImsis: string[] = [];

    for (let i = 0; i < numCount; i++) {
      const currentImsi = (startNum + BigInt(i)).toString();

      if (strategy === 'skip' && conflictBlacklist.has(currentImsi)) {
        skippedImsis.push(currentImsi);
        continue;
      }

      // ======== 核心网三表 ========

      // 构造 SUB_4G (优先使用 Profile 模板数据)


      // 构造 AUTH_4G (优先使用 Profile 模板)




      pipeline.set(`SUB_4G:${currentImsi}`, sub4GPayload);
      pipeline.set(`PCRF_4G:${currentImsi}`, pcrf4GPayload);
      pipeline.set(`AUTH_4G:${currentImsi}`, auth4GPayload);
      addSubscriberToIndex(pipeline, currentImsi);

      // ======== OCS 四表 (优先使用 Profile 模板中的 ocsDefaults) ========


      // 表1: OCS:TRAFFIC:TRAFFIC_[IMSI] - 流量余额表


      const ocsTraffic = {
        traffic_total: initialTotal,
        traffic_balance: initialBalance,
        imsi: currentImsi,
        plmn: effectivePlmn
      };
      pipeline.set(`OCS:TRAFFIC:TRAFFIC_${currentImsi}`, JSON.stringify(ocsTraffic));

      // 表2: OCS:IMSI:IMSI_[IMSI] - 配置表 (扣款参数)
      const ocsImsiObj = {
        account_id: currentImsi,
        imsi: currentImsi,
        withhold: withholdValue,
        withholding_residue: withholdingResidueValue,
        withholding_time: withholdingTimeValue
      };
      pipeline.set(`OCS:IMSI:IMSI_${currentImsi}`, JSON.stringify(ocsImsiObj));

      // 表3: OCS:ACCOUNT:ACCOUNT_[IMSI] - 账户余额表
      const ocsAccount = {
        account_id: currentImsi,
        balance: accountBalance,
        currency: accountCurrency
      };
      pipeline.set(`OCS:ACCOUNT:ACCOUNT_${currentImsi}`, JSON.stringify(ocsAccount));

      // 表4: OCS:IMSI:IMSI_SET_[IMSI] - 费率映射表 (引用 rating_group_id)
      // 优先使用请求传入的 ratingGroupId, 其次使用 Profile 模板的 ratingGroupId
      if (effectiveRatingGroupId !== undefined && effectiveRatingGroupId !== null && effectiveRatingGroupId !== '') {
        const ocsImsiSet = {
          rates_map: { [effectivePlmn]: ratingMapValue },
          imsi: currentImsi
        };
        pipeline.set(`OCS:IMSI:IMSI_SET_${currentImsi}`, JSON.stringify(ocsImsiSet));
      }

      createdImsis.push(currentImsi);
    }

    // 原子化批量执行, 确保数据一致性
    if (createdImsis.length > 0) {
      const writeResults = await pipeline.exec();
      assertPipelineSucceeded(writeResults, 'Batch create write');



      logAudit(
        'BATCH_CREATE',
        `${createdImsis[0]} ~ ${createdImsis[createdImsis.length - 1]}`,
        null,
        {
          batchSize: createdImsis.length,
          skipped: skippedImsis.length,
          profileTemplate: profileName,
          batchMetrics: {
            totalTraffic: initialTotal * createdImsis.length,
            batchSize: createdImsis.length,
            plmn: effectivePlmn,
            ratingGroupId: effectiveRatingGroupId
          }
        },
        request
      );
    }

    return NextResponse.json({
      message: `Successfully created ${createdImsis.length} subscribers${skippedImsis.length > 0 ? ` (Skipped ${skippedImsis.length})` : ''}`,
      count: createdImsis.length,
      skippedCount: skippedImsis.length,
      range: createdImsis.length > 0 ? { from: createdImsis[0], to: createdImsis[createdImsis.length - 1] } : null
    }, { status: 201 });
  } catch (error) {
    console.error('Error in batch creation:', error);
    return NextResponse.json({ error: 'Batch creation failed' }, { status: 500 });
  }
}
