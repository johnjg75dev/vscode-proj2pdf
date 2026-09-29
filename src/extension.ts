import * as vscode from 'vscode';
import * as path from 'path';
import {
  ExportOptions, FileFilterOptions, MinifyLevel, OutputTarget, ToggleOptions,
  getClipboardSettings, getCollectorSettings, getDefaultToggles,
  getMinifyLevel, getPdfSettings, getSectionOptions, resolveCollectorSettings,
  shouldPromptForOptions
} from './config';
import { SectionOptions } from './analysis/types';
import { ExportScope, SkippedFile, collectFiles } from './fileCollector';
import { renderPdf } from './pdfExporter';
import { buildClipboardText } from './textExporter';
import { analyzeFiles } from './analysis/index';
import { openExportPanel } from './webview/panel';
import { detectProject } from './projectDetect';
import { unknownVars } from './headerFooter';
import { ExportCancelledError } from './util';

const LAST_OPTIONS_KEY = 'projectExporter.lastOptions';
const LAST_SECTIONS_KEY = 'projectExporter.lastSections';
const LAST_FILTER_KEY = 'projectExporter.lastFileFilter';
let output: vscode.OutputChannel;

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel('Project Exporter');

  const register = (id: string, target?: OutputTarget) =>
    vscode.commands.registerCommand(id, (uri?: unknown) =>
      runExport(context, uri instanceof vscode.Uri ? uri : undefined, target)
    );

  context.subscriptions.push(
    output,
    register('projectExporter.export'),
    register('projectExporter.exportPdf', 'pdf'),
    register('projectExporter.copyToClipboard', 'clipboard')
  );
}

export function deactivate(): void {
  /* nothing to clean up */
}

async function runExport(
  context: vscode.ExtensionContext,
  scopeUri: vscode.Uri | undefined,
  presetTarget: OutputTarget | undefined
): Promise<void> {
  try {
    const resolved = await resolveScopes(scopeUri);
    if (!resolved) return;

    const target = presetTarget ?? (await pickTarget());
    if (!target) return;

    const options = await pickOptions(context, target, resolved.scopes);
    if (!options) return;

    let saveUri: vscode.Uri | undefined;
    if (target === 'pdf') {
      saveUri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.joinPath(resolved.scopes[0].base, `${safeFileName(resolved.name)}-source.pdf`),
        filters: { PDF: ['pdf'] },
        saveLabel: 'Export PDF',
        title: 'Save project source as PDF'
      });
      if (!saveUri) return;
    }

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Project Exporter', cancellable: true },
      async (progress, token) => {
        const report = (message: string) => progress.report({ message });

        const collectorSettings = resolveCollectorSettings(getCollectorSettings(), options.fileFilter);
        output.appendLine(
          `File filter: include [${collectorSettings.codeExtensions.join(', ')}]` +
          (options.fileFilter.ignoreExts.length ? `, ignore [${options.fileFilter.ignoreExts.join(', ')}]` : '') +
          ` (default-${options.fileFilter.defaultAll ? 'all' : 'listed'})`
        );
        const { files, skipped } = await collectFiles(
          resolved.scopes, collectorSettings, options.includeMarkdown, token, report
        );
        logSkipped(skipped);

        if (files.length === 0) {
          void vscode.window.showWarningMessage(
            'Project Exporter: no matching source files found. Check the extension/exclude settings.'
          );
          return;
        }
        const skippedNote = skipped.length ? ` (${skipped.length} skipped - see Output)` : '';

        const analysis = await analyzeFiles(files, options.sections, {
          onProgress: report,
          isCancelled: () => token.isCancellationRequested
        });
        if (analysis) {
          output.appendLine(
            `Analysis: ${analysis.classes.length} classes, ${analysis.functions.length} functions, ` +
            `${analysis.strings.length} strings, ${analysis.dependencies.length} dependencies`
          );
        }

        if (target === 'pdf' && saveUri) {
          const pdfSettings = getPdfSettings();
          warnUnknownVars(pdfSettings.headerTemplate, 'pdf.headerTemplate');
          warnUnknownVars(pdfSettings.footerTemplate, 'pdf.footerTemplate');
          const { data, pageCount } = await renderPdf({
            projectName: resolved.name,
            files,
            options,
            settings: pdfSettings,
            analysis,
            onProgress: report,
            isCancelled: () => token.isCancellationRequested
          });
          report('Writing PDF...');
          await vscode.workspace.fs.writeFile(saveUri, data);
          output.appendLine(`Exported ${files.length} files, ${pageCount} pages -> ${saveUri.fsPath}`);
          void announcePdf(saveUri, files.length, pageCount, skippedNote);
        } else {
          report('Building text...');
          const clipboardSettings = getClipboardSettings();
          warnUnknownVars(clipboardSettings.headerTemplate, 'clipboard.headerTemplate');
          warnUnknownVars(clipboardSettings.footerTemplate, 'clipboard.footerTemplate');
          const text = buildClipboardText(resolved.name, files, options, clipboardSettings, analysis);
          await vscode.env.clipboard.writeText(text);
          const tokens = Math.round(text.length / 4);
          void vscode.window.showInformationMessage(
            `Copied ${files.length} files to clipboard (${text.length.toLocaleString()} chars, ` +
            `~${tokens.toLocaleString()} tokens)${skippedNote}.`
          );
        }
      }
    );
  } catch (err) {
    if (err instanceof ExportCancelledError) {
      void vscode.window.showInformationMessage('Project Exporter: export cancelled.');
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    output.appendLine(`[error] ${err instanceof Error && err.stack ? err.stack : message}`);
    void vscode.window.showErrorMessage(`Project Exporter failed: ${message}`);
  }
}

