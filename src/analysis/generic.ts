import { ClassInfo, FunctionInfo, Visibility } from './types';
import { folderOf } from './mask';

/** Best-effort fallback for languages without a dedicated extractor. */
export function extractGeneric(relPath: string, _content: string, masked: string): { classes: ClassInfo[]; functions: FunctionInfo[] } {
  const classes: ClassInfo[] = [];
  const functions: FunctionInfo[] = [];
  const mlines = masked.split('\n');
  const folder = folderOf(relPath);
  const seen = new Set<string>();

  const classRes = [
    /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_]\w*)/,
    /^\s*(?:public\s+|private\s+|protected\s+)?struct\s+([A-Za-z_]\w*)/,
    /^\s*type\s+([A-Za-z_]\w*)\s*(?:=|:)?\s*(?:struct|class|interface|object)/,
    /^\s*interface\s+([A-Za-z_]\w*)/,
  ];
  const fnRes = [
    /^\s*(?:public|private|protected|static|async|function|def|fn|func|sub|procedure)\s+(?:[\w<>\[\]]+\s+)?([A-Za-z_]\w*)\s*\(/,
    /^\s*([A-Za-z_]\w*)\s*=\s*function\s*\(/,
    /^\s*([A-Za-z_]\w*)\s*:=\s*func\s*\(/,
  ];
  const keywords = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'class', 'function', 'new', 'import', 'export']);

  for (let i = 0; i < mlines.length; i++) {
    const line = mlines[i];
    let matched = false;
    for (const re of classRes) {
      const m = re.exec(line);
      if (m && !keywords.has(m[1])) {
        const key = `c:${m[1]}`;
        if (!seen.has(key)) {
          seen.add(key);
          classes.push({
            name: m[1], file: relPath, folder, line: i + 1,
            baseClasses: [], methods: [], fields: [], heuristic: true
          });
        }
        matched = true;
        break;
      }
    }
    if (matched) continue;
    for (const re of fnRes) {
      const m = re.exec(line);
      if (m && !keywords.has(m[1])) {
        functions.push({
          name: m[1], file: relPath, folder, line: i + 1,
          sig: `${m[1]}(...)`, heuristic: true
        });
        break;
      }
    }
  }
  void _content;
  return { classes, functions };
}

const _vis: Visibility = 'unknown';
void _vis;
