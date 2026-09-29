import { DepEdge } from './types';

/**
 * Strips comments but KEEPS string literals intact, so quoted dependency
 * specs (e.g. `import x from "./b"`, `#include "foo.h"`) survive scanning.
 */
export function stripCommentsKeepStrings(text: string, ext: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let inBlock = false;
  const isPy = ext === 'py' || ext === 'pyi';
  for (const line of lines) {
    let res = '';
    let i = 0;
    let quote: string | null = null;
    while (i < line.length) {
      if (inBlock) {
        const end = line.indexOf('*/', i);
        if (end === -1) { i = line.length; break; }
        i = end + 2;
        inBlock = false;
        continue;
      }
      const ch = line[i];
      const two = line.slice(i, i + 2);
      if (quote) {
        res += ch;
        if (ch === '\\') {
          res += line[i + 1] ?? '';
          i += 2;
          continue;
        }
        if (ch === quote) quote = null;
        i++;
        continue;
      }
      if (two === '/*' && !isPy) { inBlock = true; i += 2; continue; }
      if (two === '//' && !isPy) break;
      if (ch === '#' && isPy) break;
      if (ch === '"' || ch === "'" || ch === '`') { quote = ch; res += ch; i++; continue; }
      res += ch;
      i++;
    }
    out.push(res);
  }
  return out.join('\n');
}