function warnUnknownVars(template: string, setting: string): void {
  if (!template) return;
  const bad = unknownVars(template);
  if (bad.length > 0) {
    output.appendLine(`[warn] ${setting}: unknown variable(s) ${bad.join(', ')} (left as-is)`);
  }
}

async function resolveScopes(
  uri?: vscode.Uri
): Promise<{ scopes: ExportScope[]; name: string } | undefined> {
  if (uri) {
    const stat = await vscode.workspace.fs.stat(uri);
    if (stat.type & vscode.FileType.Directory) {
      return { scopes: [{ base: uri, prefix: '' }], name: path.posix.basename(uri.path) };
    }
  }

  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    void vscode.window.showErrorMessage('Project Exporter: open a folder or workspace first.');
    return undefined;
  }
  if (folders.length === 1) {
    return { scopes: [{ base: folders[0].uri, prefix: '' }], name: folders[0].name };
  }

  interface ScopePick extends vscode.QuickPickItem { folder?: vscode.WorkspaceFolder }
  const picks: ScopePick[] = [
    { label: '$(root-folder) All workspace folders' },
    ...folders.map((f) => ({ label: `$(folder) ${f.name}`, description: f.uri.fsPath, folder: f }))
  ];
  const choice = await vscode.window.showQuickPick(picks, { placeHolder: 'Which folder do you want to export?' });
  if (!choice) return undefined;
  if (choice.folder) {
    return { scopes: [{ base: choice.folder.uri, prefix: '' }], name: choice.folder.name };
  }
  return {
    scopes: folders.map((f) => ({ base: f.uri, prefix: `${f.name}/` })),
    name: vscode.workspace.name ?? 'Workspace'
  };
}

async function pickTarget(): Promise<OutputTarget | undefined> {
  const items: (vscode.QuickPickItem & { target: OutputTarget })[] = [
    { label: '$(file-pdf) Export to PDF', description: 'Paginated, optional syntax highlighting', target: 'pdf' },
    { label: '$(clippy) Copy to clipboard', description: 'Plain text (great for pasting into an LLM)', target: 'clipboard' }
  ];
  const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Export project source to...' });
  return pick?.target;
}

function defaultFileFilter(stored: Partial<FileFilterOptions> | undefined, fallback: FileFilterOptions): FileFilterOptions {
  if (!stored || (stored.includeExts === undefined && stored.ignoreExts === undefined && stored.defaultAll === undefined)) {
    return fallback;
  }
  return {
    includeExts: stored.includeExts ?? fallback.includeExts,
    ignoreExts: stored.ignoreExts ?? fallback.ignoreExts,
    defaultAll: stored.defaultAll ?? fallback.defaultAll
  };
}

