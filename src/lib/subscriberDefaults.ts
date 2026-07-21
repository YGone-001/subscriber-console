type Ambr = { downlink: { unit: number; value: number }; uplink: { unit: number; value: number } };

const DEFAULT_AMBR: Ambr = {
  downlink: { unit: 3, value: 1 },
  uplink: { unit: 3, value: 1 },
};

const DEFAULT_PCC_AMBR: Ambr = {
  downlink: { unit: 1, value: 0 },
  uplink: { unit: 1, value: 0 },
};

function normalizeAmbr(value: any, fallback: Ambr = DEFAULT_AMBR): Ambr {
  return {
    downlink: {
      unit: Number(value?.downlink?.unit ?? fallback.downlink.unit),
      value: Number(value?.downlink?.value ?? fallback.downlink.value),
    },
    uplink: {
      unit: Number(value?.uplink?.unit ?? fallback.uplink.unit),
      value: Number(value?.uplink?.value ?? fallback.uplink.value),
    },
  };
}

function mapArp(arp: any, fallbackPriorityLevel: number) {
  const preemptCapRaw = arp?.preemptCap ?? arp?.pre_emption_capability;
  const preemptVulnRaw = arp?.preemptVuln ?? arp?.pre_emption_vulnerability;

  return {
    priorityLevel: Number(arp?.priorityLevel ?? arp?.arpPriority ?? arp?.priority_level ?? fallbackPriorityLevel),
    preemptCap: preemptCapRaw === 0 || preemptCapRaw === "0" || preemptCapRaw === "PREEMPT" ? "PREEMPT" : "NOT_PREEMPT",
    preemptVuln: preemptVulnRaw === 0 || preemptVulnRaw === "0" || preemptVulnRaw === "PREEMPTABLE" ? "PREEMPTABLE" : "NOT_PREEMPTABLE",
  };
}

function normalizePccRule(rule: any) {
  const qos = rule?.qos || {};

  return {
    ...rule,
    flow: Array.isArray(rule?.flow) ? rule.flow : [],
    qos: {
      ...qos,
      _5qi: Number(qos?._5qi ?? qos?.index ?? 1),
      index: Number(qos?.index ?? qos?._5qi ?? 1),
      arp: mapArp(qos?.arp, 2),
      mbr: normalizeAmbr(qos?.mbr, DEFAULT_PCC_AMBR),
      gbr: normalizeAmbr(qos?.gbr, DEFAULT_PCC_AMBR),
    },
  };
}

function normalizeSession(session: any, idx: number) {
  const name = String(session?.name || (idx === 0 ? "internet" : "ims"));
  const isIms = name === "ims";
  const qosIndex = Number(session?.qos?.index ?? 0);
  const fiveQi = Number(session?.qos?._5qi ?? (qosIndex > 0 ? qosIndex : isIms ? 5 : 9));

  const arp = mapArp(session?.qos?.arp, isIms ? 1 : 8);

  return {
    name,
    type: Number(session?.type ?? (isIms ? 3 : 1)),
    pgwIpv4: session?.pgwIpv4 ?? "",
    pgwIpv6: session?.pgwIpv6 ?? "",
    qos: {
      _5qi: fiveQi,
      index: 0,
      arp,
    },
    ambr: normalizeAmbr(session?.ambr),
    pcc_rule: Array.isArray(session?.pcc_rule) ? session.pcc_rule.map(normalizePccRule) : [],
  };
}

export function normalizeSliceList(sliceList: any): any[] {
  if (!Array.isArray(sliceList) || sliceList.length === 0) {
    return [{
      default_indicator: true,
      sst: 1,
      session_list: [
        normalizeSession({ name: "internet", type: 1, qos: { _5qi: 9, arp: { priorityLevel: 8 } } }, 0),
        normalizeSession({ name: "mobile", type: 1, qos: { _5qi: 9, arp: { priorityLevel: 8 } } }, 1),
        {
          ...normalizeSession({ name: "ims", type: 3, qos: { _5qi: 5, arp: { priorityLevel: 1 } } }, 2),
          pcc_rule: [{
            qos: {
              index: 1,
              gbr: { uplink: { value: 128, unit: 1 }, downlink: { value: 128, unit: 1 } },
              mbr: { uplink: { value: 128, unit: 1 }, downlink: { value: 128, unit: 1 } },
              arp: {
                priority_level: 2,
                pre_emption_capability: 2,
                pre_emption_vulnerability: 2,
              },
            },
            flow: [],
          }],
        },
      ],
    }];
  }

  return sliceList.map((slice: any) => ({
    default_indicator: slice?.default_indicator !== undefined ? !!slice.default_indicator : true,
    sd: String(slice?.sd ?? "000001"),
    sst: Number(slice?.sst ?? 1),
    session_list: (Array.isArray(slice?.session_list) ? slice.session_list : []).map((s: any, idx: number) => normalizeSession(s, idx)),
  }));
}

export function buildDefaultSub4G(msisdn = "", profileData?: any) {
  return {
    access_restriction_data: 0,
    allowedVisitedPlmns: "all",
    ambr: profileData?.ambr
      ? {
          downlink: {
            unit: Number(profileData.ambr?.downlink?.unit ?? DEFAULT_AMBR.downlink.unit),
            value: Number(profileData.ambr?.downlink?.value ?? DEFAULT_AMBR.downlink.value),
          },
          uplink: {
            unit: Number(profileData.ambr?.uplink?.unit ?? DEFAULT_AMBR.uplink.unit),
            value: Number(profileData.ambr?.uplink?.value ?? DEFAULT_AMBR.uplink.value),
          },
        }
      : DEFAULT_AMBR,
    msisdnList: msisdn ? [{ msisdn: String(msisdn) }] : [],
    network_access_mode: 0,
    sliceList: normalizeSliceList(profileData?.sliceList),
  };
}

export function normalizeSub4G(input: any) {
  const msisdn = Array.isArray(input?.msisdnList) && input.msisdnList[0]?.msisdn !== undefined
    ? String(input.msisdnList[0].msisdn)
    : "";

  const normalized = buildDefaultSub4G(msisdn, { ambr: input?.ambr, sliceList: input?.sliceList });

  normalized.access_restriction_data = Number(input?.access_restriction_data ?? 0);
  normalized.allowedVisitedPlmns = input?.allowedVisitedPlmns ?? "all";
  normalized.network_access_mode = Number(input?.network_access_mode ?? 0);

  return normalized;
}
