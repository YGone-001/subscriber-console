const AMBR_128_KBPS = {
  downlink: { value: 128, unit: 1 },
  uplink: { value: 128, unit: 1 },
};

const AMBR_1_MBPS = {
  downlink: { value: 1, unit: 2 },
  uplink: { value: 1, unit: 2 },
};

const AMBR_2_MBPS = {
  downlink: { value: 2, unit: 2 },
  uplink: { value: 2, unit: 2 },
};

const AMBR_4_MBPS = {
  downlink: { value: 4, unit: 2 },
  uplink: { value: 4, unit: 2 },
};

const AMBR_10_MBPS = {
  downlink: { value: 10, unit: 2 },
  uplink: { value: 10, unit: 2 },
};

// Rate values are product-level recommended presets. 3GPP defines QoS
// characteristics such as priority, delay budget, and error rate, not AMBR/MBR/GBR.
export const IMS_SESSION_AMBR = {
  downlink: { value: 1, unit: 3 },
  uplink: { value: 1, unit: 3 },
};

export const IMS_VOICE_PCC_AMBR = AMBR_128_KBPS;

export const IMS_VIDEO_MBR = AMBR_4_MBPS;

export const IMS_VIDEO_GBR = {
  downlink: { value: 2, unit: 2 },
  uplink: { value: 2, unit: 2 },
};

export const STANDARD_QOS_INDEX_OPTIONS = [
  1, 2, 3, 4, 5, 6, 7, 8, 9, 65, 66, 67, 69, 70, 75, 79, 80, 82, 83, 84, 85,
];

export const LTE_QCI_STANDARD_VALUES = {
  1: { priority: 2, sessionAmbr: AMBR_128_KBPS },
  2: { priority: 4, sessionAmbr: AMBR_4_MBPS },
  3: { priority: 3, sessionAmbr: AMBR_2_MBPS },
  4: { priority: 5, sessionAmbr: AMBR_10_MBPS },
  5: { priority: 1, sessionAmbr: IMS_SESSION_AMBR },
  6: { priority: 6, sessionAmbr: IMS_SESSION_AMBR },
  7: { priority: 7, sessionAmbr: AMBR_10_MBPS },
  8: { priority: 8, sessionAmbr: IMS_SESSION_AMBR },
  9: { priority: 9, sessionAmbr: IMS_SESSION_AMBR },
  65: { priority: 0.7, sessionAmbr: AMBR_128_KBPS },
  66: { priority: 2, sessionAmbr: AMBR_128_KBPS },
  67: { priority: 1.5, sessionAmbr: AMBR_4_MBPS },
  69: { priority: 0.5, sessionAmbr: IMS_SESSION_AMBR },
  70: { priority: 5.5, sessionAmbr: IMS_SESSION_AMBR },
  75: { priority: 2.5, sessionAmbr: AMBR_2_MBPS },
  79: { priority: 6.5, sessionAmbr: AMBR_2_MBPS },
  80: { priority: 6.8, sessionAmbr: AMBR_10_MBPS },
  82: { priority: 1.9, sessionAmbr: AMBR_10_MBPS },
  83: { priority: 2.2, sessionAmbr: AMBR_10_MBPS },
  84: { priority: 2.4, sessionAmbr: AMBR_10_MBPS },
  85: { priority: 2.1, sessionAmbr: AMBR_1_MBPS },
};

export const FIVE_QI_STANDARD_VALUES = {
  1: { priority: 20, sessionAmbr: AMBR_128_KBPS },
  2: { priority: 40, sessionAmbr: AMBR_4_MBPS },
  3: { priority: 30, sessionAmbr: AMBR_2_MBPS },
  4: { priority: 50, sessionAmbr: AMBR_10_MBPS },
  5: { priority: 10, sessionAmbr: IMS_SESSION_AMBR },
  6: { priority: 60, sessionAmbr: IMS_SESSION_AMBR },
  7: { priority: 70, sessionAmbr: AMBR_10_MBPS },
  8: { priority: 80, sessionAmbr: IMS_SESSION_AMBR },
  9: { priority: 90, sessionAmbr: IMS_SESSION_AMBR },
  65: { priority: 7, sessionAmbr: AMBR_128_KBPS },
  66: { priority: 20, sessionAmbr: AMBR_128_KBPS },
  67: { priority: 15, sessionAmbr: AMBR_4_MBPS },
  69: { priority: 5, sessionAmbr: IMS_SESSION_AMBR },
  70: { priority: 55, sessionAmbr: IMS_SESSION_AMBR },
  75: { priority: 25, sessionAmbr: AMBR_2_MBPS },
  79: { priority: 65, sessionAmbr: AMBR_2_MBPS },
  80: { priority: 68, sessionAmbr: AMBR_10_MBPS },
  82: { priority: 19, sessionAmbr: AMBR_10_MBPS },
  83: { priority: 22, sessionAmbr: AMBR_10_MBPS },
  84: { priority: 24, sessionAmbr: AMBR_10_MBPS },
  85: { priority: 21, sessionAmbr: AMBR_1_MBPS },
};

function copyAmbr(ambr) {
  return {
    downlink: { value: ambr.downlink.value, unit: ambr.downlink.unit },
    uplink: { value: ambr.uplink.value, unit: ambr.uplink.unit },
  };
}

function clampArpPriority(value) {
  return Math.min(15, Math.max(1, Math.ceil(value)));
}

export function sessionQosPreset(value) {
  const index = Number(value);
  if (!Number.isFinite(index)) return null;

  const qci = LTE_QCI_STANDARD_VALUES[index];
  const fiveQi = FIVE_QI_STANDARD_VALUES[index];
  if (!qci && !fiveQi) return null;

  const qciPriority = qci?.priority ?? (fiveQi.priority / 10);
  return {
    index,
    qciPriority,
    fiveQiPriority: fiveQi?.priority ?? qciPriority * 10,
    arpPriorityLevel: clampArpPriority(qciPriority),
    sessionAmbr: copyAmbr(qci?.sessionAmbr || fiveQi.sessionAmbr),
  };
}

export function isImsDnn(value) {
  return String(value || '').trim().toLowerCase() === 'ims';
}

export function imsSessionPreset(session) {
  const preset = sessionQosPreset(5);

  return {
    ...session,
    name: 'ims',
    type: 3,
    qos: {
      ...(session.qos || {}),
      _5qi: 5,
      arp: {
        ...(session.qos?.arp || {}),
        priorityLevel: preset?.arpPriorityLevel || 1,
        preemptCap: session.qos?.arp?.preemptCap || 'NOT_PREEMPT',
        preemptVuln: session.qos?.arp?.preemptVuln || 'NOT_PREEMPTABLE',
      },
    },
    ambr: preset?.sessionAmbr || copyAmbr(IMS_SESSION_AMBR),
  };
}

export function pccQosPreset(value) {
  const preset = sessionQosPreset(value);
  if (!preset) return null;

  if (preset.index === 1) {
    return {
      arpPriorityLevel: preset.arpPriorityLevel,
      mbr: copyAmbr(IMS_VOICE_PCC_AMBR),
      gbr: copyAmbr(IMS_VOICE_PCC_AMBR),
    };
  }

  if (preset.index === 2) {
    return {
      arpPriorityLevel: preset.arpPriorityLevel,
      mbr: copyAmbr(IMS_VIDEO_MBR),
      gbr: copyAmbr(IMS_VIDEO_GBR),
    };
  }

  return {
    arpPriorityLevel: preset.arpPriorityLevel,
    mbr: copyAmbr(preset.sessionAmbr),
    gbr: copyAmbr(preset.sessionAmbr),
  };
}
