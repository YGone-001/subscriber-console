export class CsvParseError extends Error {
  constructor(message = "Invalid CSV format") {
    super(message);
    this.name = "CsvParseError";
  }
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let fieldStarted = false;

  const source = text.replace(/^\uFEFF/, "");

  const pushField = () => {
    row.push(field);
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

    if (char === ",") {
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

export function toCsvRow(fields: Array<string | number | null | undefined>): string {
  return fields.map((value) => {
    const text = String(value ?? "");
    if (/[",\r\n]/.test(text)) {
      return `"${text.replace(/"/g, '""')}"`;
    }
    return text;
  }).join(",");
}
