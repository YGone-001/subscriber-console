import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  assertFrozenSubscriberBatchUpdateV2,
  expectedTouchedLeafKeys,
} from "../src/server/subscriberOperationPolicy.ts";

// Section 3: Canonical Node frozen-integrity production tests

// Helper to compute stable JSON (same algorithm as production)
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

// Helper to compute fingerprint (same algorithm as production)
function fingerprint(value) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

// Helper to build a valid frozen payload with correct hashes
function makeValidFrozen(overrides = {}) {
  const patch = overrides.patch || { accessRestrictionData: 0 };
  const before = overrides.before || { access_restriction_data: 32 };
  const after = overrides.after || { access_restriction_data: 0 };
  const imsi = overrides.imsi || "001010000000001";

  const preconditionHash = fingerprint(before);
  const fieldNames = overrides.fieldNames || ["access_restriction_data"];

  const targets = [
    { imsi, before, after, preconditionHash },
  ];

  const operationFingerprint = fingerprint({
    operation: "SUBSCRIBER_BATCH_UPDATE",
    targets: targets.map((t) => ({
      imsi: t.imsi,
      preconditionHash: t.preconditionHash,
      after: t.after,
    })),
    patch,
    fieldNames,
  });

  const snapshotBytes = Buffer.byteLength(
    stableJson({ targets, patch, fieldNames, operationFingerprint }),
    "utf8"
  );

  return {
    version: "subscriber-batch-update-v2",
    targetCount: targets.length,
    targets,
    patch,
    fieldNames,
    snapshotBytes,
    operationFingerprint,
    ...overrides,
    // Override computed fields if not explicitly provided
    ...(overrides.targets ? {} : { targets }),
    ...(overrides.operationFingerprint ? {} : { operationFingerprint }),
    ...(overrides.snapshotBytes ? {} : { snapshotBytes }),
  };
}

// ─── Valid frozen payload ───

test("valid frozen payload passes assertion", () => {
  // Section 21: Actually invoke production assert with valid payload
  const frozen = makeValidFrozen();
  const result = assertFrozenSubscriberBatchUpdateV2(frozen);
  assert.ok(result.version === "subscriber-batch-update-v2");
  assert.ok(result.targetCount === 1);
  assert.ok(result.targets.length === 1);
  assert.ok(result.targets[0].imsi === "001010000000001");
  assert.ok(result.targets[0].preconditionHash);
  assert.ok(result.operationFingerprint);
  assert.ok(result.snapshotBytes > 0);
});

// ─── expectedTouchedLeafKeys ───

test("expectedTouchedLeafKeys: accessRestrictionData only", () => {
  const keys = expectedTouchedLeafKeys({ accessRestrictionData: 0 });
  assert.deepStrictEqual(keys, ["access_restriction_data"]);
});

test("expectedTouchedLeafKeys: ambr downlink only", () => {
  const keys = expectedTouchedLeafKeys({ ambr: { downlink: { value: 100, unit: 1 } } });
  assert.deepStrictEqual(keys, ["ambr.downlink.unit", "ambr.downlink.value"]);
});

test("expectedTouchedLeafKeys: ambr uplink only", () => {
  const keys = expectedTouchedLeafKeys({ ambr: { uplink: { value: 50, unit: 2 } } });
  assert.deepStrictEqual(keys, ["ambr.uplink.unit", "ambr.uplink.value"]);
});

test("expectedTouchedLeafKeys: both ambr directions", () => {
  const keys = expectedTouchedLeafKeys({
    ambr: { downlink: { value: 100, unit: 1 }, uplink: { value: 50, unit: 2 } },
  });
  assert.deepStrictEqual(keys, [
    "ambr.downlink.unit",
    "ambr.downlink.value",
    "ambr.uplink.unit",
    "ambr.uplink.value",
  ]);
});

