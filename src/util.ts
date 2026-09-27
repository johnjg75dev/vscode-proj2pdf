/** A run of text with a single visual style. */
export interface Segment {
  text: string;
  color?: string;
  bold?: boolean;
  italic?: boolean;
}

export class ExportCancelledError extends Error {
  constructor() {
    super('Export cancelled');
  }
}

/** Normalizes line endings and strips trailing whitespace/blank lines. */
export function normalizeContent(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/\s+$/, '');
}

export function countLines(text: string): number {
  if (!text) return 0;
  let n = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

/** Expands tabs to spaces using real tab stops. */
export function expandTabs(text: string, tabSize: number): string {
  if (!text.includes('\t')) return text;
  return text
    .split('\n')
    .map((line) => {
      let out = '';
      for (const ch of line) {
        if (ch === '\t') out += ' '.repeat(tabSize - (out.length % tabSize));
        else out += ch;
      }
      return out;
    })
    .join('\n');
}

const TRANSLITERATIONS: Record<string, string> = {
  '\u2018': "'", '\u2019': "'", '\u201A': "'", '\u201B': "'",
  '\u201C': '"', '\u201D': '"', '\u201E': '"',
  '\u2013': '-', '\u2014': '--', '\u2026': '...', '\u2022': '*',
  '\u2192': '->', '\u2190': '<-', '\u21D2': '=>', '\u2264': '<=', '\u2265': '>=', '\u2260': '!=',
  '\u2713': 'v', '\u2714': 'v', '\u2717': 'x', '\u2718': 'x',
  '\u2500': '-', '\u2502': '|', '\u251C': '|', '\u2514': '`',
  '\u00A0': ' ', '\u200B': '', '\uFEFF': ''
};
const TRANSLIT_RE = new RegExp(`[${Object.keys(TRANSLITERATIONS).join('')}]`, 'g');

/**
 * The 14 standard PDF fonts only support WinAnsi (≈ Latin-1).
 * Transliterate common symbols and replace anything else with '?'.
 */
export function toWinAnsiSafe(text: string): string {
  return text
    .replace(TRANSLIT_RE, (c) => TRANSLITERATIONS[c] ?? '?')
    .replace(/[^\n\x20-\x7E\xA1-\xFF]/gu, '?');
}

export function stripControlChars(text: string): string {
  return text.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '');
}

export function compareNames(a: string, b: string): number {
  return (
    a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }) ||
    (a < b ? -1 : a > b ? 1 : 0)
  );
}

/** Sorts like a file explorer: folders before files at each level, then by name. */
export function comparePaths(a: string, b: string): number {
  const as = a.split('/');
  const bs = b.split('/');
  const n = Math.min(as.length, bs.length);
  for (let i = 0; i < n; i++) {
    if (as[i] === bs[i]) continue;
    const aDir = i < as.length - 1;
    const bDir = i < bs.length - 1;
    if (aDir !== bDir) return aDir ? -1 : 1;
    return compareNames(as[i], bs[i]);
  }
  return as.length - bs.length;
}

export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
