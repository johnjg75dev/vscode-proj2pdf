import PDFDocument from 'pdfkit';
import * as fs from 'fs';
import { ExportOptions, PdfSettings } from './config';
import { SourceFile } from './fileCollector';
import { DEFAULT_TEXT_COLOR, highlightToLines, plainLines } from './highlighter';
import { minifySegments } from './minify';
import { buildTreeLines } from './tree';
import {
  ExportCancelledError, Segment, expandTabs, stripControlChars, toWinAnsiSafe, yieldToEventLoop
} from './util';

/** PDFKit APIs that are missing or incomplete in @types/pdfkit. */
interface PdfKitExtras {
  addNamedDestination(name: string, ...args: unknown[]): void;
  goTo(x: number, y: number, w: number, h: number, name: string): unknown;
  outline: { addItem(title: string): unknown };
}

export interface PdfRenderRequest {
  projectName: string;
  files: SourceFile[];
  options: ExportOptions;
  settings: PdfSettings;
  onProgress?: (message: string) => void;
  isCancelled?: () => boolean;
}

export interface PdfRenderResult {
  data: Buffer;
  pageCount: number;
}

const MARGIN = { top: 50, bottom: 50, left: 40, right: 40 };
const COLOR = {
  title: '#0b2e59',
  muted: '#6e7781',
  rule: '#d0d7de',
  headerBg: '#eef2f7',
  headerText: '#0b2e59',
  gutter: '#9aa4ae',
  dots: '#b8c0c8'
};
const TOC_FONT_SIZE = 9;
const TOC_LINE_H = 13;

