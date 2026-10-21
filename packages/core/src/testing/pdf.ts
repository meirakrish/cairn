/**
 * A page of text runs placed by hand, each drawn left to right from (x, y) in 12pt with every
 * character 7.2pt wide. Hebrew letters work (in visual order, as older PDF tools write them):
 * they use a font that names its glyphs, which is how pdf.js knows them.
 */
export interface RunsPage {
  runs: { x: number; y: number; text: string }[];
}

/** A page that is only a JPEG image, scaled to fill the page, like a scanned page. */
export interface ImagePage {
  jpeg: Uint8Array;
  width: number;
  height: number;
}

/**
 * A minimal valid PDF, one entry per page. A string is text (Helvetica, ASCII only; newlines start
 * new lines; an empty string makes a blank page); a RunsPage is text placed run by run; an ImagePage
 * is a page with only an image, like a scanned page with no text layer.
 */
export function makePdf(pages: (string | RunsPage | ImagePage)[]): Uint8Array {
  // Objects are byte arrays: image streams are binary, so the file can't be built as a string.
  const objects: Uint8Array[] = [];
  const latin1 = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
  const add = (body: string | Uint8Array) =>
    objects.push(typeof body === 'string' ? latin1(body) : body) && objects.length;
  const stream = (dict: string, data: Uint8Array) =>
    concat([latin1(`<< ${dict} /Length ${data.length} >>\nstream\n`), data, latin1('\nendstream')]);

  const catalog = add(''); // filled in once the page tree exists
  const tree = add('');
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  // Codes 0xC0–0xDA are א–ת (glyphs afii57664–afii57690); every glyph is 600/1000 em wide.
  const hebrewGlyphs = Array.from({ length: 27 }, (_, i) => `/afii${57664 + i}`).join(' ');
  const hebrewFont = add(
    `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /FirstChar 32 /LastChar 218 ` +
      `/Widths [${Array.from({ length: 187 }, () => 600).join(' ')}] ` +
      `/Encoding << /Type /Encoding /Differences [192 ${hebrewGlyphs}] >> >>`,
  );
  const kids = pages.map((page) => {
    let resources: string;
    let ops: string;
    if (typeof page === 'string') {
      const lines = page
        .split('\n')
        .map((line) => `(${line.replace(/[\\()]/g, (c) => `\\${c}`)}) Tj`)
        .join(' T* ');
      ops = page ? `BT /F1 11 Tf 14 TL 72 740 Td ${lines} ET` : '';
      resources = `/Font << /F1 ${font} 0 R >>`;
    } else if ('runs' in page) {
      const encode = (text: string) =>
        [...text]
          .map((c) =>
            c >= 'א' && c <= 'ת' ? String.fromCharCode(0xc0 + c.charCodeAt(0) - 0x5d0) : c,
          )
          .join('')
          .replace(/[\\()]/g, (c) => `\\${c}`);
      ops = page.runs
        .map((r) => `BT /F1 12 Tf ${r.x} ${r.y} Td (${encode(r.text)}) Tj ET`)
        .join(' ');
      resources = `/Font << /F1 ${hebrewFont} 0 R >>`;
    } else {
      const image = add(
        stream(
          `/Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} ` +
            '/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode',
          page.jpeg,
        ),
      );
      ops = 'q 612 0 0 792 0 0 cm /Im1 Do Q';
      resources = `/XObject << /Im1 ${image} 0 R >>`;
    }
    const content = add(stream('', latin1(ops)));
    return add(
      `<< /Type /Page /Parent ${tree} 0 R /MediaBox [0 0 612 792] /Contents ${content} 0 R ` +
        `/Resources << ${resources} >> >>`,
    );
  });
  objects[catalog - 1] = latin1(`<< /Type /Catalog /Pages ${tree} 0 R >>`);
  objects[tree - 1] = latin1(
    `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`,
  );

  const parts: Uint8Array[] = [latin1('%PDF-1.4\n')];
  let length = parts[0]!.length;
  const offsets = objects.map((body, i) => {
    const offset = length;
    const chunk = concat([latin1(`${i + 1} 0 obj\n`), body, latin1('\nendobj\n')]);
    parts.push(chunk);
    length += chunk.length;
    return offset;
  });
  let tail = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  tail += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  tail += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${length}\n%%EOF\n`;
  parts.push(latin1(tail));
  return concat(parts);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
