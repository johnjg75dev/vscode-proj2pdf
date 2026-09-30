import * as vscode from 'vscode';
import { FileFilterOptions, MinifyLevel, ToggleOptions } from '../config';
import { SectionOptions, defaultSectionOptions } from '../analysis/types';
import { PreviewFile } from '../fileCollector';
import { PresetData, PresetScope } from '../presets';
import { ProjectDetection, parseExtList, parseGlobList } from '../projectDetect';

export interface PanelResult extends PresetData {
  /** Master Analysis toggle (raw sub-section values are preserved in `sections`). */
  analysisEnabled: boolean;
  /** Per-file drop list (relPaths) from the preview tree. Session-only. */
  dropped: string[];
}

export interface PreviewData {
  included: PreviewFile[];
  ignored: PreviewFile[];
  truncated: boolean;
}

export interface PresetRef {
  name: string;
  scope: PresetScope;
}

export interface PanelInit {
  toggles: ToggleOptions;
  minifyLevel: MinifyLevel;
  sections: SectionOptions;
  analysisEnabled: boolean;
  fileFilter: FileFilterOptions;
  detection: ProjectDetection;
  preview: PreviewData;
  gitignoreFiles: string[];
  presets: PresetRef[];
}

/** Host-side services the panel needs (implemented in extension.ts). */
export interface PanelHooks {
  refreshPreview(filter: FileFilterOptions, includeMarkdown: boolean): Promise<PreviewData>;
  savePreset(data: PresetData): Promise<PresetRef | undefined>;
  deletePreset(name: string, scope: PresetScope): Promise<boolean>;
  loadPreset(name: string, scope: PresetScope): PresetData | undefined;
  listPresets(): PresetRef[];
}

const LAST_OPTIONS_KEY = 'projectExporter.lastOptions';
const LAST_SECTIONS_KEY = 'projectExporter.lastSections';
const LAST_FILTER_KEY = 'projectExporter.lastFileFilter';

interface StoredToggles extends Partial<ToggleOptions> {
  minifyLevel?: MinifyLevel;
}

export async function openExportPanel(
  context: vscode.ExtensionContext,
  target: 'pdf' | 'clipboard',
  init: PanelInit,
  hooks: PanelHooks
): Promise<PanelResult | undefined> {
  const stored = context.globalState.get<StoredToggles>(LAST_OPTIONS_KEY, {});
  const storedSections = context.globalState.get<Partial<SectionOptions>>(LAST_SECTIONS_KEY, {});
  const storedFilter = context.globalState.get<Partial<FileFilterOptions>>(LAST_FILTER_KEY, {});
  const initToggles: ToggleOptions = { ...init.toggles, ...stripUndefined(stored) };
  const initMinify: MinifyLevel = stored.minifyLevel ?? init.minifyLevel;
  const initSections: SectionOptions = deepMergeSections(init.sections, storedSections);
  const initFilter: FileFilterOptions = {
    includeExts: storedFilter.includeExts ?? init.fileFilter.includeExts,
    ignoreExts: storedFilter.ignoreExts ?? init.fileFilter.ignoreExts,
    defaultAll: storedFilter.defaultAll ?? init.fileFilter.defaultAll,
    respectGitignore: storedFilter.respectGitignore ?? init.fileFilter.respectGitignore,
    extraIgnores: storedFilter.extraIgnores ?? init.fileFilter.extraIgnores
  };

  const panel = vscode.window.createWebviewPanel(
    'projectExporterConfig',
    target === 'pdf' ? 'Export Project Source — PDF Options' : 'Export Project Source — Clipboard Options',
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true }
  );

  panel.webview.html = htmlFor(target, {
    toggles: initToggles, minifyLevel: initMinify, sections: initSections,
    analysisEnabled: init.analysisEnabled, fileFilter: initFilter,
    detection: init.detection, preview: init.preview,
    gitignoreFiles: init.gitignoreFiles, presets: init.presets
  });

  return new Promise<PanelResult | undefined>((resolve) => {
    let settled = false;
    const done = (v: PanelResult | undefined) => {
      if (settled) return;
      settled = true;
      panel.dispose();
      resolve(v);
    };
    panel.webview.onDidReceiveMessage(async (msg) => {
      try {
        if (msg?.type === 'export') {
          const parsed = parseState(msg.state, target);
          await context.globalState.update(LAST_OPTIONS_KEY, {
            includeMarkdown: parsed.toggles.includeMarkdown,
            syntaxHighlighting: parsed.toggles.syntaxHighlighting,
            minify: parsed.toggles.minify,
            tableOfContents: parsed.toggles.tableOfContents,
            folderStructure: parsed.toggles.folderStructure,
            minifyLevel: parsed.minifyLevel
          });
          await context.globalState.update(LAST_SECTIONS_KEY, parsed.sections);
          await context.globalState.update(LAST_FILTER_KEY, parsed.fileFilter);
          done(parsed);
        } else if (msg?.type === 'cancel') {
          done(undefined);
        } else if (msg?.type === 'refreshPreview') {
          const draft = parseDraftFilter(msg.state ?? {});
          const data = await hooks.refreshPreview(draft.filter, draft.includeMarkdown);
          if (!settled) {
            await panel.webview.postMessage({
              type: 'preview', seq: msg.seq ?? 0,
              included: data.included, ignored: data.ignored, truncated: data.truncated
            });
          }
        } else if (msg?.type === 'savePreset') {
          const parsed = parseState(msg.state ?? {}, target);
          const ref = await hooks.savePreset({
            toggles: parsed.toggles, minifyLevel: parsed.minifyLevel,
            sections: parsed.sections, analysisEnabled: parsed.analysisEnabled,
            fileFilter: parsed.fileFilter
          });
          if (!settled) {
            await panel.webview.postMessage({
              type: 'presetsUpdated', presets: hooks.listPresets(), selected: ref
            });
          }
        } else if (msg?.type === 'deletePreset') {
          await hooks.deletePreset(String(msg.name ?? ''), msg.scope === 'workspace' ? 'workspace' : 'global');
          if (!settled) {
            await panel.webview.postMessage({ type: 'presetsUpdated', presets: hooks.listPresets() });
          }
        } else if (msg?.type === 'loadPreset') {
          const data = hooks.loadPreset(String(msg.name ?? ''), msg.scope === 'workspace' ? 'workspace' : 'global');
          if (!settled) {
            await panel.webview.postMessage(data ? { type: 'applyPreset', data } : { type: 'error', message: 'Preset not found.' });
          }
        }
      } catch (err) {
        if (!settled) {
          await panel.webview.postMessage({
            type: 'error', message: err instanceof Error ? err.message : String(err)
          });
        }
      }
    });
    panel.onDidDispose(() => done(undefined));
  });
}