test("expectedTouchedLeafKeys: combined patch", () => {
  const keys = expectedTouchedLeafKeys({
    accessRestrictionData: 16,
    ambr: { downlink: { value: 500, unit: 1 } },
  });
  assert.deepStrictEqual(keys, [
    "access_restriction_data",
    "ambr.downlink.unit",
    "ambr.downlink.value",
  ]);
});

// ─── Structure validation ───

test("frozen validation rejects wrong version", () => {
  const frozen = makeValidFrozen({ version: "wrong-version" });
  assert.throws(
    () => assertFrozenSubscriberBatchUpdateV2(frozen),
    (err) => err.code === "INVALID_SUBSCRIBER_BATCH_UPDATE_PAYLOAD"
  );
});

test("frozen validation rejects mismatched targetCount", () => {
  const frozen = makeValidFrozen({ targetCount: 2 });
  assert.throws(
    () => assertFrozenSubscriberBatchUpdateV2(frozen),
    (err) => err.code === "INVALID_SUBSCRIBER_BATCH_UPDATE_PAYLOAD"
  );
});

test("frozen validation rejects empty targets", () => {
  const frozen = makeValidFrozen({ targets: [], targetCount: 0 });
  assert.throws(
    () => assertFrozenSubscriberBatchUpdateV2(frozen),
    (err) => err.code === "INVALID_SUBSCRIBER_BATCH_UPDATE_PAYLOAD"
  );
});

test("frozen validation rejects non-array targets", () => {
  const frozen = makeValidFrozen({ targets: "not-array" });
  assert.throws(
    () => assertFrozenSubscriberBatchUpdateV2(frozen),
    (err) => err.code === "INVALID_SUBSCRIBER_BATCH_UPDATE_PAYLOAD"
  );
});

// ─── IMSI validation ───

test("frozen validation rejects invalid IMSI (too short)", () => {
  const frozen = makeValidFrozen({
    targets: [
      {
        imsi: "12345678901234",
        before: { access_restriction_data: 32 },
        after: { access_restriction_data: 0 },
        preconditionHash: "abc",
      },
    ],
  });
  assert.throws(
    () => assertFrozenSubscriberBatchUpdateV2(frozen),
    (err) => err.code === "INVALID_BATCH_REQUEST" || err.code === "INVALID_SUBSCRIBER_BATCH_UPDATE_PAYLOAD"
  );
});

test("frozen validation rejects invalid IMSI (too long)", () => {
  const frozen = makeValidFrozen({
    targets: [
      {
        imsi: "1234567890123456",
        before: { access_restriction_data: 32 },
        after: { access_restriction_data: 0 },
        preconditionHash: "abc",
      },
    ],
  });
  assert.throws(
    () => assertFrozenSubscriberBatchUpdateV2(frozen),
    (err) => err.code === "INVALID_BATCH_REQUEST" || err.code === "INVALID_SUBSCRIBER_BATCH_UPDATE_PAYLOAD"
  );
});

test("frozen validation rejects invalid IMSI (non-digit)", () => {
  const frozen = makeValidFrozen({
    targets: [
      {
        imsi: "00101000000000a",
        before: { access_restriction_data: 32 },
        after: { access_restriction_data: 0 },
        preconditionHash: "abc",
      },
    ],
  });
  assert.throws(
    () => assertFrozenSubscriberBatchUpdateV2(frozen),
    (err) => err.code === "INVALID_BATCH_REQUEST" || err.code === "INVALID_SUBSCRIBER_BATCH_UPDATE_PAYLOAD"
  );
});

// ─── Duplicate IMSI ───

test("frozen validation rejects duplicate IMSI", () => {
  const frozen = makeValidFrozen({
    targetCount: 2,
    targets: [
      {
        imsi: "001010000000001",
        before: { access_restriction_data: 32 },
        after: { access_restriction_data: 0 },
        preconditionHash: "abc",
      },
      {
        imsi: "001010000000001",
        before: { access_restriction_data: 64 },
        after: { access_restriction_data: 0 },
        preconditionHash: "def",
      },
    ],
  });
  assert.throws(
    () => assertFrozenSubscriberBatchUpdateV2(frozen),
    (err) => err.code === "INVALID_BATCH_REQUEST" || err.code === "INVALID_SUBSCRIBER_BATCH_UPDATE_PAYLOAD"
  );
});

