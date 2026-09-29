import { UsageRef } from './types';
import { maskCode } from './mask';

export interface UsageOptions {
  maxHitsPerSymbol: number;
  contextLines: number;
}

/**
 * Second pass over collected files: for each class/function name, finds
 * instantiation / call sites. Definition lines and comment/string zones
 * (via mask) are excluded.
 */
export function findUsages(
  files: { relPath: string; content: string; ext: string }[],
  classNames: string[],
  functionNames: string[],
  defLines: Map<string, Set<string>>, // name -> set of "file:line"
  opts: UsageOptions
): { classUsages: Map<string, UsageRef[]>; functionUsages: Map<string, UsageRef[]>; truncated: boolean } {
  const classUsages = new Map<string, UsageRef[]>();
  const functionUsages = new Map<string, UsageRef[]>();
  for (const n of classNames) classUsages.set(n, []);
  for (const n of functionNames) functionUsages.set(n, []);
  let truncated = false;

  if (classNames.length === 0 && functionNames.length === 0) {
    return { classUsages, functionUsages, truncated };
  }

  // Pre-compile patterns per name. Cap total names to avoid pathological regex counts.
  const MAX_NAMES = 2000;
  const cnames = classNames.slice(0, MAX_NAMES);
  const fnames = functionNames.slice(0, MAX_NAMES);

  const classPats = new Map<string, RegExp>();
  for (const n of cnames) {
    // new X( | X( | X{ | X:: | : X | = X(  — keep broad, filter defs via defLines
    classPats.set(n, new RegExp(`\\b${escapeRe(n)}\\b\\s*(?:\\(|\\{|::|<)`, 'g'));
    // also bare `new X` without paren
    if (!classPats.has(n + '#new')) {
      classPats.set(n + '#new', new RegExp(`\\bnew\\s+${escapeRe(n)}\\b`, 'g'));
    }
  }
  const fnPats = new Map<string, RegExp>();
  for (const n of fnames) {
    fnPats.set(n, new RegExp(`\\b${escapeRe(n)}\\s*\\(`, 'g'));
  }

  for (const f of files) {
    const { masked, lines } = maskCode(f.content, f.ext);
    const mlines = masked.split('\n');

    for (let li = 0; li < lines.length; li++) {
      const mline = mlines[li];
      if (!mline.trim()) continue;

      for (const n of cnames) {
        const arr = classUsages.get(n)!;
        if (arr.length >= opts.maxHitsPerSymbol) continue;
        const key = `${f.relPath}:${li + 1}`;
        if (defLines.get(n)?.has(key)) continue;
        const re1 = classPats.get(n)!;
        const re2 = classPats.get(n + '#new')!;
        re1.lastIndex = 0;
        re2.lastIndex = 0;
        if (re1.test(mline) || re2.test(mline)) {
          if (arr.length >= opts.maxHitsPerSymbol) { truncated = true; continue; }
          arr.push({ file: f.relPath, line: li + 1, code: snippet(lines, li, opts.contextLines) });
        }
      }
      for (const n of fnames) {
        // skip if same name is also a class (avoid double count); class match takes precedence
        if (classPats.has(n)) continue;
        const arr = functionUsages.get(n)!;
        if (arr.length >= opts.maxHitsPerSymbol) continue;
        const key = `${f.relPath}:${li + 1}`;
        if (defLines.get(n)?.has(key)) continue;
        const re = fnPats.get(n)!;
        re.lastIndex = 0;
        if (re.test(mline)) {
          if (arr.length >= opts.maxHitsPerSymbol) { truncated = true; continue; }
          // skip lines that look like definitions: `function n(`, `def n(`, `void n(`
          if (/^\s*(?:export\s+|async\s+|static\s+|public\s+|private\s+|protected\s+|def\s+|function\s+|func\s+|fn\s+|sub\s+)?[\w<>\[\]]*\s*\b/.test(mline) && /(function|def|func|fn|sub)\s+$/.test(mline.slice(0, mline.indexOf(n)))) continue;
          arr.push({ file: f.relPath, line: li + 1, code: snippet(lines, li, opts.contextLines) });
        }
      }
    }
  }

  return { classUsages, functionUsages, truncated };
}

function snippet(lines: string[], idx: number, ctx: number): string {
  if (ctx <= 0) return lines[idx].trim().slice(0, 220);
  const from = Math.max(0, idx - ctx);
  const to = Math.min(lines.length - 1, idx + ctx);
  return lines.slice(from, to + 1).join('\n').trim().slice(0, 400);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
