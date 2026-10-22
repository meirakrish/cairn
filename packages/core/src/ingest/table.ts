import type { SourceKind, TableColumn } from '../db';
import { columnNames, parseCsv, sniffDelimiter } from './csv';
import { decodeText } from './extract';
import type { Json } from './json';

export interface TableRow {
  /** The number the chunks locate it by: spreadsheet row (header = 1), JSONL line, JSON array index. */
  row: number;
  /** Column name → value, typed per column; empty cells are left out. */
  data: Record<string, string | number>;
}

export interface ParsedTable {
  columns: TableColumn[];
  rows: TableRow[];
}

/** A bigger table keeps its chunks only: table queries run over rows, so they need all of them. */
export const TABLE_LIMITS = { maxRows: 200_000, maxColumns: 200 };

// Plain numbers only: a leading zero (007, a zip code), a thousands separator or a decimal comma
// could mean something else, so such a column stays text.
const NUMBER = /^-?(0|[1-9]\d*)(\.\d+)?$/;
const DATE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

const isNumber = (v: string) =>
  NUMBER.test(v) &&
  (v.includes('.') ? Number.isFinite(Number(v)) : Number.isSafeInteger(Number(v)));

function isDate(v: string): boolean {
  const m = DATE.exec(v);
  if (!m) return false;
  // 2024-02-30 parses in some engines as March 1st: require the day to round-trip.
  const day = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
  return !Number.isNaN(day.getTime()) && day.toISOString().startsWith(`${m[1]}-${m[2]}-${m[3]}`);
}

/**
 * Builds a table from `cells` (one array per row, by column; empty or missing cells are absent).
 * A column is a number or date column when all of its values are, else text. Undefined for no rows
 * or more than TABLE_LIMITS.
 */
function buildTable(
  names: string[],
  records: { row: number; cells: (string | undefined)[] }[],
): ParsedTable | undefined {
  if (!records.length || records.length > TABLE_LIMITS.maxRows) return undefined;
  if (names.length > TABLE_LIMITS.maxColumns) return undefined;

  const columns: TableColumn[] = names.map((name, j) => {
    const values = records.flatMap((r) => (r.cells[j] ? [r.cells[j]!] : []));
    const type =
      values.length && values.every(isNumber)
        ? 'number'
        : values.length && values.every(isDate)
          ? 'date'
          : 'text';
    return { name, type };
  });

  const rows = records.map(({ row, cells }) => {
    const data: TableRow['data'] = {};
    columns.forEach((column, j) => {
      const cell = cells[j];
      if (cell) data[column.name] = column.type === 'number' ? Number(cell) : cell;
    });
    return { row, data };
  });
  return { columns, rows };
}

/** A CSV as a table; its header names the columns (see csvSegments for the naming and row numbers). */
export function csvTable(text: string): ParsedTable | undefined {
  const [header, ...data] = parseCsv(text, sniffDelimiter(text));
  if (!header) return undefined;
  const width = Math.max(header.length, ...data.map((fields) => fields.length));
  const names = columnNames(header);
  for (let j = names.length; j < width; j++) names.push(`column ${j + 1}`);

  const records = data.flatMap((fields, i) => {
    const cells = fields.map((v) => v.trim() || undefined);
    return cells.some(Boolean) ? [{ row: i + 2, cells }] : [];
  });
  return buildTable(names, records);
}

const isFlatRecord = (v: Json): v is Record<string, null | boolean | number | string> =>
  typeof v === 'object' &&
  v !== null &&
  !Array.isArray(v) &&
  Object.values(v).every((x) => x === null || typeof x !== 'object');

/**
 * A JSON array of flat objects, or JSON Lines of them, as a table; the columns are the keys in order
 * of first appearance. Undefined for anything else (nested values, a wrapper object, one record):
 * those are left to their chunks.
 */
export function jsonTable(text: string): ParsedTable | undefined {
  let records: { row: number; value: Json }[];
  try {
    const document = JSON.parse(text) as Json;
    if (!Array.isArray(document)) return undefined;
    records = document.map((value, row) => ({ row, value }));
  } catch {
    try {
      records = text
        .split('\n')
        .flatMap((raw, i) => (raw.trim() ? [{ row: i + 1, value: JSON.parse(raw) as Json }] : []));
    } catch {
      return undefined;
    }
  }
  if (records.length < 2 || !records.every((r) => isFlatRecord(r.value))) return undefined;

  const keys = [...new Set(records.flatMap((r) => Object.keys(r.value as object)))];
  const names = keys.map((k, j) => k.trim() || `column ${j + 1}`);
  const cell = (v: Json | undefined) =>
    v === null || v === undefined ? undefined : String(v).trim() || undefined;
  return buildTable(
    names,
    records.map(({ row, value }) => ({
      row,
      cells: keys.map((k) => cell((value as Record<string, Json>)[k])),
    })),
  );
}

/** The table in a CSV or JSON file, if it holds one. */
export function readTable(kind: SourceKind, data: Uint8Array): ParsedTable | undefined {
  if (kind === 'csv') return csvTable(decodeText(data));
  if (kind === 'json') return jsonTable(decodeText(data));
  return undefined;
}
