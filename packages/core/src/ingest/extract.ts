import { extractText, getDocumentProxy } from 'unpdf';
import type { ChunkLocation, SourceKind } from '../db';
import { DEFAULT_CHUNKING } from './chunk';
import { csvSegments } from './csv';
import { PermanentIngestError } from './errors';
import { jsonSegments } from './json';

/** A run of text with one location: a whole text file, a Markdown section, a PDF page, CSV rows or JSON records. */
export interface Segment {
  text: string;
  location: ChunkLocation;
}

export const EXTRACT_LIMITS = {
  /** Total extracted characters (~800 chunks). Beyond this a file is better split by the user. */
  maxChars: 2_000_000,
  maxPdfPages: 2_000,
  pdfTimeoutMs: 60_000,
};

/** `maxChars`: the chunk size, so record formats (CSV, JSON) can group whole records into chunks. */
export async function extract(
  kind: SourceKind,
  data: Uint8Array,
  maxChars = DEFAULT_CHUNKING.maxChars,
): Promise<Segment[]> {
  // Images need a model; IngestService reads them (describeImage).
  if (kind === 'image') throw new Error('extract() does not read images');
  const segments =
    kind === 'pdf'
      ? await extractPdf(data)
      : kind === 'markdown'
        ? markdownSections(decodeText(data))
        : kind === 'csv'
          ? csvSegments(decodeText(data), maxChars)
          : kind === 'json'
            ? jsonSegments(decodeText(data), maxChars)
            : [{ text: decodeText(data), location: { offset: 0 } }];

  const total = segments.reduce((n, s) => n + s.text.length, 0);
  if (total > EXTRACT_LIMITS.maxChars) {
    throw new PermanentIngestError(
      `the file has too much text (${Math.round(total / 1e6)}M characters, limit ${EXTRACT_LIMITS.maxChars / 1e6}M); split it into smaller files`,
    );
  }
  return segments.filter((s) => s.text.trim() !== '');
}

function decodeText(data: Uint8Array): string {
  // The api only accepts valid UTF-8; drop a BOM and normalise line endings.
  return new TextDecoder('utf-8').decode(data).replace(/\r\n?/g, '\n');
}

const HEADING = /^ {0,3}(#{1,6})[ \t]+(.+?)[ \t#]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** Splits Markdown at ATX headings (outside code fences); each section keeps its heading path. */
export function markdownSections(text: string): Segment[] {
  const sections: Segment[] = [];
  const path: string[] = [];
  let lines: string[] = [];
  let fence: string | undefined;

  const flush = () => {
    if (lines.length) sections.push({ text: lines.join('\n'), location: { headings: [...path] } });
    lines = [];
  };

  for (const line of text.split('\n')) {
    const fenceMatch = FENCE.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1]!;
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
    }
    const heading = fence ? null : HEADING.exec(line);
    if (heading) {
      flush();
      const level = heading[1]!.length;
      path.length = Math.min(path.length, level - 1);
      path[level - 1] = heading[2]!;
      // Fill skipped levels (e.g. # then ###) so the path has no holes.
      for (let i = 0; i < path.length; i++) path[i] ??= '';
    }
    lines.push(line);
  }
  flush();
  return sections.map((s) => ({
    ...s,
    location: { headings: s.location.headings!.filter((h) => h !== '') },
  }));
}

async function extractPdf(data: Uint8Array): Promise<Segment[]> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new PermanentIngestError('the PDF took too long to read')),
      EXTRACT_LIMITS.pdfTimeoutMs,
    );
  });
  try {
    return await Promise.race([readPdf(data), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function readPdf(data: Uint8Array): Promise<Segment[]> {
  let pdf;
  try {
    // Uploaded PDFs are untrusted: no font loading, no system fonts (pdf.js 5 no longer uses eval).
    // verbosity 0 = errors only; font warnings concern rendering, which text extraction doesn't do.
    pdf = await getDocumentProxy(new Uint8Array(data), {
      disableFontFace: true,
      useSystemFonts: false,
      verbosity: 0,
    });
  } catch {
    throw new PermanentIngestError('the PDF could not be read (damaged or password-protected)');
  }
  try {
    if (pdf.numPages > EXTRACT_LIMITS.maxPdfPages) {
      throw new PermanentIngestError(
        `the PDF has ${pdf.numPages} pages; the limit is ${EXTRACT_LIMITS.maxPdfPages}`,
      );
    }
    const { text } = await extractText(pdf, { mergePages: false });
    const pages = text.map((page, i) => ({ text: page, location: { page: i + 1 } }));
    if (pages.every((p) => p.text.trim() === '')) {
      throw new PermanentIngestError(
        'no text found in the PDF; scanned PDFs need OCR, which is not supported yet',
      );
    }
    return pages;
  } finally {
    await pdf.loadingTask.destroy();
  }
}
