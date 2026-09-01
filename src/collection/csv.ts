/**
 * RFC 4180 CSV, with the tolerances real files need: CRLF or LF, an
 * optional BOM, a configurable delimiter, and quoted fields that may
 * contain the delimiter, quotes or newlines.
 */

export type Row = string[];

/** Parse a delimited file into rows. Blank trailing lines are dropped. */
export function parseCsv(text: string, delimiter = ','): Row[] {
  const input = text.replace(/^﻿/, '');
  const rows: Row[] = [];
  let row: Row = [];
  let value = '';
  let inQuotes = false;
  let i = 0;

  const endValue = (): void => {
    row.push(value);
    value = '';
  };
  const endRow = (): void => {
    endValue();
    rows.push(row);
    row = [];
  };

  while (i < input.length) {
    const ch = input[i]!;

    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          value += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      value += ch;
      i += 1;
      continue;
    }

    if (ch === '"' && value.length === 0) {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === delimiter) {
      endValue();
      i += 1;
      continue;
    }
    if (ch === '\r') {
      // Swallow CR so CRLF and lone CR both end the row exactly once.
      if (input[i + 1] === '\n') i += 1;
      endRow();
      i += 1;
      continue;
    }
    if (ch === '\n') {
      endRow();
      i += 1;
      continue;
    }

    value += ch;
    i += 1;
  }

  // Whatever is left is the final row, unless the file ended on a newline.
  if (value.length > 0 || row.length > 0) endRow();

  while (rows.length > 0 && isBlankRow(rows[rows.length - 1]!)) rows.pop();
  return rows;
}

function isBlankRow(row: Row): boolean {
  return row.every((cell) => cell.trim() === '');
}

/** Serialise rows, quoting only the cells that need it. */
export function toCsv(rows: readonly Row[], delimiter = ','): string {
  return rows.map((row) => row.map((cell) => quote(cell, delimiter)).join(delimiter)).join('\r\n');
}

function quote(value: string, delimiter: string): string {
  const needsQuoting =
    value.includes(delimiter) ||
    value.includes('"') ||
    value.includes('\n') ||
    value.includes('\r') ||
    value !== value.trim();
  if (!needsQuoting) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

/** Guess the delimiter from the first line: comma, semicolon or tab. */
export function sniffDelimiter(text: string): string {
  const line = text.replace(/^﻿/, '').split(/\r?\n/)[0] ?? '';
  const counts: Array<[string, number]> = [
    [',', countOutsideQuotes(line, ',')],
    [';', countOutsideQuotes(line, ';')],
    ['\t', countOutsideQuotes(line, '\t')],
  ];
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0]![1] > 0 ? counts[0]![0] : ',';
}

function countOutsideQuotes(line: string, ch: string): number {
  let count = 0;
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQuotes = !inQuotes;
    else if (c === ch && !inQuotes) count += 1;
  }
  return count;
}
