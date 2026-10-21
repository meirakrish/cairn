import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { makePdf } from '../testing/pdf';
import { PermanentIngestError } from './errors';
import { extract, EXTRACT_LIMITS, markdownSections } from './extract';

const utf8 = (s: string) => new TextEncoder().encode(s);

describe('extract', () => {
  it('reads text files as one segment, without BOM or CRLF', async () => {
    expect(await extract('text', utf8('﻿שלום\r\nworld\r\n'))).toEqual([
      { text: 'שלום\nworld\n', location: { offset: 0 } },
    ]);
  });

  it('reads PDFs page by page and skips pages without text', async () => {
    const segments = await extract('pdf', makePdf(['Hello from page one', '', 'Page (three)']));
    expect(segments.map((s) => [s.location.page, s.text.trim()])).toEqual([
      [1, 'Hello from page one'],
      [3, 'Page (three)'],
    ]);
  });

  it('fails clearly on PDFs without text and on damaged PDFs', async () => {
    await expect(extract('pdf', makePdf(['', '']))).rejects.toThrow(
      /scanned PDFs need a vision model/,
    );
    await expect(extract('pdf', utf8('%PDF-1.4\nnot really a pdf'))).rejects.toBeInstanceOf(
      PermanentIngestError,
    );
  });

  it('rejects files with too much text', async () => {
    const big = utf8('x'.repeat(EXTRACT_LIMITS.maxChars + 1));
    await expect(extract('text', big)).rejects.toThrow(/too much text/);
  });
});

describe('markdownSections', () => {
  it('splits at headings and keeps the heading path', () => {
    const md = [
      'Intro line',
      '# Setup',
      'Install it.',
      '## Linux',
      'apt install',
      '# Usage',
      'Run it.',
    ].join('\n');
    expect(markdownSections(md)).toEqual([
      { text: 'Intro line', location: { headings: [] } },
      { text: '# Setup\nInstall it.', location: { headings: ['Setup'] } },
      { text: '## Linux\napt install', location: { headings: ['Setup', 'Linux'] } },
      { text: '# Usage\nRun it.', location: { headings: ['Usage'] } },
    ]);
  });

  it('ignores # lines inside code fences and closing #s', () => {
    const md = ['# Shell ##', '```sh', '# not a heading', '```', 'after'].join('\n');
    expect(markdownSections(md)).toEqual([{ text: md, location: { headings: ['Shell'] } }]);
  });

  it('handles skipped levels', () => {
    expect(markdownSections('# A\n### C\ntext').at(-1)?.location).toEqual({ headings: ['A', 'C'] });
  });
});

describe('extract (scanned PDFs)', () => {
  const longText = 'This page has a real text layer with more than fifty visible characters on it.';
  const jpeg = () =>
    sharp({ create: { width: 60, height: 80, channels: 3, background: '#d8d0c0' } })
      .jpeg()
      .toBuffer();

  it('renders pages without a text layer and reads them; text pages keep their text', async () => {
    const scan = { jpeg: await jpeg(), width: 60, height: 80 };
    const pdf = makePdf([longText, scan, 'p. 3', '']);
    const seen: { width?: number; height?: number }[] = [];
    const readScannedPage = async (png: Uint8Array) => {
      seen.push(await sharp(png).metadata());
      return seen.length === 3 ? '[blank page]' : `Transcribed page ${seen.length}`;
    };

    expect(await extract('pdf', pdf, { readScannedPage })).toEqual([
      { text: longText, location: { page: 1 } },
      { text: 'Transcribed page 1', location: { page: 2 } },
      { text: 'Transcribed page 2', location: { page: 3 } },
      { text: '[blank page]', location: { page: 4 } },
    ]);
    // Rendered as PNG, longest side EXTRACT_LIMITS.renderSide (792 pt page height).
    expect(seen[0]).toMatchObject({ format: 'png', height: EXTRACT_LIMITS.renderSide });
  });

  it('keeps the text layer when the reader finds less', async () => {
    const pdf = makePdf(['Page 7 of a scan']);
    expect(await extract('pdf', pdf, { readScannedPage: async () => '7' })).toEqual([
      { text: 'Page 7 of a scan', location: { page: 1 } },
    ]);
  });

  it('refuses more scanned pages than the limit, before reading any', async () => {
    let reads = 0;
    const pdf = makePdf(Array.from({ length: EXTRACT_LIMITS.maxScannedPages + 1 }, () => ''));
    await expect(
      extract('pdf', pdf, { readScannedPage: async () => `page ${++reads}` }),
    ).rejects.toThrow(/101 scanned pages/);
    expect(reads).toBe(0);
  });
});
