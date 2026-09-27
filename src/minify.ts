import { MinifyLevel } from './config';
import { Segment } from './util';

const PUNCTUATION = new Set('{}()[];,:=<>+-*/%&|!?^~.'.split(''));
const OPERATORS = new Set('+-*/%=<>&|!^~?:.'.split(''));

function isWhitespace(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 13 || code === 11 || code === 12 || code === 160;
}

function needsSpace(prev: string, next: string, level: MinifyLevel): boolean {
  if (level === 'collapse') return true;
  if (!PUNCTUATION.has(prev) && !PUNCTUATION.has(next)) return true;
  // Keep "a - -b", "x / /re/", "a + +b" from fusing into different tokens.
  return OPERATORS.has(prev) && OPERATORS.has(next);
}

function sameStyle(a: Segment, b: Segment | null): boolean {
  return !!b && a.color === b.color && !!a.bold === !!b.bold && !!a.italic === !!b.italic;
}

/**
 * Removes all line breaks and indentation. Every whitespace run becomes a single
 * space (or nothing in "aggressive" mode when next to punctuation). Colors are
 * preserved, so highlighting is computed on the original code and then minified.
 */
export function minifySegments(segments: Segment[], level: MinifyLevel): Segment[] {
  const out: Segment[] = [];
  let buf = '';
  let bufStyle: Segment | null = null;
  let prevChar = '';
  let pendingSpace = false;

  const flush = () => {
    if (buf && bufStyle) out.push({ ...bufStyle, text: buf });
    buf = '';
  };

  for (const seg of segments) {
    if (!sameStyle(seg, bufStyle)) {
      flush();
      bufStyle = seg;
    }
    const t = seg.text;
    for (let i = 0; i < t.length; i++) {
      if (isWhitespace(t.charCodeAt(i))) {
        if (prevChar) pendingSpace = true;
        continue;
      }
      const ch = t[i];
      if (pendingSpace) {
        if (needsSpace(prevChar, ch, level)) buf += ' ';
        pendingSpace = false;
      }
      buf += ch;
      prevChar = ch;
    }
  }
  flush();
  return out;
}

export function minifyText(text: string, level: MinifyLevel): string {
  return minifySegments([{ text }], level).map((s) => s.text).join('');
}