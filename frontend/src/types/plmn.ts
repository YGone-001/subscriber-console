/**
 * PLMN 原始数据条目定义 (符合 mcc-mnc-table.json 格式)
 */
export interface IMccMncRecord {
  mcc: string;          // 移动国家代码
  mnc: string;          // 移动网络代码
  iso: string;          // ISO 国家二字码 (小写)
  country: string;      // 国家/地区名称
  country_code: string; // 国际拨号前缀 (E.164)
  network: string;      // 运营商/网络名称
}

/**
 * 经过解析后的订阅者网络信息
 */
export interface IResolvedNetwork {
  plmn: string;         // 截取的 PLMN 字符串 (5或6位)
  operator: string;     // 运营商名称
  country: string;      // 国家名
  iso: string;          // ISO 代码
  fullInfo: string;     // 组合后的显示信息
}
