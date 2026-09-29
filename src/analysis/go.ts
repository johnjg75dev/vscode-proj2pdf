import { ClassInfo, FunctionInfo, Visibility } from './types';
import { folderOf } from './mask';

function visOf(name: string): Visibility {
  return /^[A-Z]/.test(name) ? 'public' : 'private';
}

export function extractGo(relPath: string, content: string, masked: string): { classes: ClassInfo[]; functions: FunctionInfo[] } {
  const classes: ClassInfo[] = [];
  const functions: FunctionInfo[] = [];
  const mlines = masked.split('\n');
  const folder = folderOf(relPath);
  const byName = new Map<string, ClassInfo>();

  for (let i = 0; i < mlines.length; i++) {
    const mline = mlines[i];
    // type X struct { ... }  or  type X interface
    const typeM = /^\s*type\s+([A-Za-z_]\w*)\s+(struct|interface)\b/.exec(mline);
    if (typeM) {
      const cls: ClassInfo = {
        name: typeM[1], file: relPath, folder, line: i + 1,
        baseClasses: [], methods: [], fields: []
      };
      // collect embedded fields: scan following lines until closing brace at same level (simple)
      classes.push(cls);
      byName.set(typeM[1], cls);
      // try inline struct fields on same lines
      continue;
    }
    // struct fields: Name Type `tag`  (inside struct body — approximate: line after a struct decl before next type/func)
    // handled in second loop below
    const ctorM = /^\s*func\s+(New[A-Za-z_]\w*)\s*(\([^)]*\))\s*([^\{]*)\{?/.exec(mline);
    if (ctorM) {
      // NewX convention: attach to X if exists
      const target = ctorM[1].replace(/^New/, '');
      const cls = byName.get(target);
      const sig = `${ctorM[1]}${ctorM[2]}`;
      if (cls) {
        if (!cls.ctorSig) cls.ctorSig = sig;
      } else {
        functions.push({ name: ctorM[1], file: relPath, folder, line: i + 1, sig: `func ${sig}` });
      }
      continue;
    }
    // method with receiver: func (r X) Name(params) ret
    const methM = /^\s*func\s*\(\s*\w*\s*\*?([A-Za-z_]\w*)\s*\)\s*([A-Za-z_]\w*)\s*(\([^)]*\))\s*([^\{]*)/.exec(mline);
    if (methM) {
      const cls = byName.get(methM[1]);
      const sig = `${methM[2]}${methM[3]}${methM[4] ? ' ' + methM[4].trim().replace(/\s*\{\s*$/, '') : ''}`;
      if (cls) {
        cls.methods.push({ name: methM[2], sig: sig.trim(), line: i + 1, visibility: visOf(methM[2]) });
      } else {
        functions.push({ name: methM[2], file: relPath, folder, line: i + 1, sig: `func ${sig}`, parentClass: methM[1] });
      }
      continue;
    }
    // plain function: func Name(params) ret
    const fnM = /^\s*func\s+([A-Za-z_]\w*)\s*(\([^)]*\))\s*([^\{]*)/.exec(mline);
    if (fnM) {
      const sig = `func ${fnM[1]}${fnM[2]}${fnM[3] ? ' ' + fnM[3].trim().replace(/\s*\{\s*$/, '') : ''}`;
      functions.push({ name: fnM[1], file: relPath, folder, line: i + 1, sig: sig.trim(), exported: visOf(fnM[1]) === 'public' });
    }
  }

  // second pass: struct fields — lines between `type X struct {` and matching `}`
  const lines = content.split('\n');
  for (const cls of classes) {
    const startIdx = cls.line - 1;
    let braceCount = 0;
    let started = false;
    for (let i = startIdx; i < Math.min(lines.length, startIdx + 200); i++) {
      for (const ch of mlines[i]) {
        if (ch === '{') { braceCount++; started = true; }
        else if (ch === '}') braceCount--;
      }
      if (!started) continue;
      if (braceCount <= 0 && i > startIdx) break;
      if (i === startIdx) continue;
      const fm = /^\s*([A-Za-z_]\w*)\s+([^`\/]+?)\s*(?:`[^`]*`)?\s*$/.exec(mlines[i]);
      if (fm && !/^(func|type|if|for|switch|return)/.test(fm[1])) {
        const parts = fm[2].trim().split(/\s+/);
        cls.fields.push({ name: fm[1], type: parts[0], line: i + 1, visibility: visOf(fm[1]) });
      }
    }
  }

  void content;
  void lines;
  return { classes, functions };
}
