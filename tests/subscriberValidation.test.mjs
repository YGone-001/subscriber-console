import test from "node:test";
import assert from "node:assert/strict";

import {
  validateBatchCreatePayload,
  validateImsi,
  validateImsiList,
  validateSubscriberUpdatePayload,
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
    plmn: "45400",
    ratingGroupId: "1001",
    currency: "USD",
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
  assert.equal(validateBatchCreatePayload({ startImsi: "460020000000001", count: 1, currency: "usd" }).ok, false);
});

test("validateSubscriberUpdatePayload rejects malformed auth and slice fields", () => {
  assert.equal(validateSubscriberUpdatePayload({ auth4G: { k: "bad" } }).ok, false);
  assert.equal(validateSubscriberUpdatePayload({ auth4G: { amf: "8000", sqn: 1 } }).ok, true);
  assert.equal(validateSubscriberUpdatePayload({ sub4G: { sliceList: [{ sst: 999 }] } }).ok, false);
  assert.equal(validateSubscriberUpdatePayload({ sub4G: { sliceList: [{ sd: "000001", session_list: [{ name: "internet" }] }] } }).ok, true);
});

test("validateImsiList rejects invalid entries", () => {
  assert.equal(validateImsiList(["460020000000001", "460020000000002"]).ok, true);
  assert.equal(validateImsiList(["460020000000001", "bad"]).ok, false);
});
