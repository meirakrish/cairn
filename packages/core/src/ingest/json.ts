import { PermanentIngestError } from './errors';
import type { Segment } from './extract';
import { packRecords, type TextRecord } from './records';

/** Deeper than this, a value is written as compact JSON instead of being flattened further. */
const MAX_DEPTH = 32;

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const isObject = (v: Json): v is { [key: string]: Json } =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

// Two or more objects: a list of records worth one record each (a table, orders, users...).
const isRecordList = (v: Json): v is Json[] =>
  Array.isArray(v) && v.length >= 2 && v.every(isObject);

/** `name`, `["first name"]`: a key as it appears in a path. */
function key(name: string, first: boolean): string {
  if (/^[A-Za-z_$][\w$]*$/.test(name)) return first ? name : `.${name}`;
  return `[${JSON.stringify(name)}]`;
}

interface JsonRecord {
  path: string;
  lines: string[];
}

/**
 * Flattens `value` (found at `path`) into `key: value` lines of the current record, keyed relative to
 * the record (`prefix`). Record lists start records of their own, so each element of `$.orders` is
 * one record however large the document; their parent keeps the other fields.
 */
function flatten(
  value: Json,
  path: string,
  prefix: string,
  lines: string[],
  out: JsonRecord[],
  depth: number,
): void {
  if (depth > MAX_DEPTH) {
    lines.push(`${prefix || '(value)'}: ${JSON.stringify(value)}`);
  } else if (isRecordList(value)) {
    value.forEach((element, i) => {
      const record: JsonRecord = { path: `${path}[${i}]`, lines: [] };
      out.push(record);
      flatten(element, record.path, '', record.lines, out, depth + 1);
    });
  } else if (isObject(value)) {
    for (const [name, child] of Object.entries(value)) {
      flatten(child, path + key(name, false), prefix + key(name, !prefix), lines, out, depth + 1);
    }
  } else if (Array.isArray(value)) {
    value.forEach((child, i) => {
      flatten(child, `${path}[${i}]`, `${prefix}[${i}]`, lines, out, depth + 1);
    });
  } else if (value !== '') {
    lines.push(`${prefix || '(value)'}: ${String(value)}`);
  }
}

/** Records of a JSON document in document order: the root's own fields first, then each record. */
export function jsonRecords(root: Json): JsonRecord[] {
  const nested: JsonRecord[] = [];
  const rootRecord: JsonRecord = { path: '$', lines: [] };
  flatten(root, '$', '', rootRecord.lines, nested, 0);
  // A record list inside a record leaves its parent with only the other fields, maybe none.
  return [rootRecord, ...nested].filter((r) => r.lines.length);
}

function parseLines(text: string): { line: number; value: Json }[] {
  const out: { line: number; value: Json }[] = [];
  text.split('\n').forEach((raw, i) => {
    if (!raw.trim()) return;
    try {
      out.push({ line: i + 1, value: JSON.parse(raw) as Json });
    } catch {
      throw new PermanentIngestError(`not valid JSON or JSON Lines (line ${i + 1})`);
    }
  });
  return out;
}

/**
 * A JSON document or JSON Lines file as segments of whole records, each at most `maxChars`.
 * JSON: one record per element of every list of objects, written `path: key: value; ...`; locations
 * are JSON paths. JSON Lines: one record per line, located by line number.
 */
export function jsonSegments(text: string, maxChars: number): Segment[] {
  let document: Json;
  try {
    document = JSON.parse(text) as Json;
  } catch {
    // Not one document: JSON Lines, or broken.
    const lines = parseLines(text);
    const records: TextRecord[] = lines.flatMap(({ line, value }) => {
      const flat = jsonRecords(value).map((r) =>
        r.path === '$' ? r.lines.join('; ') : `${r.path}: ${r.lines.join('; ')}`,
      );
      return flat.length ? [{ text: flat.join(' | '), row: line }] : [];
    });
    return packRecords(records, maxChars, ([first, last]) => ({ lines: [first, last] }));
  }

  const records = jsonRecords(document);
  return packRecords(
    records.map((r, i) => ({ text: `${r.path}: ${r.lines.join('; ')}`, row: i })),
    maxChars,
    ([first, last]) => ({
      path:
        first === last ? records[first]!.path : `${records[first]!.path} … ${records[last]!.path}`,
    }),
  );
}
