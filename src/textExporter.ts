import { ClipboardSettings, ExportOptions } from './config';
import { SourceFile } from './fileCollector';
import { fenceLanguage } from './highlighter';
import { minifyText } from './minify';
import { buildTreeLines } from './tree';
import { AnalysisResult } from './analysis/types';
import { stripDefaults } from './analysis/mask';
import { renderTemplate } from './headerFooter';

export interface ClipboardRenderRequest {
  projectName: string;
  files: SourceFile[];
  options: ExportOptions;
  settings: ClipboardSettings;
  analysis?: AnalysisResult | null;
}

export function buildClipboardText(
  projectName: string,
  files: SourceFile[],
  options: ExportOptions,
  settings: ClipboardSettings,
  analysis?: AnalysisResult | null
): string;
export function buildClipboardText(req: ClipboardRenderRequest): string;
export function buildClipboardText(
  projectNameOrReq: string | ClipboardRenderRequest,
  files?: SourceFile[],
  options?: ExportOptions,
  settings?: ClipboardSettings,
  analysis?: AnalysisResult | null
): string {
  const projectName = typeof projectNameOrReq === 'string' ? projectNameOrReq : projectNameOrReq.projectName;
  const fileList = typeof projectNameOrReq === 'string' ? files! : projectNameOrReq.files;
  const opts = typeof projectNameOrReq === 'string' ? options! : projectNameOrReq.options;
  const cfg = typeof projectNameOrReq === 'string' ? settings! : projectNameOrReq.settings;
  const data = typeof projectNameOrReq === 'string' ? analysis : projectNameOrReq.analysis;

  const out: string[] = [];
  const gap = () => { if (!opts.minify) out.push(''); };
  const totalLines = fileList.reduce((n, f) => n + f.lineCount, 0);
  const now = new Date();
  const ctxBase = {
    project: projectName, page: 0, pages: 0,
    fileCount: fileList.length,
    date: now.toLocaleDateString(), time: now.toLocaleTimeString()
  };

  if (cfg.headerTemplate) {
    const h = renderTemplate(cfg.headerTemplate, ctxBase, now);
    if (h) {
      out.push(h);
      gap();
    }
  }

  out.push(`# ${projectName}`);
  gap();
  out.push(`${fileList.length} files, ${totalLines} lines`);
  gap();

  if (opts.tableOfContents) {
    out.push('## Table of Contents');
    gap();
    const ordered = sectionOrder(opts);
    if (opts.sections?.placement === 'before') {
      for (const id of ordered) out.push(`- ${sectionTitle(id)}`);
    }
    fileList.forEach((f, i) => out.push(`${i + 1}. ${f.relPath} (${f.lineCount} lines)`));
    if (opts.sections?.placement === 'after') {
      for (const id of ordered) out.push(`- ${sectionTitle(id)}`);
    }
    gap();
  }

  if (opts.folderStructure) {
    out.push('## Folder Structure');
    gap();
    out.push('```', ...buildTreeLines(fileList.map((f) => f.relPath), projectName, 'unicode'), '```');
    gap();
  }

  const renderSections = () => {
    if (!data) return;
    for (const id of sectionOrder(opts)) {
      out.push(`## ${sectionTitle(id)}`);
      gap();
      if (id === 'classList') renderClassList(out, data, opts, gap);
      else if (id === 'functionList') renderFunctionList(out, data, opts, gap);
      else if (id === 'usages') renderUsages(out, data, opts, gap);
      else if (id === 'strings') renderStrings(out, data, opts, gap);
      else if (id === 'dependencies') renderDependencies(out, data, opts, fileList.map((f) => f.relPath), gap);
      gap();
    }
  };

  const renderFiles = () => {
    out.push('## Source Files');
    gap();

    for (const f of fileList) {
      const body = opts.minify ? minifyText(f.content, opts.minifyLevel) : f.content;
      if (cfg.useCodeFences) {
        const fence = fenceFor(body);
        out.push(`### ${f.relPath}`);
        gap();
        out.push(`${fence}${fenceLanguage(f.ext)}`, body, fence);
      } else {
        out.push(`===== ${f.relPath} =====`, body);
      }
      gap();
    }
  };

  if (opts.sections?.placement === 'after') {
    renderFiles();
    renderSections();
  } else {
    renderSections();
    renderFiles();
  }

  if (cfg.footerTemplate) {
    const ft = renderTemplate(cfg.footerTemplate, ctxBase, now);
    if (ft) {
      out.push(ft);
      gap();
    }
  }

  return out.join('\n');
}

