import { PermanentIngestError } from './errors';
import type { Segment } from './extract';
import { packRecords } from './records';

const DELIMITERS = [',', ';', '\t', '|'] as const;
export type Delimiter = (typeof DELIMITERS)[number];

/**
 * Parses CSV (RFC 4180): quoted fields may hold the delimiter, newlines and doubled quotes ("").
 * Returns rows of raw field values; a trailing newline adds no empty row.
 */
export function parseCsv(text: string, delimiter: Delimiter): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
      } else field += c;
      i++;
      continue;
    }
    if (c === '"' && field === '') quoted = true;
    else if (c === delimiter) {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
    i++;
  }
  if (quoted) throw new PermanentIngestError('the CSV has a quoted field that never ends');
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * The delimiter that splits the first lines into the same number of fields (more than one), most
 * often; ties go to the order of DELIMITERS. A file with one column parses the same either way.
 */
export function sniffDelimiter(text: string): Delimiter {
  const sample = text.slice(0, 64 * 1024);
  let best: { delimiter: Delimiter; score: number } = { delimiter: ',', score: 0 };
  for (const delimiter of DELIMITERS) {
    let rows: string[][];
    try {
      rows = parseCsv(sample, delimiter).slice(0, 50);
    } catch {
      continue; // the sample may cut a quoted field; others still count
    }
    // Drop the last sampled row: it may be cut off.
    if (sample.length < text.length) rows = rows.slice(0, -1);
    const width = rows[0]?.length ?? 0;
    if (width < 2) continue;
    const consistent = rows.filter((r) => r.length === width).length;
    const score = consistent * width;
    if (consistent / rows.length >= 0.8 && score > best.score) best = { delimiter, score };
  }
  return best.delimiter;
}

/** Column names from the header row: trimmed, blanks named by position, duplicates numbered. */
function columnNames(header: string[]): string[] {
  const seen = new Map<string, number>();
  return header.map((raw, i) => {
    const name = raw.trim() || `column ${i + 1}`;
    const n = (seen.get(name) ?? 0) + 1;
    seen.set(name, n);
    return n === 1 ? name : `${name} (${n})`;
  });
}

/**
 * A CSV as segments of whole rows, each at most `maxChars` (a single longer row is its own segment).
 * The first row is the header. Each data row becomes `column: value; column: value` (empty values
 * left out), so every chunk carries the column names. Locations are spreadsheet row numbers: the
 * header is row 1.
 */
export function csvSegments(text: string, maxChars: number): Segment[] {
  const rows = parseCsv(text, sniffDelimiter(text));
  const [header, ...data] = rows;
  if (!header) return [];
  const columns = columnNames(header);
  const records = data.flatMap((fields, i) => {
    const parts = fields.flatMap((value, j) => {
      const v = value.trim();
      return v ? [`${columns[j] ?? `column ${j + 1}`}: ${v}`] : [];
    });
    return parts.length ? [{ text: parts.join('; '), row: i + 2 }] : [];
  });
  return packRecords(records, maxChars);
}
