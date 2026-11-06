/** RFC-4180-ish CSV parser (quotes, escaped quotes, CRLF). Returns header + rows as records. */
export function parseCsv(text: string): { headers: string[]; rows: Record<string, string>[] } {
  const out: string[][] = [];
  let row: string[] = [];
  let field = "";
  let q = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (q) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else q = false;
      } else field += c;
    } else if (c === '"') q = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((x) => x.trim() !== "")) out.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((x) => x.trim() !== "")) out.push(row);
  const headers = (out.shift() ?? []).map((h) => h.trim());
  return { headers, rows: out.map((r) => Object.fromEntries(headers.map((h, i) => [h, (r[i] ?? "").trim()]))) };
}

export function toCsv(rows: (string | number | null | undefined)[][]): string {
  return rows.map((r) => r.map((v) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(",")).join("\n");
}

/** A saved column-mapping profile: target field → source column name. */
export type ColumnMapping = Record<string, string>;

export function applyMapping(rows: Record<string, string>[], mapping: ColumnMapping): Record<string, string>[] {
  return rows.map((r) => Object.fromEntries(Object.entries(mapping).map(([target, src]) => [target, src ? r[src] ?? "" : ""])));
}

/** Guess a mapping by header similarity (user confirms in the UI). */
export function guessMapping(headers: string[], targets: Record<string, string[]>): ColumnMapping {
  const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, "");
  const m: ColumnMapping = {};
  for (const [target, aliases] of Object.entries(targets)) {
    const h = headers.find((hh) => aliases.some((a) => norm(hh) === norm(a))) ?? headers.find((hh) => aliases.some((a) => norm(hh).includes(norm(a))));
    m[target] = h ?? "";
  }
  return m;
}
