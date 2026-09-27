import * as vscode from 'vscode';
import * as path from 'path';
import ignore, { Ignore } from 'ignore';
import { CollectorSettings } from './config';
import { ExportCancelledError, comparePaths, countLines, normalizeContent } from './util';

export interface ExportScope {
  /** Folder to search in. */
  base: vscode.Uri;
  /** Prefix for display paths (used for multi-root: "folderName/"). */
  prefix: string;
}

export interface SourceFile {
  uri: vscode.Uri;
  relPath: string;
  /** Lower-cased extension, or the full file name for special files (e.g. "dockerfile"). */
  ext: string;
  /** Normalized content (LF line endings, no trailing whitespace). */
  content: string;
  lineCount: number;
}

export interface SkippedFile {
  relPath: string;
  reason: string;
}

export interface CollectResult {
  files: SourceFile[];
  skipped: SkippedFile[];
}

interface GitignoreRule {
  dir: string;
  ig: Ignore;
}

type ReadResult = { file: SourceFile } | { skip: SkippedFile };

const decoder = new TextDecoder('utf-8');

function braceGlob(patterns: string[]): string {
  return patterns.length === 1 ? patterns[0] : `{${patterns.join(',')}}`;
}

function looksBinary(bytes: Uint8Array): boolean {
  const len = Math.min(bytes.length, 8000);
  for (let i = 0; i < len; i++) if (bytes[i] === 0) return true;
  return false;
}

export async function collectFiles(
  scopes: ExportScope[],
  settings: CollectorSettings,
  includeMarkdown: boolean,
  token: vscode.CancellationToken,
  report: (message: string) => void
): Promise<CollectResult> {
  const exts = [...new Set([
    ...settings.codeExtensions,
    ...(includeMarkdown ? settings.markdownExtensions : [])
  ])];
  const patterns = [
    ...exts.map((e) => `**/*.${e}`),
    ...settings.includeFileNames.map((n) => `**/${n}`)
  ];
  if (patterns.length === 0) {
    throw new Error('No file extensions configured (projectExporter.codeExtensions is empty).');
  }

  const include = braceGlob(patterns);
  const exclude = settings.exclude.length ? braceGlob(settings.exclude) : null;
  const maxBytes = settings.maxFileSizeKB > 0 ? settings.maxFileSizeKB * 1024 : 0;
  const specialNames = new Set(settings.includeFileNames.map((n) => n.toLowerCase()));
  const openDocs = new Map(vscode.workspace.textDocuments.map((d) => [d.uri.toString(), d]));

  const files: SourceFile[] = [];
  const skipped: SkippedFile[] = [];
  const seen = new Set<string>();

  for (const scope of scopes) {
    report(`Searching ${scope.prefix || path.posix.basename(scope.base.path)}...`);
    const uris = await vscode.workspace.findFiles(
      new vscode.RelativePattern(scope.base, include), exclude, undefined, token
    );
    if (token.isCancellationRequested) throw new ExportCancelledError();

    const gitRoot = vscode.workspace.getWorkspaceFolder(scope.base)?.uri ?? scope.base;
    const rules = settings.respectGitignore ? await loadGitignoreRules(gitRoot, exclude, token) : [];

    const candidates = uris.filter((u) => {
      if (seen.has(u.toString())) return false;
      seen.add(u.toString());
      return !isGitIgnored(rules, path.posix.relative(gitRoot.path, u.path));
    });

    const BATCH = 32;
    for (let i = 0; i < candidates.length; i += BATCH) {
      if (token.isCancellationRequested) throw new ExportCancelledError();
      report(`Reading files ${Math.min(i + BATCH, candidates.length)}/${candidates.length}...`);
      const results = await Promise.all(
        candidates.slice(i, i + BATCH).map((uri) => readSource(uri, scope, maxBytes, specialNames, openDocs))
      );
      for (const r of results) {
        if ('file' in r) files.push(r.file);
        else skipped.push(r.skip);
      }
    }
  }

  files.sort((a, b) => comparePaths(a.relPath, b.relPath));
  return { files, skipped };
}

async function readSource(
  uri: vscode.Uri,
  scope: ExportScope,
  maxBytes: number,
  specialNames: Set<string>,
  openDocs: Map<string, vscode.TextDocument>
): Promise<ReadResult> {
  const relPath = scope.prefix + path.posix.relative(scope.base.path, uri.path);
  try {
    let raw: string;
    const openDoc = openDocs.get(uri.toString());
    if (openDoc?.isDirty) {
      raw = openDoc.getText(); // include unsaved edits
    } else {
      const stat = await vscode.workspace.fs.stat(uri);
      if (maxBytes && stat.size > maxBytes) {
        return { skip: { relPath, reason: `larger than ${Math.round(maxBytes / 1024)} KB` } };
      }
      const bytes = await vscode.workspace.fs.readFile(uri);
      if (looksBinary(bytes)) return { skip: { relPath, reason: 'binary content' } };
      raw = decoder.decode(bytes);
    }

    const base = path.posix.basename(relPath).toLowerCase();
    const dot = base.lastIndexOf('.');
    const ext = specialNames.has(base) ? base : dot > 0 ? base.slice(dot + 1) : base;
    const content = normalizeContent(raw);
    return { file: { uri, relPath, ext, content, lineCount: countLines(content) } };
  } catch (err) {
    return { skip: { relPath, reason: err instanceof Error ? err.message : String(err) } };
  }
}

async function loadGitignoreRules(
  root: vscode.Uri,
  exclude: string | null,
  token: vscode.CancellationToken
): Promise<GitignoreRule[]> {
  const uris = await vscode.workspace.findFiles(
    new vscode.RelativePattern(root, '**/.gitignore'), exclude, undefined, token
  );
  const rules: GitignoreRule[] = [];
  for (const u of uris) {
    try {
      const text = decoder.decode(await vscode.workspace.fs.readFile(u));
      const dir = path.posix.dirname(path.posix.relative(root.path, u.path));
      rules.push({ dir: dir === '.' ? '' : dir, ig: ignore().add(text) });
    } catch {
      /* unreadable .gitignore - ignore it */
    }
  }
  return rules;
}

function isGitIgnored(rules: GitignoreRule[], relToRoot: string): boolean {
  if (!relToRoot || relToRoot.startsWith('..')) return false;
  for (const rule of rules) {
    if (rule.dir && !relToRoot.startsWith(rule.dir + '/')) continue;
    const sub = rule.dir ? relToRoot.slice(rule.dir.length + 1) : relToRoot;
    try {
      if (rule.ig.ignores(sub)) return true;
    } catch {
      /* invalid path for `ignore` - treat as not ignored */
    }
  }
  return false;
}
