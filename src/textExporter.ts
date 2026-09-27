import { ClipboardSettings, ExportOptions } from './config';
import { SourceFile } from './fileCollector';
import { fenceLanguage } from './highlighter';
import { minifyText } from './minify';
import { buildTreeLines } from './tree';

export function buildClipboardText(
  projectName: string,
  files: SourceFile[],
  options: ExportOptions,
  settings: ClipboardSettings
): string {
  const out: string[] = [];
  const gap = () => { if (!options.minify) out.push(''); };
  const totalLines = files.reduce((n, f) => n + f.lineCount, 0);

  out.push(`# ${projectName}`);
  gap();
  out.push(`${files.length} files, ${totalLines} lines`);
  gap();

  if (options.tableOfContents) {
    out.push('## Table of Contents');
    gap();
    files.forEach((f, i) => out.push(`${i + 1}. ${f.relPath} (${f.lineCount} lines)`));
    gap();
  }

  if (options.folderStructure) {
    out.push('## Folder Structure');
    gap();
    out.push('```', ...buildTreeLines(files.map((f) => f.relPath), projectName, 'unicode'), '```');
    gap();
  }

  out.push('## Source Files');
  gap();

  for (const f of files) {
    const body = options.minify ? minifyText(f.content, options.minifyLevel) : f.content;
    if (settings.useCodeFences) {
      const fence = fenceFor(body);
      out.push(`### ${f.relPath}`);
      gap();
      out.push(`${fence}${fenceLanguage(f.ext)}`, body, fence);
    } else {
      out.push(`===== ${f.relPath} =====`, body);
    }
    gap();
  }

  return out.join('\n');
}

/** Uses a fence longer than any backtick run inside the file. */
function fenceFor(body: string): string {
  const runs = body.match(/`{3,}/g) ?? [];
  const longest = runs.reduce((m, r) => Math.max(m, r.length), 0);
  return '`'.repeat(Math.max(3, longest + 1));
}
