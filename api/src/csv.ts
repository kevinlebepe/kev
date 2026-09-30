/** Spreadsheet programs run cells that start with these characters as formulas. */
export function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? '' : value instanceof Date ? value.toISOString() : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

export function toCsv(header: string[], rows: unknown[][]): string {
  return [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

/** A safe file name built from free text, such as a session name. */
export function fileName(text: string, fallback: string): string {
  return text.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 60) || fallback;
}
