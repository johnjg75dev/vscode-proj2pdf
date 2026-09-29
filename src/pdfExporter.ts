import PDFDocument from 'pdfkit';
import * as fs from 'fs';
import { ExportOptions, PdfSettings } from './config';
import { SourceFile } from './fileCollector';
import { DEFAULT_TEXT_COLOR, highlightToLines, plainLines } from './highlighter';
import { minifySegments } from './minify';
import { buildTreeLines } from './tree';
import { AnalysisResult } from './analysis/types';
import { stripDefaults } from './analysis/mask';
import { renderTemplate } from './headerFooter';
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
  analysis?: AnalysisResult | null;
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

/** Resolved font names for each role after registering custom TTFs. */
interface FontSet {
  mono: string;
  monoBold: string;
  monoItalic: string;
  ui: string;
  uiBold: string;
  body: string;
  bodyBold: string;
  heading: string;
  hf: string;
  unicode: boolean;
}

const BUILTINS = new Set([
  'Courier', 'Courier-Bold', 'Courier-Oblique', 'Courier-BoldOblique',
  'Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique', 'Helvetica-BoldOblique',
  'Times-Roman', 'Times-Bold', 'Times-Italic', 'Times-BoldItalic',
  'Symbol', 'ZapfDingbats'
]);

function resolveBuiltin(family: string, fallback: string): string {
  if (BUILTINS.has(family)) return family;
  const lower = family.toLowerCase();
  if (lower === 'courier') return 'Courier';
  if (lower === 'helvetica' || lower === 'arial') return 'Helvetica';
  if (lower === 'times' || lower === 'serif') return 'Times-Roman';
  if (lower === 'helvetica-bold' || lower === 'arial-bold') return 'Helvetica-Bold';
  if (lower === 'times-bold') return 'Times-Bold';
  // 'Custom' without path, or unknown name -> fallback
  return fallback;
}

