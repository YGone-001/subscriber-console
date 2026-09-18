import test from "node:test";
import assert from "node:assert/strict";

import {
  toCsvDocument,
  detectDelimiter,
  normalizeHeaderKey,
  parseImportContent,
  generateCsvTemplate,
  generateJsonTemplate,
} from "../src/lib/csv.ts";

test("CSV Utilities: Delimiter detection", () => {
  assert.equal(detectDelimiter("imsi,k,opc\n123,456,789"), ",");
  assert.equal(detectDelimiter("imsi;k;opc\n123;456;789"), ";");
  assert.equal(detectDelimiter("imsi\tk\topc\n123\t456\t789"), "\t");
  assert.equal(detectDelimiter("\uFEFFimsi,k,opc"), ",");
});

test("CSV Document generation includes BOM and escaped content", () => {
  const headers = ["imsi", "name", "plan"];
  const rows = [
    ["454001234567890", "User, Special", 'VIP "Pro"'],
    ["454001234567891", "Normal", "Default"],
  ];
  const doc = toCsvDocument(headers, rows, true);
  assert.ok(doc.startsWith("\uFEFF"));
  assert.ok(doc.includes('"User, Special"'));
  assert.ok(doc.includes('"VIP ""Pro"""'));
});

test("Header Normalization maps aliases correctly", () => {
  assert.equal(normalizeHeaderKey("IMSI"), "imsi");
  assert.equal(normalizeHeaderKey("subscriber_imsi"), "imsi");
  assert.equal(normalizeHeaderKey("Tariff_Plan"), "plan_id");
  assert.equal(normalizeHeaderKey("Policy"), "plan_id");
  assert.equal(normalizeHeaderKey("PlanId"), "plan_id");
  assert.equal(normalizeHeaderKey("Auth_K"), "k");
  assert.equal(normalizeHeaderKey("Key"), "k");
  assert.equal(normalizeHeaderKey("op_c"), "opc");
  assert.equal(normalizeHeaderKey("total_bytes"), "traffic_total");
  assert.equal(normalizeHeaderKey("data_balance"), "traffic_balance");
  assert.equal(normalizeHeaderKey("ard"), "access_restriction_data");
});

test("parseImportContent parses valid CSV with aliases", () => {
  const csvContent = `imsi,key,op_c,policy,total_bytes
454000000000001,00112233445566778899aabbccddeeff,00112233445566778899aabbccddeeff,plan_vip,21474836480
454000000000002,112233445566778899aabbccddeeff00,112233445566778899aabbccddeeff00,plan_basic,10737418240`;

  const parsed = parseImportContent(csvContent);
  assert.equal(parsed.format, "csv");
  assert.equal(parsed.totalRows, 2);
  assert.equal(parsed.validRows, 2);
  assert.equal(parsed.invalidRows, 0);
  assert.equal(parsed.duplicateCount, 0);
  assert.equal(parsed.records.length, 2);

  assert.equal(parsed.records[0].imsi, "454000000000001");
  assert.equal(parsed.records[0].k, "00112233445566778899aabbccddeeff");
  assert.equal(parsed.records[0].plan_id, "plan_vip");
  assert.equal(parsed.records[0].traffic_total, "21474836480");
});

test("parseImportContent detects invalid IMSIs and intra-file duplicates in CSV", () => {
  const csvContent = `imsi,plan_id
454000000000001,plan_default
invalid_imsi_123,plan_default
454000000000001,plan_default
454000000000002,plan_default`;

  const parsed = parseImportContent(csvContent);
  assert.equal(parsed.totalRows, 4);
  assert.equal(parsed.validRows, 2); // 001 (first occurrence) and 002
  assert.equal(parsed.invalidRows, 2); // invalid_imsi_123 and 001 (duplicate)
  assert.equal(parsed.duplicateCount, 1);
  assert.deepEqual(parsed.duplicateImsis, ["454000000000001"]);
  assert.equal(parsed.errors.length, 2);
  assert.ok(parsed.errors.some((e) => e.reason.includes("exactly 15 digits")));
  assert.ok(parsed.errors.some((e) => e.reason.includes("Duplicate IMSI")));
});

test("parseImportContent parses JSON format", () => {
  const jsonContent = JSON.stringify([
    {
      imsi: "454000000000010",
      k: "00112233445566778899aabbccddeeff",
      opc: "00112233445566778899aabbccddeeff",
      planId: "plan_enterprise",
      data_total: 53687091200,
    },
    {
      imsi: "454000000000011",
      plan_id: "plan_default_10gb",
    },
    {
      imsi: "454000000000010", // duplicate
      plan_id: "plan_duplicate",
    },
  ]);

  const parsed = parseImportContent(jsonContent);
  assert.equal(parsed.format, "json");
  assert.equal(parsed.totalRows, 3);
  assert.equal(parsed.validRows, 2);
  assert.equal(parsed.invalidRows, 1);
  assert.equal(parsed.duplicateCount, 1);
  assert.equal(parsed.records[0].imsi, "454000000000010");
  assert.equal(parsed.records[0].plan_id, "plan_enterprise");
  assert.equal(parsed.records[0].traffic_total, "53687091200");
});

test("Templates generation works and produces valid schemas", () => {
  const csvTemplate = generateCsvTemplate();
  assert.ok(csvTemplate.includes("imsi,k,opc,amf,plan_id"));
  const parsedCsv = parseImportContent(csvTemplate);
  assert.equal(parsedCsv.validRows, 2);

  const jsonTemplate = generateJsonTemplate();
  assert.ok(jsonTemplate.includes('"imsi": "454001234567890"'));
  const parsedJson = parseImportContent(jsonTemplate);
  assert.equal(parsedJson.validRows, 2);
});
