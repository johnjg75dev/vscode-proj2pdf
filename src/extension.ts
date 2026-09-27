import * as vscode from 'vscode';
import * as path from 'path';
import {
  ExportOptions, OutputTarget, ToggleOptions,
  getClipboardSettings, getCollectorSettings, getDefaultToggles,
  getMinifyLevel, getPdfSettings, shouldPromptForOptions
} from './config';
import { ExportScope, SkippedFile, collectFiles } from './fileCollector';
import { renderPdf } from './pdfExporter';
import { buildClipboardText } from './textExporter';
import { ExportCancelledError } from './util';

const LAST_OPTIONS_KEY = 'projectExporter.lastOptions';
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

    const options = await pickOptions(context, target);
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

        const { files, skipped } = await collectFiles(
          resolved.scopes, getCollectorSettings(), options.includeMarkdown, token, report
        );
        logSkipped(skipped);

        if (files.length === 0) {
          void vscode.window.showWarningMessage(
            'Project Exporter: no matching source files found. Check the extension/exclude settings.'
          );
          return;
        }
        const skippedNote = skipped.length ? ` (${skipped.length} skipped - see Output)` : '';

        if (target === 'pdf' && saveUri) {
          const { data, pageCount } = await renderPdf({
            projectName: resolved.name,
            files,
            options,
            settings: getPdfSettings(),
            onProgress: report,
            isCancelled: () => token.isCancellationRequested
          });
          report('Writing PDF...');
          await vscode.workspace.fs.writeFile(saveUri, data);
          output.appendLine(`Exported ${files.length} files, ${pageCount} pages -> ${saveUri.fsPath}`);
          void announcePdf(saveUri, files.length, pageCount, skippedNote);
        } else {
          report('Building text...');
          const text = buildClipboardText(resolved.name, files, options, getClipboardSettings());
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

async function pickOptions(
  context: vscode.ExtensionContext,
  target: OutputTarget
): Promise<ExportOptions | undefined> {
  const toggles: ToggleOptions = {
    ...getDefaultToggles(),
    ...(shouldPromptForOptions() ? context.globalState.get<Partial<ToggleOptions>>(LAST_OPTIONS_KEY) : {})
  };
  const build = (t: ToggleOptions): ExportOptions => ({ ...t, target, minifyLevel: getMinifyLevel() });

  if (!shouldPromptForOptions()) return build(toggles);

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
    placeHolder: 'Select options, then press Enter'
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
  return build(result);
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