function stripUndefined(o: StoredToggles): Partial<ToggleOptions> {
  const out: Partial<ToggleOptions> = {};
  for (const k of ['includeMarkdown', 'syntaxHighlighting', 'minify', 'tableOfContents', 'folderStructure'] as const) {
    if (o[k] !== undefined) (out as Record<string, unknown>)[k] = o[k];
  }
  return out;
}

function deepMergeSections(base: SectionOptions, overlay: Partial<SectionOptions>): SectionOptions {
  const merged: SectionOptions = JSON.parse(JSON.stringify(base)) as SectionOptions;
  const d = defaultSectionOptions();
  const full = (id: string): boolean => (overlay as Record<string, unknown>)[id] !== undefined;
  if (overlay.classList) merged.classList = { ...d.classList, ...overlay.classList };
  if (overlay.functionList) merged.functionList = { ...d.functionList, ...overlay.functionList };
  if (overlay.usages) merged.usages = { ...d.usages, ...overlay.usages };
  if (overlay.strings) merged.strings = { ...d.strings, ...overlay.strings };
  if (overlay.dependencies) merged.dependencies = { ...d.dependencies, ...overlay.dependencies };
  if (full('placement')) merged.placement = overlay.placement as SectionOptions['placement'];
  if (overlay.order) merged.order = overlay.order;
  return merged;
}

type PanelState = Record<string, string | boolean | string[]>;

/** Parses just the Files-section draft (used for live preview refresh). */
function parseDraftFilter(state: PanelState): { filter: FileFilterOptions; includeMarkdown: boolean } {
  const str = (k: string, fallback: string): string => {
    const v = state[k];
    return typeof v === 'string' && v ? v : fallback;
  };
  const checkedExts = Array.isArray(state['ff.checked']) ? state['ff.checked'] : [];
  const extraInclude = parseExtList(str('ff.extraInclude', ''));
  const ignoreExts = parseExtList(str('ff.ignore', ''));
  const includeExts = [...new Set(
    [...checkedExts.map((e) => e.toLowerCase()), ...extraInclude].filter((e) => e && !ignoreExts.includes(e))
  )];
  return {
    filter: {
      includeExts,
      ignoreExts,
      defaultAll: str('ff.policy', 'all') !== 'listed',
      respectGitignore: state['ff.gitignore'] === undefined ? true : state['ff.gitignore'] === true,
      extraIgnores: parseGlobList(str('ff.extraIgnores', ''))
    },
    includeMarkdown: state['includeMarkdown'] === true
  };
}