/** Extracts raw dependency specs per language, then resolves to collected files. */
export function extractDependencies(
  files: { relPath: string; content: string; ext: string }[],
  showUnresolved: boolean
): { edges: DepEdge[]; dependents: Map<string, string[]> } {
  const rawEdges: { from: string; raw: string }[] = [];

  for (const f of files) {
    const code = stripCommentsKeepStrings(f.content, f.ext);
    for (const spec of rawSpecsFor(f.ext, code)) {
      rawEdges.push({ from: f.relPath, raw: spec });
    }
  }

  // resolution index: basename / stem / path-suffix -> relPath
  const byBase = new Map<string, string[]>();
  const byStem = new Map<string, string[]>();
  for (const f of files) {
    const base = f.relPath.split('/').pop()!.toLowerCase();
    const stem = base.replace(/\.[^.]+$/, '');
    pushMap(byBase, base, f.relPath);
    pushMap(byStem, stem, f.relPath);
  }

  const edges: DepEdge[] = [];
  for (const r of rawEdges) {
    const to = resolveSpec(r.raw, r.from, byBase, byStem, files.map((f) => f.relPath));
    if (to) {
      if (to !== r.from) edges.push({ from: r.from, to, raw: r.raw, resolved: true });
    } else if (showUnresolved) {
      edges.push({ from: r.from, to: r.raw, raw: r.raw, resolved: false });
    }
  }

  // dedupe
  const seen = new Set<string>();
  const uniq = edges.filter((e) => {
    const k = `${e.from}\0${e.to}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  uniq.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));

  const dependents = new Map<string, string[]>();
  for (const e of uniq) {
    if (!e.resolved) continue;
    const arr = dependents.get(e.to) ?? [];
    if (!arr.includes(e.from)) arr.push(e.from);
    dependents.set(e.to, arr);
  }
  for (const arr of dependents.values()) arr.sort();

  return { edges: uniq, dependents };
}

function pushMap(m: Map<string, string[]>, k: string, v: string): void {
  const arr = m.get(k) ?? [];
  if (!arr.includes(v)) arr.push(v);
  m.set(k, arr);
}

function resolveSpec(
  spec: string,
  from: string,
  byBase: Map<string, string[]>,
  byStem: Map<string, string[]>,
  allPaths: string[]
): string | null {
  const clean = spec.trim().replace(/^['"]|['"]$/g, '');
  if (!clean || clean.startsWith('http://') || clean.startsWith('https://')) return null;
  // skip stdlib-ish bare imports without path separators for compiled langs? keep as unresolved
  const lower = clean.toLowerCase();

  // relative path: ./x, ../x, /abs
  if (clean.startsWith('.') || clean.startsWith('/')) {
    const fromDir = from.includes('/') ? from.slice(0, from.lastIndexOf('/')) : '';
    const parts = (fromDir ? fromDir + '/' + clean : clean).split('/');
    const norm: string[] = [];
    for (const p of parts) {
      if (p === '' || p === '.') continue;
      if (p === '..') norm.pop();
      else norm.push(p);
    }
    const joined = norm.join('/');
    // try exact, + extension, /index
    const candidates = [joined, joined + '.ts', joined + '.tsx', joined + '.js', joined + '.jsx', joined + '.py', joined + '.java', joined + '.cs', joined + '.go', joined + '.cpp', joined + '.h', joined + '/index.ts', joined + '/index.js', joined + '/__init__.py'];
    for (const c of candidates) {
      const hit = allPaths.find((p) => p === c || p.toLowerCase() === c.toLowerCase());
      if (hit) return hit;
    }
    // suffix match on last segment stem
    const stem = joined.split('/').pop()!.replace(/\.[^.]+$/, '').toLowerCase();
    const hits = byStem.get(stem);
    if (hits?.length === 1) return hits[0];
    return null;
  }

  // dotted / package spec: com.foo.Bar, os, sys, lodash
  const last = lower.split(/[./\\:]/).pop()!;
  // exact basename match
  const baseHits = byBase.get(last) ?? byBase.get(last + '.py') ?? byBase.get(last + '.java') ?? [];
  if (baseHits.length === 1) return baseHits[0];
  const stemHits = byStem.get(last) ?? [];
  if (stemHits.length === 1) return stemHits[0];
  // path-suffix match (foo/bar)
  const suffixHits = allPaths.filter((p) => p.toLowerCase().endsWith('/' + lower) || p.toLowerCase() === lower);
  if (suffixHits.length === 1) return suffixHits[0];
  return null;
}

function rawSpecsFor(ext: string, masked: string): string[] {
  const specs: string[] = [];
  const push = (s: string | undefined): void => {
    if (s && s.trim()) specs.push(s.trim());
  };

  const patterns: RegExp[] = [];
  if (['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs', 'vue', 'svelte', 'astro'].includes(ext)) {
    patterns.push(
      /^\s*import\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/gm,
      /^\s*export\s+(?:[^'"]*?\s+from\s+)['"]([^'"]+)['"]/gm,
      /(?:require|import)\s*\(\s*['"]([^'"]+)['"]\s*\)/g
    );
  }
  if (['py', 'pyi'].includes(ext)) {
    patterns.push(
      /^\s*import\s+([A-Za-z_][\w., ]*)/gm,
      /^\s*from\s+([A-Za-z_.][\w.]*)\s+import\b/gm
    );
  }
  if (['java', 'kt', 'kts', 'scala', 'groovy'].includes(ext)) {
    patterns.push(/^\s*import\s+(?:static\s+)?([\w.]+)(?:\s*\*)?;/gm);
  }
  if (['cs', 'fs', 'vb'].includes(ext)) {
    patterns.push(/^\s*using\s+([\w.]+)\s*;/gm);
  }
  if (['c', 'h', 'cpp', 'cc', 'cxx', 'hpp', 'hh', 'hxx', 'm', 'mm'].includes(ext)) {
    patterns.push(/^\s*#\s*include\s*[<"]([^>"]+)[>"]/gm);
  }
  if (ext === 'go') {
    patterns.push(/^\s*(?:import\s+(?:\(\s*)?["']([^"']+)["']|["']([^"']+\/[^"']+)["'])/gm);
  }
  if (['rs'].includes(ext)) {
    patterns.push(/^\s*use\s+([\w:]+)(?:::\*)?\s*;/gm);
  }
  if (['rb'].includes(ext)) {
    patterns.push(/^\s*(?:require|require_relative|load)\s+['"]([^'"]+)['"]/gm);
  }
  if (['php'].includes(ext)) {
    patterns.push(/^\s*(?:require|include)(?:_once)?\s*\(?\s*['"]([^'"]+)['"]/gm);
  }
  if (patterns.length === 0) {
    // generic fallback: ES import + python import + include
    patterns.push(
      /^\s*import\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/gm,
      /^\s*from\s+([A-Za-z_.][\w.]*)\s+import\b/gm,
      /^\s*#\s*include\s*[<"]([^>"]+)[>"]/gm
    );
  }

  for (const re of patterns) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(masked)) !== null) {
      // python `import a, b.c` -> split
      const group = m[1] ?? m[2] ?? m[0];
      if (ext === 'py' || ext === 'pyi') {
        if (/^\s*import\s/.test(m[0])) {
          for (const part of group.split(',')) push(part.split(/\s+as\s+/)[0]);
          continue;
        }
      }
      push(group);
    }
  }
  return specs;
}
