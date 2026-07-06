import { NextResponse } from 'next/server';
import { redis, scanAll } from '@/lib/redis';
import { logAudit } from '@/lib/audit';
import { enforceRateLimit } from '@/lib/rateLimit';
import { requireAuth, requireRole } from '@/lib/authz';
import { saveProfileVersion } from '@/lib/profileVersions';

export const dynamic = 'force-dynamic';

/**
 * GET /api/profiles
 * 获取所有 Profile 的列表摘要信息
 * Redis 存储格式: PROFILE:<name> => JSON string
 */
export async function GET(request: Request) {
  try {
    const auth = requireAuth(request);
    if (!auth.ok) return auth.response;

    const rateLimit = await enforceRateLimit(`profiles:list:${auth.auth.user}`, 90, 60);
    if (!rateLimit.ok) return rateLimit.response;
    // 扫描所有以 PROFILE: 为前缀的键
    const keys = await scanAll('PROFILE:*');
    const profiles: any[] = [];

    if (keys.length > 0) {
      const pipeline = redis.pipeline();
      keys.forEach(key => pipeline.get(key));
      const results = await pipeline.exec();

      if (results) {
        results.forEach((result, index) => {
          if (result[1]) {
            try {
              const data = JSON.parse(result[1] as string);
              const name = keys[index].replace('PROFILE:', '');
              profiles.push({
                name,
                title: data.title || name,
                sliceCount: Array.isArray(data.sliceList) ? data.sliceList.length : 0,
                createdAt: data.createdAt || null,
                updatedAt: data.updatedAt || null,
                updatedBy: data.updatedBy || data.createdBy || null,
                ratingGroupId: data.ocsDefaults?.ratingGroupId || ""
              });
            } catch (e) {
              // 跳过解析失败的条目
            }
          }
        });
      }
    }

    return NextResponse.json({ profiles });
  } catch (error) {
    console.error('Error fetching profiles:', error);
    return NextResponse.json({ error: 'Failed to fetch profiles' }, { status: 500 });
  }
}

/**
 * POST /api/profiles
 * 创建一个新的 Profile 模板
 * 请求体必须包含 name 字段作为唯一键
 */
export async function POST(request: Request) {
  try {
    const auth = requireRole(request, 'root');
    if (!auth.ok) return auth.response;
    const rateLimit = await enforceRateLimit(`profiles:create:${auth.auth.user}`, 20, 60);
    if (!rateLimit.ok) return rateLimit.response;

    const data = await request.json();
    const { name } = data;

    if (!name) {
      return NextResponse.json({ error: 'Profile name is required' }, { status: 400 });
    }
    if (!/^[a-zA-Z0-9_\s-]+$/.test(name)) return NextResponse.json({ error: 'Invalid profile name format' }, { status: 400 });

    // 检查是否已存在同名 Profile
    const exists = await redis.exists(`PROFILE:${name}`);
    if (exists) {
      return NextResponse.json({ error: 'Profile with this name already exists' }, { status: 409 });
    }

    // 默认 Profile 数据结构 (与 Subscriber 的 sub4G 格式一致)
    const defaultProfile = {
      title: name,
      createdAt: new Date().toISOString(),
      createdBy: auth.auth.user,
      updatedAt: new Date().toISOString(),
      updatedBy: auth.auth.user,
      // 鉴权参数模板
      auth: {
        k: "00000000000000000000000000000000",
        opc: "00000000000000000000000000000000",
        amf: "8000"
      },
      // 网络参数模板
      ambr: {
        downlink: { unit: 2, value: 10 },
        uplink: { unit: 2, value: 10 }
      },
      msisdnList: [{ msisdn: "8529000006" }],
      // 切片配置模板 (三级嵌套: Slice -> Session -> PCC Rules)
      sliceList: [
        {
          default_indicator: true,
          sd: "000001",
          sst: 1,
          session_list: [
            {
              name: "internet",
              type: 1,
              qos: {
                _5qi: 9,
                index: 0,
                arp: {
                  priorityLevel: 8,
                  preemptCap: "NOT_PREEMPT",
                  preemptVuln: "NOT_PREEMPTABLE"
                }
              },
              ambr: {
                downlink: { unit: 2, value: 10 },
                uplink: { unit: 2, value: 10 }
              },
              pcc_rule: [],
              pgwIpv4: "127.0.0.4",
              pgwIpv6: ""
            },
            {
              name: "ims",
              type: 3,
              qos: {
                _5qi: 5,
                index: 0,
                arp: {
                  priorityLevel: 1,
                  preemptCap: "NOT_PREEMPT",
                  preemptVuln: "NOT_PREEMPTABLE"
                }
              },
              ambr: {
                downlink: { unit: 2, value: 10 },
                uplink: { unit: 2, value: 10 }
              },
              pcc_rule: [],
              pgwIpv4: "127.0.0.4",
              pgwIpv6: ""
            }
          ]
        }
      ]
    };

    await redis.set(`PROFILE:${name}`, JSON.stringify(defaultProfile));
    await saveProfileVersion(name, defaultProfile, auth.auth.user, 'CREATE');

    logAudit('PROFILE_CREATE', name, null, defaultProfile, request);

    return NextResponse.json({ message: 'Profile created successfully', name }, { status: 201 });
  } catch (error) {
    console.error('Error creating profile:', error);
    return NextResponse.json({ error: 'Failed to create profile' }, { status: 500 });
  }
}
