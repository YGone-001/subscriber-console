import test from "node:test";
import assert from "node:assert/strict";

import {
  validateBatchCreatePayload,
  validateImsi,
  validateImsiList,
  validatePolicyChangePayload,
  validateSubscriberUpdatePayload,
  validateTrafficAdjustmentPayload,
} from "../src/lib/subscriberValidation.ts";

test("validateImsi accepts only 15 digit strings", () => {
  assert.equal(validateImsi("460020000000001").ok, true);
  assert.equal(validateImsi("46002000000001").ok, false);
  assert.equal(validateImsi("46002000000000a").ok, false);
});

test("validateBatchCreatePayload normalizes safe batch input", () => {
  const result = validateBatchCreatePayload({
    startImsi: "460020000000001",
    count: "10",
    strategy: "skip",
  });

  assert.equal(result.ok, true);
  assert.equal(result.ok && result.value.count, 10);
  assert.equal(result.ok && result.value.strategy, "skip");
});

test("validateBatchCreatePayload rejects unsafe ranges and values", () => {
  assert.equal(validateBatchCreatePayload({ startImsi: "460020000000001", count: 0 }).ok, false);
  assert.equal(validateBatchCreatePayload({ startImsi: "460020000000001", count: 1001 }).ok, false);
  assert.equal(validateBatchCreatePayload({ startImsi: "460020000000001", count: 1, trafficBalance: -1 }).ok, false);
});

test("validateSubscriberUpdatePayload rejects malformed auth and slice fields", () => {
  assert.equal(validateSubscriberUpdatePayload({ auth4G: { k: "bad" } }).ok, false);
  assert.equal(validateSubscriberUpdatePayload({ auth4G: { amf: "8000", sqn: 1 } }).ok, true);
  assert.equal(validateSubscriberUpdatePayload({ sub4G: { sliceList: [{ sst: 999 }] } }).ok, false);
  assert.equal(validateSubscriberUpdatePayload({ sub4G: { sliceList: [{ sd: "000001", session_list: [{ name: "internet" }] }] } }).ok, true);
  assert.equal(validateSubscriberUpdatePayload({ ocsTraffic: { voice_total: 3600, voice_balance: 1800 } }).ok, true);
  assert.equal(validateSubscriberUpdatePayload({ ocsTraffic: { sms_total: 100, sms_balance: 80 } }).ok, true);
  assert.equal(validateSubscriberUpdatePayload({ ocsTraffic: { voice_balance: -1 } }).ok, false);
  assert.equal(validateSubscriberUpdatePayload({ ocsTraffic: { sms_balance: -1 } }).ok, false);
});

test("validateTrafficAdjustmentPayload normalizes supported balance actions", () => {
  const recharge = validateTrafficAdjustmentPayload({ mode: "recharge", amount: "1048576", reason: "top up" });
  assert.equal(recharge.ok, true);
  assert.equal(recharge.ok && recharge.value.amount, 1048576);
  assert.equal(recharge.ok && recharge.value.reason, "top up");

  const reset = validateTrafficAdjustmentPayload({ mode: "reset" });
  assert.equal(reset.ok, true);
  assert.equal(reset.ok && reset.value.mode, "reset");
});

test("validateTrafficAdjustmentPayload rejects unsafe balance actions", () => {
  assert.equal(validateTrafficAdjustmentPayload({ mode: "bad", amount: 1 }).ok, false);
  assert.equal(validateTrafficAdjustmentPayload({ mode: "recharge", amount: 0 }).ok, false);
  assert.equal(validateTrafficAdjustmentPayload({ mode: "recharge", amount: 1.5 }).ok, false);
  assert.equal(validateTrafficAdjustmentPayload({ mode: "set_available", value: -1 }).ok, false);
  assert.equal(validateTrafficAdjustmentPayload({ mode: "set_total" }).ok, false);
});

test("validatePolicyChangePayload normalizes bulk policy changes", () => {
  const result = validatePolicyChangePayload({
    imsiList: ["460020000000001", "460020000000002"],
    status: "suspended",
    resetBalances: true,
  });

  assert.equal(result.ok, true);
  assert.equal(result.ok && result.value.planId, "plan_default_10gb");
  assert.equal(result.ok && result.value.status, "suspended");
  assert.equal(result.ok && result.value.resetBalances, true);
});

test("validatePolicyChangePayload rejects unsafe policy changes", () => {
  assert.equal(validatePolicyChangePayload({ imsiList: [], planId: "plan_default_10gb" }).ok, false);
  assert.equal(validatePolicyChangePayload({ imsiList: ["460020000000001"], planId: "../bad" }).ok, false);
  assert.equal(validatePolicyChangePayload({ imsiList: ["460020000000001"], status: "locked" }).ok, false);
});

test("validateImsiList rejects invalid entries", () => {
  assert.equal(validateImsiList(["460020000000001", "460020000000002"]).ok, true);
  assert.equal(validateImsiList(["460020000000001", "bad"]).ok, false);
});
