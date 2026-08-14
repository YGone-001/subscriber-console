import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: {
    "@": fileURLToPath(new URL("../src", import.meta.url)),
  },
});
const { prepareSubscriberLegacyUpdate } = await jiti.import("../src/server/repositories/subscriberRepository.ts");

const source = readFileSync(new URL("../src/lib/xcloudSubscriber.ts", import.meta.url), "utf8");
const types = readFileSync(new URL("../src/types/xcloud.ts", import.meta.url), "utf8");

test("Open5GS subscriber generator emits current collection fields", () => {
  assert.match(source, /__v:\s*0/);
  assert.match(source, /schema_version:\s*1/);
  assert.doesNotMatch(source, /ocs:\s*\{/);
  assert.doesNotMatch(source, /webui_meta:\s*\{/);
  assert.doesNotMatch(source, /mm_realm:\s*\[\]/);
  assert.match(source, /mme_realm/);
  assert.match(types, /__v\?:\s*number/);
  assert.match(types, /mm_realm\?:\s*string\[\]/);
  assert.match(types, /mme_realm\?:\s*string/);
});

test("Open5GS subscriber reader maps PCC rules into editable fields", () => {
  assert.match(source, /function legacyPccRule/);
  assert.match(source, /pcc_rule:\s*\(session\.pcc_rule \|\| \[\]\)\.map\(legacyPccRule\)/);
  assert.match(source, /_5qi:\s*qos\.index \?\? 1/);
  assert.match(source, /arp:\s*toLegacyArp\(qos\.arp,\s*2\)/);
});

test("legacy updates persist the same primary MSISDN to HSS and OCS", () => {
  const payload = {
    sub4G: {
      msisdnList: [{ msisdn: "13900000000" }],
    },
  };

  const persistence = prepareSubscriberLegacyUpdate("417010000000099", payload);

  assert.equal(persistence.requestedMsisdn, "13900000000");
  assert.deepEqual(persistence.next.msisdn, [persistence.requestedMsisdn]);
});

test("legacy updates clear HSS and OCS MSISDNs together", () => {
  const payload = {
    sub4G: {
      msisdnList: [],
    },
  };

  const persistence = prepareSubscriberLegacyUpdate("417010000000099", payload);

  assert.equal(persistence.requestedMsisdn, "");
  assert.deepEqual(persistence.next.msisdn, []);
});

test("partial legacy updates preserve the existing HSS and OCS MSISDN", () => {
  const initial = prepareSubscriberLegacyUpdate("417010000000099", {
    sub4G: {
      msisdnList: [{ msisdn: "13900000000" }],
    },
  });

  const persistence = prepareSubscriberLegacyUpdate(
    "417010000000099",
    { auth4G: { amf: "8000" } },
    initial.next
  );

  assert.equal(persistence.requestedMsisdn, "13900000000");
  assert.deepEqual(persistence.next.msisdn, [persistence.requestedMsisdn]);
});
