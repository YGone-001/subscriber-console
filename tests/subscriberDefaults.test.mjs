import test from "node:test";
import assert from "node:assert/strict";

import {
  buildDefaultSub4G,
  normalizeSliceList,
  normalizeSub4G,
} from "../src/lib/subscriberDefaults.ts";

test("normalizeSliceList creates Open5GS-ready default sessions without an SD override", () => {
  const slices = normalizeSliceList(undefined);

  assert.equal(slices.length, 1);
  assert.equal(slices[0].sst, 1);
  assert.equal(slices[0].sd, undefined);
  assert.equal(slices[0].default_indicator, true);
  assert.deepEqual(
    slices[0].session_list.map((session) => [session.name, session.type, session.qos._5qi, session.qos.arp.priorityLevel]),
    [
      ["internet", 1, 9, 8],
      ["mobile", 1, 9, 8],
      ["ims", 3, 5, 1],
    ]
  );
});

test("buildDefaultSub4G applies profile AMBR, MSISDN fallback, and slice defaults", () => {
  const sub4g = buildDefaultSub4G("", {
    msisdnList: [{ msisdn: "13900000000" }],
    ambr: {
      downlink: { unit: 3, value: 1 },
      uplink: { unit: 3, value: 2 },
    },
  });

  assert.equal(sub4g.msisdnList[0].msisdn, "13900000000");
  assert.deepEqual(sub4g.ambr.downlink, { unit: 3, value: 1 });
  assert.deepEqual(sub4g.ambr.uplink, { unit: 3, value: 2 });
  assert.equal(sub4g.sliceList[0].session_list.length, 3);
});

test("normalizeSub4G preserves existing access settings and normalizes nested sessions", () => {
  const normalized = normalizeSub4G({
    access_restriction_data: "32",
    allowedVisitedPlmns: "home",
    network_access_mode: "2",
    msisdnList: [{ msisdn: 12345 }],
    sliceList: [
      {
        default_indicator: false,
        sd: 7,
        sst: "2",
        session_list: [
          {
            name: "private",
            type: "3",
            qos: { index: 6, arp: { priority_level: 4, pre_emption_capability: 0, pre_emption_vulnerability: 0 } },
          },
        ],
      },
    ],
  });

  assert.equal(normalized.access_restriction_data, 32);
  assert.equal(normalized.allowedVisitedPlmns, "home");
  assert.equal(normalized.network_access_mode, 2);
  assert.equal(normalized.msisdnList[0].msisdn, "12345");
  assert.equal(normalized.sliceList[0].default_indicator, false);
  assert.equal(normalized.sliceList[0].sd, "7");
  assert.equal(normalized.sliceList[0].session_list[0].qos._5qi, 6);
  assert.equal(normalized.sliceList[0].session_list[0].qos.arp.preemptCap, "PREEMPT");
  assert.equal(normalized.sliceList[0].session_list[0].qos.arp.preemptVuln, "PREEMPTABLE");
});
