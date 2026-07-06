/**
 * MCC_MNC_MAPPING
 * 运营商与 MCC/MNC 映射库
 * 数据格式: "MCCMNC": { n: "运营商名称", c: "国家/地区" }
 */
export const MCC_MNC_MAPPING: Record<string, { n: string; c: string }> = {
  // China (中国)
  "46000": { n: "China Mobile", c: "China" },
  "46002": { n: "China Mobile", c: "China" },
  "46001": { n: "China Unicom", c: "China" },
  "46006": { n: "China Unicom", c: "China" },
  "46003": { n: "China Telecom", c: "China" },
  "46005": { n: "China Telecom", c: "China" },
  "46011": { n: "China Telecom", c: "China" },

  // Taiwan (中国台湾)
  "46601": { n: "FarEasTone", c: "Taiwan" },
  "46602": { n: "Taiwan Mobile", c: "Taiwan" },
  "46605": { n: "Asia Pacific Telecom", c: "Taiwan" },
  "46688": { n: "T Star", c: "Taiwan" },
  "46692": { n: "Chunghwa Telecom", c: "Taiwan" },
  "466929": { n: "Special Network (IoT)", c: "Taiwan" }, // 3-digit MNC example

  // Hong Kong (中国香港)
  "45400": { n: "CSL", c: "Hong Kong" },
  "45403": { n: "3HK", c: "Hong Kong" },
  "45404": { n: "HKT", c: "Hong Kong" },
  "45406": { n: "SmarTone", c: "Hong Kong" },
  "45412": { n: "China Mobile HK", c: "Hong Kong" },

  // USA (美国) - 3-digit MNCs
  "310260": { n: "T-Mobile USA", c: "USA" },
  "310410": { n: "AT&T USA", c: "USA" },
  "310120": { n: "Sprint USA", c: "USA" },
  "311480": { n: "Verizon Wireless", c: "USA" },
  "310004": { n: "Verizon Wireless", c: "USA" }
};
