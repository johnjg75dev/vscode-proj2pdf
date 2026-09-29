import * as vscode from 'vscode';
import { ExportScope } from './fileCollector';

export interface ExtCount {
  ext: string;
  count: number;
}

export interface ProjectDetection {
  /** Detected project kinds, e.g. ['Node.js', 'Python']. Empty = generic. */
  kinds: string[];
  /** Top extensions present in the project, sorted by file count desc. */
  extCounts: ExtCount[];
  /** Suggested include list (subset of extCounts, kind-associated first). */
  suggested: string[];
  /** True when Markdown files are present and worth suggesting. */
  suggestMarkdown: boolean;
}

interface Marker {
  pattern: string;
  kind: string;
  exts: string[];
}

const MARKERS: Marker[] = [
  { pattern: '**/package.json', kind: 'Node.js', exts: ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts'] },
  { pattern: '**/pyproject.toml', kind: 'Python', exts: ['py', 'pyi'] },
  { pattern: '**/requirements*.txt', kind: 'Python', exts: ['py', 'pyi'] },
  { pattern: '**/setup.py', kind: 'Python', exts: ['py'] },
  { pattern: '**/Pipfile', kind: 'Python', exts: ['py'] },
  { pattern: '**/pom.xml', kind: 'Java (Maven)', exts: ['java'] },
  { pattern: '**/build.gradle*', kind: 'Java (Gradle)', exts: ['java', 'kt', 'kts', 'groovy'] },
  { pattern: '**/*.csproj', kind: 'C# (.NET)', exts: ['cs', 'fs', 'vb'] },
  { pattern: '**/*.sln', kind: 'C# (.NET)', exts: ['cs', 'fs', 'vb'] },
  { pattern: '**/go.mod', kind: 'Go', exts: ['go'] },
  { pattern: '**/Cargo.toml', kind: 'Rust', exts: ['rs'] },
  { pattern: '**/composer.json', kind: 'PHP', exts: ['php'] },
  { pattern: '**/Gemfile', kind: 'Ruby', exts: ['rb'] },
  { pattern: '**/pubspec.yaml', kind: 'Dart/Flutter', exts: ['dart'] },
  { pattern: '**/CMakeLists.txt', kind: 'C/C++ (CMake)', exts: ['c', 'h', 'cpp', 'hpp'] },
  { pattern: '**/*.cmake', kind: 'C/C++ (CMake)', exts: ['c', 'h', 'cpp', 'hpp'] },
  { pattern: '**/Makefile', kind: 'C/C++ (Make)', exts: ['c', 'h', 'cpp', 'hpp'] },
  { pattern: '**/build.zig', kind: 'Zig', exts: ['zig'] },
  { pattern: '**/deno.json*', kind: 'Deno', exts: ['ts', 'tsx', 'js', 'jsx'] }
];

const MARKDOWN_EXTS = ['md', 'markdown', 'mdx'];
const MAX_SCAN_FILES = 5000;
const MAX_LISTED_EXTS = 30;

/**
 * Detects the project type(s) from marker files and tallies the extensions
 * actually present, so the export panel can pre-select what the user most
 * likely wants. Never throws — returns an empty detection on failure.
 */
export async function detectProject(
  scopes: ExportScope[],
  exclude: string | null,
  token?: vscode.CancellationToken
): Promise<ProjectDetection> {
  const empty: ProjectDetection = { kinds: [], extCounts: [], suggested: [], suggestMarkdown: false };
  try {
    const kinds: string[] = [];
    const kindExts: string[] = [];

    for (const scope of scopes) {
      if (token?.isCancellationRequested) return empty;
      for (const marker of MARKERS) {
        const hits = await vscode.workspace.findFiles(
          new vscode.RelativePattern(scope.base, marker.pattern), exclude, 3, token
        );
        if (hits.length > 0 && !kinds.includes(marker.kind)) {
          kinds.push(marker.kind);
          for (const e of marker.exts) if (!kindExts.includes(e)) kindExts.push(e);
        }
      }
    }

    // Tally extensions actually present (respecting the user's excludes).
    const counts = new Map<string, number>();
    let scanned = 0;
    for (const scope of scopes) {
      if (token?.isCancellationRequested || scanned >= MAX_SCAN_FILES) break;
      const uris = await vscode.workspace.findFiles(
        new vscode.RelativePattern(scope.base, '**/*.*'), exclude, MAX_SCAN_FILES - scanned, token
      );
      scanned += uris.length;
      for (const u of uris) {
        const base = u.path.split('/').pop()?.toLowerCase() ?? '';
        const dot = base.lastIndexOf('.');
        if (dot <= 0) continue;
        const ext = base.slice(dot + 1);
        if (!/^[a-z0-9]+$/.test(ext)) continue;
        counts.set(ext, (counts.get(ext) ?? 0) + 1);
      }
    }

    const extCounts: ExtCount[] = [...counts.entries()]
      .map(([ext, count]) => ({ ext, count }))
      .sort((a, b) => b.count - a.count || (a.ext < b.ext ? -1 : 1))
      .slice(0, MAX_LISTED_EXTS);

    const suggested = suggestExtensions(kindExts, extCounts);
    const suggestMarkdown = extCounts.some((e) => MARKDOWN_EXTS.includes(e.ext));

    return { kinds, extCounts, suggested, suggestMarkdown };
  } catch {
    return empty;
  }
}

/**
 * Pure suggestion logic (unit-testable): kind-associated extensions that are
 * actually present come first, then any other present extensions.
 */
export function suggestExtensions(kindExts: string[], extCounts: ExtCount[]): string[] {
  const present = new Set(extCounts.map((e) => e.ext));
  const first = kindExts.filter((e) => present.has(e));
  const rest = extCounts.map((e) => e.ext).filter((e) => !first.includes(e));
  return [...first, ...rest];
}

/** Normalizes free-form user input ("ts, .JS; *.py") into clean extensions. */
export function parseExtList(input: string): string[] {
  const out: string[] = [];
  for (let part of input.split(/[,;\s]+/)) {
    part = part.trim().toLowerCase().replace(/^\*?\./, '').replace(/^\*/, '');
    if (!part || !/^[a-z0-9]+$/.test(part)) continue;
    if (!out.includes(part)) out.push(part);
  }
  return out;
}
