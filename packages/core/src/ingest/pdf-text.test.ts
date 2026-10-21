import { describe, expect, it } from 'vitest';
import { pageText, type PdfTextItem } from './pdf-text';

// Items as pdf.js gives them for PDFs that Chrome printed from right-to-left HTML (Arial, 14px).
const item = (str: string, x: number, width: number, height = 10.5): PdfTextItem => ({
  str,
  transform: [1, 0, 0, 1, x, 700],
  width,
  height: str.trim() ? height : 0,
  hasEOL: false,
});
const eol = (x: number): PdfTextItem => ({ ...item('', x, 0), hasEOL: true });
const space = (x: number, width = 3.9) => item(' ', x, width);
const WIDTH = 612;

describe('pageText', () => {
  it('reads Hebrew lines with numbers and English in reading order', () => {
    const items = [
      item('.17:30', 280, 29),
      space(309),
      item('בחודש, בשעה', 312, 58),
      space(370),
      item('15', 373, 12),
      item('שלום עולם. המועד האחרון להגשת הדוח הוא ה-', 385, 193),
      eol(201),
      item('בתיקייה הראשית.', 201, 72),
      space(273),
      item('pnpm dev', 276, 46),
      space(323),
      item('ואז', 325, 13),
      space(338),
      item('pnpm install', 341, 56),
      space(397),
      item('יש להריץ את הפקודה', 400, 87),
      space(487),
      item('Cairn', 490, 25),
      space(515),
      item('כדי להתקין את', 518, 60),
    ];
    expect(pageText(items, WIDTH)).toBe(
      'שלום עולם. המועד האחרון להגשת הדוח הוא ה-15 בחודש, בשעה 17:30.\n' +
        'כדי להתקין את Cairn יש להריץ את הפקודה pnpm install ואז pnpm dev בתיקייה הראשית.',
    );
  });

  it('mirrors brackets and keeps numbers apart', () => {
    const items = [
      item('.054-1234567', 326, 65),
      space(391),
      item(', והמספר', 394, 38),
      item('(', 432, 3),
      item('כולל מע"מ', 436, 42),
      item(')', 478, 3),
      space(481),
      item('ש"ח', 484, 17),
      space(502),
      item('1,250', 504, 26),
      space(531),
      item('המחיר הוא', 534, 45),
      eol(544),
      // A table row: cells with gaps and no spaces.
      item('תפוחים', 544, 30),
      item('3', 534, 6),
      item('12.50', 488, 26),
    ];
    expect(pageText(items, WIDTH)).toBe(
      'המחיר הוא 1,250 ש"ח (כולל מע"מ), והמספר 054-1234567.\nתפוחים 3 12.50',
    );
  });

  it('tells a Hebrew line full of English from an English line by its margin', () => {
    const items = [
      item('.GitHub Actions', 351, 72),
      item('ו-', 423, 6),
      space(429),
      item('Google Drive', 432, 61),
      space(493),
      item('הפריט השני:', 496, 52),
      eol(34),
      item('The word for stone pile is', 34, 117),
      space(151),
      item('גל עבנים', 154, 36),
      space(190),
      item('in Hebrew.', 193, 50),
    ];
    expect(pageText(items, WIDTH)).toBe(
      'הפריט השני: Google Drive ו-GitHub Actions.\nThe word for stone pile is גל עבנים in Hebrew.',
    );
  });

  it('puts vowel points that come apart back on their letters', () => {
    // "הַמִּשְׁפָּט." a glyph at a time, with pdf.js's zero-width filler spaces.
    const items = [
      item('ט.', 376.07, 8.72),
      item('ָ', 385.81, 0),
      item('ּפ', 384.78, 4.65),
      item('ְ', 392, 0),
      item(' ', 389.43, 0),
      item('ׁש', 389.43, 6.39),
      item('ִ', 398.39, 0),
      item('ּמ', 395.83, 6.1),
      item('ַ', 403.98, 0),
      item('ה', 401.93, 5.81),
    ];
    expect(pageText(items, WIDTH).normalize('NFC')).toBe('הַמִּשְׁפָּט.'.normalize('NFC'));
  });

  it('leaves left-to-right lines as pdf.js gives them', () => {
    const items = [item('Plain (English) line', 34, 100), item(' and 3.14.', 134, 40)];
    expect(pageText(items, WIDTH)).toBe('Plain (English) line and 3.14.');
  });
});
