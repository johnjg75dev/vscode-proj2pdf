/**
 * Builds a per-character mask of "code" vs "comment/string" zones so that
 * class/function/usage regexes don't match inside literals or comments.
 * Best-effort scanner covering //, #, --, / * * /, <!-- -->, string quotes,
 * template literals and Python triple-quoted strings.
 */

export interface CodeMask {
  /** Same length as input; ' ' for masked chars, original char for code. */
  masked: string;
  /** Original lines (split on \n). */
  lines: string[];
}

/** Languages whose line comments start with # or -- instead of //. */
function lineCommentKind(ext: string): '#' | '--' | '//' | null {
  if (['py', 'pyi', 'rb', 'pl', 'pm', 'sh', 'bash', 'zsh', 'fish', 'yaml', 'yml', 'toml', 'r', 'jl', 'ex', 'exs', 'nim'].includes(ext)) return '#';
  if (['sql', 'lua'].includes(ext)) return '--';
  if (['html', 'htm', 'xml', 'vue', 'svelte', 'astro'].includes(ext)) return null; // handled as <!-- -->
  return '//';
}

export function maskCode(text: string, ext: string): CodeMask {
  const lines = text.split('\n');
  const out: string[] = new Array(lines.length);
  const lineKind = lineCommentKind(ext);
  const isHtml = lineKind === null;
  let inBlock: string | null = null; // '/*' or '<!--' or python triple
  let inStr: string | null = null; // quote char(s)
  let inTemplateExpr = 0;

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    let res = '';
    let i = 0;
    while (i < line.length) {
      // inside block comment
      if (inBlock === '/*' || inBlock === '<!--') {
        const end = inBlock === '/*' ? '*/' : '-->';
        if (line.startsWith(end, i)) {
          res += ' '.repeat(end.length);
          i += end.length;
          inBlock = null;
        } else {
          res += ' ';
          i++;
        }
        continue;
      }
      // inside python triple string spanning lines
      if (inBlock === "'''" || inBlock === '"""') {
        if (line.startsWith(inBlock, i)) {
          res += ' '.repeat(3);
          i += 3;
          inBlock = null;
        } else {
          res += ' ';
          i++;
        }
        continue;
      }
      // inside single-line string
      if (inStr) {
        if (line[i] === '\\') {
          res += '  ';
          i += 2;
          continue;
        }
        if (inStr === '`' && line[i] === '$' && line[i + 1] === '{') {
          res += '  ';
          i += 2;
          inTemplateExpr++;
          inStr = null;
          continue;
        }
        if (line.startsWith(inStr, i)) {
          res += ' '.repeat(inStr.length);
          i += inStr.length;
          inStr = null;
        } else {
          res += ' ';
          i++;
        }
        continue;
      }
      const ch = line[i];
      const two = line.slice(i, i + 2);
      const three = line.slice(i, i + 3);

      // block comment start
      if (!isHtml && two === '/*') { res += '  '; i += 2; inBlock = '/*'; continue; }
      if (isHtml && line.startsWith('<!--', i)) { res += '    '; i += 4; inBlock = '<!--'; continue; }
      // python triple quotes
      if ((three === "'''" || three === '"""') && (ext === 'py' || ext === 'pyi')) {
        res += '   ';
        i += 3;
        // single-line triple string?
        const close = line.indexOf(three, i);
        if (close === -1) inBlock = three;
        else {
          res += ' '.repeat(close - i + 3);
          i = close + 3;
        }
        continue;
      }
      // line comment
      if (two === '//' && !isHtml && inTemplateExpr === 0) { res += ' '.repeat(line.length - i); break; }
      if (lineKind === '#' && ch === '#') { res += ' '.repeat(line.length - i); break; }
      if (lineKind === '--' && two === '--' && (ext === 'sql' || ext === 'lua')) { res += ' '.repeat(line.length - i); break; }
      // string start
      if (ch === '"' || ch === "'" || ch === '`') {
        // crude char-literal tolerance: keep scanning as string anyway
        inStr = ch;
        res += ' ';
        i++;
        continue;
      }
      if (ch === '{' && inTemplateExpr > 0) inTemplateExpr++;
      if (ch === '}' && inTemplateExpr > 0) {
        inTemplateExpr--;
        if (inTemplateExpr === 0) { /* back to template string? treat rest as code */ }
      }
      res += ch;
      i++;
    }
    out[li] = res;
  }
  return { masked: out.join('\n'), lines };
}

/** Splits `a = default` params respecting nested brackets/quotes. */
export function splitParams(params: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  let quote: string | null = null;
  for (let i = 0; i < params.length; i++) {
    const ch = params[i];
    if (quote) {
      cur += ch;
      if (ch === '\\') { cur += params[i + 1] ?? ''; i++; }
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; cur += ch; continue; }
    if ('([{<'.includes(ch)) depth++;
    if (')]}>'.includes(ch)) depth--;
    if (ch === ',' && depth === 0) {
      parts.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

/** Removes default values from a signature: `f(a: int = 3)` -> `f(a: int)`. */
export function stripDefaults(sig: string): string {
  const open = sig.indexOf('(');
  const close = sig.lastIndexOf(')');
  if (open === -1 || close === -1 || close < open) return sig;
  const before = sig.slice(0, open + 1);
  const after = sig.slice(close);
  const inner = sig.slice(open + 1, close);
  const stripped = splitParams(inner).map((p) => {
    // keep `a = 1` -> `a`; keep `a: T = v` -> `a: T`
    let depth = 0;
    for (let i = 0; i < p.length; i++) {
      const c = p[i];
      if (c === '"' || c === "'") {
        const q = c;
        i++;
        while (i < p.length && p[i] !== q) { if (p[i] === '\\') i++; i++; }
        continue;
      }
      if ('([{<'.includes(c)) depth++;
      if (')]}>'.includes(c)) depth--;
      if (c === '=' && depth === 0) return p.slice(0, i).trim();
    }
    return p.trim();
  });
  return before + stripped.join(', ') + after;
}

export function folderOf(relPath: string): string {
  const idx = relPath.lastIndexOf('/');
  return idx === -1 ? '.' : relPath.slice(0, idx) || '.';
}
