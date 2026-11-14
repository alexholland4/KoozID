// Minimal RFC 4180 CSV reader/writer (Excel-compatible). Used by import and export.

/** Parse CSV text into rows. Handles quotes, escaped quotes, CRLF, a BOM, and ; or tab delimiters. */
export function parseCsv(text: string, delimiter?: string): string[][] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const delim = delimiter ?? detectDelimiter(text);
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
        } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"' && field === "") {
      inQuotes = true;
    } else if (ch === delim) {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  // Drop fully empty lines (common at the end of Excel exports).
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

function detectDelimiter(text: string): string {
  const firstLine = text.slice(0, text.search(/\r?\n|$/));
  const counts = [",", ";", "\t"].map((d) => [d, firstLine.split(d).length] as const);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 1 ? counts[0][0] : ",";
}

/**
 * Neutralise spreadsheet formula injection: cells beginning with = + - @ (or tab/CR) are
 * prefixed with an apostrophe so Excel treats them as text.
 */
function safeCell(v: unknown): string {
  let s = v === null || v === undefined ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Serialise rows to CSV with a UTF-8 BOM so Excel detects the encoding. */
export function toCsv(rows: unknown[][]): string {
  return "﻿" + rows.map((r) => r.map(safeCell).join(",")).join("\r\n") + "\r\n";
}

/** Parse common spreadsheet date formats to YYYY-MM-DD. US M/D/YYYY is assumed for slashes. */
export function parseLooseDate(v: string): string | null {
  const s = v.trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return iso(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (m) {
    const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    return iso(y, +m[1], +m[2]);
  }
  return null;
}

function iso(y: number, mo: number, d: number): string | null {
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 1900 || y > 2100) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}
