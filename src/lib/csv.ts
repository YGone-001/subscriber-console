export class CsvParseError extends Error {
  constructor(message = "Invalid CSV format") {
    super(message);
    this.name = "CsvParseError";
  }
}

export interface CsvParseOptions {
  delimiter?: string;
  trimFields?: boolean;
}

export function detectDelimiter(text: string): string {
  const clean = text.replace(/^\uFEFF/, "");
  const firstLine = clean.split(/\r?\n/)[0] || "";
  const commaCount = (firstLine.match(/,/g) || []).length;
  const semicolonCount = (firstLine.match(/;/g) || []).length;
  const tabCount = (firstLine.match(/\t/g) || []).length;

  if (tabCount > commaCount && tabCount > semicolonCount) return "\t";
  if (semicolonCount > commaCount) return ";";
  return ",";
}

export function parseCsv(text: string, options?: CsvParseOptions): string[][] {
  const delimiter = options?.delimiter || detectDelimiter(text);
  const trim = options?.trimFields !== false;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let fieldStarted = false;

  const source = text.replace(/^\uFEFF/, "");

  const pushField = () => {
    row.push(trim ? field.trim() : field);
    field = "";
    fieldStarted = false;
  };

  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };

  for (let i = 0; i < source.length; i++) {
    const char = source[i];

    if (inQuotes) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      if (!fieldStarted || field.trim() === "") {
        field = "";
        fieldStarted = true;
        inQuotes = true;
      } else {
        field += char;
      }
      continue;
    }

    if (char === delimiter) {
      pushField();
      continue;
    }

    if (char === "\n") {
      pushRow();
      continue;
    }

    if (char === "\r") {
      if (source[i + 1] === "\n") i++;
      pushRow();
      continue;
    }

    field += char;
    fieldStarted = true;
  }

  if (inQuotes) {
    throw new CsvParseError("Unclosed quoted field");
  }

  if (fieldStarted || field.length > 0 || row.length > 0) {
    pushField();
    rows.push(row);
  }

  return rows;
}