function sectionTitle(id: string): string {
  if (id === 'classList') return 'Class List';
  if (id === 'functionList') return 'Function List';
  if (id === 'usages') return 'Usages';
  if (id === 'strings') return 'String List';
  if (id === 'dependencies') return 'Dependencies';
  return id;
}

function sectionOrder(opts: ExportOptions): string[] {
  const s = opts.sections;
  if (!s) return [];
  const enabled = (id: string): boolean => {
    if (id === 'classList') return s.classList.enabled;
    if (id === 'functionList') return s.functionList.enabled;
    if (id === 'usages') return s.usages.enabledClasses || s.usages.enabledFunctions;
    if (id === 'strings') return s.strings.enabled;
    if (id === 'dependencies') return s.dependencies.enabled;
    return false;
  };
  return (s.order ?? []).filter(enabled);
}

function sigFor(sig: string, showDefaults: boolean): string {
  return showDefaults ? sig : stripDefaults(sig);
}

function renderClassList(out: string[], data: AnalysisResult, opts: ExportOptions, gap: () => void): void {
  const o = opts.sections.classList;
  if (data.classes.length === 0) {
    out.push('_(no classes found)_');
    return;
  }
  let lastGroup = '';
  for (const cls of data.classes) {
    const group = o.groupBy === 'file' ? cls.file : o.groupBy === 'folder' ? cls.folder : '';
    if (group && group !== lastGroup) {
      out.push(`### ${group}`);
      gap();
      lastGroup = group;
    }
    let title = `**${cls.name}**`;
    if (o.showBaseClass && cls.baseClasses.length > 0) title += ` : ${cls.baseClasses.join(', ')}`;
    out.push(`- ${title} — \`${cls.file}:${cls.line}\``);
    if (o.showCtor && cls.ctorSig) out.push(`  - ctor \`${sigFor(cls.ctorSig, o.showDefaults)}\``);
    if (o.showMethods) {
      for (const m of cls.methods) out.push(`  - [${m.visibility}] \`${sigFor(m.sig, o.showDefaults)}\``);
    }
    if (o.showFields !== 'none') {
      for (const f of cls.fields) {
        if (o.showFields === 'public' && f.visibility !== 'public' && f.visibility !== 'protected') continue;
        if (o.showFields === 'private' && f.visibility !== 'private') continue;
        const def = o.showDefaults && f.defaultValue ? ` = ${f.defaultValue}` : '';
        out.push(`  - [${f.visibility}] \`${f.name}${f.type ? `: ${f.type}` : ''}${def}\``);
      }
    }
  }
}

function renderFunctionList(out: string[], data: AnalysisResult, opts: ExportOptions, gap: () => void): void {
  const o = opts.sections.functionList;
  let list = data.functions;
  if (!o.includeMethods) list = list.filter((f) => !f.parentClass);
  if (list.length === 0) {
    out.push('_(no functions found)_');
    return;
  }
  let lastGroup = '';
  for (const fn of list) {
    const group = o.groupBy === 'file' ? fn.file : o.groupBy === 'folder' ? fn.folder : '';
    if (group && group !== lastGroup) {
      out.push(`### ${group}`);
      gap();
      lastGroup = group;
    }
    const label = o.showSigs ? sigFor(fn.sig, o.showDefaults) : fn.name;
    out.push(`- \`${fn.parentClass ? fn.parentClass + '.' : ''}${label}\` — \`${fn.file}:${fn.line}\``);
  }
}

