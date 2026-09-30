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

/** A content-free file entry for the export panel's live preview tree. */
export interface PreviewFile {
  relPath: string;
  /** Byte size from stat, or -1 when unknown. */
  sizeBytes: number;
  /** Why this file is excluded although it matched, if applicable. */
  ignoredBy: 'gitignore' | null;
}

export interface PreviewResult {
  /** Files that would be read (before content load and drop-list filtering). */
  included: PreviewFile[];
  /** Files that matched the glob but were excluded by .gitignore rules. */
  ignored: PreviewFile[];
  /** True when the listing was truncated at PREVIEW_CAP. */
  truncated: boolean;
}

/** Hard cap so the preview tree stays responsive on huge repos. */
export const PREVIEW_CAP = 5000;

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

interface Candidate {
  uri: vscode.Uri;
  scope: ExportScope;
  relPath: string;
  ignoredBy: 'gitignore' | null;
}

/**
 * Single shared scan: glob match + gitignore filter, no content reads.
 * `cap` bounds included files (preview only — collection passes Infinity).
 */
async function scanCandidates(
  scopes: ExportScope[],
  settings: CollectorSettings,
  includeMarkdown: boolean,
  token: vscode.CancellationToken,
  report: ((message: string) => void) | undefined,
  cap: number
): Promise<{ candidates: Candidate[]; truncated: boolean }> {
  const globs = buildGlobs(settings, includeMarkdown);
  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  let truncated = false;
  let includedCount = 0;

  for (const scope of scopes) {
    if (token.isCancellationRequested) throw new ExportCancelledError();
    report?.(`Searching ${scope.prefix || path.posix.basename(scope.base.path)}...`);
    const uris = await vscode.workspace.findFiles(
      new vscode.RelativePattern(scope.base, globs.include), globs.exclude, undefined, token
    );
    if (token.isCancellationRequested) throw new ExportCancelledError();

    const gitRoot = vscode.workspace.getWorkspaceFolder(scope.base)?.uri ?? scope.base;
    const rules = settings.respectGitignore ? await loadGitignoreRules(gitRoot, globs.exclude, token) : [];

    for (const u of uris) {
      if (seen.has(u.toString())) continue;
      seen.add(u.toString());
      if (candidates.length >= cap * 2) {
        truncated = true;
        continue;
      }
      const relPath = scope.prefix + path.posix.relative(scope.base.path, u.path);
      const ignoredBy = isGitIgnored(rules, path.posix.relative(gitRoot.path, u.path)) ? 'gitignore' as const : null;
      if (!ignoredBy) {
        if (includedCount >= cap) {
          truncated = true;
          continue;
        }
        includedCount++;
      }
      candidates.push({ uri: u, scope, relPath, ignoredBy });
    }
  }
  candidates.sort((a, b) => comparePaths(a.relPath, b.relPath));
  return { candidates, truncated };
}

/**
 * Content-free listing of what the current filter selects. Shared by the
 * export panel preview tree and `collectFiles` so the two can never diverge.
 */
export async function previewFiles(
  scopes: ExportScope[],
  settings: CollectorSettings,
  includeMarkdown: boolean,
  token: vscode.CancellationToken,
  report?: (message: string) => void
): Promise<PreviewResult> {
  const { candidates, truncated } = await scanCandidates(scopes, settings, includeMarkdown, token, report, PREVIEW_CAP);

  // Attach sizes in batches (cheap stat calls, no content reads).
  const included: PreviewFile[] = [];
  const ignored: PreviewFile[] = [];
  const STAT_BATCH = 64;
  const sized = (c: Candidate, sizeBytes: number): PreviewFile =>
    ({ relPath: c.relPath, sizeBytes, ignoredBy: c.ignoredBy });
  for (let i = 0; i < candidates.length; i += STAT_BATCH) {
    if (token.isCancellationRequested) throw new ExportCancelledError();
    const chunk = candidates.slice(i, i + STAT_BATCH);
    const stats = await Promise.all(chunk.map(async (c) => {
      try {
        const st = await vscode.workspace.fs.stat(c.uri);
        return sized(c, st.size);
      } catch {
        return sized(c, -1);
      }
    }));
    for (const s of stats) (s.ignoredBy ? ignored : included).push(s);
  }

  return { included, ignored, truncated };
}

export async function collectFiles(
  scopes: ExportScope[],
  settings: CollectorSettings,
  includeMarkdown: boolean,
  token: vscode.CancellationToken,
  report: (message: string) => void,
  /** Per-file drop list from the panel tree (relPaths). Dropped wins over all rules. */
  dropped?: Set<string>
): Promise<CollectResult> {
  const maxBytes = settings.maxFileSizeKB > 0 ? settings.maxFileSizeKB * 1024 : 0;
  const specialNames = new Set(settings.includeFileNames.map((n) => n.toLowerCase()));
  const openDocs = new Map(vscode.workspace.textDocuments.map((d) => [d.uri.toString(), d]));

  const { candidates } = await scanCandidates(scopes, settings, includeMarkdown, token, report, Infinity);

  const files: SourceFile[] = [];
  const skipped: SkippedFile[] = [];
  const readable = candidates.filter((c) => !c.ignoredBy && !dropped?.has(c.relPath));
  if (dropped) {
    for (const c of candidates) {
      if (!c.ignoredBy && dropped.has(c.relPath)) {
        skipped.push({ relPath: c.relPath, reason: 'deselected in export panel' });
      }
    }
  }

  const BATCH = 32;
  for (let i = 0; i < readable.length; i += BATCH) {
    if (token.isCancellationRequested) throw new ExportCancelledError();
    report(`Reading files ${Math.min(i + BATCH, readable.length)}/${readable.length}...`);
    const results = await Promise.all(
      readable.slice(i, i + BATCH).map((c) => readSource(c.uri, c.scope, maxBytes, specialNames, openDocs))
    );
    for (const r of results) {
      if ('file' in r) files.push(r.file);
      else skipped.push(r.skip);
    }
  }

  files.sort((a, b) => comparePaths(a.relPath, b.relPath));
  return { files, skipped };
}

/** Lists .gitignore files (display relPaths) covering the given scopes. */
export async function listGitignoreFiles(
  scopes: ExportScope[],
  exclude: string | null,
  token: vscode.CancellationToken
): Promise<string[]> {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const scope of scopes) {
    if (token.isCancellationRequested) throw new ExportCancelledError();
    const gitRoot = vscode.workspace.getWorkspaceFolder(scope.base)?.uri ?? scope.base;
    const key = gitRoot.toString();
    if (seen.has(key)) continue;
    seen.add(key);
    const uris = await vscode.workspace.findFiles(
      new vscode.RelativePattern(gitRoot, '**/.gitignore'), exclude, undefined, token
    );
    for (const u of uris) {
      const rel = scope.prefix + path.posix.relative(gitRoot.path, u.path);
      if (!out.includes(rel)) out.push(rel);
    }
  }
  out.sort();
  return out;
}

/** Builds the findFiles include/exclude brace globs. Throws when empty. */
function buildGlobs(
  settings: CollectorSettings,
  includeMarkdown: boolean
): { include: string; exclude: string | null } {
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
  return {
    include: braceGlob(patterns),
    exclude: settings.exclude.length ? braceGlob(settings.exclude) : null
  };
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
