// Conversion runs in a bounded child process; never execute document macros or HTML.
console.log = (...args) => console.error(...args);
let data = Buffer.alloc(0);
for await (const chunk of process.stdin) data = Buffer.concat([data, chunk]);
const ext = process.argv[2];
let text = '';
if (ext === '.pdf') {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({
    data: new Uint8Array(data),
    isEvalSupported: false,
    useSystemFonts: false,
  });
  const doc = await task.promise;
  for (let page = 1; page <= Math.min(doc.numPages, 100) && text.length < 200000; page++) {
    const content = await (await doc.getPage(page)).getTextContent();
    text += `\nPagina ${page}\n` + content.items.map((item) => item.str || '').join(' ') + '\n';
  }
  await task.destroy();
} else if (ext === '.docx') {
  const { default: mammoth } = await import('mammoth');
  text = (await mammoth.extractRawText({ buffer: data })).value;
} else if (ext === '.xlsx') {
  const { default: ExcelJS } = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(data);
  for (const sheet of workbook.worksheets) {
    text += `\nFoglio: ${sheet.name}\n`;
    for (let row = 1; row <= Math.min(sheet.rowCount, 5000) && text.length < 200000; row++) {
      const values = [];
      for (let col = 1; col <= Math.min(sheet.columnCount, 100); col++)
        values.push(sheet.getCell(row, col).text);
      text += values.join('\t') + '\n';
    }
    if (text.length >= 200000) break;
  }
}
process.stdout.write(JSON.stringify({ text: text.slice(0, 200000) }));
