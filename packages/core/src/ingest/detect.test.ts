import { describe, expect, it } from 'vitest';
import { detectFetchedKind, fetchedName } from './detect';

const utf8 = (s: string) => new TextEncoder().encode(s);

describe('detectFetchedKind', () => {
  it('treats HTML as a web page and keeps the Content-Type for its charset', () => {
    expect(
      detectFetchedKind('text/html; charset=ISO-8859-1', 'https://a.com/', utf8('<p>')),
    ).toEqual({ kind: 'web', mime: 'text/html; charset=ISO-8859-1' });
    expect(detectFetchedKind('application/xhtml+xml', 'https://a.com/', utf8('<p>'))?.kind).toBe(
      'web',
    );
  });

  it('uses the Content-Type, then the URL file name, as the extension', () => {
    const text = utf8('a,b\n1,2');
    expect(detectFetchedKind('text/csv', 'https://a.com/export', text)?.kind).toBe('csv');
    expect(detectFetchedKind('application/ld+json', 'https://a.com/x', text)?.kind).toBe('json');
    expect(detectFetchedKind('text/plain', 'https://a.com/notes.md', text)?.kind).toBe('markdown');
    expect(detectFetchedKind('', 'https://a.com/notes', text)?.kind).toBe('text');
  });

  it('trusts PDF and image signatures over the Content-Type, and refuses other binaries', () => {
    expect(detectFetchedKind('text/html', 'https://a.com/', utf8('%PDF-1.7'))?.kind).toBe('web');
    expect(
      detectFetchedKind('application/octet-stream', 'https://a.com/x', utf8('%PDF-1.7')),
    ).toEqual({ kind: 'pdf', mime: 'application/pdf' });
    expect(detectFetchedKind('audio/mpeg', 'https://a.com/a.mp3', new Uint8Array([0, 1]))).toBe(
      undefined,
    );
  });
});

describe('fetchedName', () => {
  it('prefers the title, keeping slashes, else host and path', () => {
    expect(fetchedName('https://a.com/x', 'A/B testing\u0007 guide')).toBe('A/B testing guide');
    expect(fetchedName('https://a.com/docs/intro?x=1')).toBe('a.com/docs/intro');
    expect(fetchedName('https://a.com/', '  ')).toBe('a.com');
  });
});
