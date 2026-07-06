type Ambr = { downlink: { unit: number; value: number }; uplink: { unit: number; value: number } };

const DEFAULT_AMBR: Ambr = {
  downlink: { unit: 2, value: 10 },
  uplink: { unit: 2, value: 10 },
};

function mapArp(arp: any, fallbackPriorityLevel: number) {
  const preemptCapRaw = arp?.preemptCap ?? arp?.pre_emption_capability;
  const preemptVulnRaw = arp?.preemptVuln ?? arp?.pre_emption_vulnerability;

  return {
    priorityLevel: Number(arp?.priorityLevel ?? arp?.arpPriority ?? arp?.priority_level ?? fallbackPriorityLevel),
    preemptCap: preemptCapRaw === 0 ? "PREEMPT" : "NOT_PREEMPT",
    preemptVuln: preemptVulnRaw === 0 ? "PREEMPTABLE" : "NOT_PREEMPTABLE",
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
    pgwIpv4: session?.pgwIpv4 ?? "127.0.0.4",
    pgwIpv6: session?.pgwIpv6 ?? "",
    qos: {
      _5qi: fiveQi,
      index: 0,
      arp,
    },
    ambr: {
      downlink: {
        unit: Number(session?.ambr?.downlink?.unit ?? DEFAULT_AMBR.downlink.unit),
        value: Number(session?.ambr?.downlink?.value ?? DEFAULT_AMBR.downlink.value),
      },
      uplink: {
        unit: Number(session?.ambr?.uplink?.unit ?? DEFAULT_AMBR.uplink.unit),
        value: Number(session?.ambr?.uplink?.value ?? DEFAULT_AMBR.uplink.value),
      },
    },
    pcc_rule: [],
  };
}

export function normalizeSliceList(sliceList: any): any[] {
  if (!Array.isArray(sliceList) || sliceList.length === 0) {
    return [{
      default_indicator: true,
      sd: "000001",
      sst: 1,
      session_list: [
        normalizeSession({ name: "internet", type: 1, qos: { _5qi: 9, arp: { priorityLevel: 8 } } }, 0),
        normalizeSession({ name: "ims", type: 3, qos: { _5qi: 5, arp: { priorityLevel: 1 } } }, 1),
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

export function buildDefaultSub4G(msisdn = "8529000006", profileData?: any) {
  const resolvedMsisdn = msisdn || profileData?.msisdnList?.[0]?.msisdn || "8529000006";
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
    msisdnList: [{ msisdn: String(resolvedMsisdn) }],
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
