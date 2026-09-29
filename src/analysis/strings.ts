import { StringRef } from './types';
import { StringListOptions } from './types';

interface ScanOptions {
  minLength: number;
  maxItems: number;
}

/**
 * Quote-aware string literal scanner. Skips line/block comments but keeps
 * template literals' static parts. Handles single, double, backtick, and
 * Python triple-quoted strings with escape handling.
 */
export function extractStrings(files: { relPath: string; content: string; ext: string }[], opts: ScanOptions): { items: StringRef[]; truncated: boolean } {
  const items: StringRef[] = [];
  let truncated = false;

  outer: for (const f of files) {
    const lines = f.content.split('\n');
    let inBlock: string | null = null; // '/*' | python triple
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      let i = 0;
      while (i < line.length) {
        if (items.length >= opts.maxItems) {
          truncated = true;
          break outer;
        }
        if (inBlock === '/*') {
          const end = line.indexOf('*/', i);
          if (end === -1) break;
          i = end + 2;
          inBlock = null;
          continue;
        }
        if (inBlock === "'''" || inBlock === '"""') {
          const end = line.indexOf(inBlock, i);
          if (end === -1) break; // rest of line inside triple string; skip line scanning for literals
          i = end + 3;
          inBlock = null;
          continue;
        }
        const two = line.slice(i, i + 2);
        const three = line.slice(i, i + 3);
        if (two === '/*') { inBlock = '/*'; i += 2; continue; }
        if ((three === "'''" || three === '"""') && (f.ext === 'py' || f.ext === 'pyi')) {
          const close = line.indexOf(three, i + 3);
          if (close === -1) { inBlock = three; break; }
          const val = line.slice(i + 3, close);
          pushVal(val, f.relPath, li + 1);
          i = close + 3;
          continue;
        }
        if (two === '//' && f.ext !== 'py' && f.ext !== 'pyi') break;
        if (line[i] === '#' && ['py', 'pyi', 'rb', 'sh', 'bash', 'zsh', 'yaml', 'yml', 'toml', 'r'].includes(f.ext)) break;

        const ch = line[i];
        if (ch === '"' || ch === "'" || ch === '`') {
          const { value, next } = readQuoted(line, i, ch);
          pushVal(value, f.relPath, li + 1);
          i = next;
          continue;
        }
        i++;
      }
    }
  }

  function pushVal(value: string, file: string, line: number): void {
    if (value.length < opts.minLength) return;
    // skip pure whitespace
    if (!value.trim()) return;
    items.push({ value, file, line });
  }

  return { items, truncated };
}

/** Reads a quoted literal starting at index `start` (which holds the quote). */
function readQuoted(line: string, start: number, quote: string): { value: string; next: number } {
  let out = '';
  let i = start + 1;
  while (i < line.length) {
    const ch = line[i];
    if (ch === '\\') {
      out += ch + (line[i + 1] ?? '');
      i += 2;
      continue;
    }
    if (ch === quote) {
      return { value: out, next: i + 1 };
    }
    // template literal ${...} — include literally up to closing backtick
    out += ch;
    i++;
    // unterminated quote: stop at EOL
  }
  return { value: out, next: i };
}

export function sortStrings(items: StringRef[], opts: StringListOptions): StringRef[] {
  const arr = [...items];
  if (opts.dedupe) {
    const seen = new Set<string>();
    const uniq: StringRef[] = [];
    for (const s of arr) {
      const key = `${s.file}\0${s.value}`;
      if (opts.groupBy === 'flat') {
        if (seen.has(s.value)) continue;
        seen.add(s.value);
      } else {
        if (seen.has(key)) continue;
        seen.add(key);
      }
      uniq.push(s);
    }
    arr.length = 0;
    arr.push(...uniq);
  }
  if (opts.sort === 'alpha') {
    arr.sort((a, b) => a.value.localeCompare(b.value, undefined, { sensitivity: 'base' }) || a.file.localeCompare(b.file) || a.line - b.line);
  } else {
    arr.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  }
  return arr;
}
