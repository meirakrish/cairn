import { getDocumentProxy, renderPageAsImage } from 'unpdf';
import type { ChunkLocation, SourceKind } from '../db';
import { DEFAULT_CHUNKING } from './chunk';
import { csvSegments } from './csv';
import { PermanentIngestError } from './errors';
import { readHtml } from './html';
import { jsonSegments } from './json';
import { pageText } from './pdf-text';

/** A run of text with one location: a whole text file, a Markdown or web page section, a PDF page, CSV rows or JSON records. */
export interface Segment {
  text: string;
  location: ChunkLocation;
}

export const EXTRACT_LIMITS = {
  /** Total extracted characters (~800 chunks). Beyond this a file is better split by the user. */
  maxChars: 2_000_000,
  maxPdfPages: 2_000,
  pdfTimeoutMs: 60_000,
  /** A PDF page with fewer visible characters than this is treated as scanned (no text layer). */
  scannedPageChars: 50,
  /** Scanned pages read by the vision model per file: each takes seconds. */
  maxScannedPages: 100,
  /** Longest side of a rendered scanned page, in pixels (prepareImage caps what the model gets). */
  renderSide: 1568,
  renderTimeoutMs: 30_000,
};

export interface ExtractOptions {
  /** The chunk size, so record formats (CSV, JSON) can group whole records into chunks. */
  maxChars?: number;
  /** Reads a rendered scanned PDF page (PNG); without it, pages with no text layer are skipped. */
  readScannedPage?: (png: Uint8Array) => Promise<string>;
  /** The Content-Type a web page was served with, for its charset. */
  contentType?: string;
}

export async function extract(
  kind: SourceKind,
  data: Uint8Array,
  opts: ExtractOptions = {},
): Promise<Segment[]> {
  const { maxChars = DEFAULT_CHUNKING.maxChars } = opts;
  // Images need a model; IngestService reads them (describeImage).
  if (kind === 'image') throw new Error('extract() does not read images');
  const segments =
    kind === 'pdf'
      ? await extractPdf(data, opts.readScannedPage)
      : kind === 'markdown'
        ? markdownSections(decodeText(data))
        : kind === 'csv'
          ? csvSegments(decodeText(data), maxChars)
          : kind === 'json'
            ? jsonSegments(decodeText(data), maxChars)
            : kind === 'web'
              ? readHtml(data, opts.contentType).segments
              : [{ text: decodeText(data), location: { offset: 0 } }];

  const total = segments.reduce((n, s) => n + s.text.length, 0);
  if (total > EXTRACT_LIMITS.maxChars) {
    throw new PermanentIngestError(
      `the file has too much text (${Math.round(total / 1e6)}M characters, limit ${EXTRACT_LIMITS.maxChars / 1e6}M); split it into smaller files`,
    );
  }
  return segments.filter((s) => s.text.trim() !== '');
}

export function decodeText(data: Uint8Array): string {
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

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new PermanentIngestError(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const visibleChars = (text: string) => text.replace(/\s/g, '').length;

/**
 * Text per page. Pages with (almost) no text layer are scanned: with `readScannedPage` they are
 * rendered and read by it (the vision model), otherwise skipped. A PDF with no text at all fails.
 */
async function extractPdf(
  data: Uint8Array,
  readScannedPage?: (png: Uint8Array) => Promise<string>,
): Promise<Segment[]> {
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
    const text = await withTimeout(
      Promise.all(Array.from({ length: pdf.numPages }, (_, i) => readPage(pdf!, i + 1))),
      EXTRACT_LIMITS.pdfTimeoutMs,
      'the PDF took too long to read',
    );
    const pages = text.map((page, i) => ({ text: page, location: { page: i + 1 } }));

    const scanned = readScannedPage
      ? pages.filter((p) => visibleChars(p.text) < EXTRACT_LIMITS.scannedPageChars)
      : [];
    if (scanned.length > EXTRACT_LIMITS.maxScannedPages) {
      throw new PermanentIngestError(
        `the PDF has ${scanned.length} scanned pages (no text layer); reading more than ${EXTRACT_LIMITS.maxScannedPages} per file is not supported, so split it`,
      );
    }
    for (const page of scanned) {
      const png = await withTimeout(
        renderPage(pdf, page.location.page),
        EXTRACT_LIMITS.renderTimeoutMs,
        `page ${page.location.page} of the PDF took too long to render`,
      );
      const read = await readScannedPage!(png);
      if (visibleChars(read) > visibleChars(page.text)) page.text = read;
    }

    if (pages.every((p) => p.text.trim() === '')) {
      throw new PermanentIngestError(
        readScannedPage
          ? 'no text found in the PDF'
          : 'no text found in the PDF; scanned PDFs need a vision model, and none is configured',
      );
    }
    return pages;
  } finally {
    await pdf.loadingTask.destroy();
  }
}

type PdfDocument = Awaited<ReturnType<typeof getDocumentProxy>>;

/** A page's text layer, with right-to-left lines in reading order (see pageText). */
async function readPage(pdf: PdfDocument, pageNumber: number): Promise<string> {
  const page = await pdf.getPage(pageNumber);
  const content = await page.getTextContent();
  const { width } = page.getViewport({ scale: 1 });
  return pageText(
    content.items.filter((item) => 'str' in item),
    width,
  );
}

/** A page as PNG, its longest side EXTRACT_LIMITS.renderSide pixels. */
async function renderPage(pdf: PdfDocument, pageNumber: number): Promise<Uint8Array> {
  const page = await pdf.getPage(pageNumber);
  const { width, height } = page.getViewport({ scale: 1 });
  const scale = EXTRACT_LIMITS.renderSide / Math.max(width, height);
  const png = await renderPageAsImage(pdf, pageNumber, {
    canvasImport: () => import('@napi-rs/canvas'),
    scale,
  });
  return new Uint8Array(png);
}
