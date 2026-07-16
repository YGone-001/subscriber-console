import test from "node:test";
import assert from "node:assert/strict";

import {
  composeByteInput,
  formatBytes,
  formatBytesAligned,
  formatSeconds,
  parseBytes,
  parseSeconds,
  splitByteInput,
} from "../src/lib/unitParser.ts";

test("parseBytes accepts binary units, decimals, commas, and invalid input", () => {
  assert.equal(parseBytes("1 GB"), 1024 ** 3);
  assert.equal(parseBytes("1.5GB"), 1.5 * 1024 ** 3);
  assert.equal(parseBytes("1,024 KB"), 1024 * 1024);
  assert.equal(parseBytes("not-a-size"), 0);
});

test("formatBytes chooses stable binary display units", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatBytes(10 * 1024 ** 3), "10 GB");
});

test("formatBytesAligned formats both values with the larger unit", () => {
  assert.deepEqual(formatBytesAligned(512, 2 * 1024 ** 2), ["0 MB", "2 MB"]);
});

test("splitByteInput and composeByteInput support value plus unit controls", () => {
  assert.deepEqual(splitByteInput("10 GB"), { value: "10", unit: "GB" });
  assert.deepEqual(splitByteInput("512", "MB"), { value: "512", unit: "MB" });
  assert.deepEqual(splitByteInput(2 * 1024 ** 3), { value: "2", unit: "GB" });
  assert.equal(composeByteInput("1.5", "TB"), "1.5 TB");
  assert.equal(composeByteInput("", "GB"), "0 GB");
});

test("parseSeconds and formatSeconds round-trip common operator inputs", () => {
  assert.equal(parseSeconds("60m"), 3600);
  assert.equal(parseSeconds("1.5h"), 5400);
  assert.equal(parseSeconds("2d"), 172800);
  assert.equal(parseSeconds("bad"), 0);
  assert.equal(formatSeconds(3600), "1h");
  assert.equal(formatSeconds(90), "90s");
});
