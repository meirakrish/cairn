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
    await expect(extract('pdf', makePdf(['', '']))).rejects.toThrow(/scanned PDFs need OCR/);
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
