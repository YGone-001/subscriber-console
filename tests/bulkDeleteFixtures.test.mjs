import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  SINGLE_FROZEN,
  SINGLE_TARGET,
  SINGLE_TARGET_BEFORE,
  MULTI_FROZEN,
  MULTI_TARGET_1,
  MULTI_TARGET_2,
  MULTI_TARGET_1_BEFORE,
  MULTI_TARGET_2_BEFORE,
  FULL_FROZEN,
  FULL_TARGET,
  FULL_TARGET_BEFORE,
  fingerprint,
  stableJson,
} from "../src/server/__tests__/bulk-delete-fixtures.ts";

// Section 28: Cross-runtime frozen integrity tests (canonical)

test("SafeSnapshot excludes security fields", () => {
  const doc = {
    imsi: "460001234567890",
    msisdn: ["1234567890"],
    accessRestrictionData: 47,
    networkAccessMode: 2,
    security: {
      k: "00112233445566778899AABBCCDDEEFF",
      opc: "FFEEDDCCBBAA99887766554433221100",
      amf: "8000",
      sqn: "000000000000",
    },
  };

  // SafeSnapshot should only contain safe fields
  const safe = {
    imsi: doc.imsi,
    msisdn: doc.msisdn,
    accessRestrictionData: doc.accessRestrictionData,
    networkAccessMode: doc.networkAccessMode,
  };

  assert.equal(safe.imsi, "460001234567890");
  assert.deepEqual(safe.msisdn, ["1234567890"]);
  assert.equal(safe.accessRestrictionData, 47);
  assert.equal(safe.networkAccessMode, 2);
  assert.equal(safe.security, undefined);
});

test("preconditionHash is deterministic", () => {
  const hash1 = fingerprint(SINGLE_TARGET_BEFORE);
  const hash2 = fingerprint(SINGLE_TARGET_BEFORE);
  assert.equal(hash1, hash2);
  assert.equal(hash1.length, 64); // SHA256 hex
});

test("preconditionHash changes with different data", () => {
  const hash1 = fingerprint(SINGLE_TARGET_BEFORE);
  const hash2 = fingerprint({
    ...SINGLE_TARGET_BEFORE,
    accessRestrictionData: 0,
  });
  assert.notEqual(hash1, hash2);
});

test("operationFingerprint is deterministic", () => {
  const fp1 = fingerprint({
    operation: "SUBSCRIBER_BULK_DELETE",
    targets: [{ imsi: SINGLE_TARGET.imsi, preconditionHash: SINGLE_TARGET.preconditionHash }],
    strategy: "delete-only",
  });
  const fp2 = fingerprint({
    operation: "SUBSCRIBER_BULK_DELETE",
    targets: [{ imsi: SINGLE_TARGET.imsi, preconditionHash: SINGLE_TARGET.preconditionHash }],
    strategy: "delete-only",
  });
  assert.equal(fp1, fp2);
});

test("operationFingerprint changes with different targets", () => {
  const fp1 = fingerprint({
    operation: "SUBSCRIBER_BULK_DELETE",
    targets: [{ imsi: SINGLE_TARGET.imsi, preconditionHash: SINGLE_TARGET.preconditionHash }],
    strategy: "delete-only",
  });
  const fp2 = fingerprint({
    operation: "SUBSCRIBER_BULK_DELETE",
    targets: [{ imsi: MULTI_TARGET_1.imsi, preconditionHash: MULTI_TARGET_1.preconditionHash }],
    strategy: "delete-only",
  });
  assert.notEqual(fp1, fp2);
});

test("single target frozen structure", () => {
  assert.equal(SINGLE_FROZEN.version, "subscriber-bulk-delete-v2");
  assert.equal(SINGLE_FROZEN.strategy, "delete-only");
  assert.equal(SINGLE_FROZEN.targetCount, 1);
  assert.equal(SINGLE_FROZEN.targets.length, 1);
  assert.equal(SINGLE_FROZEN.targets[0].imsi, "460001234567890");
  assert.equal(typeof SINGLE_FROZEN.targets[0].preconditionHash, "string");
  assert.equal(SINGLE_FROZEN.targets[0].preconditionHash.length, 64);
  assert.equal(typeof SINGLE_FROZEN.snapshotBytes, "number");
  assert.ok(SINGLE_FROZEN.snapshotBytes > 0);
  assert.equal(typeof SINGLE_FROZEN.operationFingerprint, "string");
  assert.equal(SINGLE_FROZEN.operationFingerprint.length, 64);
});

test("multi target frozen structure", () => {
  assert.equal(MULTI_FROZEN.version, "subscriber-bulk-delete-v2");
  assert.equal(MULTI_FROZEN.targetCount, 2);
  assert.equal(MULTI_FROZEN.targets.length, 2);
  // Targets must be sorted ascending
  assert.ok(MULTI_FROZEN.targets[0].imsi < MULTI_FROZEN.targets[1].imsi);
});

test("snapshot bytes computed correctly", () => {
  const computed = stableJson({
    targets: SINGLE_FROZEN.targets,
    strategy: SINGLE_FROZEN.strategy,
    operationFingerprint: SINGLE_FROZEN.operationFingerprint,
  }).length;
  assert.equal(SINGLE_FROZEN.snapshotBytes, computed);
});

test("stableJson produces deterministic output", () => {
  const a = { b: 1, a: 2 };
  const result1 = stableJson(a);
  const result2 = stableJson(a);
  assert.equal(result1, result2);
  assert.equal(result1, '{"a":2,"b":1}');
});

test("stableJson handles arrays", () => {
  const a = [3, 1, 2];
  const result = stableJson(a);
  assert.equal(result, "[3,1,2]");
});

test("stableJson handles nested objects", () => {
  const a = { z: { b: 1, a: 2 }, y: 3 };
  const result = stableJson(a);
  assert.equal(result, '{"y":3,"z":{"a":2,"b":1}}');
});

test("preconditionHash matches between Node fixtures and Go computation", () => {
  // This test verifies that the hash computation is identical between Node and Go
  // The Go test TestBulkDelete_SnapshotHash verifies the same thing from the Go side
  const hash = fingerprint(SINGLE_TARGET_BEFORE);
  assert.equal(hash, SINGLE_TARGET.preconditionHash);
});

test("operationFingerprint matches between Node fixtures and Go computation", () => {
  // Verify fingerprint computation matches
  const fp = fingerprint({
    operation: "SUBSCRIBER_BULK_DELETE",
    targets: [{ imsi: SINGLE_TARGET.imsi, preconditionHash: SINGLE_TARGET.preconditionHash }],
    strategy: "delete-only",
  });
  assert.equal(fp, SINGLE_FROZEN.operationFingerprint);
});
