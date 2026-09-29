import { ClassInfo, FunctionInfo } from './types';
import { maskCode } from './mask';
import { extractTsJs } from './tsjs';
import { extractPython } from './python';
import { extractJava } from './java';
import { extractCSharp } from './csharp';
import { extractCpp } from './cpp';
import { extractGo } from './go';
import { extractGeneric } from './generic';

export interface FileSymbols {
  classes: ClassInfo[];
  functions: FunctionInfo[];
}

type Extractor = (relPath: string, content: string, masked: string) => FileSymbols;

const TABLE: Record<string, Extractor> = {
  ts: extractTsJs, tsx: extractTsJs, mts: extractTsJs, cts: extractTsJs,
  js: extractTsJs, jsx: extractTsJs, mjs: extractTsJs, cjs: extractTsJs,
  py: extractPython, pyi: extractPython,
  java: extractJava,
  cs: extractCSharp,
  c: extractCpp, h: extractCpp, cpp: extractCpp, cc: extractCpp,
  cxx: extractCpp, hpp: extractCpp, hh: extractCpp, hxx: extractCpp,
  go: extractGo,
};

export function extractSymbols(relPath: string, ext: string, content: string): FileSymbols {
  const masked = maskCode(content, ext).masked;
  const fn = TABLE[ext] ?? extractGeneric;
  try {
    return fn(relPath, content, masked);
  } catch {
    return { classes: [], functions: [] };
  }
}

/** Extensions handled by an accurate (non-generic) extractor. */
export function isAccurateLanguage(ext: string): boolean {
  return ext in TABLE;
}
