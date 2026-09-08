import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  ACCESS_RESTRICTION_FIXTURE,
  AMBR_DOWNLINK_FIXTURE,
  AMBR_UPLINK_FIXTURE,
  AMBR_BOTH_FIXTURE,
  COMBINED_FIXTURE,
  MULTI_IMSI_FIXTURE,
} from "../src/server/__tests__/batch-update-fixtures.ts";

// Section 4: Cross-runtime frozen integrity tests (canonical)

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

function fingerprint(value) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

const FIXTURES = {
  accessRestriction: {
    frozen: ACCESS_RESTRICTION_FIXTURE,
    expectedLeafKeys: ["access_restriction_data"],
    expectedPatch: { accessRestrictionData: 0 },
  },
  ambrDownlink: {
    frozen: AMBR_DOWNLINK_FIXTURE,
    expectedLeafKeys: ["ambr.downlink.unit", "ambr.downlink.value"],
    expectedPatch: { ambr: { downlink: { value: 100, unit: 1 } } },
  },
  ambrUplink: {
    frozen: AMBR_UPLINK_FIXTURE,
    expectedLeafKeys: ["ambr.uplink.unit", "ambr.uplink.value"],
    expectedPatch: { ambr: { uplink: { value: 50, unit: 2 } } },
  },
  ambrBoth: {
    frozen: AMBR_BOTH_FIXTURE,
    expectedLeafKeys: ["ambr.downlink.unit", "ambr.downlink.value", "ambr.uplink.unit", "ambr.uplink.value"],
    expectedPatch: { ambr: { downlink: { value: 200, unit: 1 }, uplink: { value: 100, unit: 1 } } },
  },
  combined: {
    frozen: COMBINED_FIXTURE,
    expectedLeafKeys: ["access_restriction_data", "ambr.downlink.unit", "ambr.downlink.value"],
    expectedPatch: { accessRestrictionData: 16, ambr: { downlink: { value: 500, unit: 1 } } },
  },
  multiImsi: {
    frozen: MULTI_IMSI_FIXTURE,
    expectedLeafKeys: ["access_restriction_data"],
    expectedPatch: { accessRestrictionData: 0 },
  },
};

for (const [fixtureName, { frozen, expectedLeafKeys, expectedPatch }] of Object.entries(FIXTURES)) {
  test(`[${fixtureName}] frozen payload has correct targetCount`, () => {
    assert.equal(frozen.targetCount, frozen.targets.length);
  });

  test(`[${fixtureName}] frozen payload has sorted fieldNames`, () => {
    const actual = [...frozen.fieldNames].sort();
    assert.deepStrictEqual(frozen.fieldNames, actual);
  });

  test(`[${fixtureName}] frozen payload has sorted targets by IMSI`, () => {
    const imsis = frozen.targets.map((t) => t.imsi);
    const sorted = [...imsis].sort();
    assert.deepStrictEqual(imsis, sorted);
  });

  test(`[${fixtureName}] frozen payload snapshotBytes is plausible`, () => {
    assert.ok(frozen.snapshotBytes > 0, "snapshotBytes must be positive");
    assert.ok(frozen.snapshotBytes < 512 * 1024, "snapshotBytes must be under 512 KiB");
  });

  test(`[${fixtureName}] frozen payload operationFingerprint is non-empty`, () => {
    assert.ok(frozen.operationFingerprint.length > 0);
  });

  test(`[${fixtureName}] before/after key sets exactly match expected leaf keys`, () => {
    for (const target of frozen.targets) {
      const beforeKeys = Object.keys(target.before).sort();
      const afterKeys = Object.keys(target.after).sort();
      assert.deepStrictEqual(beforeKeys, afterKeys, `${target.imsi}: before/after key mismatch`);
      assert.deepStrictEqual(beforeKeys, expectedLeafKeys, `${target.imsi}: keys don't match expected leaf keys`);
    }
  });

  test(`[${fixtureName}] preconditionHash matches fingerprint of before`, () => {
    for (const target of frozen.targets) {
      const actual = fingerprint(target.before);
      assert.strictEqual(actual, target.preconditionHash, `${target.imsi}: preconditionHash mismatch`);
    }
  });

  test(`[${fixtureName}] after values match expected from patch`, () => {
    for (const target of frozen.targets) {
      if ("accessRestrictionData" in expectedPatch) {
        assert.strictEqual(target.after.access_restriction_data, expectedPatch.accessRestrictionData);
      }
      const ambr = expectedPatch.ambr;
      if (ambr?.downlink) {
        assert.strictEqual(target.after["ambr.downlink.value"], ambr.downlink.value);
        assert.strictEqual(target.after["ambr.downlink.unit"], ambr.downlink.unit);
      }
      if (ambr?.uplink) {
        assert.strictEqual(target.after["ambr.uplink.value"], ambr.uplink.value);
        assert.strictEqual(target.after["ambr.uplink.unit"], ambr.uplink.unit);
      }
    }
  });

  test(`[${fixtureName}] IMSIs are exactly 15 ASCII digits`, () => {
    for (const target of frozen.targets) {
      assert.ok(/^\d{15}$/.test(target.imsi), `${target.imsi} is not 15 ASCII digits`);
    }
  });
}