export function toCsvRow(
  fields: Array<string | number | null | undefined>,
  delimiter = ","
): string {
  return fields
    .map((value) => {
      const text = String(value ?? "");
      if (text.includes(delimiter) || /[",\r\n]/.test(text)) {
        return `"${text.replace(/"/g, '""')}"`;
      }
      return text;
    })
    .join(delimiter);
}

export function toCsvDocument(
  headers: string[],
  rows: Array<Array<string | number | null | undefined>>,
  includeBom = true,
  delimiter = ","
): string {
  const headerRow = toCsvRow(headers, delimiter);
  const dataRows = rows.map((row) => toCsvRow(row, delimiter));
  const content = [headerRow, ...dataRows].join("\r\n");
  return includeBom ? `\uFEFF${content}` : content;
}

export interface NormalizedImportRecord {
  imsi: string;
  k: string;
  opc: string;
  amf: string;
  plan_id: string;
  traffic_total: string;
  traffic_balance: string;
  sms_total: string;
  sms_balance: string;
  access_restriction_data: string;
  [key: string]: unknown;
}

export interface ImportErrorDetail {
  row: number;
  imsi?: string;
  reason: string;
  field?: string;
}

export interface ParsedImportFile {
  format: "csv" | "json";
  records: NormalizedImportRecord[];
  allRecords: Array<NormalizedImportRecord & { _valid: boolean; _error?: string; _duplicate?: boolean; _row: number }>;
  totalRows: number;
  validRows: number;
  invalidRows: number;
  duplicateCount: number;
  duplicateImsis: string[];
  errors: ImportErrorDetail[];
}

const HEADER_ALIAS_MAP: Record<string, string> = {
  imsi: "imsi",
  subscriber_imsi: "imsi",
  k: "k",
  key: "k",
  ki: "k",
  auth_k: "k",
  opc: "opc",
  op: "opc",
  op_c: "opc",
  auth_opc: "opc",
  amf: "amf",
  plan_id: "plan_id",
  planid: "plan_id",
  plan: "plan_id",
  policy: "plan_id",
  policy_id: "plan_id",
  tariff_plan: "plan_id",
  traffic_total: "traffic_total",
  traffictotal: "traffic_total",
  total_bytes: "traffic_total",
  data_total: "traffic_total",
  traffic_balance: "traffic_balance",
  trafficbalance: "traffic_balance",
  balance_bytes: "traffic_balance",
  data_balance: "traffic_balance",
  data_available: "traffic_balance",
  sms_total: "sms_total",
  smstotal: "sms_total",
  sms_balance: "sms_balance",
  smsbalance: "sms_balance",
  sms_available: "sms_balance",
  access_restriction_data: "access_restriction_data",
  access_restriction: "access_restriction_data",
  ard: "access_restriction_data",
};

export function normalizeHeaderKey(rawHeader: string): string {
  const clean = rawHeader.toLowerCase().trim().replace(/[\s_-]+/g, "_");
  return HEADER_ALIAS_MAP[clean] || clean;
}

export function parseImportContent(content: string): ParsedImportFile {
  const trimmed = content.trim();
  const errors: ImportErrorDetail[] = [];
  const validRecords: NormalizedImportRecord[] = [];
  const allRecords: ParsedImportFile["allRecords"] = [];
  const seenImsis = new Set<string>();
  const duplicateImsis = new Set<string>();

  if (trimmed.startsWith("[") || (trimmed.startsWith("{") && trimmed.includes('"records"'))) {
    // JSON format
    let rawArray: any[] = [];
    try {
      const parsed = JSON.parse(trimmed);
      rawArray = Array.isArray(parsed) ? parsed : Array.isArray(parsed.records) ? parsed.records : [];
    } catch {
      throw new CsvParseError("Invalid JSON array format");
    }

    if (rawArray.length === 0) {
      return {
        format: "json",
        records: [],
        allRecords: [],
        totalRows: 0,
        validRows: 0,
        invalidRows: 0,
        duplicateCount: 0,
        duplicateImsis: [],
        errors: [{ row: 1, reason: "Empty JSON array" }],
      };
    }

    rawArray.forEach((item, index) => {
      const rowNum = index + 1;
      const record: NormalizedImportRecord = {
        imsi: String(item.imsi || item.IMSI || "").trim(),
        k: String(item.k || item.key || item.ki || "00000000000000000000000000000000").trim(),
        opc: String(item.opc || item.op || "00000000000000000000000000000000").trim(),
        amf: String(item.amf || "8000").trim(),
        plan_id: String(item.plan_id || item.planId || item.policy || "plan_default_10gb").trim(),
        traffic_total: String(item.traffic_total ?? item.trafficTotal ?? item.data_total ?? "10737418240").trim(),
        traffic_balance: String(item.traffic_balance ?? item.trafficBalance ?? item.data_available ?? "10737418240").trim(),
        sms_total: String(item.sms_total ?? item.smsTotal ?? "100").trim(),
        sms_balance: String(item.sms_balance ?? item.smsBalance ?? "100").trim(),
        access_restriction_data: String(item.access_restriction_data ?? item.ard ?? "32").trim(),
      };

      let isValid = true;
      let errorReason = "";

      if (!/^\d{15}$/.test(record.imsi)) {
        isValid = false;
        errorReason = "IMSI must be exactly 15 digits";
      }

      let isDuplicate = false;
      if (isValid) {
        if (seenImsis.has(record.imsi)) {
          isDuplicate = true;
          duplicateImsis.add(record.imsi);
          errorReason = "Duplicate IMSI in file";
        } else {
          seenImsis.add(record.imsi);
        }
      }

      if (!isValid || isDuplicate) {
        errors.push({ row: rowNum, imsi: record.imsi, reason: errorReason });
      } else {
        validRecords.push(record);
      }

      allRecords.push({
        ...record,
        _valid: isValid && !isDuplicate,
        _error: errorReason,
        _duplicate: isDuplicate,
        _row: rowNum,
      });
    });

    return {
      format: "json",
      records: validRecords,
      allRecords,
      totalRows: rawArray.length,
      validRows: validRecords.length,
      invalidRows: rawArray.length - validRecords.length,
      duplicateCount: duplicateImsis.size,
      duplicateImsis: Array.from(duplicateImsis),
      errors,
    };
  }

  // CSV format
  const rows = parseCsv(content).filter((row) => row.some((cell) => cell.trim().length > 0));
  if (rows.length < 2) {
    throw new CsvParseError("CSV file is empty or missing data rows");
  }

  const rawHeaders = rows[0];
  const normalizedHeaders = rawHeaders.map(normalizeHeaderKey);
  const imsiIndex = normalizedHeaders.indexOf("imsi");

  if (imsiIndex === -1) {
    throw new CsvParseError("Missing required 'imsi' column header");
  }

  for (let i = 1; i < rows.length; i++) {
    const rowNum = i + 1;
    const values = rows[i];
    const record: NormalizedImportRecord = {
      imsi: "",
      k: "00000000000000000000000000000000",
      opc: "00000000000000000000000000000000",
      amf: "8000",
      plan_id: "plan_default_10gb",
      traffic_total: "10737418240",
      traffic_balance: "10737418240",
      sms_total: "100",
      sms_balance: "100",
      access_restriction_data: "32",
    };

    normalizedHeaders.forEach((header, colIndex) => {
      const val = (values[colIndex] || "").trim();
      if (val) {
        record[header] = val;
      }
    });

    record.imsi = record.imsi.replace(/\s+/g, "");

    let isValid = true;
    let errorReason = "";

    if (!/^\d{15}$/.test(record.imsi)) {
      isValid = false;
      errorReason = "IMSI must be exactly 15 digits";
    }

    let isDuplicate = false;
    if (isValid) {
      if (seenImsis.has(record.imsi)) {
        isDuplicate = true;
        duplicateImsis.add(record.imsi);
        errorReason = "Duplicate IMSI in file";
      } else {
        seenImsis.add(record.imsi);
      }
    }

    if (!isValid || isDuplicate) {
      errors.push({ row: rowNum, imsi: record.imsi, reason: errorReason });
    } else {
      validRecords.push(record);
    }

    allRecords.push({
      ...record,
      _valid: isValid && !isDuplicate,
      _error: errorReason,
      _duplicate: isDuplicate,
      _row: rowNum,
    });
  }

  return {
    format: "csv",
    records: validRecords,
    allRecords,
    totalRows: rows.length - 1,
    validRows: validRecords.length,
    invalidRows: rows.length - 1 - validRecords.length,
    duplicateCount: duplicateImsis.size,
    duplicateImsis: Array.from(duplicateImsis),
    errors,
  };
}

export function generateCsvTemplate(): string {
  const headers = [
    "imsi",
    "k",
    "opc",
    "amf",
    "plan_id",
    "traffic_total",
    "traffic_balance",
    "sms_total",
    "sms_balance",
    "access_restriction_data",
  ];
  const sampleRows = [
    [
      "454001234567890",
      "00112233445566778899aabbccddeeff",
      "00112233445566778899aabbccddeeff",
      "8000",
      "plan_default_10gb",
      "10737418240",
      "10737418240",
      "100",
      "100",
      "32",
    ],
    [
      "454001234567891",
      "112233445566778899aabbccddeeff00",
      "112233445566778899aabbccddeeff00",
      "8000",
      "plan_unlimited_vip",
      "53687091200",
      "53687091200",
      "500",
      "500",
      "32",
    ],
  ];
  return toCsvDocument(headers, sampleRows, true);
}

export function generateJsonTemplate(): string {
  const sample = [
    {
      imsi: "454001234567890",
      k: "00112233445566778899aabbccddeeff",
      opc: "00112233445566778899aabbccddeeff",
      amf: "8000",
      plan_id: "plan_default_10gb",
      traffic_total: 10737418240,
      traffic_balance: 10737418240,
      sms_total: 100,
      sms_balance: 100,
      access_restriction_data: 32,
    },
    {
      imsi: "454001234567891",
      k: "112233445566778899aabbccddeeff00",
      opc: "112233445566778899aabbccddeeff00",
      amf: "8000",
      plan_id: "plan_unlimited_vip",
      traffic_total: 53687091200,
      traffic_balance: 53687091200,
      sms_total: 500,
      sms_balance: 500,
      access_restriction_data: 32,
    },
  ];
  return JSON.stringify(sample, null, 2);
}