export async function renderPdf(req: PdfRenderRequest): Promise<PdfRenderResult> {
  const { projectName, files, options, settings, analysis } = req;

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
  const fonts: FontSet = {
    mono: 'Courier', monoBold: 'Courier-Bold', monoItalic: 'Courier-Oblique',
    ui: 'Helvetica', uiBold: 'Helvetica-Bold',
    body: 'Helvetica', bodyBold: 'Helvetica-Bold',
    heading: 'Helvetica-Bold', hf: 'Helvetica',
    unicode: false
  };
  const registerCustom = (name: string, p: string): boolean => {
    if (!p) return false;
    if (!fs.existsSync(p)) {
      throw new Error(`Custom font not found: ${p}`);
    }
    doc.registerFont(name, p);
    doc.font(name); // fail fast if the font can't be parsed
    return true;
  };
  // Legacy single fontPath (code role) keeps old behavior: everything becomes mono.
  if (settings.fontPath && !settings.fonts.code.path) {
    registerCustom('CustomMono', settings.fontPath);
    fonts.mono = fonts.monoBold = fonts.monoItalic = fonts.ui = fonts.uiBold =
      fonts.body = fonts.bodyBold = fonts.heading = fonts.hf = 'CustomMono';
    fonts.unicode = true;
  } else {
    let anyCustom = false;
    if (registerCustom('CustomCode', settings.fonts.code.path)) {
      fonts.mono = fonts.monoBold = fonts.monoItalic = 'CustomCode';
      anyCustom = true;
    } else {
      const fam = resolveBuiltin(settings.fonts.code.family, 'Courier');
      fonts.mono = fam;
      fonts.monoBold = fam === 'Courier' ? 'Courier-Bold' : fam;
      fonts.monoItalic = fam === 'Courier' ? 'Courier-Oblique' : fam;
    }
    if (registerCustom('CustomBody', settings.fonts.body.path)) {
      fonts.body = fonts.bodyBold = 'CustomBody';
      anyCustom = true;
    } else {
      fonts.body = resolveBuiltin(settings.fonts.body.family, 'Helvetica');
      fonts.bodyBold = fonts.body === 'Helvetica' ? 'Helvetica-Bold' : fonts.body;
      fonts.ui = fonts.body;
      fonts.uiBold = fonts.bodyBold;
    }
    if (registerCustom('CustomHeading', settings.fonts.heading.path)) {
      fonts.heading = 'CustomHeading';
      anyCustom = true;
    } else {
      fonts.heading = resolveBuiltin(settings.fonts.heading.family, 'Helvetica-Bold');
    }
    if (registerCustom('CustomHF', settings.fonts.headerFooter.path)) {
      fonts.hf = 'CustomHF';
      anyCustom = true;
    } else {
      fonts.hf = resolveBuiltin(settings.fonts.headerFooter.family, 'Helvetica');
    }
    fonts.unicode = anyCustom;
  }
  const clean = (s: string) => (fonts.unicode ? stripControlChars(s) : toWinAnsiSafe(s));

  // ---------- Layout ----------
  const pageW = doc.page.width;
  const pageH = doc.page.height;
  const left = MARGIN.left;
  const contentW = pageW - MARGIN.left - MARGIN.right;
  const topY = MARGIN.top;
  const bottomY = pageH - MARGIN.bottom;
  const fontSize = settings.fontSize;
  const lineH = fontSize * 1.3;
  const bodySize = settings.fonts.body.size;
  const bodyLineH = bodySize * 1.35;
  const headingSize = settings.fonts.heading.size;
  const hfSize = settings.fonts.headerFooter.size;

  doc.font(fonts.mono).fontSize(fontSize);
  const charW = doc.widthOfString('M');
  const charsPerLine = Math.max(20, Math.floor(contentW / charW));

  // Per-page attribution for %%FILE%% / %%SECTION%%
  const pageFile: string[] = [];
  const pageSection: string[] = [];
  const markPage = (file: string, sectionName: string) => {
    const p = currentPage();
    pageFile[p] = file;
    pageSection[p] = sectionName;
  };

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
    doc.font(fonts.heading).fontSize(headingSize).fillColor(COLOR.title).text(title, left, y, { lineBreak: false });
    y += headingSize + 10;
  };
  const subHeading = (title: string) => {
    ensure(bodyLineH + 4);
    doc.font(fonts.bodyBold).fontSize(bodySize + 1).fillColor(COLOR.title).text(fit(clean(title), contentW), left, y, { lineBreak: false });
    y += bodyLineH + 2;
  };
  const bodyLine = (text: string, opts?: { bold?: boolean; italic?: boolean; color?: string; indent?: number }) => {
    ensure(bodyLineH);
    const x = left + (opts?.indent ?? 0);
    doc.font(opts?.bold ? fonts.bodyBold : fonts.body).fontSize(bodySize).fillColor(opts?.color ?? DEFAULT_TEXT_COLOR);
    const t = clean(text).slice(0, charsPerLine * 2);
    doc.text(fit(t, contentW - (opts?.indent ?? 0)), x, y, { lineBreak: false });
    void opts?.italic;
    y += bodyLineH;
  };
  const codeLine = (text: string) => {
    ensure(lineH);
    drawRow([{ text: clean(text).slice(0, charsPerLine) }], left);
    y += lineH;
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
          .font(seg.bold ? fonts.monoBold : seg.italic ? fonts.monoItalic : fonts.mono)
          .fontSize(fontSize)
          .fillColor(seg.color ?? DEFAULT_TEXT_COLOR)
          .text(body, x0 + (col + lead) * charW, y, { lineBreak: false });
      }
      col += text.length;
    }
  };

  // ---------- Section plan ----------
  const SECTION_TITLES: Record<string, string> = {
    classList: 'Class List',
    functionList: 'Function List',
    usages: 'Usages',
    strings: 'String List',
    dependencies: 'Dependencies'
  };
  const hasSections = !!analysis && !!options.sections && (
    options.sections.classList.enabled || options.sections.functionList.enabled ||
    options.sections.usages.enabledClasses || options.sections.usages.enabledFunctions ||
    options.sections.strings.enabled || options.sections.dependencies.enabled
  );
  const orderedSectionIds = hasSections
    ? (options.sections.order ?? ['classList', 'functionList', 'usages', 'strings', 'dependencies'])
      .filter((id) => SECTION_TITLES[id] && sectionEnabled(id))
      : [];
  function sectionEnabled(id: string): boolean {
    if (!options.sections) return false;
    const s = options.sections;
    if (id === 'classList') return s.classList.enabled;
    if (id === 'functionList') return s.functionList.enabled;
    if (id === 'usages') return s.usages.enabledClasses || s.usages.enabledFunctions;
    if (id === 'strings') return s.strings.enabled;
    if (id === 'dependencies') return s.dependencies.enabled;
    return false;
  }
  const placement = options.sections?.placement ?? settings.sectionsPlacement ?? 'before';

  // ---------- 1. Title block ----------
  markPage('', 'Title');
  const totalLines = files.reduce((n, f) => n + f.lineCount, 0);
  doc.font(fonts.heading).fontSize(20).fillColor(COLOR.title);
  doc.text(fit(clean(projectName), contentW), left, y, { lineBreak: false });
  y += 28;
  const flags = [
    options.syntaxHighlighting && 'syntax highlighted',
    options.minify && `minified (${options.minifyLevel})`
  ].filter(Boolean).join(', ');
  const summary =
    `${files.length} files  |  ${totalLines.toLocaleString()} lines  |  ` +
    `Generated ${new Date().toLocaleString()}${flags ? `  |  ${flags}` : ''}`;
  doc.font(fonts.ui).fontSize(9).fillColor(COLOR.muted);
  doc.text(fit(clean(summary), contentW), left, y, { lineBreak: false });
  y += 16;
  hr(y);
  y += 14;

  // ---------- 2. Table of contents (reserve space now, fill in later) ----------
  interface TocSlot { page: number; y: number; label: string; dest: string; }
  const tocSlots: TocSlot[] = [];
  const fileTocIndex: number[] = new Array(files.length).fill(-1);
  const sectionTocIndex = new Map<string, number>();
  if (options.tableOfContents) {
    pdf.outline.addItem('Table of Contents');
    heading('Table of Contents');
    const reserve = (label: string, dest: string): number => {
      if (y + TOC_LINE_H > bottomY) newPage();
      const idx = tocSlots.length;
      tocSlots.push({ page: currentPage(), y, label, dest });
      y += TOC_LINE_H;
      return idx;
    };
    if (placement === 'before') {
      for (const id of orderedSectionIds) sectionTocIndex.set(id, reserve(SECTION_TITLES[id], `section-${id}`));
      files.forEach((f, i) => { fileTocIndex[i] = reserve(f.relPath, `file-${i}`); });
    } else {
      files.forEach((f, i) => { fileTocIndex[i] = reserve(f.relPath, `file-${i}`); });
      for (const id of orderedSectionIds) sectionTocIndex.set(id, reserve(SECTION_TITLES[id], `section-${id}`));
    }
  }

  // ---------- 3. Folder structure ----------
  if (options.folderStructure) {
    if (options.tableOfContents) newPage();
    else y += 6;
    markPage('', 'Folder Structure');
    pdf.outline.addItem('Folder Structure');
    heading('Folder Structure');
    const treeLines = buildTreeLines(files.map((f) => f.relPath), projectName, fonts.unicode ? 'unicode' : 'ascii');
    for (const line of treeLines) {
      ensure(lineH);
      drawRow([{ text: clean(line).slice(0, charsPerLine) }], left);
      y += lineH;
    }
  }

  // ---------- 4. Analysis sections + Source files ----------
  const filePages: number[] = new Array(files.length).fill(0);
  const sectionPages = new Map<string, number>();
  const needBreakBeforeBody = options.tableOfContents || options.folderStructure;

  const renderHeader = (index: number, file: SourceFile) => {
    const headerH = options.minify ? fontSize + 8 : fontSize + 12;
    ensure(headerH + lineH * 2);

    filePages[index] = currentPage();
    markPage(file.relPath, 'Source');
    pdf.addNamedDestination(`file-${index}`, 'XYZ', null, y, null);
    pdf.outline.addItem(clean(file.relPath));

    doc.rect(left, y, contentW, headerH).fill(COLOR.headerBg);

    const info = `${file.lineCount.toLocaleString()} lines`;
    doc.font(fonts.ui).fontSize(fontSize).fillColor(COLOR.muted);
    const infoW = doc.widthOfString(info);
    doc.text(info, left + contentW - infoW - 6, y + (headerH - fontSize) / 2, { lineBreak: false });

    doc.font(fonts.uiBold).fontSize(fontSize + 1).fillColor(COLOR.headerText);
    const label = fit(clean(file.relPath), contentW - infoW - 24);
    doc.text(label, left + 6, y + (headerH - fontSize - 1) / 2, { lineBreak: false });

    y += headerH + 4;
  };

  const renderBody = (file: SourceFile) => {
    if (!file.content) {
      ensure(lineH);
      doc.font(fonts.monoItalic).fontSize(fontSize).fillColor(COLOR.muted)
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
          doc.font(fonts.mono).fontSize(fontSize).fillColor(COLOR.gutter)
            .text(String(idx + 1).padStart(digits), left, y, { lineBreak: false });
        }
        drawRow(row, codeX);
        y += lineH;
      });
    });
  };

  const renderFiles = async () => {
    for (let i = 0; i < files.length; i++) {
      if (req.isCancelled?.()) throw new ExportCancelledError();
      const file = files[i];
      req.onProgress?.(`Rendering ${i + 1}/${files.length}: ${file.relPath}`);

      if (i > 0) {
        if (settings.startEachFileOnNewPage) newPage();
        else y += options.minify ? lineH * 0.6 : lineH * 1.5;
      } else if (needBreakBeforeBody || hasSections) {
        // first file starts on a fresh page when front matter or sections precede it
      }
      markPage(file.relPath, 'Source');
      renderHeader(i, file);
      renderBody(file);

      if (i % 5 === 0) await yieldToEventLoop(); // keep the UI responsive / allow cancel
    }
  };

  const renderSections = async () => {
    if (!hasSections || !analysis) return;
    for (const id of orderedSectionIds) {
      if (req.isCancelled?.()) throw new ExportCancelledError();
      req.onProgress?.(`Rendering section: ${SECTION_TITLES[id]}...`);
      newPage();
      markPage('', SECTION_TITLES[id]);
      sectionPages.set(id, currentPage());
      pdf.addNamedDestination(`section-${id}`, 'XYZ', null, y, null);
      pdf.outline.addItem(SECTION_TITLES[id]);
      heading(SECTION_TITLES[id]);
      markPage('', SECTION_TITLES[id]);
      if (id === 'classList') renderClassList();
      else if (id === 'functionList') renderFunctionList();
      else if (id === 'usages') renderUsages();
      else if (id === 'strings') renderStrings();
      else if (id === 'dependencies') renderDependencies();
      await yieldToEventLoop();
    }
  };

  const sigFor = (sig: string, showDefaults: boolean): string =>
    showDefaults ? sig : stripDefaults(sig);

  const visibilityPass = (vis: string, mode: string): boolean => {
    if (mode === 'both') return vis === 'public' || vis === 'private' || vis === 'protected';
    if (mode === 'public') return vis === 'public' || vis === 'protected';
    if (mode === 'private') return vis === 'private';
    return false;
  };

  const renderClassList = () => {
    if (!analysis) return;
    const o = options.sections.classList;
    if (analysis.classes.length === 0) {
      bodyLine('(no classes found)', { italic: true, color: COLOR.muted });
      return;
    }
    let lastGroup = '';
    for (const cls of analysis.classes) {
      const group = o.groupBy === 'file' ? cls.file : o.groupBy === 'folder' ? cls.folder : '';
      if (group && group !== lastGroup) {
        subHeading(group);
        lastGroup = group;
      }
      let title = cls.name;
      if (o.showBaseClass && cls.baseClasses.length > 0) title += ` : ${cls.baseClasses.join(', ')}`;
      ensure(bodyLineH + 2);
      doc.font(fonts.bodyBold).fontSize(bodySize).fillColor(COLOR.headerText)
        .text(fit(clean(title), contentW - 120), left, y, { lineBreak: false });
      doc.font(fonts.body).fontSize(bodySize - 1).fillColor(COLOR.muted);
      const loc = `${cls.file}:${cls.line}`;
      doc.text(loc, left + contentW - doc.widthOfString(loc), y, { lineBreak: false });
      y += bodyLineH;
      if (o.showCtor && cls.ctorSig) {
        codeLine(`  ctor ${sigFor(cls.ctorSig, o.showDefaults)}`);
      }
      if (o.showMethods && cls.methods.length > 0) {
        for (const m of cls.methods) {
          codeLine(`  [${m.visibility}] ${sigFor(m.sig, o.showDefaults)}`);
        }
      }
      if (o.showFields !== 'none') {
        for (const f of cls.fields) {
          if (!visibilityPass(f.visibility, o.showFields)) continue;
          const def = o.showDefaults && f.defaultValue ? ` = ${f.defaultValue}` : '';
          const typ = f.type ? `: ${f.type}` : '';
          codeLine(`  [${f.visibility}] ${f.name}${typ}${def}`);
        }
      }
      y += 2;
      markPage('', SECTION_TITLES.classList);
    }
  };

  const renderFunctionList = () => {
    if (!analysis) return;
    const o = options.sections.functionList;
    let list = analysis.functions;
    if (!o.includeMethods) list = list.filter((f) => !f.parentClass);
    if (list.length === 0) {
      bodyLine('(no functions found)', { italic: true, color: COLOR.muted });
      return;
    }
    let lastGroup = '';
    for (const fn of list) {
      const group = o.groupBy === 'file' ? fn.file : o.groupBy === 'folder' ? fn.folder : '';
      if (group && group !== lastGroup) {
        subHeading(group);
        lastGroup = group;
      }
      const label = o.showSigs ? sigFor(fn.sig, o.showDefaults) : fn.name;
      const prefix = fn.parentClass ? `${fn.parentClass}.` : '';
      ensure(bodyLineH);
      doc.font(fonts.body).fontSize(bodySize).fillColor(DEFAULT_TEXT_COLOR);
      const loc = `${fn.file}:${fn.line}`;
      doc.font(fonts.body).fontSize(bodySize - 1).fillColor(COLOR.muted);
      const locW = doc.widthOfString(loc);
      doc.text(loc, left + contentW - locW, y, { lineBreak: false });
      doc.font(fonts.mono).fontSize(fontSize).fillColor(DEFAULT_TEXT_COLOR);
      doc.text(fit(clean(prefix + label), contentW - locW - 8), left, y, { lineBreak: false });
      y += Math.max(bodyLineH, lineH);
      markPage('', SECTION_TITLES.functionList);
    }
  };

  const renderUsages = () => {
    if (!analysis) return;
    const o = options.sections.usages;
    let any = false;
    if (o.enabledClasses) {
      subHeading('Class usages');
      const names = [...analysis.classUsages.keys()].sort();
      for (const name of names) {
        const hits = analysis.classUsages.get(name) ?? [];
        bodyLine(`${name} — ${hits.length} use${hits.length === 1 ? '' : 's'}`, { bold: true });
        if (hits.length === 0) {
          bodyLine('(no usages found)', { italic: true, color: COLOR.muted, indent: 12 });
        }
        for (const h of hits) {
          codeLine(`  ${h.file}:${h.line}: ${h.code.split('\n')[0]}`);
        }
        any = true;
        markPage('', SECTION_TITLES.usages);
      }
    }
    if (o.enabledFunctions) {
      subHeading('Function usages');
      const names = [...analysis.functionUsages.keys()].sort();
      for (const name of names) {
        const hits = analysis.functionUsages.get(name) ?? [];
        bodyLine(`${name} — ${hits.length} call${hits.length === 1 ? '' : 's'}`, { bold: true });
        if (hits.length === 0) {
          bodyLine('(no usages found)', { italic: true, color: COLOR.muted, indent: 12 });
        }
        for (const h of hits) {
          codeLine(`  ${h.file}:${h.line}: ${h.code.split('\n')[0]}`);
        }
        any = true;
        markPage('', SECTION_TITLES.usages);
      }
    }
    if (!any) bodyLine('(usages disabled)', { italic: true, color: COLOR.muted });
    if (analysis.truncated.usages) {
      bodyLine('(truncated: hit cap reached — raise usages.maxHitsPerSymbol)', { italic: true, color: COLOR.muted });
    }
  };

  const renderStrings = () => {
    if (!analysis) return;
    if (analysis.strings.length === 0) {
      bodyLine('(no strings found)', { italic: true, color: COLOR.muted });
      return;
    }
    const o = options.sections.strings;
    if (o.groupBy === 'file') {
      let lastFile = '';
      for (const s of analysis.strings) {
        if (s.file !== lastFile) {
          subHeading(s.file);
          lastFile = s.file;
        }
        const val = s.value.length > 200 ? s.value.slice(0, 200) + '…' : s.value;
        codeLine(`  L${s.line}: "${val}"`);
        markPage('', SECTION_TITLES.strings);
      }
    } else {
      for (const s of analysis.strings) {
        const val = s.value.length > 200 ? s.value.slice(0, 200) + '…' : s.value;
        ensure(bodyLineH);
        doc.font(fonts.mono).fontSize(fontSize).fillColor(DEFAULT_TEXT_COLOR);
        doc.text(fit(clean(`"${val}"`), contentW - 180), left, y, { lineBreak: false });
        doc.font(fonts.body).fontSize(bodySize - 1).fillColor(COLOR.muted);
        const loc = `${s.file}:${s.line}`;
        doc.text(loc, left + contentW - doc.widthOfString(loc), y, { lineBreak: false });
        y += Math.max(bodyLineH, lineH);
        markPage('', SECTION_TITLES.strings);
      }
    }
    if (analysis.truncated.strings) {
      bodyLine('(truncated: item cap reached — raise strings.maxItems)', { italic: true, color: COLOR.muted });
    }
  };

  const renderDependencies = () => {
    if (!analysis) return;
    const o = options.sections.dependencies;
    if (analysis.dependencies.length === 0) {
      bodyLine('(no dependencies found)', { italic: true, color: COLOR.muted });
      return;
    }
    // outgoing: group by `from`
    const showOutgoing = o.direction === 'outgoing' || o.direction === 'both';
    const showIncoming = o.direction === 'incoming' || o.direction === 'both';
    if (showOutgoing) {
      if (o.direction === 'both') subHeading('Outgoing (file → its dependencies)');
      const byFrom = new Map<string, typeof analysis.dependencies>();
      for (const e of analysis.dependencies) {
        const arr = byFrom.get(e.from) ?? [];
        arr.push(e);
        byFrom.set(e.from, arr);
      }
      for (const from of [...byFrom.keys()].sort()) {
        bodyLine(from, { bold: true });
        for (const e of byFrom.get(from)!) {
          const label = e.resolved ? `  → ${e.to}` : `  → ${e.to} (unresolved)`;
          codeLine(label);
        }
        markPage('', SECTION_TITLES.dependencies);
      }
    }
    if (showIncoming) {
      if (o.direction === 'both') subHeading('Incoming (file ← its dependents)');
      const incoming = new Map<string, string[]>();
      for (const e of analysis.dependencies) {
        if (!e.resolved) continue;
        const arr = incoming.get(e.to) ?? [];
        if (!arr.includes(e.from)) arr.push(e.from);
        incoming.set(e.to, arr);
      }
      // include files with no dependents
      for (const f of files) {
        if (!incoming.has(f.relPath)) incoming.set(f.relPath, []);
      }
      for (const to of [...incoming.keys()].sort()) {
        const deps = incoming.get(to)!;
        bodyLine(`${to} — ${deps.length} dependent${deps.length === 1 ? '' : 's'}`, { bold: true });
        for (const d of deps.sort()) {
          codeLine(`  ← ${d}`);
        }
        markPage('', SECTION_TITLES.dependencies);
      }
    }
  };

  if (needBreakBeforeBody || hasSections) {
    // body (sections/files) always starts on a fresh page after front matter
  }

  if (hasSections && placement === 'before') {
    if (needBreakBeforeBody) newPage();
    await renderSections();
    newPage();
    await renderFiles();
  } else {
    if (needBreakBeforeBody) newPage();
    await renderFiles();
    if (hasSections) await renderSections();
  }

  // ---------- 5. Fill in the TOC ----------
  if (options.tableOfContents) {
    req.onProgress?.('Writing table of contents...');
    doc.font(fonts.ui).fontSize(TOC_FONT_SIZE);
    for (const slot of tocSlots) {
      doc.switchToPage(slot.page);
      const isFile = slot.dest.startsWith('file-');
      const pageNum = isFile
        ? filePages[Number(slot.dest.slice(5))] + 1
        : (sectionPages.get(slot.dest.slice('section-'.length)) ?? 0) + 1;
      const pageLabel = String(pageNum);
      const numW = doc.widthOfString(pageLabel);
      const label = fit(clean(slot.label), contentW - numW - 40);
      const labelW = doc.widthOfString(label);

      doc.fillColor(DEFAULT_TEXT_COLOR).text(label, left, slot.y, { lineBreak: false });

      const dotW = doc.widthOfString('.');
      const gapStart = left + labelW + 6;
      const gapEnd = left + contentW - numW - 6;
      const dots = Math.floor((gapEnd - gapStart) / dotW);
      if (dots > 2) doc.fillColor(COLOR.dots).text('.'.repeat(dots), gapStart, slot.y, { lineBreak: false });

      doc.fillColor(DEFAULT_TEXT_COLOR).text(pageLabel, left + contentW - numW, slot.y, { lineBreak: false });
      pdf.goTo(left, slot.y - 1, contentW, TOC_LINE_H, slot.dest); // clickable entry
    }
    void fileTocIndex;
    void sectionTocIndex;
  }

  // ---------- 6. Header + footer on every page ----------
  const range = doc.bufferedPageRange();
  const now = new Date();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const file = pageFile[i] ?? '';
    const sectionName = pageSection[i] ?? '';
    const ctxBase = {
      project: projectName,
      page: i + 1,
      pages: range.count,
      file,
      fileCount: files.length,
      section: sectionName,
      date: now.toLocaleDateString(),
      time: now.toLocaleTimeString()
    };
    if (settings.headerTemplate) {
      const text = renderTemplate(settings.headerTemplate, ctxBase, now);
      if (text) {
        doc.font(fonts.hf).fontSize(hfSize).fillColor(COLOR.muted);
        doc.text(fit(clean(text), contentW), left, 24, { lineBreak: false, align: 'center' });
      }
    }
    if (settings.footerTemplate) {
      const footerY = pageH - 32;
      hr(footerY - 6);
      const text = renderTemplate(settings.footerTemplate, ctxBase, now);
      doc.font(fonts.hf).fontSize(hfSize).fillColor(COLOR.muted);
      if (text.includes('|') || text.length > 60) {
        doc.text(fit(clean(text), contentW), left, footerY, { lineBreak: false, align: 'center' });
      } else {
        doc.text(fit(clean(text), contentW / 2), left, footerY, { lineBreak: false });
        const fallback = `Page ${i + 1} of ${range.count}`;
        void fallback;
      }
    } else {
      const footerY = pageH - 32;
      hr(footerY - 6);
      doc.font(fonts.hf).fontSize(hfSize).fillColor(COLOR.muted);
      doc.text(fit(clean(projectName), contentW / 2), left, footerY, { lineBreak: false });
      const label = `Page ${i + 1} of ${range.count}`;
      doc.text(label, left + contentW - doc.widthOfString(label), footerY, { lineBreak: false });
    }
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
