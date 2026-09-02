import test from "node:test";
import assert from "node:assert/strict";

import {
  buildDefaultSub4G,
  normalizeSliceList,
  normalizeSub4G,
} from "../src/lib/subscriberDefaults.ts";

test("normalizeSliceList creates xCloud-ready default sessions without an SD override", () => {
  const slices = normalizeSliceList(undefined);

  assert.equal(slices.length, 1);
  assert.equal(slices[0].sst, 1);
  assert.equal(slices[0].sd, undefined);
  assert.equal(slices[0].default_indicator, true);
  assert.deepEqual(
    slices[0].session_list.map((session) => [session.name, session.type, session.qos._5qi, session.qos.arp.priorityLevel]),
    [
      ["internet", 1, 9, 9],
      ["mobile", 1, 9, 9],
      ["ims", 3, 5, 1],
    ]
  );
  assert.deepEqual(slices[0].session_list[0].ambr, {
    downlink: { unit: 3, value: 1 },
    uplink: { unit: 3, value: 1 },
  });
  assert.deepEqual(slices[0].session_list[2].ambr, {
    downlink: { unit: 3, value: 1 },
    uplink: { unit: 3, value: 1 },
  });
});

test("normalizeSliceList applies IMS and PCC bitrate presets", () => {
  const normalized = normalizeSliceList([
    {
      sst: 1,
      session_list: [
        {
          name: "ims",
          pcc_rule: [
            { qos: { _5qi: 1 } },
            { qos: { _5qi: 2 } },
            { qos: { _5qi: 5 } },
            { qos: { _5qi: 9 } },
          ],
        },
      ],
    },
  ]);

  const session = normalized[0].session_list[0];
  assert.equal(session.type, 3);
  assert.equal(session.qos._5qi, 5);
  assert.equal(session.qos.arp.priorityLevel, 1);
  assert.deepEqual(session.ambr, {
    downlink: { unit: 3, value: 1 },
    uplink: { unit: 3, value: 1 },
  });
  assert.deepEqual(session.pcc_rule[0].qos.mbr, {
    downlink: { unit: 1, value: 128 },
    uplink: { unit: 1, value: 128 },
  });
  assert.equal(session.pcc_rule[0].qos.arp.priorityLevel, 2);
  assert.deepEqual(session.pcc_rule[0].qos.gbr, {
    downlink: { unit: 1, value: 128 },
    uplink: { unit: 1, value: 128 },
  });
  assert.deepEqual(session.pcc_rule[1].qos.mbr, {
    downlink: { unit: 2, value: 4 },
    uplink: { unit: 2, value: 4 },
  });
  assert.equal(session.pcc_rule[1].qos.arp.priorityLevel, 4);
  assert.deepEqual(session.pcc_rule[1].qos.gbr, {
    downlink: { unit: 2, value: 2 },
    uplink: { unit: 2, value: 2 },
  });
  assert.deepEqual(session.pcc_rule[2].qos.mbr, {
    downlink: { unit: 3, value: 1 },
    uplink: { unit: 3, value: 1 },
  });
  assert.deepEqual(session.pcc_rule[2].qos.gbr, {
    downlink: { unit: 3, value: 1 },
    uplink: { unit: 3, value: 1 },
  });
  assert.equal(session.pcc_rule[2].qos.arp.priorityLevel, 1);
  assert.deepEqual(session.pcc_rule[3].qos.mbr, {
    downlink: { unit: 3, value: 1 },
    uplink: { unit: 3, value: 1 },
  });
  assert.deepEqual(session.pcc_rule[3].qos.gbr, {
    downlink: { unit: 3, value: 1 },
    uplink: { unit: 3, value: 1 },
  });
  assert.equal(session.pcc_rule[3].qos.arp.priorityLevel, 9);
});

test("normalizeSliceList applies standard QCI and 5QI session defaults", () => {
  const normalized = normalizeSliceList([
    {
      sst: 1,
      session_list: [
        { name: "voice", qos: { _5qi: 1 } },
        { name: "video", qos: { _5qi: 2 } },
        { name: "signalling", qos: { _5qi: 5 } },
        { name: "internet", qos: { _5qi: 9 } },
      ],
    },
  ]);

  const [voice, video, signalling, internet] = normalized[0].session_list;
  assert.equal(voice.qos.arp.priorityLevel, 2);
  assert.deepEqual(voice.ambr, {
    downlink: { unit: 1, value: 128 },
    uplink: { unit: 1, value: 128 },
  });
  assert.equal(video.qos.arp.priorityLevel, 4);
  assert.deepEqual(video.ambr, {
    downlink: { unit: 2, value: 4 },
    uplink: { unit: 2, value: 4 },
  });
  assert.equal(signalling.qos.arp.priorityLevel, 1);
  assert.deepEqual(signalling.ambr, {
    downlink: { unit: 3, value: 1 },
    uplink: { unit: 3, value: 1 },
  });
  assert.equal(internet.qos.arp.priorityLevel, 9);
  assert.deepEqual(internet.ambr, {
    downlink: { unit: 3, value: 1 },
    uplink: { unit: 3, value: 1 },
  });
});

test("buildDefaultSub4G applies profile AMBR and slice defaults without copying profile MSISDN", () => {
  const sub4g = buildDefaultSub4G("", {
    msisdnList: [{ msisdn: "13900000000" }],
    ambr: {
      downlink: { unit: 3, value: 1 },
      uplink: { unit: 3, value: 2 },
    },
  });

  assert.deepEqual(sub4g.msisdnList, []);
  assert.deepEqual(sub4g.ambr.downlink, { unit: 3, value: 1 });
  assert.deepEqual(sub4g.ambr.uplink, { unit: 3, value: 2 });
  assert.equal(sub4g.sliceList[0].session_list.length, 3);
});

test("buildDefaultSub4G preserves explicitly supplied subscriber MSISDN", () => {
  const sub4g = buildDefaultSub4G("13900000000", {
    msisdnList: [{ msisdn: "8529000006" }],
  });

  assert.equal(sub4g.msisdnList[0].msisdn, "13900000000");
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
            pcc_rule: [
              {
                qos: {
                  index: 1,
                  arp: { priority_level: 2, pre_emption_capability: 2, pre_emption_vulnerability: 2 },
                  mbr: { downlink: { value: 128, unit: 1 }, uplink: { value: 128, unit: 1 } },
                  gbr: { downlink: { value: 64, unit: 1 }, uplink: { value: 64, unit: 1 } },
                },
                flow: [],
              },
            ],
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
  assert.equal(normalized.sliceList[0].session_list[0].pcc_rule.length, 1);
  assert.equal(normalized.sliceList[0].session_list[0].pcc_rule[0].qos._5qi, 1);
  assert.equal(normalized.sliceList[0].session_list[0].pcc_rule[0].qos.arp.priorityLevel, 2);
  assert.deepEqual(normalized.sliceList[0].session_list[0].pcc_rule[0].qos.mbr.downlink, { unit: 1, value: 128 });
});