export async function renderPdf(req: PdfRenderRequest): Promise<PdfRenderResult> {
  const { projectName, files, options, settings } = req;

  const doc = new PDFDocument({
    size: settings.pageSize,
    margins: MARGIN,
    bufferPages: true, // required to go back and write the TOC + page numbers
    info: { Title: `${projectName} - Source Code`, Creator: 'Project Source Exporter' }
  });
  const pdf = doc as unknown as PdfKitExtras;

  const chunks: Buffer[] = [];
  const finished = new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  // ---------- Fonts ----------
  let mono = 'Courier', monoBold = 'Courier-Bold', monoItalic = 'Courier-Oblique';
  let ui = 'Helvetica', uiBold = 'Helvetica-Bold';
  let unicode = false;
  if (settings.fontPath) {
    if (!fs.existsSync(settings.fontPath)) {
      throw new Error(`Custom font not found: ${settings.fontPath}`);
    }
    doc.registerFont('CustomMono', settings.fontPath);
    doc.font('CustomMono'); // fail fast if the font can't be parsed
    mono = monoBold = monoItalic = ui = uiBold = 'CustomMono';
    unicode = true;
  }
  const clean = (s: string) => (unicode ? stripControlChars(s) : toWinAnsiSafe(s));

  // ---------- Layout ----------
  const pageW = doc.page.width;
  const pageH = doc.page.height;
  const left = MARGIN.left;
  const contentW = pageW - MARGIN.left - MARGIN.right;
  const topY = MARGIN.top;
  const bottomY = pageH - MARGIN.bottom;
  const fontSize = settings.fontSize;
  const lineH = fontSize * 1.3;

  doc.font(mono).fontSize(fontSize);
  const charW = doc.widthOfString('M');
  const charsPerLine = Math.max(20, Math.floor(contentW / charW));

  let y = topY;
  const currentPage = () => {
    const r = doc.bufferedPageRange();
    return r.start + r.count - 1;
  };
  const newPage = () => {
    doc.addPage();
    y = topY;
  };
  const ensure = (h: number) => {
    if (y + h > bottomY) newPage();
  };
  /** Truncates from the left (keeps file names visible) using the current font. */
  const fit = (text: string, maxW: number) => {
    if (doc.widthOfString(text) <= maxW) return text;
    let t = text;
    while (t.length > 1 && doc.widthOfString('...' + t) > maxW) t = t.slice(1);
    return '...' + t;
  };
  const hr = (atY: number) => {
    doc.moveTo(left, atY).lineTo(left + contentW, atY).lineWidth(0.5).strokeColor(COLOR.rule).stroke();
  };
  const heading = (title: string) => {
    doc.font(uiBold).fontSize(14).fillColor(COLOR.title).text(title, left, y, { lineBreak: false });
    y += 24;
  };

  /** Draws one visual row of monospace segments at the current y. */
  const drawRow = (row: Segment[], x0: number) => {
    let col = 0;
    for (const seg of row) {
      const text = seg.text;
      const trimmedStart = text.replace(/^ +/, '');
      const lead = text.length - trimmedStart.length;
      const body = trimmedStart.replace(/ +$/, '');
      if (body) {
        doc
          .font(seg.bold ? monoBold : seg.italic ? monoItalic : mono)
          .fontSize(fontSize)
          .fillColor(seg.color ?? DEFAULT_TEXT_COLOR)
          .text(body, x0 + (col + lead) * charW, y, { lineBreak: false });
      }
      col += text.length;
    }
  };

  // ---------- 1. Title block ----------
  const totalLines = files.reduce((n, f) => n + f.lineCount, 0);
  doc.font(uiBold).fontSize(20).fillColor(COLOR.title);
  doc.text(fit(clean(projectName), contentW), left, y, { lineBreak: false });
  y += 28;
  const flags = [
    options.syntaxHighlighting && 'syntax highlighted',
    options.minify && `minified (${options.minifyLevel})`
  ].filter(Boolean).join(', ');
  const summary =
    `${files.length} files  |  ${totalLines.toLocaleString()} lines  |  ` +
    `Generated ${new Date().toLocaleString()}${flags ? `  |  ${flags}` : ''}`;
  doc.font(ui).fontSize(9).fillColor(COLOR.muted);
  doc.text(fit(clean(summary), contentW), left, y, { lineBreak: false });
  y += 16;
  hr(y);
  y += 14;

  // ---------- 2. Table of contents (reserve space now, fill in later) ----------
  const tocSlots: { page: number; y: number }[] = [];
  if (options.tableOfContents) {
    pdf.outline.addItem('Table of Contents');
    heading('Table of Contents');
    for (let i = 0; i < files.length; i++) {
      if (y + TOC_LINE_H > bottomY) newPage();
      tocSlots.push({ page: currentPage(), y });
      y += TOC_LINE_H;
    }
  }

  // ---------- 3. Folder structure ----------
  if (options.folderStructure) {
    if (options.tableOfContents) newPage();
    else y += 6;
    pdf.outline.addItem('Folder Structure');
    heading('Folder Structure');
    const treeLines = buildTreeLines(files.map((f) => f.relPath), projectName, unicode ? 'unicode' : 'ascii');
    for (const line of treeLines) {
      ensure(lineH);
      drawRow([{ text: clean(line).slice(0, charsPerLine) }], left);
      y += lineH;
    }
  }

  // ---------- 4. Source files ----------
  const filePages: number[] = new Array(files.length).fill(0);
  if (options.tableOfContents || options.folderStructure) newPage();

  const renderHeader = (index: number, file: SourceFile) => {
    const headerH = options.minify ? fontSize + 8 : fontSize + 12;
    ensure(headerH + lineH * 2);

    filePages[index] = currentPage();
    pdf.addNamedDestination(`file-${index}`, 'XYZ', null, y, null);
    pdf.outline.addItem(clean(file.relPath));

    doc.rect(left, y, contentW, headerH).fill(COLOR.headerBg);

    const info = `${file.lineCount.toLocaleString()} lines`;
    doc.font(ui).fontSize(fontSize).fillColor(COLOR.muted);
    const infoW = doc.widthOfString(info);
    doc.text(info, left + contentW - infoW - 6, y + (headerH - fontSize) / 2, { lineBreak: false });

    doc.font(uiBold).fontSize(fontSize + 1).fillColor(COLOR.headerText);
    const label = fit(clean(file.relPath), contentW - infoW - 24);
    doc.text(label, left + 6, y + (headerH - fontSize - 1) / 2, { lineBreak: false });

    y += headerH + 4;
  };

  const renderBody = (file: SourceFile) => {
    if (!file.content) {
      ensure(lineH);
      doc.font(monoItalic).fontSize(fontSize).fillColor(COLOR.muted)
        .text('(empty file)', left, y, { lineBreak: false });
      y += lineH;
      return;
    }

    const text = clean(expandTabs(file.content, settings.tabSize));
    const lines = options.syntaxHighlighting ? highlightToLines(text, file.ext) : plainLines(text);

    if (options.minify) {
      // Highlight first, then minify, so colors survive. Rows are filled to the last column.
      const stream: Segment[] = [];
      lines.forEach((line, idx) => {
        if (idx > 0) stream.push({ text: '\n' });
        stream.push(...line);
      });
      for (const row of wrapSegments(minifySegments(stream, options.minifyLevel), charsPerLine)) {
        ensure(lineH);
        drawRow(row, left);
        y += lineH;
      }
      return;
    }

    const digits = String(Math.max(1, lines.length)).length;
    const gutterChars = settings.lineNumbers ? digits + 2 : 0;
    const avail = Math.max(10, charsPerLine - gutterChars);
    const codeX = left + gutterChars * charW;

    lines.forEach((line, idx) => {
      const rows = line.length ? wrapSegments(line, avail) : [[]];
      rows.forEach((row, r) => {
        ensure(lineH);
        if (settings.lineNumbers && r === 0) {
          doc.font(mono).fontSize(fontSize).fillColor(COLOR.gutter)
            .text(String(idx + 1).padStart(digits), left, y, { lineBreak: false });
        }
        drawRow(row, codeX);
        y += lineH;
      });
    });
  };

  for (let i = 0; i < files.length; i++) {
    if (req.isCancelled?.()) throw new ExportCancelledError();
    const file = files[i];
    req.onProgress?.(`Rendering ${i + 1}/${files.length}: ${file.relPath}`);

    if (i > 0) {
      if (settings.startEachFileOnNewPage) newPage();
      else y += options.minify ? lineH * 0.6 : lineH * 1.5;
    }
    renderHeader(i, file);
    renderBody(file);

    if (i % 5 === 0) await yieldToEventLoop(); // keep the UI responsive / allow cancel
  }

  // ---------- 5. Fill in the TOC ----------
  if (options.tableOfContents) {
    req.onProgress?.('Writing table of contents...');
    for (let i = 0; i < files.length; i++) {
      const slot = tocSlots[i];
      doc.switchToPage(slot.page);
      doc.font(ui).fontSize(TOC_FONT_SIZE);

      const pageLabel = String(filePages[i] + 1);
      const numW = doc.widthOfString(pageLabel);
      const label = fit(clean(files[i].relPath), contentW - numW - 40);
      const labelW = doc.widthOfString(label);

      doc.fillColor(DEFAULT_TEXT_COLOR).text(label, left, slot.y, { lineBreak: false });

      const dotW = doc.widthOfString('.');
      const gapStart = left + labelW + 6;
      const gapEnd = left + contentW - numW - 6;
      const dots = Math.floor((gapEnd - gapStart) / dotW);
      if (dots > 2) doc.fillColor(COLOR.dots).text('.'.repeat(dots), gapStart, slot.y, { lineBreak: false });

      doc.fillColor(DEFAULT_TEXT_COLOR).text(pageLabel, left + contentW - numW, slot.y, { lineBreak: false });
      pdf.goTo(left, slot.y - 1, contentW, TOC_LINE_H, `file-${i}`); // clickable entry
    }
  }

  // ---------- 6. Footer with page numbers (bottom-right corner) ----------
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const footerY = pageH - 32;
    hr(footerY - 6);
    doc.font(ui).fontSize(8).fillColor(COLOR.muted);
    doc.text(fit(clean(projectName), contentW / 2), left, footerY, { lineBreak: false });
    const label = `Page ${i + 1} of ${range.count}`;
    doc.text(label, left + contentW - doc.widthOfString(label), footerY, { lineBreak: false });
  }

  doc.end();
  const data = await finished;
  return { data, pageCount: range.count };
}

/** Hard-wraps styled segments into rows of exactly `width` characters. */
function wrapSegments(segments: Segment[], width: number): Segment[][] {
  const rows: Segment[][] = [];
  let row: Segment[] = [];
  let used = 0;
  for (const seg of segments) {
    let text = seg.text;
    while (text.length) {
      if (used >= width) {
        rows.push(row);
        row = [];
        used = 0;
      }
      const part = text.slice(0, width - used);
      row.push({ ...seg, text: part });
      used += part.length;
      text = text.slice(part.length);
    }
  }
  if (row.length || rows.length === 0) rows.push(row);
  return rows;
}