function renderUsageKind(
  out: string[], title: string, unit: 'use' | 'call',
  entries: Map<string, import('./analysis/types').UsageRef[]>,
  opts: ExportOptions, gap: () => void
): boolean {
  const o = opts.sections.usages;
  out.push(`### ${title}`);
  gap();
  const names = [...entries.keys()].sort();
  const empty: string[] = [];
  let any = false;
  for (const name of names) {
    const hits = entries.get(name) ?? [];
    if (hits.length === 0 && o.skipEmpty) {
      empty.push(name);
      continue;
    }
    out.push(`**${name}** — ${hits.length} ${unit}${hits.length === 1 ? '' : 's'}`);
    if (hits.length === 0) out.push('- _(none)_');
    for (const h of hits) out.push(`- \`${h.file}:${h.line}\` ${h.code.split('\n')[0].slice(0, 160)}`);
    gap();
    any = true;
  }
  if (empty.length > 0 && o.skipEmpty && o.summarizeEmpty) {
    const shown = empty.slice(0, 100);
    const rest = empty.length - shown.length;
    const label = unit === 'use' ? 'classes' : 'functions';
    out.push(`_${empty.length} ${label} with no ${unit}s:_ ${shown.join(', ')}${rest > 0 ? ` (+${rest} more)` : ''}`);
    gap();
    any = true;
  }
  if (!any && names.length > 0) out.push('_(no usages found)_');
  return any;
}

function renderUsages(out: string[], data: AnalysisResult, opts: ExportOptions, gap: () => void): void {
  const o = opts.sections.usages;
  if (o.enabledClasses) renderUsageKind(out, 'Class usages', 'use', data.classUsages, opts, gap);
  if (o.enabledFunctions) renderUsageKind(out, 'Function usages', 'call', data.functionUsages, opts, gap);
  if (data.truncated.usages) out.push('_(truncated: hit cap reached)_');
}

function renderStrings(out: string[], data: AnalysisResult, opts: ExportOptions, gap: () => void): void {
  const o = opts.sections.strings;
  if (data.strings.length === 0) {
    out.push('_(no strings found)_');
    return;
  }
  if (o.groupBy === 'file') {
    let lastFile = '';
    for (const s of data.strings) {
      if (s.file !== lastFile) {
        out.push(`### ${s.file}`);
        gap();
        lastFile = s.file;
      }
      out.push(`- L${s.line}: \`"${s.value.slice(0, 200).replace(/`/g, "'")}"\``);
    }
  } else {
    for (const s of data.strings) {
      out.push(`- \`"${s.value.slice(0, 200).replace(/`/g, "'")}"\` — \`${s.file}:${s.line}\``);
    }
  }
  if (data.truncated.strings) out.push('_(truncated: item cap reached)_');
}

function renderDependencies(
  out: string[], data: AnalysisResult, opts: ExportOptions, allFiles: string[], gap: () => void
): void {
  const o = opts.sections.dependencies;
  if (data.dependencies.length === 0) {
    out.push('_(no dependencies found)_');
    return;
  }
  if (o.direction === 'outgoing' || o.direction === 'both') {
    if (o.direction === 'both') {
      out.push('### Outgoing');
      gap();
    }
    const byFrom = new Map<string, typeof data.dependencies>();
    for (const e of data.dependencies) {
      const arr = byFrom.get(e.from) ?? [];
      arr.push(e);
      byFrom.set(e.from, arr);
    }
    for (const from of [...byFrom.keys()].sort()) {
      out.push(`**${from}**`);
      for (const e of byFrom.get(from)!) out.push(`- → \`${e.to}\`${e.resolved ? '' : ' (unresolved)'}`);
      gap();
    }
  }
  if (o.direction === 'incoming' || o.direction === 'both') {
    if (o.direction === 'both') {
      out.push('### Incoming');
      gap();
    }
    const incoming = new Map<string, string[]>();
    for (const e of data.dependencies) {
      if (!e.resolved) continue;
      const arr = incoming.get(e.to) ?? [];
      if (!arr.includes(e.from)) arr.push(e.from);
      incoming.set(e.to, arr);
    }
    for (const f of allFiles) if (!incoming.has(f)) incoming.set(f, []);
    for (const to of [...incoming.keys()].sort()) {
      const deps = incoming.get(to)!;
      out.push(`**${to}** — ${deps.length} dependent${deps.length === 1 ? '' : 's'}`);
      for (const d of deps.sort()) out.push(`- ← \`${d}\``);
      gap();
    }
  }
}

/** Uses a fence longer than any backtick run inside the file. */
function fenceFor(body: string): string {
  const runs = body.match(/`{3,}/g) ?? [];
  const longest = runs.reduce((m, r) => Math.max(m, r.length), 0);
  return '`'.repeat(Math.max(3, longest + 1));
}
