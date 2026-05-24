/**
 * Generic RFC-4180-ish CSV parser. Extracted from openagenticv4's
 * `liz-csv.ts` during the Refill cleave — every Refill consumer
 * (emma-appointments, scan, appointment-csv, client-list-csv,
 * patient-csv) only needed this one function; the rest of liz-csv
 * was Lizzie account taxonomy (FAMILY_COLUMNS, ParsedAccountRow, etc.)
 * that doesn't belong in Refill.
 *
 * Handles: BOM stripping, quoted fields, double-quote escapes, CRLF,
 * trailing fields without final newline.
 */
export function parseCsvGrid(csv: string): string[][] {
  const text = csv.replace(/^﻿/, ""); // strip BOM if Excel added one
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      continue;
    }
    if (ch === "\r") {
      if (text[i + 1] === "\n") continue;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      continue;
    }
    if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      continue;
    }
    field += ch;
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}
