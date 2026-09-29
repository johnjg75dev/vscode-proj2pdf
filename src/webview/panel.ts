import * as vscode from 'vscode';
import { FileFilterOptions, MinifyLevel, ToggleOptions } from '../config';
import { SectionOptions, defaultSectionOptions } from '../analysis/types';
import { ProjectDetection, parseExtList } from '../projectDetect';

export interface PanelResult {
  toggles: ToggleOptions;
  sections: SectionOptions;
  minifyLevel: MinifyLevel;
  fileFilter: FileFilterOptions;
}

export interface PanelInit {
  toggles: ToggleOptions;
  minifyLevel: MinifyLevel;
  sections: SectionOptions;
  /** Effective include set when the user has no stored filter (usually detected). */
  fileFilter: FileFilterOptions;
  detection: ProjectDetection;
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
  init: PanelInit
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
    defaultAll: storedFilter.defaultAll ?? init.fileFilter.defaultAll
  };

  const panel = vscode.window.createWebviewPanel(
    'projectExporterConfig',
    target === 'pdf' ? 'Export Project Source — PDF Options' : 'Export Project Source — Clipboard Options',
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true }
  );

  panel.webview.html = htmlFor(target, initToggles, initMinify, initSections, initFilter, init.detection);

  return new Promise<PanelResult | undefined>((resolve) => {
    let settled = false;
    const done = (v: PanelResult | undefined) => {
      if (settled) return;
      settled = true;
      panel.dispose();
      resolve(v);
    };
    panel.webview.onDidReceiveMessage(async (msg) => {
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

  // File filter: checked boxes + free-form extras, minus ignored.
  const checkedExts = Array.isArray(state['ff.checked']) ? state['ff.checked'] : [];
  const extraInclude = parseExtList(str('ff.extraInclude', ''));
  const ignoreExts = parseExtList(str('ff.ignore', ''));
  const includeExts = [...new Set(
    [...checkedExts.map((e) => e.toLowerCase()), ...extraInclude].filter((e) => e && !ignoreExts.includes(e))
  )];
  const fileFilter: FileFilterOptions = {
    includeExts,
    ignoreExts,
    defaultAll: str('ff.policy', 'all') !== 'listed'
  };
  return { toggles, sections, minifyLevel, fileFilter };
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

function htmlFor(
  target: 'pdf' | 'clipboard',
  t: ToggleOptions,
  minifyLevel: MinifyLevel,
  s: SectionOptions,
  f: FileFilterOptions,
  detection: ProjectDetection
): string {
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
.opts { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 16px; font-size: 12px; }
.opts label { display: flex; gap: 6px; align-items: center; }
.extgrid { display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: 12px; margin: 6px 0; }
.extgrid label { display: flex; gap: 5px; align-items: center; border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 2px 8px; }
select, input[type=number], input[type=text] { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 4px; padding: 2px 6px; }
input[type=text].wide { width: 100%; box-sizing: border-box; margin: 4px 0; }
.actions { margin-top: 18px; display: flex; gap: 10px; }
button { padding: 6px 18px; border-radius: 4px; cursor: pointer; }
button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; }
button.ghost { background: transparent; color: var(--vscode-button-secondaryForeground); border: 1px solid var(--vscode-panel-border); }
.hint { font-size: 11px; color: var(--vscode-descriptionForeground); }
</style>
</head>
<body>
<h1>${target === 'pdf' ? 'Export to PDF' : 'Copy to Clipboard'}</h1>
<div class="sub">Analysis sections are optional appendices. Fonts and header/footer templates are configured in Settings (<code>projectExporter.pdf.fonts.*</code>, <code>*.headerTemplate / *.footerTemplate</code> with <code>%%PAGE%% %%PAGES%% %%PROJECT%% %%DATE%% %%TIME%% %%FILE%% %%FILECOUNT%% %%SECTION%%</code>).</div>

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
<input type="text" class="wide" id="ff.ignore" placeholder="e.g. map, lock, min.js" value="${escapeHtml(f.ignoreExts.join(', '))}">
<label class="row">Files with other extensions
<select id="ff.policy">
<option value="all" ${selected(f.defaultAll ? 'all' : 'listed', 'all')}>Include (default to all files)</option>
<option value="listed" ${selected(f.defaultAll ? 'all' : 'listed', 'listed')}>Exclude (only listed files)</option>
</select></label>
<div class="hint">"Include" also pulls in any other known code types from Settings. "Exclude" exports only what is checked/listed above.</div>
</fieldset>
<div class="actions">
<button class="ghost" id="resetFilterBtn">Reset to detected</button>
</div>

<h2>Analysis Sections</h2>
<label class="row">Placement
<select id="sec.placement">
<option value="before" ${selected(s.placement, 'before')}>Before source files</option>
<option value="after" ${selected(s.placement, 'after')}>After source files</option>
</select></label>

<fieldset><legend><input type="checkbox" id="sec.classList.enabled" ${checked(s.classList.enabled)}> Class List</legend>
<div class="opts">
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

<fieldset><legend><input type="checkbox" id="sec.functionList.enabled" ${checked(s.functionList.enabled)}> Function List</legend>
<div class="opts">
<label>Sort <select id="sec.functionList.sort">
<option ${selected(s.functionList.sort, 'alpha')}>alpha</option><option ${selected(s.functionList.sort, 'file')}>file</option><option ${selected(s.functionList.sort, 'folder')}>folder</option></select></label>
<label>Group <select id="sec.functionList.groupBy">
<option ${selected(s.functionList.groupBy, 'flat')}>flat</option><option ${selected(s.functionList.groupBy, 'file')}>file</option><option ${selected(s.functionList.groupBy, 'folder')}>folder</option></select></label>
<label><input type="checkbox" id="sec.functionList.includeMethods" ${checked(s.functionList.includeMethods)}> Include methods</label>
<label><input type="checkbox" id="sec.functionList.showSigs" ${checked(s.functionList.showSigs)}> Signatures</label>
<label><input type="checkbox" id="sec.functionList.showDefaults" ${checked(s.functionList.showDefaults)}> Default values</label>
</div></fieldset>

<fieldset><legend>Usages</legend>
<div class="opts">
<label><input type="checkbox" id="sec.usages.enabledClasses" ${checked(s.usages.enabledClasses)}> Class usages <span class="hint">file→line per class</span></label>
<label><input type="checkbox" id="sec.usages.enabledFunctions" ${checked(s.usages.enabledFunctions)}> Function usages</label>
<label>Context lines <input type="number" id="sec.usages.contextLines" min="0" max="5" value="${s.usages.contextLines}"></label>
<label>Max hits/symbol <input type="number" id="sec.usages.maxHitsPerSymbol" min="1" max="500" value="${s.usages.maxHitsPerSymbol}"></label>
<label><input type="checkbox" id="sec.usages.skipEmpty" ${checked(s.usages.skipEmpty)}> Skip entries with 0 results</label>
<label><input type="checkbox" id="sec.usages.summarizeEmpty" ${checked(s.usages.summarizeEmpty)}> Combine skipped into one line</label>
</div></fieldset>

<fieldset><legend><input type="checkbox" id="sec.strings.enabled" ${checked(s.strings.enabled)}> String List</legend>
<div class="opts">
<label>Sort <select id="sec.strings.sort">
<option ${selected(s.strings.sort, 'alpha')}>alpha</option><option ${selected(s.strings.sort, 'file')}>file</option></select></label>
<label>Group <select id="sec.strings.groupBy">
<option ${selected(s.strings.groupBy, 'flat')}>flat</option><option ${selected(s.strings.groupBy, 'file')}>file</option></select></label>
<label>Min length <input type="number" id="sec.strings.minLength" min="1" max="100" value="${s.strings.minLength}"></label>
<label><input type="checkbox" id="sec.strings.dedupe" ${checked(s.strings.dedupe)}> Dedupe</label>
<label>Max items <input type="number" id="sec.strings.maxItems" min="100" max="50000" step="100" value="${s.strings.maxItems}"></label>
</div></fieldset>

<fieldset><legend><input type="checkbox" id="sec.dependencies.enabled" ${checked(s.dependencies.enabled)}> Dependencies</legend>
<div class="opts">
<label>Direction <select id="sec.dependencies.direction">
<option ${selected(s.dependencies.direction, 'outgoing')}>outgoing</option><option ${selected(s.dependencies.direction, 'incoming')}>incoming</option><option ${selected(s.dependencies.direction, 'both')}>both</option></select></label>
<label><input type="checkbox" id="sec.dependencies.showUnresolved" ${checked(s.dependencies.showUnresolved)}> Show unresolved</label>
</div>
<div class="hint">Outgoing: under each file, files it relies on. Incoming: files that depend on it.</div>
</fieldset>

<div class="actions">
<button class="primary" id="exportBtn">Export</button>
<button class="ghost" id="cancelBtn">Cancel</button>
</div>

<script>
const vscode = acquireVsCodeApi();
const ids = ['includeMarkdown','syntaxHighlighting','minify','tableOfContents','folderStructure','minifyLevel','ff.extraInclude','ff.ignore','ff.policy','sec.placement','sec.classList.enabled','sec.classList.sort','sec.classList.groupBy','sec.classList.showCtor','sec.classList.showMethods','sec.classList.showFields','sec.classList.showDefaults','sec.classList.showBaseClass','sec.functionList.enabled','sec.functionList.sort','sec.functionList.groupBy','sec.functionList.includeMethods','sec.functionList.showSigs','sec.functionList.showDefaults','sec.usages.enabledClasses','sec.usages.enabledFunctions','sec.usages.contextLines','sec.usages.maxHitsPerSymbol','sec.usages.skipEmpty','sec.usages.summarizeEmpty','sec.strings.enabled','sec.strings.sort','sec.strings.groupBy','sec.strings.minLength','sec.strings.dedupe','sec.strings.maxItems','sec.dependencies.enabled','sec.dependencies.direction','sec.dependencies.showUnresolved'];
function collect() {
  const state = {};
  for (const id of ids) {
    const el = document.getElementById(id);
    if (!el) continue;
    if (el.type === 'checkbox') state[id] = el.checked;
    else state[id] = el.value;
  }
  state['ff.checked'] = Array.from(document.querySelectorAll('.ff-ext')).filter((c) => c.checked).map((c) => c.value);
  return state;
}
document.getElementById('exportBtn').addEventListener('click', () => vscode.postMessage({ type: 'export', state: collect() }));
document.getElementById('cancelBtn').addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
document.getElementById('resetFilterBtn').addEventListener('click', () => {
  document.querySelectorAll('.ff-ext').forEach((c) => { c.checked = c.getAttribute('data-suggested') === '1'; });
  document.getElementById('ff.extraInclude').value = '';
  document.getElementById('ff.ignore').value = '';
  document.getElementById('ff.policy').value = 'all';
});
</script>
</body>
</html>`;
}
