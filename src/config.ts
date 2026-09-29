import * as vscode from 'vscode';
import { SectionOptions, defaultSectionOptions } from './analysis/types';

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
  sections: SectionOptions;
}

export interface CollectorSettings {
  codeExtensions: string[];
  markdownExtensions: string[];
  includeFileNames: string[];
  exclude: string[];
  respectGitignore: boolean;
  maxFileSizeKB: number;
}

export type BuiltinFontFamily = 'Courier' | 'Helvetica' | 'Times' | 'Custom';

export interface FontRoleSetting {
  /** Built-in PDFKit family, or 'Custom' to use `path`. */
  family: BuiltinFontFamily | string;
  /** Optional path to a .ttf/.otf file (used when family is 'Custom' or as override). */
  path: string;
  size: number;
}

export interface FontsSettings {
  body: FontRoleSetting;
  code: FontRoleSetting;
  heading: FontRoleSetting;
  headerFooter: FontRoleSetting;
}

export interface PdfSettings {
  pageSize: string;
  fontSize: number;
  lineNumbers: boolean;
  startEachFileOnNewPage: boolean;
  fontPath: string;
  tabSize: number;
  fonts: FontsSettings;
  headerTemplate: string;
  footerTemplate: string;
  sectionsPlacement: 'before' | 'after';
}

export interface ClipboardSettings {
  useCodeFences: boolean;
  headerTemplate: string;
  footerTemplate: string;
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

function clamp(n: number, lo: number, hi: number, fallback: number): number {
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

function getFontRole(c: vscode.WorkspaceConfiguration, key: string, fallbackSize: number): FontRoleSetting {
  const family = c.get<string>(`pdf.fonts.${key}.family`, key === 'code' ? 'Courier' : key === 'heading' ? 'Helvetica-Bold' : 'Helvetica');
  const path = (c.get<string>(`pdf.fonts.${key}.path`, '') ?? '').trim();
  const size = clamp(c.get<number>(`pdf.fonts.${key}.size`, fallbackSize), 4, 32, fallbackSize);
  return { family, path, size };
}

export function getPdfSettings(): PdfSettings {
  const c = section();
  // Deprecated aliases: pdf.fontSize / pdf.fontPath map onto fonts.code
  const legacySize = clamp(c.get<number>('pdf.fontSize', 8), 4, 16, 8);
  const legacyPath = (c.get<string>('pdf.fontPath', '') ?? '').trim();
  const codeRole = getFontRole(c, 'code', legacySize);
  if (legacyPath && !codeRole.path) {
    codeRole.path = legacyPath;
    codeRole.family = 'Custom';
  }
  if (c.get<number>('pdf.fontSize', 8) !== codeRole.size && codeRole.size === legacySize) {
    codeRole.size = legacySize;
  }
  return {
    pageSize: c.get<string>('pdf.pageSize', 'A4'),
    fontSize: codeRole.size,
    lineNumbers: c.get<boolean>('pdf.lineNumbers', true),
    startEachFileOnNewPage: c.get<boolean>('pdf.startEachFileOnNewPage', false),
    fontPath: codeRole.path,
    tabSize: Math.max(1, c.get<number>('tabSize', 4)),
    fonts: {
      body: getFontRole(c, 'body', 9),
      code: codeRole,
      heading: getFontRole(c, 'heading', 14),
      headerFooter: getFontRole(c, 'headerFooter', 8)
    },
    headerTemplate: c.get<string>('pdf.headerTemplate', '') ?? '',
    footerTemplate: c.get<string>('pdf.footerTemplate', '%%PROJECT%% | Page %%PAGE%% of %%PAGES%%') ?? '',
    sectionsPlacement: c.get<string>('pdf.sectionsPlacement', 'before') === 'after' ? 'after' : 'before'
  };
}

export function getClipboardSettings(): ClipboardSettings {
  const c = section();
  return {
    useCodeFences: c.get<boolean>('clipboard.useCodeFences', true),
    headerTemplate: c.get<string>('clipboard.headerTemplate', '') ?? '',
    footerTemplate: c.get<string>('clipboard.footerTemplate', '') ?? ''
  };
}

export function getSectionOptions(): SectionOptions {
  const c = section();
  const d = defaultSectionOptions();
  const get = <T>(key: string, fallback: T): T => {
    const v = c.get<T>(`sections.${key}`);
    return v === undefined ? fallback : v;
  };
  return {
    classList: {
      enabled: get('classList.enabled', d.classList.enabled),
      sort: get('classList.sort', d.classList.sort),
      groupBy: get('classList.groupBy', d.classList.groupBy),
      showCtor: get('classList.showCtor', d.classList.showCtor),
      showMethods: get('classList.showMethods', d.classList.showMethods),
      showFields: get('classList.showFields', d.classList.showFields),
      showDefaults: get('classList.showDefaults', d.classList.showDefaults),
      showBaseClass: get('classList.showBaseClass', d.classList.showBaseClass)
    },
    functionList: {
      enabled: get('functionList.enabled', d.functionList.enabled),
      sort: get('functionList.sort', d.functionList.sort),
      groupBy: get('functionList.groupBy', d.functionList.groupBy),
      includeMethods: get('functionList.includeMethods', d.functionList.includeMethods),
      showSigs: get('functionList.showSigs', d.functionList.showSigs),
      showDefaults: get('functionList.showDefaults', d.functionList.showDefaults)
    },
    usages: {
      enabledClasses: get('usages.enabledClasses', d.usages.enabledClasses),
      enabledFunctions: get('usages.enabledFunctions', d.usages.enabledFunctions),
      contextLines: clamp(get('usages.contextLines', d.usages.contextLines), 0, 5, 0),
      maxHitsPerSymbol: clamp(get('usages.maxHitsPerSymbol', d.usages.maxHitsPerSymbol), 1, 500, 50)
    },
    strings: {
      enabled: get('strings.enabled', d.strings.enabled),
      sort: get('strings.sort', d.strings.sort),
      groupBy: get('strings.groupBy', d.strings.groupBy),
      minLength: clamp(get('strings.minLength', d.strings.minLength), 1, 100, 2),
      dedupe: get('strings.dedupe', d.strings.dedupe),
      maxItems: clamp(get('strings.maxItems', d.strings.maxItems), 100, 50000, 5000)
    },
    dependencies: {
      enabled: get('dependencies.enabled', d.dependencies.enabled),
      direction: get('dependencies.direction', d.dependencies.direction),
      showUnresolved: get('dependencies.showUnresolved', d.dependencies.showUnresolved)
    },
    placement: get('placement', d.placement),
    order: c.get<string[]>('sections.order', d.order) ?? d.order
  };
}