function parseState(state: PanelState, target: 'pdf' | 'clipboard'): PanelResult {
  const b = (k: string): boolean => state[k] === true || state[k] === 'on' || state[k] === 'true';
  const str = (k: string, fallback: string): string => {
    const v = state[k];
    return typeof v === 'string' && v ? v : fallback;
  };
  const num = (k: string, fallback: number): number => {
    const v = Number(state[k]);
    return Number.isFinite(v) ? v : fallback;
  };
  const d = defaultSectionOptions();
  const toggles: ToggleOptions = {
    includeMarkdown: b('includeMarkdown'),
    syntaxHighlighting: target === 'pdf' ? b('syntaxHighlighting') : true,
    minify: b('minify'),
    tableOfContents: b('tableOfContents'),
    folderStructure: b('folderStructure')
  };
  // Sub-section values are parsed untouched so presets + re-enable restore them.
  const sections: SectionOptions = {
    classList: {
      enabled: b('sec.classList.enabled'),
      sort: str('sec.classList.sort', 'alpha') as SectionOptions['classList']['sort'],
      groupBy: str('sec.classList.groupBy', 'flat') as SectionOptions['classList']['groupBy'],
      showCtor: b('sec.classList.showCtor'),
      showMethods: b('sec.classList.showMethods'),
      showFields: str('sec.classList.showFields', 'none') as SectionOptions['classList']['showFields'],
      showDefaults: b('sec.classList.showDefaults'),
      showBaseClass: b('sec.classList.showBaseClass')
    },
    functionList: {
      enabled: b('sec.functionList.enabled'),
      sort: str('sec.functionList.sort', 'alpha') as SectionOptions['functionList']['sort'],
      groupBy: str('sec.functionList.groupBy', 'flat') as SectionOptions['functionList']['groupBy'],
      includeMethods: b('sec.functionList.includeMethods'),
      showSigs: b('sec.functionList.showSigs'),
      showDefaults: b('sec.functionList.showDefaults')
    },
    usages: {
      enabledClasses: b('sec.usages.enabledClasses'),
      enabledFunctions: b('sec.usages.enabledFunctions'),
      contextLines: Math.min(5, Math.max(0, num('sec.usages.contextLines', 0))),
      maxHitsPerSymbol: Math.min(500, Math.max(1, num('sec.usages.maxHitsPerSymbol', 50))),
      skipEmpty: state['sec.usages.skipEmpty'] === undefined ? true : b('sec.usages.skipEmpty'),
      summarizeEmpty: state['sec.usages.summarizeEmpty'] === undefined ? true : b('sec.usages.summarizeEmpty')
    },
    strings: {
      enabled: b('sec.strings.enabled'),
      sort: str('sec.strings.sort', 'alpha') as SectionOptions['strings']['sort'],
      groupBy: str('sec.strings.groupBy', 'flat') as SectionOptions['strings']['groupBy'],
      minLength: Math.min(100, Math.max(1, num('sec.strings.minLength', 2))),
      dedupe: b('sec.strings.dedupe'),
      maxItems: Math.min(50000, Math.max(100, num('sec.strings.maxItems', 5000)))
    },
    dependencies: {
      enabled: b('sec.dependencies.enabled'),
      direction: str('sec.dependencies.direction', 'outgoing') as SectionOptions['dependencies']['direction'],
      showUnresolved: b('sec.dependencies.showUnresolved')
    },
    placement: (str('sec.placement', 'before') === 'after' ? 'after' : 'before'),
    order: d.order
  };
  const minifyLevel: MinifyLevel = state['minifyLevel'] === 'aggressive' ? 'aggressive' : 'collapse';
  const draft = parseDraftFilter(state);
  const dropped = Array.isArray(state['ff.dropped']) ? state['ff.dropped'].map(String) : [];
  return {
    toggles, sections, minifyLevel,
    analysisEnabled: state['sec.analysis.enabled'] === undefined ? true : b('sec.analysis.enabled'),
    fileFilter: draft.filter, dropped
  };
}

function checked(v: boolean): string {
  return v ? 'checked' : '';
}

function selected(cur: string, val: string): string {
  return cur === val ? 'selected' : '';
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c));
}

/** JSON-embeds preview data safely inside a <script> tag. */
function previewJson(data: PreviewData): string {
  return JSON.stringify(data).replace(/</g, '\\u003c');
}

function presetOptions(presets: PresetRef[], selected?: string): string {
  const opts = [`<option value="">Custom…</option>`];
  for (const p of presets.filter((x) => x.scope === 'global')) {
    opts.push(`<option value="global:${escapeHtml(p.name)}"${selected === `global:${p.name}` ? ' selected' : ''}>🌐 ${escapeHtml(p.name)}</option>`);
  }
  for (const p of presets.filter((x) => x.scope === 'workspace')) {
    opts.push(`<option value="workspace:${escapeHtml(p.name)}"${selected === `workspace:${p.name}` ? ' selected' : ''}>📁 ${escapeHtml(p.name)}</option>`);
  }
  return opts.join('');
}