// ─── Unsorted IMSI ───

test("frozen validation rejects unsorted IMSI", () => {
  const frozen = makeValidFrozen({
    targetCount: 2,
    targets: [
      {
        imsi: "001010000000002",
        before: { access_restriction_data: 32 },
        after: { access_restriction_data: 0 },
        preconditionHash: "abc",
      },
      {
        imsi: "001010000000001",
        before: { access_restriction_data: 64 },
        after: { access_restriction_data: 0 },
        preconditionHash: "def",
      },
    ],
  });
  assert.throws(
    () => assertFrozenSubscriberBatchUpdateV2(frozen),
    (err) => err.code === "INVALID_SUBSCRIBER_BATCH_UPDATE_PAYLOAD"
  );
});

// ─── Key set validation ───

test("frozen validation rejects missing before leaf", () => {
  const frozen = makeValidFrozen({
    targets: [
      {
        imsi: "001010000000001",
        before: {},
        after: { access_restriction_data: 0 },
        preconditionHash: "abc",
      },
    ],
  });
  assert.throws(
    () => assertFrozenSubscriberBatchUpdateV2(frozen),
    (err) => err.code === "INVALID_SUBSCRIBER_BATCH_UPDATE_PAYLOAD"
  );
});

test("frozen validation rejects extra before leaf", () => {
  const frozen = makeValidFrozen({
    targets: [
      {
        imsi: "001010000000001",
        before: { access_restriction_data: 32, extra_field: 0 },
        after: { access_restriction_data: 0, extra_field: 0 },
        preconditionHash: "abc",
      },
    ],
  });
  assert.throws(
    () => assertFrozenSubscriberBatchUpdateV2(frozen),
    (err) => err.code === "INVALID_SUBSCRIBER_BATCH_UPDATE_PAYLOAD"
  );
});

test("frozen validation rejects missing after leaf", () => {
  const frozen = makeValidFrozen({
    targets: [
      {
        imsi: "001010000000001",
        before: { access_restriction_data: 32 },
        after: {},
        preconditionHash: "abc",
      },
    ],
  });
  assert.throws(
    () => assertFrozenSubscriberBatchUpdateV2(frozen),
    (err) => err.code === "INVALID_SUBSCRIBER_BATCH_UPDATE_PAYLOAD"
  );
});

test("frozen validation rejects extra after leaf", () => {
  const frozen = makeValidFrozen({
    targets: [
      {
        imsi: "001010000000001",
        before: { access_restriction_data: 32, extra_field: 0 },
        after: { access_restriction_data: 0, extra_field: 0 },
        preconditionHash: "abc",
      },
    ],
  });
  assert.throws(
    () => assertFrozenSubscriberBatchUpdateV2(frozen),
    (err) => err.code === "INVALID_SUBSCRIBER_BATCH_UPDATE_PAYLOAD"
  );
});

// ─── fieldNames validation ───

test("frozen validation rejects wrong fieldNames", () => {
  const frozen = makeValidFrozen({
    fieldNames: ["wrong_field"],
  });
  assert.throws(
    () => assertFrozenSubscriberBatchUpdateV2(frozen),
    (err) => err.code === "INVALID_SUBSCRIBER_BATCH_UPDATE_PAYLOAD"
  );
});

// ─── Patch validation ───

test("frozen validation rejects unknown patch key", () => {
  const frozen = makeValidFrozen({
    patch: { accessRestrictionData: 0, unknownKey: 1 },
    fieldNames: ["access_restriction_data", "unknown_key"],
  });
  assert.throws(
    () => assertFrozenSubscriberBatchUpdateV2(frozen),
    (err) => err.code === "UNSUPPORTED_SUBSCRIBER_FIELD" || err.code === "INVALID_SUBSCRIBER_BATCH_UPDATE_PAYLOAD"
  );
});
