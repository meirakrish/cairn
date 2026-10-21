import { describe, expect, it } from 'vitest';
import { cleanFilename, detectKind } from './upload';

describe('detectKind', () => {
  it('detects PDF by its signature, whatever the name', () => {
    expect(detectKind('notes.txt', Buffer.from('%PDF-1.7\n%âãÏÓ\n1 0 obj'))).toEqual({
      kind: 'pdf',
      mime: 'application/pdf',
    });
  });

  it('treats UTF-8 text as Markdown or plain text by extension', () => {
    const text = Buffer.from('# Title\n\nשלום, héllo');
    expect(detectKind('README.md', text)?.kind).toBe('markdown');
    expect(detectKind('notes.MARKDOWN', text)?.kind).toBe('markdown');
    expect(detectKind('notes.txt', text)).toEqual({ kind: 'text', mime: 'text/plain' });
    expect(detectKind('no-extension', text)?.kind).toBe('text');
    expect(detectKind('data.csv', text)).toEqual({ kind: 'csv', mime: 'text/csv' });
    expect(detectKind('data.TSV', text)?.kind).toBe('csv');
  });

  it('rejects binary content, even with a text extension', () => {
    expect(
      detectKind('image.txt', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])),
    ).toBeUndefined();
    expect(detectKind('latin1.txt', Buffer.from([0x63, 0x61, 0x66, 0xe9]))).toBeUndefined();
    expect(detectKind('archive.md', Buffer.from('PK\u0003\u0004\u0000'))).toBeUndefined();
  });
});

describe('cleanFilename', () => {
  it('strips directories, control characters and surrounding space', () => {
    expect(cleanFilename('../../etc/passwd')).toBe('passwd');
    expect(cleanFilename('C:\\Users\\me\\report.pdf')).toBe('report.pdf');
    expect(cleanFilename(' a\u0000b\nc.txt ')).toBe('abc.txt');
    expect(cleanFilename('דוח שנתי.pdf')).toBe('דוח שנתי.pdf');
  });

  it('bounds the length and never returns an empty name', () => {
    expect(cleanFilename(`${'x'.repeat(300)}.txt`)).toHaveLength(200);
    expect(cleanFilename('')).toBe('upload');
    expect(cleanFilename('/')).toBe('upload');
  });
});
