import { ClassInfo, FunctionInfo, Visibility } from './types';
import { folderOf } from './mask';

function visOf(name: string): Visibility {
  if (name.startsWith('__') && !name.endsWith('__')) return 'private';
  if (name.startsWith('_')) return 'protected';
  return 'public';
}

export function extractPython(relPath: string, content: string, masked: string): { classes: ClassInfo[]; functions: FunctionInfo[] } {
  const classes: ClassInfo[] = [];
  const functions: FunctionInfo[] = [];
  const lines = content.split('\n');
  const mlines = masked.split('\n');
  const folder = folderOf(relPath);

  interface Scope { indent: number; cls?: ClassInfo; func?: string; }
  const stack: Scope[] = [];

  const indentOf = (s: string): number => {
    let n = 0;
    for (const ch of s) {
      if (ch === ' ') n++;
      else if (ch === '\t') n += 8;
      else break;
    }
    return n;
  };

  for (let i = 0; i < lines.length; i++) {
    const mline = mlines[i];
    if (!mline.trim()) continue;
    const indent = indentOf(mline);
    while (stack.length > 0 && indent <= stack[stack.length - 1].indent) stack.pop();
    const cur = stack.length > 0 ? stack[stack.length - 1] : undefined;
    const inClass = cur?.cls;

    const clsM = /^(\s*)class\s+([A-Za-z_]\w*)\s*(?:\(([^)]*)\))?\s*:/.exec(mline);
    if (clsM) {
      const bases = (clsM[3] ?? '').split(',').map((s) => s.trim()).filter(Boolean).filter((s) => s !== 'object');
      const cls: ClassInfo = {
        name: clsM[2], file: relPath, folder, line: i + 1,
        baseClasses: bases, methods: [], fields: []
      };
      classes.push(cls);
      stack.push({ indent, cls });
      continue;
    }

    const defM = /^(\s*)def\s+([A-Za-z_]\w*)\s*(\([^)]*\))\s*(?:->\s*([^:]+))?:/.exec(mline);
    if (defM) {
      // Re-capture the signature from the ORIGINAL line so string defaults
      // (blanked in the masked line) survive, e.g. name="x".
      const origM = /^(\s*)def\s+([A-Za-z_]\w*)\s*(\([^)]*\))\s*(?:->\s*([^:]+))?:/.exec(lines[i]);
      const name = defM[2];
      const params = origM?.[3] ?? defM[3];
      const ret = (origM?.[4] ?? defM[4])?.trim();
      const sig = `${name}${params}${ret ? ' -> ' + ret : ''}`;
      if (inClass) {
        if (name === '__init__') {
          inClass.ctorSig = `__init__${params}`;
        } else {
          inClass.methods.push({ name, sig, line: i + 1, visibility: visOf(name) });
        }
        // collect self.x assignments in __init__ body handled below via separate scan
        stack.push({ indent, cls: inClass, func: name });
      } else {
        functions.push({ name, file: relPath, folder, line: i + 1, sig: `def ${sig}` });
        stack.push({ indent, func: name });
      }
      continue;
    }

    // self.x[: T] = default  /  self.x = default  inside class scope.
    // Detect on the masked line (skips comments), capture values from the original.
    if (inClass && /self\.[A-Za-z_]\w*\s*(?::[^=]+)?\s*=/.test(mline)) {
      const selfM = /self\.([A-Za-z_]\w*)\s*(?::\s*([^=]+))?\s*=\s*(.+)/.exec(lines[i]);
      if (selfM) {
        const fname = selfM[1];
        if (!inClass.fields.some((f) => f.name === fname)) {
          inClass.fields.push({
            name: fname, type: selfM[2]?.trim(), defaultValue: selfM[3]?.trim(),
            line: i + 1, visibility: visOf(fname)
          });
        }
      }
      // class-level assignment:  x: int = 3 (detect masked, capture original)
      const clsVarM = /^\s{4,}([A-Za-z_]\w*)\s*(?::\s*([^=]+))?\s*=\s*(.+)/.exec(mline)
        ? /^\s{4,}([A-Za-z_]\w*)\s*(?::\s*([^=]+))?\s*=\s*(.+)/.exec(lines[i])
        : null;
      if (clsVarM && cur?.func === undefined) {
        if (!inClass.fields.some((f) => f.name === clsVarM[1])) {
          inClass.fields.push({
            name: clsVarM[1], type: clsVarM[2]?.trim(), defaultValue: clsVarM[3]?.trim(),
            line: i + 1, visibility: visOf(clsVarM[1])
          });
        }
      }
    }
  }
  return { classes, functions };
}
