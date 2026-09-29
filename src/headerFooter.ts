/** Header/footer template engine. Variables are wrapped in double percents. */

export interface HeaderFooterContext {
  project: string;
  page: number;
  pages: number;
  file?: string;
  fileCount?: number;
  section?: string;
  date?: string;
  time?: string;
}

export const HEADER_FOOTER_VARS = [
  '%%PAGE%%',
  '%%PAGES%%',
  '%%PROJECT%%',
  '%%DATE%%',
  '%%TIME%%',
  '%%FILE%%',
  '%%FILECOUNT%%',
  '%%SECTION%%'
] as const;

function fmtDate(d: Date): string {
  return d.toLocaleDateString();
}

function fmtTime(d: Date): string {
  return d.toLocaleTimeString();
}

/** Renders a header/footer template. Unknown %%VARS%% are left literal. */
export function renderTemplate(template: string, ctx: HeaderFooterContext, now = new Date()): string {
  if (!template) return '';
  const map: Record<string, string> = {
    '%%PAGE%%': String(ctx.page),
    '%%PAGES%%': String(ctx.pages),
    '%%PROJECT%%': ctx.project,
    '%%DATE%%': ctx.date ?? fmtDate(now),
    '%%TIME%%': ctx.time ?? fmtTime(now),
    '%%FILE%%': ctx.file ?? '',
    '%%FILECOUNT%%': ctx.fileCount !== undefined ? String(ctx.fileCount) : '',
    '%%SECTION%%': ctx.section ?? ''
  };
  return template.replace(/%%[A-Z]+%%/g, (m) => (m in map ? map[m] : m));
}

/** Returns unknown %%VARS%% found in a template (for validation warnings). */
export function unknownVars(template: string): string[] {
  const known = new Set<string>(HEADER_FOOTER_VARS as unknown as string[]);
  const found = new Set<string>();
  for (const m of template.match(/%%[A-Z]+%%/g) ?? []) {
    if (!known.has(m)) found.add(m);
  }
  return [...found];
}