function htmlFor(target: 'pdf' | 'clipboard', init: PanelInit): string {
  const { toggles: t, minifyLevel, sections: s } = init;
  const f = init.fileFilter;
  const detection = init.detection;
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">`;
  const kindsHint = detection.kinds.length > 0
    ? `Detected project type: <b>${detection.kinds.map(escapeHtml).join(', ')}</b>. Pre-selected the extensions you most likely want.`
    : detection.extCounts.length > 0
      ? `No project markers found — pre-selected by file frequency. Adjust below.`
      : `Could not scan the project — showing configured extensions. Adjust below.`;
  const includeSet = new Set(f.includeExts);
  const suggestedSet = new Set(detection.suggested);
  const boxes = detection.extCounts.length > 0
    ? detection.extCounts.map((e) =>
      `<label title="${e.count} file(s)"><input type="checkbox" class="ff-ext" value="${escapeHtml(e.ext)}" data-suggested="${suggestedSet.has(e.ext) ? '1' : '0'}" ${checked(includeSet.has(e.ext))}> .${escapeHtml(e.ext)} <span class="hint">(${e.count})</span></label>`
    ).join('')
    : `<span class="hint">No extensions scanned.</span>`;
  const gitignoreHint = init.gitignoreFiles.length > 0
    ? `${init.gitignoreFiles.length} found: <code>${init.gitignoreFiles.slice(0, 5).map(escapeHtml).join('</code>, <code>')}</code>${init.gitignoreFiles.length > 5 ? ` (+${init.gitignoreFiles.length - 5} more)` : ''}`
    : `No .gitignore files found in scope.`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
${csp}
<style>
body { font-family: var(--vscode-font-family); padding: 16px 20px; color: var(--vscode-foreground); background: var(--vscode-editor-background); }
h1 { font-size: 18px; margin-bottom: 4px; }
h2 { font-size: 14px; margin: 18px 0 8px; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 4px; }
.sub { color: var(--vscode-descriptionForeground); font-size: 12px; margin-bottom: 12px; }
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 18px; }
label.row { display: flex; gap: 8px; align-items: center; padding: 4px 0; font-size: 13px; }
fieldset { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 10px 12px; margin: 10px 0; }
legend { font-weight: 600; font-size: 13px; padding: 0 6px; }
legend.collapsible { cursor: pointer; user-select: none; }
.opts { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 16px; font-size: 12px; }
.opts label { display: flex; gap: 6px; align-items: center; }
.extgrid { display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: 12px; margin: 6px 0; }
.extgrid label { display: flex; gap: 5px; align-items: center; border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 2px 8px; }
select, input[type=number], input[type=text] { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 4px; padding: 2px 6px; }
input[type=text].wide { width: 100%; box-sizing: border-box; margin: 4px 0; }
.actions { margin-top: 18px; display: flex; gap: 10px; align-items: center; }
button { padding: 6px 18px; border-radius: 4px; cursor: pointer; }
button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; }
button.ghost { background: transparent; color: var(--vscode-button-secondaryForeground); border: 1px solid var(--vscode-panel-border); }
button.small { padding: 3px 10px; font-size: 12px; }
.hint { font-size: 11px; color: var(--vscode-descriptionForeground); }
.hidden { display: none !important; }
.presetbar { display: flex; gap: 8px; align-items: center; margin: 4px 0 0; }
.presetbar select { min-width: 220px; }
.master { display: flex; gap: 8px; align-items: center; font-size: 14px; font-weight: 600; margin: 6px 0; }
.master .chev { cursor: pointer; color: var(--vscode-descriptionForeground); }
.tree { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 8px 10px; max-height: 340px; overflow: auto; font-size: 12px; }
.tree ul { list-style: none; margin: 2px 0 2px 14px; padding: 0; }
.tree > ul { margin-left: 0; }
.tree li { margin: 1px 0; }
.tree label { display: inline-flex; gap: 6px; align-items: center; cursor: pointer; }
.tree label.excluded { color: var(--vscode-descriptionForeground); }
.tree .tag { font-size: 10px; border: 1px solid var(--vscode-panel-border); border-radius: 3px; padding: 0 4px; color: var(--vscode-descriptionForeground); }
.tree .size { color: var(--vscode-descriptionForeground); font-size: 11px; }
.tree .folder > label { font-weight: 600; }
.treetools { display: flex; gap: 8px; align-items: center; margin: 6px 0; flex-wrap: wrap; }
#scanNote { font-size: 11px; color: var(--vscode-descriptionForeground); }
#panelError { color: var(--vscode-errorForeground); font-size: 12px; margin-top: 8px; }
</style>
</head>
<body>
<h1>${target === 'pdf' ? 'Export to PDF' : 'Copy to Clipboard'}</h1>
<div class="sub">Analysis sections are optional appendices. Fonts and header/footer templates are configured in Settings (<code>projectExporter.pdf.fonts.*</code>, <code>*.headerTemplate / *.footerTemplate</code> with <code>%%PAGE%% %%PAGES%% %%PROJECT%% %%DATE%% %%TIME%% %%FILE%% %%FILECOUNT%% %%SECTION%%</code>).</div>

<div class="presetbar">
<label class="row" for="presetSelect"><b>Preset</b></label>
<select id="presetSelect">${presetOptions(init.presets)}</select>
<button class="ghost small" id="savePresetBtn">Save as preset…</button>
<button class="ghost small" id="deletePresetBtn">Delete</button>
</div>
<div class="hint">Presets store every setting on this page except per-file picks. 🌐 = global, 📁 = this workspace.</div>

<h2>Output</h2>
<div class="grid">
<label class="row"><input type="checkbox" id="includeMarkdown" ${checked(t.includeMarkdown)}> Include Markdown files <span class="hint">.md/.markdown/.mdx</span></label>
${target === 'pdf' ? `<label class="row"><input type="checkbox" id="syntaxHighlighting" ${checked(t.syntaxHighlighting)}> Syntax highlighting <span class="hint">PDF only</span></label>` : ''}
<label class="row"><input type="checkbox" id="minify" ${checked(t.minify)}> Minify <span class="hint">collapse whitespace</span></label>
<label class="row"><input type="checkbox" id="tableOfContents" ${checked(t.tableOfContents)}> Table of contents</label>
<label class="row"><input type="checkbox" id="folderStructure" ${checked(t.folderStructure)}> Folder structure</label>
<label class="row">Minify level
<select id="minifyLevel">
<option value="collapse" ${selected(minifyLevel, 'collapse')}>collapse</option>
<option value="aggressive" ${selected(minifyLevel, 'aggressive')}>aggressive</option>
</select></label>
</div>

<h2>Files</h2>
<div class="sub">${kindsHint}</div>
<fieldset><legend>Extensions to include</legend>
<div class="extgrid">${boxes}</div>
<label class="hint" for="ff.extraInclude">Extra extensions (comma/space separated, e.g. <code>ts, .py, *.go</code>):</label>
<input type="text" class="wide" id="ff.extraInclude" placeholder="e.g. ts, py, go" value="">
</fieldset>
<fieldset><legend>Extensions to ignore</legend>
<label class="hint" for="ff.ignore">These always win over the include list (e.g. <code>map, lock</code>):</label>
<input type="text" class="wide" id="ff.ignore" placeholder="e.g. map, lock" value="${escapeHtml(f.ignoreExts.join(', '))}">
<label class="row">Files with other extensions
<select id="ff.policy">
<option value="all" ${selected(f.defaultAll ? 'all' : 'listed', 'all')}>Include (default to all files)</option>
<option value="listed" ${selected(f.defaultAll ? 'all' : 'listed', 'listed')}>Exclude (only listed files)</option>
</select></label>
<div class="hint">"Include" also pulls in any other known code types from Settings. "Exclude" exports only what is checked/listed above.</div>
</fieldset>
<fieldset><legend>Ignore rules</legend>
<label class="row"><input type="checkbox" id="ff.gitignore" ${checked(f.respectGitignore)}> Use .gitignore <span class="hint">${gitignoreHint}</span></label>
<label class="hint" for="ff.extraIgnores">Extra ignore globs for this export (one per line or comma-separated):</label>
<input type="text" class="wide" id="ff.extraIgnores" placeholder="e.g. **/*.gen.ts, docs/drafts/**" value="${escapeHtml(f.extraIgnores.join(', '))}">
</fieldset>
<div class="actions">
<button class="ghost" id="resetFilterBtn">Reset to detected</button>
</div>

