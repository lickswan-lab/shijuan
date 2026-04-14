const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  HeadingLevel, AlignmentType, BorderStyle, WidthType, ShadingType, LevelFormat
} = require('docx');
const fs = require('fs');

const md = fs.readFileSync('C:/Users/18475/OneDrive/Desktop/拾卷-使用指南.md', 'utf-8');
const accent = 'C8956C', txt = '3D3529', muted = '6B5E4F', bdr = 'E8E0D0', bg = 'FBF4E8';
const b = { style: BorderStyle.SINGLE, size: 1, color: bdr };
const bs = { top: b, bottom: b, left: b, right: b };

function parseInline(text) {
  const runs = [];
  const re = /\*\*(.+?)\*\*|`(.+?)`/g;
  let last = 0, m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) runs.push(new TextRun(text.slice(last, m.index)));
    if (m[1]) runs.push(new TextRun({ text: m[1], bold: true }));
    if (m[2]) runs.push(new TextRun({ text: m[2], font: 'Consolas', size: 20, color: accent }));
    last = re.lastIndex;
  }
  if (last < text.length) runs.push(new TextRun(text.slice(last)));
  return runs;
}

const content = [];
const lines = md.split('\n');
let i = 0, olRef = 0, tableRows = null, inTable = false;

const olConfigs = [];
for (let n = 0; n < 10; n++) {
  olConfigs.push({
    reference: 'ol' + n,
    levels: [{ level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.LEFT,
      style: { paragraph: { indent: { left: 720, hanging: 360 } } } }]
  });
}

function flushTable() {
  if (!tableRows || tableRows.length === 0) return;
  const colCount = tableRows[0].length;
  const colW = Math.floor(9026 / colCount);
  content.push(new Table({
    width: { size: 9026, type: WidthType.DXA },
    columnWidths: Array(colCount).fill(colW),
    rows: tableRows.map((row, ri) => new TableRow({
      children: row.map(cell => new TableCell({
        borders: bs,
        width: { size: colW, type: WidthType.DXA },
        shading: ri === 0 ? { fill: bg, type: ShadingType.CLEAR } : undefined,
        margins: { top: 60, bottom: 60, left: 120, right: 120 },
        children: [new Paragraph({ children: [new TextRun({ text: cell, bold: ri === 0, size: 20 })] })]
      }))
    }))
  }));
  tableRows = null;
  inTable = false;
}

while (i < lines.length) {
  const line = lines[i];

  if (inTable && !line.startsWith('|')) { flushTable(); continue; }

  if (line.startsWith('# ')) {
    content.push(new Paragraph({ heading: HeadingLevel.HEADING_1, alignment: AlignmentType.CENTER,
      spacing: { after: 400 },
      children: [new TextRun({ text: line.slice(2), bold: true, size: 44, color: accent })]
    }));
    i++; continue;
  }
  if (line.startsWith('## ')) {
    content.push(new Paragraph({ heading: HeadingLevel.HEADING_2, children: parseInline(line.slice(3)) }));
    i++; continue;
  }
  if (line.startsWith('### ')) {
    content.push(new Paragraph({ heading: HeadingLevel.HEADING_3, children: parseInline(line.slice(4)) }));
    i++; continue;
  }
  if (line.startsWith('---')) { i++; continue; }
  if (line.startsWith('> ')) {
    content.push(new Paragraph({
      spacing: { before: 120 }, indent: { left: 360 },
      border: { left: { style: BorderStyle.SINGLE, size: 6, color: accent } },
      children: [new TextRun({ text: line.slice(2), italics: true, color: muted, size: 20 })]
    }));
    i++; continue;
  }
  if (line.startsWith('| ') && !inTable) {
    tableRows = [];
    inTable = true;
    tableRows.push(line.split('|').filter(c => c.trim()).map(c => c.trim()));
    i++;
    if (i < lines.length && lines[i].includes('---')) i++;
    continue;
  }
  if (inTable && line.startsWith('| ')) {
    tableRows.push(line.split('|').filter(c => c.trim()).map(c => c.trim()));
    i++; continue;
  }

  const olMatch = line.match(/^(\d+)\. (.+)/);
  if (olMatch) {
    content.push(new Paragraph({
      numbering: { reference: 'ol' + Math.min(olRef, 9), level: 0 },
      children: parseInline(olMatch[2])
    }));
    i++; continue;
  }
  if (line.startsWith('- ')) {
    content.push(new Paragraph({
      numbering: { reference: 'ul', level: 0 },
      children: parseInline(line.slice(2))
    }));
    i++; continue;
  }
  if (line.trim() === '') {
    if (i > 0 && lines[i-1] && !lines[i-1].match(/^\d+\. /) && !lines[i-1].startsWith('- ')) {
      olRef = Math.min(olRef + 1, 9);
    }
    i++; continue;
  }

  content.push(new Paragraph({ spacing: { after: 80 }, children: parseInline(line) }));
  i++;
}
flushTable();

const doc = new Document({
  styles: {
    default: { document: { run: { font: 'Microsoft YaHei', size: 22, color: txt } } },
    paragraphStyles: [
      { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true,
        run: { size: 36, bold: true, font: 'Microsoft YaHei', color: accent },
        paragraph: { spacing: { before: 360, after: 240 }, outlineLevel: 0 } },
      { id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true,
        run: { size: 30, bold: true, font: 'Microsoft YaHei', color: txt },
        paragraph: { spacing: { before: 300, after: 180 }, outlineLevel: 1 } },
      { id: 'Heading3', name: 'Heading 3', basedOn: 'Normal', next: 'Normal', quickFormat: true,
        run: { size: 26, bold: true, font: 'Microsoft YaHei', color: muted },
        paragraph: { spacing: { before: 240, after: 120 }, outlineLevel: 2 } },
    ]
  },
  numbering: {
    config: [
      ...olConfigs,
      { reference: 'ul', levels: [{ level: 0, format: LevelFormat.BULLET, text: '\u2022',
        alignment: AlignmentType.LEFT,
        style: { paragraph: { indent: { left: 720, hanging: 360 } } } }] },
    ]
  },
  sections: [{
    properties: {
      page: {
        size: { width: 11906, height: 16838 },
        margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 }
      }
    },
    children: content
  }]
});

Packer.toBuffer(doc).then(buf => {
  fs.writeFileSync('C:/Users/18475/OneDrive/Desktop/拾卷-使用指南.docx', buf);
  console.log('DOCX created:', buf.length, 'bytes');
});