async function pickOptions(
  context: vscode.ExtensionContext,
  target: OutputTarget,
  scopes: ExportScope[]
): Promise<ExportOptions | undefined> {
  const toggles: ToggleOptions = {
    ...getDefaultToggles(),
    ...(shouldPromptForOptions() ? context.globalState.get<Partial<ToggleOptions>>(LAST_OPTIONS_KEY) : {})
  };
  const sections = {
    ...getSectionOptions(),
    ...(shouldPromptForOptions() ? context.globalState.get<Partial<import('./analysis/types').SectionOptions>>(LAST_SECTIONS_KEY) : {})
  };
  const collectorBase = getCollectorSettings();

  // Detect the project type + present extensions so the panel can pre-select
  // what the user most likely wants. Fast and failure-proof (falls back to config).
  const detection = await detectProject(scopes, collectorBase.exclude.length ? `{${collectorBase.exclude.join(',')}}` : null);
  const detectedFilter: FileFilterOptions = {
    includeExts: detection.suggested.length > 0 ? detection.suggested : [...collectorBase.codeExtensions],
    ignoreExts: [],
    defaultAll: true
  };
  const fileFilter = defaultFileFilter(
    shouldPromptForOptions() ? context.globalState.get<Partial<FileFilterOptions>>(LAST_FILTER_KEY) : undefined,
    detectedFilter
  );

  const build = (t: ToggleOptions, s: SectionOptions, level: MinifyLevel, f: FileFilterOptions): ExportOptions =>
    ({ ...t, target, minifyLevel: level, sections: s, fileFilter: f });

  if (!shouldPromptForOptions()) {
    return { ...toggles, target, minifyLevel: getMinifyLevel(), sections, fileFilter };
  }

  // Rich webview config panel (Output | Files | Analysis Sections).
  // Falls back to the legacy QuickPick if the webview cannot be shown.
  try {
    const result = await openExportPanel(context, target, {
      toggles, minifyLevel: getMinifyLevel(), sections, fileFilter, detection
    });
    if (!result) return undefined;
    return { ...result.toggles, target, minifyLevel: result.minifyLevel, sections: result.sections, fileFilter: result.fileFilter };
  } catch (err) {
    output.appendLine(`[warn] Config panel unavailable, using QuickPick: ${err instanceof Error ? err.message : String(err)}`);
    return pickOptionsQuickPick(context, target, toggles, sections, fileFilter, build);
  }
}

async function pickOptionsQuickPick(
  context: vscode.ExtensionContext,
  target: OutputTarget,
  toggles: ToggleOptions,
  sections: SectionOptions,
  fileFilter: FileFilterOptions,
  build: (t: ToggleOptions, s: SectionOptions, level: MinifyLevel, f: FileFilterOptions) => ExportOptions
): Promise<ExportOptions | undefined> {
  type Key = keyof ToggleOptions;
  const defs: { key: Key; label: string; detail: string; pdfOnly?: boolean }[] = [
    { key: 'includeMarkdown', label: '$(markdown) Include Markdown files', detail: '.md / .markdown / .mdx' },
    { key: 'syntaxHighlighting', label: '$(symbol-color) Syntax highlighting', detail: 'PDF only', pdfOnly: true },
    { key: 'minify', label: '$(fold) Minify', detail: 'Strip all line breaks & indentation - fill every line completely' },
    { key: 'tableOfContents', label: '$(list-ordered) Table of contents', detail: target === 'pdf' ? 'With page numbers & links' : 'List of files' },
    { key: 'folderStructure', label: '$(list-tree) Folder structure', detail: 'Tree view of exported files' }
  ];

  const items = defs
    .filter((d) => target === 'pdf' || !d.pdfOnly)
    .map((d) => ({ label: d.label, detail: d.detail, picked: toggles[d.key], key: d.key }));

  const picked = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    title: target === 'pdf' ? 'PDF export options' : 'Clipboard export options',
    placeHolder: 'Select options, then press Enter (analysis sections use Settings defaults)'
  });
  if (!picked) return undefined;

  const chosen = new Set(picked.map((p) => p.key));
  const result: ToggleOptions = {
    includeMarkdown: chosen.has('includeMarkdown'),
    syntaxHighlighting: target === 'pdf' ? chosen.has('syntaxHighlighting') : toggles.syntaxHighlighting,
    minify: chosen.has('minify'),
    tableOfContents: chosen.has('tableOfContents'),
    folderStructure: chosen.has('folderStructure')
  };
  await context.globalState.update(LAST_OPTIONS_KEY, result);
  return build(result, sections, getMinifyLevel(), fileFilter);
}

async function announcePdf(uri: vscode.Uri, fileCount: number, pages: number, note: string): Promise<void> {
  const OPEN = 'Open PDF';
  const REVEAL = 'Reveal in File Explorer';
  const choice = await vscode.window.showInformationMessage(
    `Exported ${fileCount} files (${pages} pages) to ${path.basename(uri.fsPath)}${note}.`,
    OPEN, REVEAL
  );
  if (choice === OPEN) await vscode.env.openExternal(uri);
  else if (choice === REVEAL) await vscode.commands.executeCommand('revealFileInOS', uri);
}

function logSkipped(skipped: SkippedFile[]): void {
  if (!skipped.length) return;
  output.appendLine(`Skipped ${skipped.length} file(s):`);
  for (const s of skipped) output.appendLine(`  - ${s.relPath}: ${s.reason}`);
}

function safeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'project';
}
