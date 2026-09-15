/**
 * CSV generation, in one place.
 *
 * There were already two hand-rolled implementations — `ResultsPanel.svelte` and
 * `logs/LogExportDialog.svelte` — with three bugs between them, and the panel
 * inspector was about to become a third. Both now call this.
 *
 * ## Formula injection is the reason this is not five lines
 *
 * A cell beginning `=`, `+`, `@`, TAB or CR is executed as a formula when the
 * file is opened in Excel or Sheets. The cells here are whatever a user's SQL
 * returned out of Arc, and "download CSV" is precisely the path that carries
 * them into a spreadsheet, so this is reachable content rather than a
 * theoretical concern.
 *
 * The usual advice — prefix anything starting with `= + - @ TAB CR` — is wrong
 * as stated for an observability product, because **every negative number starts
 * with `-`**. Applied literally it turns `-273.15` into the text `'-273.15` in
 * every export, which is no longer a number to pandas, DuckDB or csvkit. Of
 * fourteen sample cells, five ordinary readings were corrupted that way.
 *
 * So a leading `-` is treated as dangerous only when the cell is not a finite
 * number. That preserves `-12.5`, `-1e6` and `-0`, and still catches the
 * number-prefixed bypass `-2+3+cmd|'/c calc'!A0`, which is not finite.
 *
 * Note the mitigation is imperfect by nature: LibreOffice and Sheets keep the
 * apostrophe as a literal character on import rather than stripping it on
 * display. That is why it is an option, defaulted on only for downloads a user
 * asked for.
 */

export interface CsvOptions {
  /**
   * Prefix cells that a spreadsheet would execute. Default true — turn it off
   * for machine-to-machine output, where the apostrophe is corruption rather
   * than protection.
   */
  escapeFormulas?: boolean;
  /**
   * Emit a UTF-8 byte order mark. Excel on Windows mis-decodes UTF-8 without
   * one; a naive `csv.reader(encoding='utf-8')` reads it as part of the first
   * header. Default true for user-initiated downloads, off elsewhere.
   */
  bom?: boolean;
}

const BOM = '﻿';

/** Quote when the value contains a delimiter, a quote, or ANY line break. */
const NEEDS_QUOTING = /[",\n\r]/;

/** Characters a spreadsheet treats as the start of a formula. */
const FORMULA_START = /^[=+@\t\r]/;

/**
 * The stringification contract, stated because the two implementations this
 * replaces disagreed about it:
 *
 *   null      -> ''              (both agreed)
 *   undefined -> ''              (ResultsPanel emitted the text "undefined")
 *   object    -> JSON.stringify  (ResultsPanel emitted "[object Object]")
 *   otherwise -> String(value)
 */
export function csvValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function isDangerous(text: string): boolean {
  if (FORMULA_START.test(text)) return true;
  if (!text.startsWith('-')) return false;
  // A leading minus is only a formula when the cell is not simply a number.
  return !Number.isFinite(Number(text));
}

export function csvCell(value: unknown, opts: CsvOptions = {}): string {
  let text = csvValue(value);
  if (opts.escapeFormulas !== false && text !== '' && isDangerous(text)) {
    text = `'${text}`;
  }
  if (NEEDS_QUOTING.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

/**
 * Rows as separate strings rather than one joined blob.
 *
 * `Blob` accepts the array directly and never materialises the concatenation,
 * which matters here: `LIMITS.maxFrameRows` is 200,000, and a wide result joined
 * into a single JS string approaches V8's ~512MB string ceiling and then gets
 * copied again into the Blob. Tests just `join('')`.
 *
 * Records are separated with `\n`. RFC 4180 says CRLF, but every consumer
 * accepts LF, and the two implementations this replaces both used it — changing
 * it would alter the bytes of the existing logs export for no benefit.
 */
export function toCsvChunks(
  columns: readonly string[],
  rows: Iterable<readonly unknown[]>,
  opts: CsvOptions = {},
): string[] {
  const chunks: string[] = [];
  if (opts.bom) chunks.push(BOM);
  // Headers are escaped too. A column named `avg(cpu, 2)` otherwise splits the
  // header row while every data row stays intact — a misalignment that is easy
  // to miss and impossible to recover from.
  chunks.push(columns.map((c) => csvCell(c, opts)).join(','));
  for (const row of rows) {
    chunks.push(`\n${row.map((cell) => csvCell(cell, opts)).join(',')}`);
  }
  return chunks;
}

/** The whole document as one string. Prefer `toCsvChunks` for large results. */
export function toCsv(
  columns: readonly string[],
  rows: Iterable<readonly unknown[]>,
  opts: CsvOptions = {},
): string {
  return toCsvChunks(columns, rows, opts).join('');
}

/**
 * Adapter for callers holding records rather than positional rows.
 *
 * `columns` selects and orders the fields. When it is empty the keys of the
 * FIRST record are used — which is what the logs export does today, and is
 * deliberately preserved: log records are heterogeneous, and widening this to a
 * union of all keys would change every existing export.
 */
export function rowsFromObjects(
  records: readonly Record<string, unknown>[],
  columns: readonly string[],
): { columns: string[]; rows: unknown[][] } {
  const cols = columns.length > 0 ? [...columns] : Object.keys(records[0] ?? {});
  return { columns: cols, rows: records.map((r) => cols.map((c) => r[c])) };
}
