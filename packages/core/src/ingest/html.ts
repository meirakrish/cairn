import { Readability } from '@mozilla/readability';
import { JSDOM, VirtualConsole } from 'jsdom';
import TurndownService from 'turndown';
import { PermanentIngestError } from './errors';
import { markdownSections, type Segment } from './extract';

export interface HtmlPage {
  /** The article or page title; empty if the page has none. */
  title: string;
  /** Markdown sections of the main text, located by heading path. */
  segments: Segment[];
}

const MAX_TITLE = 200;
/** Main content or a Readability pick shorter than this (visible characters) falls through. */
const MIN_ARTICLE_CHARS = 200;
// Page furniture dropped from marked main content and from the whole body.
const CHROME =
  'nav, header, footer, aside, form, [role=navigation], [role=complementary], [role=search], [hidden], [aria-hidden=true]';

/**
 * Reads the main text of a web page as Markdown sections located by heading path. The text is the
 * part the page marks as main (its only `<article>`, else `<main>`) without menus and the like; on
 * pages that mark none, Readability picks the article; failing both, the whole body. jsdom parses
 * like a browser but runs no scripts and loads nothing, so pages that only render with JavaScript
 * come out empty.
 *
 * Marked main content goes first because Readability, which keeps its best block and close
 * siblings, dropped Wikipedia's section headings (filing "Today" and "Concerns" under the last
 * subsection) and kept one story of index pages; `<main>` kept every heading, for 5–20% more text.
 * A lone `<article>` beats `<main>`: it is the post or README without comments, file lists etc.
 */
export function readHtml(data: Uint8Array, contentType = ''): HtmlPage {
  // A silent console: jsdom reports CSS it can't parse, which is the page's problem, not ours.
  const dom = new JSDOM(decodeHtml(data, contentType), { virtualConsole: new VirtualConsole() });
  try {
    const { document } = dom.window;
    const segments = markdownSections(mainText(document).trim()).filter(
      (s) => s.text.trim() !== '',
    );
    if (segments.length === 0) {
      throw new PermanentIngestError('no readable text on the page (it may need JavaScript)');
    }
    const ogTitle = document.querySelector('meta[property="og:title"]')?.getAttribute('content');
    return { title: cleanTitle(document.title || ogTitle), segments };
  } finally {
    dom.window.close();
  }
}

function mainText(document: Document): string {
  const articles = document.querySelectorAll('article');
  const marked = [
    articles.length === 1 ? articles[0] : null,
    document.querySelector('main, [role=main]'),
  ];
  // Readability and withoutChrome change the document, so work on copies.
  const body = document.body?.cloneNode(true) as Element | undefined;
  for (const el of marked) {
    if (!el) continue;
    const text = withoutChrome(el.cloneNode(true) as Element);
    if (visibleChars(text) >= MIN_ARTICLE_CHARS) return text;
  }
  try {
    const content = new Readability(document).parse()?.content;
    const text = content ? toMarkdown(content) : '';
    if (visibleChars(text) >= MIN_ARTICLE_CHARS) return text;
  } catch {
    // Some malformed pages trip Readability; the whole body is the fallback.
  }
  return body ? withoutChrome(body) : '';
}

function withoutChrome(el: Element): string {
  for (const chrome of el.querySelectorAll(CHROME)) chrome.remove();
  return toMarkdown(el.innerHTML);
}

const visibleChars = (text: string) => text.replace(/\s/g, '').length;

function cleanTitle(title: string | null | undefined): string {
  return (title ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE);
}

/** Decodes with the charset from the header, else from a `<meta>` near the top, else UTF-8. */
export function decodeHtml(data: Uint8Array, contentType = ''): string {
  const head = new TextDecoder('latin1').decode(data.subarray(0, 1024));
  const label =
    /charset\s*=\s*["']?([\w.:-]+)/i.exec(contentType)?.[1] ??
    /<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i.exec(head)?.[1] ??
    'utf-8';
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(label);
  } catch {
    decoder = new TextDecoder('utf-8');
  }
  return decoder.decode(data).replace(/\r\n?/g, '\n');
}

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
});
// The Markdown is only read by the chunker and the model: backslash escapes would be noise.
turndown.escape = (text) => text;
const DROPPED = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'IFRAME', 'CANVAS', 'BUTTON']);
// A function filter: Turndown's tag-name list is typed for HTML elements only, and svg isn't one.
turndown.remove((node) => DROPPED.has(node.nodeName) || node.nodeName.toLowerCase() === 'svg');
// Link targets and images add noise to chunks and embeddings; keep the link text only, and drop
// permalink anchors (¶, #, §) next to headings.
turndown.addRule('linkText', {
  filter: 'a',
  replacement: (content) => (/^\s*[¶#§🔗]\s*$/u.test(content) ? '' : content),
});
// Code in a bare <pre> (Turndown only fences <pre><code>): fenced, so a `# comment` line in it is
// not taken for a heading.
turndown.addRule('preformatted', {
  filter: (node) => node.nodeName === 'PRE' && node.firstElementChild?.nodeName !== 'CODE',
  replacement: (_, node) => {
    const code = (node.textContent ?? '').replace(/\n$/, '');
    const fence = '`'.repeat(Math.max(3, ...(code.match(/`+/g) ?? []).map((m) => m.length + 1)));
    return `\n\n${fence}\n${code}\n${fence}\n\n`;
  },
});
turndown.addRule('noImages', {
  filter: ['img', 'picture', 'video', 'audio'],
  replacement: () => '',
});
// Tables as `a | b` rows, like transcribed scans.
turndown.addRule('tableCell', {
  filter: ['th', 'td'],
  replacement: (content) => content.replace(/\s+/g, ' ').trim() + ' | ',
});
turndown.addRule('tableRow', {
  filter: 'tr',
  replacement: (content) => '\n' + content.replace(/ \| $/, '').trim() + '\n',
});
turndown.addRule('table', {
  filter: 'table',
  replacement: (content) => '\n\n' + content.replace(/\n{2,}/g, '\n').trim() + '\n\n',
});

function toMarkdown(html: string): string {
  return turndown.turndown(html);
}
