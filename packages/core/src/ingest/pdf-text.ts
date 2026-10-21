/** What pdf.js's getTextContent gives per piece of text (a TextItem), as far as we use it. */
export interface PdfTextItem {
  str: string;
  /** [a, b, c, d, x, y]: x and y are where the text starts. */
  transform: number[];
  width: number;
  /** About the font size (0 for the spaces pdf.js adds). */
  height: number;
  /** The last piece of a line. */
  hasEOL: boolean;
}

const RTL_LETTER = /[\p{Script=Hebrew}\p{Script=Arabic}\p{Script=Syriac}\p{Script=Thaana}]/u;
const RTL_LETTERS = new RegExp(RTL_LETTER.source, 'gu');
const LETTERS = /\p{L}/gu;
const MARKS_ONLY = /^\p{M}+$/u;
const MIRRORED: Record<string, string> = {
  '(': ')',
  ')': '(',
  '[': ']',
  ']': '[',
  '{': '}',
  '}': '{',
  '<': '>',
  '>': '<',
};
/**
 * A gap wider than this share of the font size, with no space in it, is read as a space (table
 * cells, list numbers). Pointed text comes a letter at a time, with gaps up to ~0.2 inside words.
 */
const SPACE_GAP = 0.3;
/** Spaces narrower than this (in points) are pdf.js filler between letters, not real spaces. */
const MIN_SPACE_WIDTH = 0.5;

/**
 * A page's text from its pdf.js text items, a line per `hasEOL`. Left-to-right lines are the items
 * joined as they come, which is what unpdf's extractText does. Right-to-left lines are put in reading
 * order by `rtlLine`.
 */
export function pageText(items: PdfTextItem[], pageWidth: number): string {
  const lines: PdfTextItem[][] = [[]];
  for (const item of items) {
    // The end of a line is an empty item placed where the next line starts.
    if (item.str) lines.at(-1)!.push(item);
    if (item.hasEOL) lines.push([]);
  }
  const rtlPage = mostlyRtl(items.map((item) => item.str).join(''));
  return lines
    .map((line, i) => {
      const text = isRtl(line, pageWidth, rtlPage)
        ? rtlLine(line)
        : line.map((item) => item.str).join('');
      return i < lines.length - 1 ? `${text}\n` : text;
    })
    .join('');
}

function mostlyRtl(text: string): boolean {
  const rtl = text.match(RTL_LETTERS)?.length ?? 0;
  return rtl > (text.match(LETTERS)?.length ?? 0) - rtl;
}

/**
 * Whether a line is right to left. A line's first letter is at its right end in Hebrew and at its
 * left end in English. When the two ends disagree (English at the left end, Hebrew at the right),
 * a line nearer the right margin is Hebrew, and one that fills the width goes with the page.
 */
function isRtl(line: PdfTextItem[], pageWidth: number, rtlPage: boolean): boolean {
  const strong = line
    .filter((item) => /\p{L}/u.test(item.str))
    .sort((a, b) => a.transform[4]! - b.transform[4]!);
  if (!strong.some((item) => RTL_LETTER.test(item.str))) return false;
  const leftRtl = RTL_LETTER.test(strong[0]!.str);
  const rightRtl = RTL_LETTER.test(strong.at(-1)!.str);
  if (leftRtl === rightRtl) return leftRtl;
  const leftMargin = Math.min(...line.map((item) => item.transform[4]!));
  const rightMargin = pageWidth - Math.max(...line.map((item) => item.transform[4]! + item.width));
  if (Math.abs(leftMargin - rightMargin) > pageWidth * 0.05) return rightMargin < leftMargin;
  return rtlPage;
}

interface Piece {
  str: string;
  x: number;
  width: number;
  size: number;
  kind: 'rtl' | 'latin' | 'number' | 'neutral';
}

const left = (p: Piece) => p.x;
const right = (p: Piece) => p.x + p.width;

