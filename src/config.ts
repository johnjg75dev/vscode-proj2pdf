import * as vscode from 'vscode';

export type OutputTarget = 'pdf' | 'clipboard';
export type MinifyLevel = 'collapse' | 'aggressive';

export interface ToggleOptions {
  includeMarkdown: boolean;
  syntaxHighlighting: boolean;
  minify: boolean;
  tableOfContents: boolean;
  folderStructure: boolean;
}

export interface ExportOptions extends ToggleOptions {
  target: OutputTarget;
  minifyLevel: MinifyLevel;
}

export interface CollectorSettings {
  codeExtensions: string[];
  markdownExtensions: string[];
  includeFileNames: string[];
  exclude: string[];
  respectGitignore: boolean;
  maxFileSizeKB: number;
}

export interface PdfSettings {
  pageSize: string;
  fontSize: number;
  lineNumbers: boolean;
  startEachFileOnNewPage: boolean;
  fontPath: string;
  tabSize: number;
}

export interface ClipboardSettings {
  useCodeFences: boolean;
}

const section = () => vscode.workspace.getConfiguration('projectExporter');
const normalizeExt = (e: string) => e.trim().replace(/^\*?\./, '').toLowerCase();

export function getDefaultToggles(): ToggleOptions {
  const c = section();
  return {
    includeMarkdown: c.get<boolean>('defaults.includeMarkdown', false),
    syntaxHighlighting: c.get<boolean>('defaults.syntaxHighlighting', true),
    minify: c.get<boolean>('defaults.minify', false),
    tableOfContents: c.get<boolean>('defaults.tableOfContents', true),
    folderStructure: c.get<boolean>('defaults.folderStructure', true)
  };
}

export function getMinifyLevel(): MinifyLevel {
  return section().get<MinifyLevel>('minifyLevel', 'collapse');
}

export function shouldPromptForOptions(): boolean {
  return section().get<boolean>('promptForOptions', true);
}

export function getCollectorSettings(): CollectorSettings {
  const c = section();
  return {
    codeExtensions: c.get<string[]>('codeExtensions', []).map(normalizeExt).filter(Boolean),
    markdownExtensions: c.get<string[]>('markdownExtensions', []).map(normalizeExt).filter(Boolean),
    includeFileNames: c.get<string[]>('includeFileNames', []).map((s) => s.trim()).filter(Boolean),
    exclude: c.get<string[]>('exclude', []).filter(Boolean),
    respectGitignore: c.get<boolean>('respectGitignore', true),
    maxFileSizeKB: c.get<number>('maxFileSizeKB', 1024)
  };
}

export function getPdfSettings(): PdfSettings {
  const c = section();
  return {
    pageSize: c.get<string>('pdf.pageSize', 'A4'),
    fontSize: Math.min(16, Math.max(4, c.get<number>('pdf.fontSize', 8))),
    lineNumbers: c.get<boolean>('pdf.lineNumbers', true),
    startEachFileOnNewPage: c.get<boolean>('pdf.startEachFileOnNewPage', false),
    fontPath: c.get<string>('pdf.fontPath', '').trim(),
    tabSize: Math.max(1, c.get<number>('tabSize', 4))
  };
}

export function getClipboardSettings(): ClipboardSettings {
  return { useCodeFences: section().get<boolean>('clipboard.useCodeFences', true) };
}