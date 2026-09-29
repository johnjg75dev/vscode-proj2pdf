import { SourceFile } from '../fileCollector';
import {
  AnalysisResult, SectionOptions, anySectionEnabled,
  ClassInfo, FunctionInfo
} from './types';
import { extractSymbols } from './registry';
import { extractStrings, sortStrings } from './strings';
import { extractDependencies } from './dependencies';
import { findUsages } from './usages';
import { compareNames } from '../util';

export { defaultSectionOptions, anySectionEnabled } from './types';
export type { AnalysisResult, SectionOptions } from './types';

export interface AnalysisProgress {
  onProgress?: (message: string) => void;
  isCancelled?: () => boolean;
}

function sortClasses(classes: ClassInfo[], sort: string): ClassInfo[] {
  const arr = [...classes];
  if (sort === 'alpha') arr.sort((a, b) => compareNames(a.name, b.name) || a.file.localeCompare(b.file));
  else if (sort === 'file') arr.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  else arr.sort((a, b) => a.folder.localeCompare(b.folder) || compareNames(a.name, b.name));
  return arr;
}

function sortFunctions(fns: FunctionInfo[], sort: string): FunctionInfo[] {
  const arr = [...fns];
  if (sort === 'alpha') arr.sort((a, b) => compareNames(a.name, b.name) || a.file.localeCompare(b.file));
  else if (sort === 'file') arr.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  else arr.sort((a, b) => a.folder.localeCompare(b.folder) || compareNames(a.name, b.name));
  return arr;
}

/** Runs all enabled analysis sections over collected files. */
export async function analyzeFiles(
  files: SourceFile[],
  sections: SectionOptions,
  progress?: AnalysisProgress
): Promise<AnalysisResult | null> {
  if (!anySectionEnabled(sections)) return null;

  const needSymbols =
    sections.classList.enabled || sections.functionList.enabled ||
    sections.usages.enabledClasses || sections.usages.enabledFunctions;
  const needStrings = sections.strings.enabled;
  const needDeps = sections.dependencies.enabled;

  let classes: ClassInfo[] = [];
  let functions: FunctionInfo[] = [];

  if (needSymbols) {
    for (let i = 0; i < files.length; i++) {
      if (progress?.isCancelled?.()) {
        const { ExportCancelledError } = await import('../util');
        throw new ExportCancelledError();
      }
      if (i % 10 === 0) {
        progress?.onProgress?.(`Analyzing ${i + 1}/${files.length}: ${files[i].relPath}`);
        await new Promise((r) => setImmediate(r));
      }
      const f = files[i];
      const sym = extractSymbols(f.relPath, f.ext, f.content);
      classes.push(...sym.classes);
      functions.push(...sym.functions);
    }
    classes = sortClasses(classes, sections.classList.sort);
    functions = sortFunctions(functions, sections.functionList.sort);
  }

  // def lines map for usage filtering
  const defLines = new Map<string, Set<string>>();
  const addDef = (name: string, file: string, line: number): void => {
    const k = `${file}:${line}`;
    let s = defLines.get(name);
    if (!s) { s = new Set(); defLines.set(name, s); }
    s.add(k);
  };
  for (const c of classes) addDef(c.name, c.file, c.line);
  for (const fn of functions) addDef(fn.name, fn.file, fn.line);

  let classUsages = new Map<string, import('./types').UsageRef[]>();
  let functionUsages = new Map<string, import('./types').UsageRef[]>();
  let usagesTruncated = false;

  if (sections.usages.enabledClasses || sections.usages.enabledFunctions) {
    progress?.onProgress?.('Finding usages...');
    const cnames = sections.usages.enabledClasses ? [...new Set(classes.map((c) => c.name))] : [];
    let fnames = sections.usages.enabledFunctions ? [...new Set(functions.map((f) => f.name))] : [];
    // cap names for perf
    if (cnames.length + fnames.length > 2000) {
      fnames = fnames.slice(0, Math.max(0, 2000 - cnames.length));
      usagesTruncated = true;
    }
    const res = findUsages(
      files, cnames, fnames, defLines,
      { maxHitsPerSymbol: sections.usages.maxHitsPerSymbol, contextLines: sections.usages.contextLines }
    );
    classUsages = res.classUsages;
    functionUsages = res.functionUsages;
    usagesTruncated = usagesTruncated || res.truncated;
    await new Promise((r) => setImmediate(r));
  }

  let strings: import('./types').StringRef[] = [];
  let stringsTruncated = false;
  if (needStrings) {
    progress?.onProgress?.('Extracting strings...');
    const res = extractStrings(files, { minLength: sections.strings.minLength, maxItems: sections.strings.maxItems });
    strings = sortStrings(res.items, sections.strings);
    stringsTruncated = res.truncated;
  }

  let edges: import('./types').DepEdge[] = [];
  let dependents = new Map<string, string[]>();
  if (needDeps) {
    progress?.onProgress?.('Resolving dependencies...');
    const res = extractDependencies(files, sections.dependencies.showUnresolved);
    edges = res.edges;
    dependents = res.dependents;
  }

  return {
    classes, functions, strings,
    dependencies: edges, dependents,
    classUsages, functionUsages,
    truncated: { usages: usagesTruncated, strings: stringsTruncated }
  };
}
