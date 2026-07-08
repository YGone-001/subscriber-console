import test from "node:test";
import assert from "node:assert/strict";

import { CsvParseError, parseCsv, toCsvRow } from "../src/lib/csv.ts";

test("parseCsv handles BOM, quoted commas, escaped quotes, and blank rows", () => {
  const rows = parseCsv('\uFEFFimsi,name,note\r\n460020000000001,"Alice, Bob","said ""hi"""\n,,\n');

  assert.deepEqual(rows, [
    ["imsi", "name", "note"],
    ["460020000000001", "Alice, Bob", 'said "hi"'],
    ["", "", ""],
  ]);
});

test("parseCsv rejects unclosed quoted fields", () => {
  assert.throws(() => parseCsv('imsi,note\n460020000000001,"unterminated'), CsvParseError);
});

test("toCsvRow escapes delimiters, quotes, and newlines", () => {
  assert.equal(
    toCsvRow(["plain", "a,b", 'say "hi"', "line\nbreak", null]),
    'plain,"a,b","say ""hi""","line\nbreak",'
  );
});