<fieldset><legend>Selected files <span class="hint" id="fileCounter"></span></legend>
<div class="treetools">
<input type="text" id="treeSearch" placeholder="Filter files…" style="flex:1;min-width:140px">
<button class="ghost small" id="treeAllBtn">Select all</button>
<button class="ghost small" id="treeNoneBtn">Select none</button>
<button class="ghost small" id="treeResetBtn">Reset picks</button>
<span id="scanNote"></span>
</div>
<div class="tree" id="fileTree"></div>
<div class="hint">Uncheck files to drop them from this export (dropped wins over all rules). Greyed rows are excluded by .gitignore. Picks are session-only — use presets for the rest.</div>
</fieldset>

<h2>Analysis</h2>
<div class="master"><input type="checkbox" id="sec.analysis.enabled" ${checked(init.analysisEnabled)}> <label for="sec.analysis.enabled">Enable analysis sections</label> <span class="chev" id="analysisChev">▾</span></div>
<div id="analysisBody" class="${init.analysisEnabled ? '' : 'hidden'}">
<label class="row">Placement
<select id="sec.placement">
<option value="before" ${selected(s.placement, 'before')}>Before source files</option>
<option value="after" ${selected(s.placement, 'after')}>After source files</option>
</select></label>

<fieldset data-sec="classList"><legend class="collapsible" data-target="opts-classList">▾ <input type="checkbox" id="sec.classList.enabled" ${checked(s.classList.enabled)}> Class List</legend>
<div class="opts" id="opts-classList">
<label>Sort <select id="sec.classList.sort">
<option ${selected(s.classList.sort, 'alpha')}>alpha</option><option ${selected(s.classList.sort, 'file')}>file</option><option ${selected(s.classList.sort, 'folder')}>folder</option></select></label>
<label>Group <select id="sec.classList.groupBy">
<option ${selected(s.classList.groupBy, 'flat')}>flat</option><option ${selected(s.classList.groupBy, 'file')}>file</option><option ${selected(s.classList.groupBy, 'folder')}>folder</option></select></label>
<label><input type="checkbox" id="sec.classList.showCtor" ${checked(s.classList.showCtor)}> Ctor signatures</label>
<label><input type="checkbox" id="sec.classList.showMethods" ${checked(s.classList.showMethods)}> Function sigs</label>
<label>Vars <select id="sec.classList.showFields">
<option ${selected(s.classList.showFields, 'none')}>none</option><option ${selected(s.classList.showFields, 'public')}>public</option><option ${selected(s.classList.showFields, 'private')}>private</option><option ${selected(s.classList.showFields, 'both')}>both</option></select></label>
<label><input type="checkbox" id="sec.classList.showDefaults" ${checked(s.classList.showDefaults)}> Default values</label>
<label><input type="checkbox" id="sec.classList.showBaseClass" ${checked(s.classList.showBaseClass)}> Base classes</label>
</div></fieldset>

<fieldset data-sec="functionList"><legend class="collapsible" data-target="opts-functionList">▾ <input type="checkbox" id="sec.functionList.enabled" ${checked(s.functionList.enabled)}> Function List</legend>
<div class="opts" id="opts-functionList">
<label>Sort <select id="sec.functionList.sort">
<option ${selected(s.functionList.sort, 'alpha')}>alpha</option><option ${selected(s.functionList.sort, 'file')}>file</option><option ${selected(s.functionList.sort, 'folder')}>folder</option></select></label>
<label>Group <select id="sec.functionList.groupBy">
<option ${selected(s.functionList.groupBy, 'flat')}>flat</option><option ${selected(s.functionList.groupBy, 'file')}>file</option><option ${selected(s.functionList.groupBy, 'folder')}>folder</option></select></label>
<label><input type="checkbox" id="sec.functionList.includeMethods" ${checked(s.functionList.includeMethods)}> Include methods</label>
<label><input type="checkbox" id="sec.functionList.showSigs" ${checked(s.functionList.showSigs)}> Signatures</label>
<label><input type="checkbox" id="sec.functionList.showDefaults" ${checked(s.functionList.showDefaults)}> Default values</label>
</div></fieldset>

<fieldset data-sec="usages"><legend class="collapsible" data-target="opts-usages">▾ Usages</legend>
<div class="opts" id="opts-usages">
<label><input type="checkbox" id="sec.usages.enabledClasses" ${checked(s.usages.enabledClasses)}> Class usages <span class="hint">file→line per class</span></label>
<label><input type="checkbox" id="sec.usages.enabledFunctions" ${checked(s.usages.enabledFunctions)}> Function usages</label>
<label>Context lines <input type="number" id="sec.usages.contextLines" min="0" max="5" value="${s.usages.contextLines}"></label>
<label>Max hits/symbol <input type="number" id="sec.usages.maxHitsPerSymbol" min="1" max="500" value="${s.usages.maxHitsPerSymbol}"></label>
<label><input type="checkbox" id="sec.usages.skipEmpty" ${checked(s.usages.skipEmpty)}> Skip entries with 0 results</label>
<label><input type="checkbox" id="sec.usages.summarizeEmpty" ${checked(s.usages.summarizeEmpty)}> Combine skipped into one line</label>
</div></fieldset>

