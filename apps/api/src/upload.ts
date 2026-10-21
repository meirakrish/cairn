import busboy from 'busboy';
import type { Request } from 'express';
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

// Shared with the worker, which detects the kind of fetched URLs the same way.
export { cleanFilename, detectKind } from '@cairn/core';
