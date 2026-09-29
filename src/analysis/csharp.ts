import { ClassInfo, FunctionInfo, Visibility } from './types';
import { folderOf } from './mask';

function visOf(mods: string): Visibility {
  if (/private/.test(mods)) return 'private';
  if (/protected/.test(mods)) return 'protected';
  if (/public/.test(mods)) return 'public';
  return 'public';
}

export function extractCSharp(relPath: string, content: string, masked: string): { classes: ClassInfo[]; functions: FunctionInfo[] } {
  const classes: ClassInfo[] = [];
  const functions: FunctionInfo[] = [];
  const lines = content.split('\n');
  const mlines = masked.split('\n');
  const folder = folderOf(relPath);

  const classRe = /^\s*(?:\[[^\]]*\]\s*)?((?:(?:public|private|protected|internal|static|sealed|abstract|partial)\s+)*)(class|struct|record|interface|enum)\s+([A-Za-z_]\w*)\s*(?::\s*([^{]+))?/;
  // merge partial classes by name+file
  const byName = new Map<string, ClassInfo>();
  let current: ClassInfo | null = null;
  let depth = 0;
  let classDepth = -1;

  const braces = (s: string): number => {
    let d = 0;
    for (const ch of s) {
      if (ch === '{') d++;
      else if (ch === '}') d--;
    }
    return d;
  };

  for (let i = 0; i < lines.length; i++) {
    const mline = mlines[i];
    const cm = classRe.exec(mline);
    if (cm && cm[2] !== 'enum') {
      const bases = (cm[4] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      const key = cm[3];
      let cls = byName.get(key);
      if (!cls) {
        cls = { name: key, file: relPath, folder, line: i + 1, baseClasses: bases, methods: [], fields: [] };
        byName.set(key, cls);
        classes.push(cls);
      } else {
        for (const b of bases) if (!cls.baseClasses.includes(b)) cls.baseClasses.push(b);
      }
      current = cls;
      classDepth = depth;
    }

    if (current) {
      const ctorRe = new RegExp(`^\\s*((?:(?:public|private|protected|internal|static)\\s+)*)${current.name}\\s*(\\([^;{}]*\\))`);
      const ctorM = ctorRe.exec(mline);
      if (ctorM && !mline.includes(':') === false) { /* fallthrough */ }
      if (ctorM) {
        const origCtor = new RegExp(`^\\s*((?:(?:public|private|protected|internal|static)\\s+)*)${current.name}\\s*(\\([^;{}]*\\))`).exec(lines[i]);
        current.ctorSig = `${current.name}${origCtor?.[2] ?? ctorM[2]}`;
      } else {
        // property: [mods] Type Name { get; set; } [= init];
        const propM = /^\s*((?:(?:public|private|protected|internal|static|virtual|override|abstract|sealed|readonly)\s+)*)([\w<>\[\]?., ]+?)\s+([A-Za-z_]\w*)\s*\{\s*(get|set)/.exec(mline);
        if (propM) {
          current.fields.push({
            name: propM[3], type: propM[2].trim(),
            line: i + 1, visibility: visOf(propM[1])
          });
        } else {
          const methM = /^\s*((?:(?:public|private|protected|internal|static|virtual|override|abstract|sealed|async|extern)\s+)*)([\w<>\[\]?., ]+?)\s+([A-Za-z_]\w*)\s*(\([^;{}]*\))/.exec(mline);
          if (methM && !/^(if|for|foreach|while|switch|catch|using|lock|return|new)$/.test(methM[3])) {
            const after = mline.slice(methM[0].length);
            if (/^\s*[{;]/.test(after) || /[{;]\s*$/.test(mline) || /=>/.test(mline)) {
              const origMeth = /^\s*((?:(?:public|private|protected|internal|static|virtual|override|abstract|sealed|async|extern)\s+)*)([\w<>\[\]?., ]+?)\s+([A-Za-z_]\w*)\s*(\([^;{}]*\))/.exec(lines[i]);
              current.methods.push({
                name: methM[3], sig: `${methM[3]}${origMeth?.[4] ?? methM[4]}`,
                line: i + 1, visibility: visOf(methM[1])
              });
            }
          } else {
            const fieldM = /^\s*((?:(?:public|private|protected|internal|static|readonly|const|volatile)\s+)*)([\w<>\[\]?.,]+)\s+([A-Za-z_]\w*)\s*(=\s*([^;]+))?;/.exec(mline);
            if (fieldM && !fieldM[0].includes('(') && /^([A-Z]|string|int|long|short|byte|bool|float|double|decimal|char|var|object)/.test(fieldM[2].trim())) {
              const origField = /^\s*((?:(?:public|private|protected|internal|static|readonly|const|volatile)\s+)*)([\w<>\[\]?.,]+)\s+([A-Za-z_]\w*)\s*(=\s*([^;]+))?;/.exec(lines[i]);
              current.fields.push({
                name: fieldM[3], type: fieldM[2].trim(),
                defaultValue: (origField?.[5] ?? fieldM[5])?.trim(),
                line: i + 1, visibility: visOf(fieldM[1])
              });
            }
          }
        }
      }
    }

    depth += braces(mline);
    if (current && depth <= classDepth) {
      current = null;
      classDepth = -1;
    }
  }

  // top-level functions (C# 9+): static-free statements; detect local `void/Task Name(`
  const topFnRe = /^\s*(?:static\s+)?(?:async\s+)?([\w<>\[\]?]+)\s+([A-Za-z_]\w*)\s*(\([^;{}]*\))\s*[{;]/;
  for (let i = 0; i < mlines.length; i++) {
    if (classes.length > 0) break; // only when no class found (script-style file)
    const m = topFnRe.exec(mlines[i]);
    if (m && !/^(if|for|foreach|while|switch|catch|using)$/.test(m[2])) {
      functions.push({ name: m[2], file: relPath, folder, line: i + 1, sig: `${m[2]}${m[3]}` });
    }
  }

  void functions;
  void content;
  return { classes, functions };
}