<fieldset data-sec="strings"><legend class="collapsible" data-target="opts-strings">▾ <input type="checkbox" id="sec.strings.enabled" ${checked(s.strings.enabled)}> String List</legend>
<div class="opts" id="opts-strings">
<label>Sort <select id="sec.strings.sort">
<option ${selected(s.strings.sort, 'alpha')}>alpha</option><option ${selected(s.strings.sort, 'file')}>file</option></select></label>
<label>Group <select id="sec.strings.groupBy">
<option ${selected(s.strings.groupBy, 'flat')}>flat</option><option ${selected(s.strings.groupBy, 'file')}>file</option></select></label>
<label>Min length <input type="number" id="sec.strings.minLength" min="1" max="100" value="${s.strings.minLength}"></label>
<label><input type="checkbox" id="sec.strings.dedupe" ${checked(s.strings.dedupe)}> Dedupe</label>
<label>Max items <input type="number" id="sec.strings.maxItems" min="100" max="50000" step="100" value="${s.strings.maxItems}"></label>
</div></fieldset>

<fieldset data-sec="dependencies"><legend class="collapsible" data-target="opts-dependencies">▾ <input type="checkbox" id="sec.dependencies.enabled" ${checked(s.dependencies.enabled)}> Dependencies</legend>
<div class="opts" id="opts-dependencies">
<label>Direction <select id="sec.dependencies.direction">
<option ${selected(s.dependencies.direction, 'outgoing')}>outgoing</option><option ${selected(s.dependencies.direction, 'incoming')}>incoming</option><option ${selected(s.dependencies.direction, 'both')}>both</option></select></label>
<label><input type="checkbox" id="sec.dependencies.showUnresolved" ${checked(s.dependencies.showUnresolved)}> Show unresolved</label>
</div>
<div class="hint">Outgoing: under each file, files it relies on. Incoming: files that depend on it.</div>
</fieldset>
</div>

<div class="actions">
<button class="primary" id="exportBtn">Export</button>
<button class="ghost" id="cancelBtn">Cancel</button>
</div>
<div id="panelError"></div>

<script>
window.__INIT_PREVIEW = ${previewJson(init.preview)};
</script>
<script>
var vscode = acquireVsCodeApi();
var RENDER_CAP = 3000;
var dropped = {};
var lastSeq = 0;
var pendingTimer = null;
var treeData = { included: [], ignored: [], truncated: false };

var ids = ['includeMarkdown','syntaxHighlighting','minify','tableOfContents','folderStructure','minifyLevel','ff.extraInclude','ff.ignore','ff.policy','ff.gitignore','ff.extraIgnores','sec.analysis.enabled','sec.placement','sec.classList.enabled','sec.classList.sort','sec.classList.groupBy','sec.classList.showCtor','sec.classList.showMethods','sec.classList.showFields','sec.classList.showDefaults','sec.classList.showBaseClass','sec.functionList.enabled','sec.functionList.sort','sec.functionList.groupBy','sec.functionList.includeMethods','sec.functionList.showSigs','sec.functionList.showDefaults','sec.usages.enabledClasses','sec.usages.enabledFunctions','sec.usages.contextLines','sec.usages.maxHitsPerSymbol','sec.usages.skipEmpty','sec.usages.summarizeEmpty','sec.strings.enabled','sec.strings.sort','sec.strings.groupBy','sec.strings.minLength','sec.strings.dedupe','sec.strings.maxItems','sec.dependencies.enabled','sec.dependencies.direction','sec.dependencies.showUnresolved'];

function el(id) { return document.getElementById(id); }
function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

function collect() {
  var state = {};
  for (var i = 0; i < ids.length; i++) {
    var e = el(ids[i]);
    if (!e) continue;
    if (e.type === 'checkbox') state[ids[i]] = e.checked;
    else state[ids[i]] = e.value;
  }
  state['ff.checked'] = Array.prototype.map.call(document.querySelectorAll('.ff-ext'), function (c) { return c.checked ? c.value : null; }).filter(Boolean);
  state['ff.dropped'] = Object.keys(dropped).filter(function (k) { return dropped[k]; });
  return state;
}

function fmtSize(n) {
  if (n < 0) return '?';
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}

function buildTree(files) {
  var root = { name: '', children: {}, files: [] };
  files.forEach(function (f) {
    var parts = f.relPath.split('/');
    var node = root;
    for (var i = 0; i < parts.length - 1; i++) {
      if (!node.children[parts[i]]) node.children[parts[i]] = { name: parts[i], children: {}, files: [] };
      node = node.children[parts[i]];
    }
    node.files.push(f);
  });
  return root;
}

