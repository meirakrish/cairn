import { basename } from 'node:path';
import busboy from 'busboy';
import type { Request } from 'express';
import type { SourceKind } from '@cairn/shared';
import { HttpError } from './errors';

export interface Upload {
  filename: string;
  data: Buffer;
}

/**
 * Reads the one file in multipart field "file" into memory (uploads are capped, so this is bounded).
 * Rejects oversized, missing or extra files with an HttpError.
 */
export function readUpload(req: Request, maxBytes: number): Promise<Upload> {
  const tooLarge = () =>
    new HttpError(413, `files are limited to ${Math.round(maxBytes / 1e6)} MB`);
  // Fail fast on an honest Content-Length; the stream limit below catches the rest.
  if (Number(req.headers['content-length']) > maxBytes + 64 * 1024)
    return Promise.reject(tooLarge());

  return new Promise((resolve, reject) => {
    let parser: busboy.Busboy;
    try {
      parser = busboy({
        headers: req.headers,
        // Browsers send UTF-8 filenames; busboy's default (latin1) garbles non-ASCII names.
        defParamCharset: 'utf8',
        limits: { files: 1, fileSize: maxBytes, fields: 0 },
      });
    } catch {
      return reject(new HttpError(400, 'expected a multipart/form-data upload'));
    }

    let upload: Upload | undefined;
    let error: HttpError | undefined;

    parser.on('file', (field, stream, info) => {
      if (field !== 'file') {
        stream.resume();
        return;
      }
      const parts: Buffer[] = [];
      stream.on('data', (part: Buffer) => parts.push(part));
      stream.on('limit', () => (error ??= tooLarge()));
      stream.on('end', () => {
        if (!stream.truncated)
          upload = { filename: info.filename ?? '', data: Buffer.concat(parts) };
      });
    });
    parser.on('filesLimit', () => (error ??= new HttpError(400, 'send one file per upload')));
    parser.on('error', () => reject(new HttpError(400, 'malformed upload')));
    parser.on('close', () => {
      if (error) reject(error);
      else if (!upload) reject(new HttpError(400, 'no file in field "file"'));
      else resolve(upload);
    });
    req.pipe(parser);
  });
}

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

/**
 * Decides the kind from the bytes, not the client's Content-Type: a PDF signature, or valid UTF-8 text
 * (Markdown, CSV or JSON by extension). Anything else, including binary formats renamed to .txt, is
 * unsupported.
 */
export function detectKind(
  filename: string,
  data: Buffer,
): { kind: SourceKind; mime: string } | undefined {
  // PDF readers accept the header anywhere in the first 1 KB.
  if (data.subarray(0, 1024).includes('%PDF-')) return { kind: 'pdf', mime: 'application/pdf' };
  if (data.includes(0)) return undefined;
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
