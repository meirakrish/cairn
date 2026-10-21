import { describe, expect, it } from 'vitest';
import { PermanentIngestError } from './errors';
import { extract } from './extract';
import { decodeHtml, readHtml } from './html';

const enc = (s: string) => new TextEncoder().encode(s);
const words = (n: number, word = 'cairn') => Array(n).fill(word).join(' ');

const PAGE = `<!doctype html>
<html><head><title>Saint Elmo's Climb | Trail Club</title><style>body { color: red }</style>
<script>document.write('injected')</script></head>
<body>
  <nav><a href="/">Home</a> <a href="/trails">Trails</a></nav>
  <article>
    <h1>Saint Elmo's Climb</h1>
    <p>The trail starts at the <a href="/lot">north lot</a> and climbs ${words(80, 'steadily')}.</p>
    <img src="map.png" alt="map">
    <h2>Cairns</h2>
    <p>There are 14 cairns on the way up, ${words(40, 'mostly')} near the ridge.</p>
    <table>
      <tr><th>Section</th><th>Length</th></tr>
      <tr><td>Forest</td><td>2.1 km</td></tr>
      <tr><td>Ridge</td><td>1.4 km</td></tr>
    </table>
    <h2>Getting there</h2>
    <p>Take the 7:15 bus from the station; ${words(40, 'then')} walk.</p>
  </article>
  <footer>© Trail Club · <a href="/privacy">Privacy</a></footer>
</body></html>`;

describe('readHtml', () => {
  it('keeps the article as Markdown sections with heading paths, and the title', () => {
    const page = readHtml(enc(PAGE), 'text/html; charset=utf-8');
    expect(page.title).toMatch(/Saint Elmo's Climb/);
    const text = page.segments.map((s) => s.text).join('\n');
    expect(text).toContain('starts at the north lot and climbs');
    expect(text).toContain('Section | Length\nForest | 2.1 km\nRidge | 1.4 km');
    expect(page.segments.map((s) => s.location.headings)).toEqual(
      expect.arrayContaining([
        expect.arrayContaining(['Cairns']),
        expect.arrayContaining(['Getting there']),
      ]),
    );
    expect(page.segments.find((s) => s.text.includes('7:15 bus'))!.location.headings).toContain(
      'Getting there',
    );
  });

  it('drops scripts, styles, menus, footers, link targets and images', () => {
    const text = readHtml(enc(PAGE))
      .segments.map((s) => s.text)
      .join('\n');
    for (const gone of ['injected', 'color: red', 'Privacy', '/lot', 'map.png', '](', '![']) {
      expect(text, gone).not.toContain(gone);
    }
  });

  it('does not add Markdown escapes', () => {
    const html = `<p>${words(60)}</p><p>1. Not a list * really [x] under_score</p>`;
    const text = readHtml(enc(html))
      .segments.map((s) => s.text)
      .join('\n');
    expect(text).toContain('1. Not a list * really [x] under_score');
  });

  it('keeps all of <main>, with every heading, minus its menus', () => {
    const section = (h: string) => `<div class="heading"><h2>${h}</h2></div><p>${words(40, h)}</p>`;
    const html = `<body><nav>Site menu</nav><main><header>Tools</header>
      <p>${words(40, 'intro')}</p>${['History', 'Today', 'Concerns'].map(section).join('')}
      <div role="navigation">Related pages</div></main><footer>Footer</footer></body>`;
    const page = readHtml(enc(html));
    expect(page.segments.map((s) => s.location.headings)).toEqual([
      [],
      ['History'],
      ['Today'],
      ['Concerns'],
    ]);
    const text = page.segments.map((s) => s.text).join('\n');
    for (const gone of ['Site menu', 'Tools', 'Related pages', 'Footer']) {
      expect(text).not.toContain(gone);
    }
  });

  it('prefers a lone <article> over the rest of <main>', () => {
    const html = `<main><ul><li>src/</li><li>test/</li></ul>
      <article><h2>Readme</h2><p>${words(60, 'readme')}</p></article><h2>Releases</h2></main>`;
    const text = readHtml(enc(html))
      .segments.map((s) => s.text)
      .join('\n');
    expect(text).toContain('## Readme');
    expect(text).not.toMatch(/src\/|Releases/);
  });

  it('fences bare <pre> code, so a # comment is not a heading, and drops permalink anchors', () => {
    const html = `<main><h2>Numbers<a href="#numbers">¶</a></h2><p>${words(40)}</p>
      <pre><span># this is a comment</span>\nx = 1 \`\`\` y\n</pre></main>`;
    const page = readHtml(enc(html));
    expect(page.segments).toHaveLength(1);
    expect(page.segments[0]!.location.headings).toEqual(['Numbers']);
    expect(page.segments[0]!.text).toContain('````\n# this is a comment\nx = 1 ``` y\n````');
  });

  it('uses the whole body when the page is too short for Readability', () => {
    const page = readHtml(enc('<title>Note</title><body><p>The gate code is 4512.</p></body>'));
    expect(page).toEqual({
      title: 'Note',
      segments: [{ text: 'The gate code is 4512.', location: { headings: [] } }],
    });
  });

  it('fails for a page that renders with JavaScript', () => {
    const app =
      '<html><head><title>App</title></head><body><div id="root"></div><script src="app.js"></script></body></html>';
    expect(() => readHtml(enc(app))).toThrow(PermanentIngestError);
    expect(() => readHtml(enc(app))).toThrow(/may need JavaScript/);
  });

  it('is reachable through extract as kind web', async () => {
    const segments = await extract('web', enc('<p>Hello from the web</p>'), {
      contentType: 'text/html',
    });
    expect(segments.map((s) => s.text)).toEqual(['Hello from the web']);
  });
});

describe('decodeHtml', () => {
  const latin1 = new Uint8Array([...enc('<p>caf'), 0xe9, ...enc('</p>')]);

  it('uses the charset from the Content-Type', () => {
    expect(decodeHtml(latin1, 'text/html; charset=ISO-8859-1')).toBe('<p>café</p>');
  });

  it('falls back to a meta charset, then UTF-8', () => {
    const meta = new Uint8Array([...enc('<meta charset="windows-1252">'), ...latin1]);
    expect(decodeHtml(meta)).toBe('<meta charset="windows-1252"><p>café</p>');
    expect(decodeHtml(enc('<p>café</p>'), 'text/html')).toBe('<p>café</p>');
    expect(decodeHtml(enc('<p>café</p>'), 'text/html; charset=nonsense')).toBe('<p>café</p>');
  });
});
