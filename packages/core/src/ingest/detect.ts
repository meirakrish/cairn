import { basename } from 'node:path';
import type { SourceKind } from '../db';

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

/** A display-safe file name: no directories or control characters, bounded length. */
export function cleanFilename(name: string): string {
  const base = basename(name.replaceAll('\\', '/')).replace(CONTROL_CHARS, '').trim();
  return base.slice(0, 200) || 'upload';
}

const MARKDOWN_EXTENSIONS = /\.(md|markdown)$/i;
const CSV_EXTENSIONS = /\.(csv|tsv)$/i;
const JSON_EXTENSIONS = /\.(json|jsonl|ndjson)$/i;

// Image signatures; the extension doesn't matter.
const startsWith = (data: Uint8Array, bytes: number[], at = 0) =>
  data.length >= at + bytes.length && bytes.every((b, i) => data[at + i] === b);
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

function imageMime(data: Uint8Array): string | undefined {
  if (startsWith(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(data, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(data, ascii('RIFF')) && startsWith(data, ascii('WEBP'), 8)) return 'image/webp';
  return undefined;
}

/**
 * Decides the kind from the bytes, not the client's Content-Type: a PDF or image (PNG, JPEG, WebP)
 * signature, or valid UTF-8 text (Markdown, CSV or JSON by extension). Anything else, including
 * binary formats renamed to .txt, is unsupported.
 */
export function detectKind(
  filename: string,
  data: Uint8Array,
): { kind: SourceKind; mime: string } | undefined {
  const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  // PDF readers accept the header anywhere in the first 1 KB.
  if (bytes.subarray(0, 1024).includes('%PDF-')) return { kind: 'pdf', mime: 'application/pdf' };
  const image = imageMime(data);
  if (image) return { kind: 'image', mime: image };
  if (bytes.includes(0)) return undefined;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    return undefined;
  }
  if (MARKDOWN_EXTENSIONS.test(filename)) return { kind: 'markdown', mime: 'text/markdown' };
  if (CSV_EXTENSIONS.test(filename)) return { kind: 'csv', mime: 'text/csv' };
  if (JSON_EXTENSIONS.test(filename)) return { kind: 'json', mime: 'application/json' };
  return { kind: 'text', mime: 'text/plain' };
}

const HTML_TYPES = new Set(['text/html', 'application/xhtml+xml']);
// The site's Content-Type stands in for the file extension uploads have.
const TYPE_EXTENSIONS: Record<string, string> = {
  'text/markdown': '.md',
  'text/x-markdown': '.md',
  'text/csv': '.csv',
  'text/tab-separated-values': '.tsv',
  'application/json': '.json',
  'application/x-ndjson': '.ndjson',
  'application/jsonl': '.jsonl',
};

/**
 * The kind of a fetched URL. HTML is a web page (mime = the Content-Type as sent, for its charset);
 * anything else is detected like an upload, using the Content-Type, then the URL's file name, as
 * the extension.
 */
export function detectFetchedKind(
  contentType: string,
  url: string,
  data: Uint8Array,
): { kind: SourceKind; mime: string } | undefined {
  const type = contentType.split(';')[0]!.trim().toLowerCase();
  if (HTML_TYPES.has(type)) return { kind: 'web', mime: contentType };
  const ext =
    TYPE_EXTENSIONS[type] ?? (type.endsWith('+json') ? '.json' : basename(new URL(url).pathname));
  return detectKind(ext, data);
}

/** A name for a fetched source: the page title, else the URL's host and path. */
export function fetchedName(url: string, title = ''): string {
  const { host, pathname } = new URL(url);
  // Not cleanFilename: titles and paths may contain slashes.
  const name = title.trim() || host + (pathname === '/' ? '' : pathname);
  return name.replace(CONTROL_CHARS, '').slice(0, 200);
}