function renderTree() {
  var q = (el('treeSearch').value || '').toLowerCase();
  var included = treeData.included || [];
  var ignored = treeData.ignored || [];
  var shown = 0;
  var selected = 0;
  function match(f) { return !q || f.relPath.toLowerCase().indexOf(q) !== -1; }
  function fileRow(f, disabled, tag) {
    if (shown >= RENDER_CAP) return '';
    if (!match(f)) return '';
    shown++;
    var isDropped = !!dropped[f.relPath];
    if (!disabled && !isDropped) selected++;
    var cls = disabled || isDropped ? ' class="excluded"' : '';
    var dis = disabled ? ' disabled' : '';
    var chk = (!disabled && !isDropped) ? ' checked' : '';
    var tagHtml = tag ? ' <span class="tag">' + tag + '</span>' : (isDropped ? ' <span class="tag">dropped</span>' : '');
    return '<li><label' + cls + '><input type="checkbox" class="tree-file" data-path="' + esc(f.relPath) + '"' + chk + dis + '> ' +
      esc(f.relPath.split('/').pop()) + ' <span class="size">' + fmtSize(f.sizeBytes) + '</span>' + tagHtml + '</label></li>';
  }
  function folderHtml(node, path, depth) {
    var html = '';
    var folders = Object.keys(node.children).sort();
    var i, sub;
    for (i = 0; i < folders.length; i++) {
      sub = renderFolder(node.children[folders[i]], path, depth);
      if (sub) html += sub;
    }
    node.files.slice().sort(function (a, b) { return a.relPath < b.relPath ? -1 : 1; }).forEach(function (f) {
      html += fileRow(f, false, null);
    });
    return html;
  }
  function renderFolder(node, parentPath, depth) {
    var full = parentPath ? parentPath + '/' + node.name : node.name;
    var inner = folderHtml(node, full, depth + 1);
    if (!inner) return '';
    var open = depth < 1 ? ' open' : '';
    return '<li class="folder"><details' + open + '><summary><label><input type="checkbox" class="tree-folder" data-path="' + esc(full) + '"> ' +
      esc(node.name) + '/</label></summary><ul>' + inner + '</ul></details></li>';
  }
  var root = buildTree(included);
  var html = '<ul>' + folderHtml(root, '', 0) + '</ul>';
  var ignHtml = '';
  ignored.forEach(function (f) {
    if (!match(f)) return;
    ignHtml += fileRow(f, true, 'gitignored');
  });
  if (ignHtml) html += '<div class="hint" style="margin-top:6px">Excluded by .gitignore:</div><ul>' + ignHtml + '</ul>';
  el('fileTree').innerHTML = html;
  refreshFolderStates();
  var total = included.length;
  el('fileCounter').textContent = selected + ' of ' + total + ' selected' + (treeData.truncated ? ' (list truncated)' : '');
  el('scanNote').textContent = shown >= RENDER_CAP ? 'Showing first ' + RENDER_CAP + ' — use the filter box.' : '';
}

function refreshFolderStates() {
  Array.prototype.forEach.call(document.querySelectorAll('.tree-folder'), function (box) {
    var prefix = box.getAttribute('data-path') + '/';
    var kids = Array.prototype.filter.call(document.querySelectorAll('.tree-file'), function (c) {
      return c.getAttribute('data-path').indexOf(prefix) === 0 && !c.disabled;
    });
    var on = kids.filter(function (c) { return c.checked; }).length;
    box.checked = kids.length > 0 && on === kids.length;
    box.indeterminate = on > 0 && on < kids.length;
  });
}

function scheduleRefresh() {
  el('scanNote').textContent = 'Scanning…';
  if (pendingTimer) clearTimeout(pendingTimer);
  pendingTimer = setTimeout(function () {
    lastSeq++;
    vscode.postMessage({ type: 'refreshPreview', seq: lastSeq, state: collect() });
  }, 400);
}

function refreshSectionVisibility() {
  var master = el('sec.analysis.enabled');
  var body = el('analysisBody');
  if (master && body) body.classList.toggle('hidden', !master.checked);
  var pairs = [
    ['sec.classList.enabled', 'opts-classList'],
    ['sec.functionList.enabled', 'opts-functionList'],
    ['sec.strings.enabled', 'opts-strings'],
    ['sec.dependencies.enabled', 'opts-dependencies']
  ];
  pairs.forEach(function (p) {
    var box = el(p[0]);
    var opts = el(p[1]);
    if (box && opts) opts.classList.toggle('hidden', !box.checked);
  });
  var uo = el('opts-usages');
  if (uo) {
    var anyU = (el('sec.usages.enabledClasses') || {}).checked || (el('sec.usages.enabledFunctions') || {}).checked;
    uo.classList.toggle('hidden', !anyU);
  }
}

function applyPresetData(data) {
  function set(id, v) { var e = el(id); if (!e) return; if (e.type === 'checkbox') e.checked = !!v; else e.value = v; }
  if (data.toggles) {
    set('includeMarkdown', data.toggles.includeMarkdown);
    set('syntaxHighlighting', data.toggles.syntaxHighlighting);
    set('minify', data.toggles.minify);
    set('tableOfContents', data.toggles.tableOfContents);
    set('folderStructure', data.toggles.folderStructure);
  }
  if (data.minifyLevel) set('minifyLevel', data.minifyLevel);
  if (typeof data.analysisEnabled === 'boolean') set('sec.analysis.enabled', data.analysisEnabled);
  var s = data.sections || {};
  Object.keys(s).forEach(function (group) {
    if (group === 'order' || group === 'placement') return;
    Object.keys(s[group] || {}).forEach(function (k) {
      set('sec.' + group + '.' + k, s[group][k]);
    });
  });
  if (s.placement) set('sec.placement', s.placement);
  if (data.fileFilter) {
    var inc = data.fileFilter.includeExts || [];
    Array.prototype.forEach.call(document.querySelectorAll('.ff-ext'), function (c) {
      c.checked = inc.indexOf(c.value) !== -1;
    });
    set('ff.extraInclude', '');
    set('ff.ignore', (data.fileFilter.ignoreExts || []).join(', '));
    set('ff.policy', data.fileFilter.defaultAll === false ? 'listed' : 'all');
    set('ff.gitignore', data.fileFilter.respectGitignore !== false);
    set('ff.extraIgnores', (data.fileFilter.extraIgnores || []).join(', '));
  }
  dropped = {};
  refreshSectionVisibility();
  scheduleRefresh();
}