function kindOf(str: string): Piece['kind'] {
  if (RTL_LETTER.test(str)) return 'rtl';
  if (/\p{L}/u.test(str)) return 'latin';
  return /\p{N}/u.test(str) ? 'number' : 'neutral';
}

/**
 * A right-to-left line in reading order. pdf.js already reverses the letters inside each item, but
 * the items come left to right on the page, so a line that mixes in English or numbers reads its
 * runs backwards ("15 בחודש" as "בחודש 15"). The items are reordered right to left, keeping each
 * English run (with the numbers after it, as in "Windows 11") left to right; punctuation at a run's
 * edge moves to its reading side, and brackets outside English runs are mirrored. Vowel points that
 * come as items of their own (as in Chrome's PDFs) go back after the letter they sit on.
 */
export function rtlLine(line: PdfTextItem[]): string {
  const pieces: Piece[] = [];
  const marks: Piece[] = [];
  for (const item of line) {
    // pdf.js puts a letter's marks before it when it reverses an item: "ּפ" for "פּ".
    const str = item.str.replace(/^(\p{M}+)(\P{M})/u, '$2$1');
    if (!str.trim() && item.width < MIN_SPACE_WIDTH) continue;
    const piece: Piece = {
      str,
      x: item.transform[4]!,
      width: item.width,
      size: item.height,
      kind: kindOf(str),
    };
    (MARKS_ONLY.test(str) ? marks : pieces).push(piece);
  }
  pieces.sort((a, b) => left(a) - left(b));

  // A mark belongs to the letter whose middle is nearest.
  for (const mark of marks) {
    let base: Piece | undefined;
    for (const p of pieces) {
      if (p.kind !== 'rtl') continue;
      const distance = Math.abs(p.x + p.width / 2 - mark.x);
      if (!base || distance < Math.abs(base.x + base.width / 2 - mark.x)) base = p;
    }
    if (base) base.str += mark.str;
  }

  // Runs in page order: an English run is its items up to the last English or number item, with
  // only punctuation, spaces or numbers between them; anything else is a run of one item.
  const runs: Piece[][] = [];
  for (let i = 0; i < pieces.length; i++) {
    let end = i;
    if (pieces[i]!.kind === 'latin') {
      for (let j = i + 1; j < pieces.length && pieces[j]!.kind !== 'rtl'; j++) {
        if (pieces[j]!.kind !== 'neutral') end = j;
      }
    }
    runs.push(pieces.slice(i, end + 1));
    i = end;
  }

  let text = '';
  let previous: Piece | undefined; // the run read before, to the right
  for (const run of runs.reverse()) {
    let str = join(run);
    if (run[0]!.kind === 'neutral') {
      str = mirror(str);
    } else if (run[0]!.kind !== 'rtl') {
      // On the page, ".GitHub" is "GitHub." read right to left.
      const [, before, middle, after] = /^(\p{P}*)(.*?)(\p{P}*)$/su.exec(str)!;
      str = mirror(after!) + middle + mirror(before!);
    }
    if (previous && spaced(text, str, left(previous) - right(run.at(-1)!), previous, run[0]!)) {
      text += ' ';
    }
    text += str;
    previous = run[0];
  }
  return text;
}

/** A run's items left to right. */
function join(run: Piece[]): string {
  let text = run[0]!.str;
  for (let i = 1; i < run.length; i++) {
    const str = run[i]!.str;
    if (spaced(text, str, left(run[i]!) - right(run[i - 1]!), run[i - 1]!, run[i]!)) text += ' ';
    text += str;
  }
  return text;
}

/** Whether the gap between two pieces needs a space that the PDF doesn't have. */
function spaced(before: string, after: string, gap: number, a: Piece, b: Piece): boolean {
  return gap > Math.max(a.size, b.size) * SPACE_GAP && !/\s$/.test(before) && !/^\s/.test(after);
}

const mirror = (s: string) => s.replace(/[()[\]{}<>]/g, (c) => MIRRORED[c]!);
