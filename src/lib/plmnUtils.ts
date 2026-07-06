import { MCC_MNC_MAPPING } from "./plmn_db";

/**
 * resolveSubscriberNetwork
 * 基于 Longest Prefix Match (最长前缀匹配) 算法识别 IMSI 所属的网络信息
 *
 * 背景说明:
 * MNC (移动网络代码) 可能为 2 位或 3 位。
 * 为避免冲突 (例如 466-92 和 466-929), 必须采用最长前缀匹配算法。
 *
 * 处理逻辑:
 * 1. 优先尝试截取前 6 位 (MCC+3位MNC)。如果命中映射库，则返回该结果。
 * 2. 如果前 6 位未命中，则尝试截取前 5 位 (MCC+2位MNC)。
 * 3. 如果均未命中，返回前 5 位作为 PLMN 编号，运营商显示为 "Unknown"。
 */
export const resolveSubscriberNetwork = (imsi: string | null | undefined) => {
  // 安全检查: 处理 null, undefined 或长度不足的情况
  if (!imsi || imsi.length < 5) {
    return {
      plmn: "N/A",
      name: "Unknown",
      country: "N/A"
    };
  }

  // 1. 尝试 6 位前缀匹配 (针对 MNC 为 3 位的情况)
  const prefix6 = imsi.substring(0, 6);
  if (MCC_MNC_MAPPING[prefix6]) {
    return {
      plmn: prefix6,
      name: MCC_MNC_MAPPING[prefix6].n,
      country: MCC_MNC_MAPPING[prefix6].c
    };
  }

  // 2. 尝试 5 位前缀匹配 (针对 MNC 为 2 位的情况)
  const prefix5 = imsi.substring(0, 5);
  if (MCC_MNC_MAPPING[prefix5]) {
    return {
      plmn: prefix5,
      name: MCC_MNC_MAPPING[prefix5].n,
      country: MCC_MNC_MAPPING[prefix5].c
    };
  }

  // 3. Fallback: 默认前 5 位
  return {
    plmn: prefix5,
    name: "Unknown",
    country: "Unknown"
  };
};