function rebuildPresetSelect(presets, selectedValue) {
  var sel = el('presetSelect');
  var html = '<option value="">Custom…</option>';
  presets.filter(function (p) { return p.scope === 'global'; }).forEach(function (p) {
    html += '<option value="global:' + esc(p.name) + '"' + (selectedValue === 'global:' + p.name ? ' selected' : '') + '>🌐 ' + esc(p.name) + '</option>';
  });
  presets.filter(function (p) { return p.scope === 'workspace'; }).forEach(function (p) {
    html += '<option value="workspace:' + esc(p.name) + '"' + (selectedValue === 'workspace:' + p.name ? ' selected' : '') + '>📁 ' + esc(p.name) + '</option>';
  });
  sel.innerHTML = html;
}

document.getElementById('exportBtn').addEventListener('click', function () { vscode.postMessage({ type: 'export', state: collect() }); });
document.getElementById('cancelBtn').addEventListener('click', function () { vscode.postMessage({ type: 'cancel' }); });
document.getElementById('resetFilterBtn').addEventListener('click', function () {
  document.querySelectorAll('.ff-ext').forEach(function (c) { c.checked = c.getAttribute('data-suggested') === '1'; });
  el('ff.extraInclude').value = '';
  el('ff.ignore').value = '';
  el('ff.policy').value = 'all';
  scheduleRefresh();
});
document.getElementById('analysisChev').addEventListener('click', function () {
  el('analysisBody').classList.toggle('hidden');
});
document.getElementById('sec.analysis.enabled').addEventListener('change', refreshSectionVisibility);
Array.prototype.forEach.call(document.querySelectorAll('fieldset[data-sec] legend.collapsible'), function (leg) {
  leg.addEventListener('click', function (ev) {
    if (ev.target && ev.target.type === 'checkbox') return;
    var t = el(leg.getAttribute('data-target'));
    if (t) t.classList.toggle('hidden');
  });
});
Array.prototype.forEach.call(document.querySelectorAll('fieldset[data-sec] input[type=checkbox]'), function (box) {
  box.addEventListener('change', refreshSectionVisibility);
});
['includeMarkdown', 'ff.policy', 'ff.gitignore'].forEach(function (id) {
  var e = el(id); if (e) e.addEventListener('change', scheduleRefresh);
});
['ff.extraInclude', 'ff.ignore', 'ff.extraIgnores'].forEach(function (id) {
  var e = el(id); if (e) e.addEventListener('input', scheduleRefresh);
});
document.querySelectorAll('.ff-ext').forEach(function (c) { c.addEventListener('change', scheduleRefresh); });

el('treeSearch').addEventListener('input', renderTree);
el('treeAllBtn').addEventListener('click', function () {
  document.querySelectorAll('.tree-file:not(:disabled)').forEach(function (c) {
    c.checked = true; delete dropped[c.getAttribute('data-path')];
  });
  refreshFolderStates(); renderTree();
});
el('treeNoneBtn').addEventListener('click', function () {
  document.querySelectorAll('.tree-file:not(:disabled)').forEach(function (c) {
    c.checked = false; dropped[c.getAttribute('data-path')] = true;
  });
  refreshFolderStates(); renderTree();
});
el('treeResetBtn').addEventListener('click', function () { dropped = {}; renderTree(); });
document.getElementById('fileTree').addEventListener('change', function (ev) {
  var t = ev.target;
  if (!t || !t.getAttribute) return;
  var p = t.getAttribute('data-path');
  if (!p) return;
  if (t.classList.contains('tree-folder')) {
    var prefix = p + '/';
    document.querySelectorAll('.tree-file').forEach(function (c) {
      var cp = c.getAttribute('data-path');
      if (cp.indexOf(prefix) === 0 && !c.disabled) {
        c.checked = t.checked;
        if (t.checked) delete dropped[cp]; else dropped[cp] = true;
      }
    });
  } else if (t.classList.contains('tree-file')) {
    if (t.checked) delete dropped[p]; else dropped[p] = true;
  }
  refreshFolderStates();
  var total = (treeData.included || []).length;
  var selCount = document.querySelectorAll('.tree-file:checked').length;
  el('fileCounter').textContent = selCount + ' of ' + total + ' selected' + (treeData.truncated ? ' (list truncated)' : '');
});

el('presetSelect').addEventListener('change', function () {
  var v = el('presetSelect').value;
  if (!v) return;
  var idx = v.indexOf(':');
  vscode.postMessage({ type: 'loadPreset', name: v.slice(idx + 1), scope: v.slice(0, idx) });
});
document.getElementById('savePresetBtn').addEventListener('click', function () { vscode.postMessage({ type: 'savePreset', state: collect() }); });
document.getElementById('deletePresetBtn').addEventListener('click', function () {
  var v = el('presetSelect').value;
  if (!v) return;
  var idx = v.indexOf(':');
  vscode.postMessage({ type: 'deletePreset', name: v.slice(idx + 1), scope: v.slice(0, idx) });
});

window.addEventListener('message', function (ev) {
  var msg = ev.data || {};
  if (msg.type === 'preview') {
    if (msg.seq !== lastSeq) return;
    treeData = { included: msg.included || [], ignored: msg.ignored || [], truncated: !!msg.truncated };
    renderTree();
  } else if (msg.type === 'applyPreset') {
    applyPresetData(msg.data || {});
  } else if (msg.type === 'presetsUpdated') {
    var selVal = null;
    if (msg.selected) selVal = msg.selected.scope + ':' + msg.selected.name;
    rebuildPresetSelect(msg.presets || [], selVal);
  } else if (msg.type === 'error') {
    el('panelError').textContent = msg.message || 'Something went wrong.';
  }
});

treeData = window.__INIT_PREVIEW || treeData;
refreshSectionVisibility();
renderTree();
</script>
</body>
</html>`;
}