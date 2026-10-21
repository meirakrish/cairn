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
/** Below this many visible characters, Readability's pick is ignored and the whole body is used. */
const MIN_ARTICLE_CHARS = 200;

/**
 * Reads the main text of a web page: Readability picks the article (dropping menus, footers, ads),
 * Turndown turns it into Markdown, and markdownSections splits it at headings. jsdom parses like a
 * browser but runs no scripts and loads nothing, so pages that only render with JavaScript come out
 * empty.
 */
export function readHtml(data: Uint8Array, contentType = ''): HtmlPage {
  // A silent console: jsdom reports CSS it can't parse, which is the page's problem, not ours.
  const dom = new JSDOM(decodeHtml(data, contentType), { virtualConsole: new VirtualConsole() });
  try {
    return readDocument(dom.window.document);
  } finally {
    dom.window.close();
  }
}

function readDocument(document: Document): HtmlPage {
  const pageTitle = document.title;
  // Readability changes the document, so keep a copy of the body for the fallback.
  const body = document.body?.cloneNode(true) as Element | undefined;

  let article: ReturnType<Readability<string>['parse']> = null;
  try {
    article = new Readability(document).parse();
  } catch {
    // Some malformed pages trip Readability; the whole body is the fallback.
  }

  let markdown = article?.content ? toMarkdown(article.content) : '';
  if (visibleChars(markdown) < MIN_ARTICLE_CHARS && body) {
    for (const el of body.querySelectorAll('nav, header, footer, aside, form')) el.remove();
    const whole = toMarkdown(body.innerHTML);
    if (visibleChars(whole) > visibleChars(markdown)) markdown = whole;
  }
  const segments = markdownSections(markdown.trim()).filter((s) => s.text.trim() !== '');
  if (segments.length === 0) {
    throw new PermanentIngestError('no readable text on the page (it may need JavaScript)');
  }
  return { title: cleanTitle(article?.title || pageTitle), segments };
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
// Link targets and images add noise to chunks and embeddings; keep the link text only.
turndown.addRule('linkText', { filter: 'a', replacement: (content) => content });
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
