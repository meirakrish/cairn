/**
 * A minimal valid PDF, one string per page (Helvetica, ASCII only). Newlines in a page start new lines.
 * An empty string makes a page with no text, like a scanned page.
 */
export function makePdf(pages: string[]): Uint8Array {
  const objects: string[] = [];
  const add = (body: string) => objects.push(body) && objects.length;

  const catalog = add(''); // filled in once the page tree exists
  const tree = add('');
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const kids = pages.map((text) => {
    const lines = text
      .split('\n')
      .map((line) => `(${line.replace(/[\\()]/g, (c) => `\\${c}`)}) Tj`)
      .join(' T* ');
    const ops = text ? `BT /F1 11 Tf 14 TL 72 740 Td ${lines} ET` : '';
    const content = add(`<< /Length ${ops.length} >>\nstream\n${ops}\nendstream`);
    return add(
      `<< /Type /Page /Parent ${tree} 0 R /MediaBox [0 0 612 792] /Contents ${content} 0 R ` +
        `/Resources << /Font << /F1 ${font} 0 R >> >> >>`,
    );
  });
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${tree} 0 R >>`;
  objects[tree - 1] =
    `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;

  let pdf = '%PDF-1.4\n';
  const offsets = objects.map((body, i) => {
    const offset = pdf.length;
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return offset;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}
