import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/lib/open5gsSubscriber.ts", import.meta.url), "utf8");
const types = readFileSync(new URL("../src/types/open5gs.ts", import.meta.url), "utf8");

test("Open5GS subscriber generator emits current collection fields", () => {
  assert.match(source, /__v:\s*0/);
  assert.match(source, /schema_version:\s*1/);
  assert.match(source, /mm_realm:\s*\[\]/);
  assert.doesNotMatch(source, /mme_realm/);
  assert.match(types, /__v\?:\s*number/);
  assert.match(types, /mm_realm:\s*string\[\]/);
  assert.doesNotMatch(types, /mme_realm/);
});
