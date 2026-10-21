import type { ChunkLocation } from '../db';
import type { Segment } from './extract';

export interface TextRecord {
  text: string;
  /** Row (CSV), line (JSONL) or record index (JSON): increasing, used to locate segments. */
  row: number;
}

const asRows = ([first, last]: [number, number]): ChunkLocation => ({ rows: [first, last] });

/**
 * Packs records, one per line, into segments of at most `maxChars`, never splitting a record across
 * segments (a record longer than that is a segment of its own, which the chunker then splits).
 * `locate` turns a segment's first and last `row` into its location (default: a row range).
 */
export function packRecords(
  records: TextRecord[],
  maxChars: number,
  locate: (range: [number, number]) => ChunkLocation = asRows,
): Segment[] {
  const segments: Segment[] = [];
  let lines: string[] = [];
  let length = 0;
  let first = 0;
  let last = 0;

  const flush = () => {
    if (lines.length) segments.push({ text: lines.join('\n'), location: locate([first, last]) });
    lines = [];
    length = 0;
  };

  for (const record of records) {
    const added = (lines.length ? 1 : 0) + record.text.length;
    if (lines.length && length + added > maxChars) flush();
    if (!lines.length) first = record.row;
    lines.push(record.text);
    length += lines.length === 1 ? record.text.length : added;
    last = record.row;
  }
  flush();
  return segments;
}
