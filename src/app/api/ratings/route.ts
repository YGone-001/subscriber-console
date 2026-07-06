import { NextResponse } from 'next/server';
import { redis, scanAll } from '@/lib/redis';
import { enforceRateLimit } from '@/lib/rateLimit';
import { requireAuth, requireRole } from '@/lib/authz';

export const dynamic = 'force-dynamic';

/**
 * GET /api/ratings
 * -------------------------------------------------------
 * 获取全部 OCS 费率模板列表
 *
 * Redis 键名规范: OCS:RATES:RATES_[RATING_ID]
 * 数据结构:
 *   {
 *     "currency": str,        // 币种 (如 "USD", "CNY", "HKD")
 *     "rates": str,           // 费率数值 (字符串格式, 如 "0.01")
 *     "rates_type": int,      // 计费类型 (1=时长, 2=流量, 3=事件, 4=包月)
 *     "rating_group_id": int  // 计费组唯一标识
 *   }
 * -------------------------------------------------------
 */
export async function GET(request: Request) {
  try {
    const auth = requireAuth(request);
    if (!auth.ok) return auth.response;

    const rateLimit = await enforceRateLimit(`ratings:list:${auth.auth.user}`, 90, 60);
    if (!rateLimit.ok) return rateLimit.response;

    // 扫描所有符合 OCS:RATES:RATES_* 前缀的键
    const keys = await scanAll('OCS:RATES:RATES_*');
    const ratings: any[] = [];

    if (keys.length > 0) {
      const pipeline = redis.pipeline();
      keys.forEach(key => pipeline.get(key));
      const results = await pipeline.exec();

      if (results) {
        results.forEach((result) => {
          if (result[1]) {
            try {
              const data = JSON.parse(result[1] as string);
              ratings.push(data);
            } catch (e) {
              // 跳过 JSON 解析失败的条目
            }
          }
        });
      }
    }

    // 按 rating_group_id 升序排列, 确保列表稳定性
    ratings.sort((a, b) => (a.rating_group_id || 0) - (b.rating_group_id || 0));

    return NextResponse.json({ ratings });
  } catch (error) {
    console.error('Error fetching ratings:', error);
    return NextResponse.json({ error: 'Failed to fetch ratings' }, { status: 500 });
  }
}

/**
 * POST /api/ratings
 * -------------------------------------------------------
 * 创建新的 OCS 费率模板
 *
 * 请求体字段:
 *   rating_group_id: int  (必填, 唯一标识)
 *   currency: str         (币种, 默认 "USD")
 *   rates: str            (费率数值, 默认 "0")
 *   rates_type: int       (计费类型, 默认 1)
 *
 * Redis 写入键: OCS:RATES:RATES_[rating_group_id]
 * -------------------------------------------------------
 */
export async function POST(request: Request) {
  try {
    const auth = requireRole(request, 'root');
    if (!auth.ok) return auth.response;
    const rateLimit = await enforceRateLimit(`ratings:create:${auth.auth.user}`, 20, 60);
    if (!rateLimit.ok) return rateLimit.response;

    const data = await request.json();
    const { rating_group_id, currency, rates, rates_type } = data;

    // 校验必填字段: rating_group_id
    if (rating_group_id === undefined || rating_group_id === null || rating_group_id === '') {
      return NextResponse.json({ error: 'rating_group_id is required' }, { status: 400 });
    }
    if (!/^\d+$/.test(String(rating_group_id))) {
      return NextResponse.json({ error: 'Invalid rating_group_id format' }, { status: 400 });
    }

    const id = Number(rating_group_id);

    // 检查 Redis 中该 ID 是否已存在, 防止重复创建
    const exists = await redis.exists(`OCS:RATES:RATES_${id}`);
    if (exists) {
      return NextResponse.json({ error: 'Rating Group ID already exists' }, { status: 409 });
    }

    // 严格遵守 OCS:RATES 数据结构规范
    const rateObj = {
      currency: currency || 'USD',
      rates: String(rates || '0'),
      rates_type: Number(rates_type) || 1,
      rating_group_id: id
    };

    await redis.set(`OCS:RATES:RATES_${id}`, JSON.stringify(rateObj));

    return NextResponse.json({ message: 'Rating created successfully', rating_group_id: id }, { status: 201 });
  } catch (error) {
    console.error('Error creating rating:', error);
    return NextResponse.json({ error: 'Failed to create rating' }, { status: 500 });
  }
}
