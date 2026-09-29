import { ClassInfo, FunctionInfo, Visibility } from './types';
import { folderOf } from './mask';

function visOf(mods: string, name: string): Visibility {
  if (/private/.test(mods)) return 'private';
  if (/protected/.test(mods)) return 'protected';
  if (/public/.test(mods)) return 'public';
  // package-private -> treat as public for listing purposes? keep protected-neutral: public
  void name;
  return 'public';
}

export function extractJava(relPath: string, content: string, masked: string): { classes: ClassInfo[]; functions: FunctionInfo[] } {
  const classes: ClassInfo[] = [];
  const functions: FunctionInfo[] = [];
  const lines = content.split('\n');
  const mlines = masked.split('\n');
  const folder = folderOf(relPath);

  const classRe = /^\s*(?:public|private|protected|static|final|abstract|sealed\s+\w+)?\s*(?:public|private|protected|static|final|abstract)*\s*(class|interface|enum|record)\s+([A-Za-z_]\w*)\s*(?:extends\s+([A-Za-z_][\w.]*))?\s*(?:implements\s+([A-Za-z_][\w.,\s]*))?/;
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
    if (cm) {
      const bases: string[] = [];
      if (cm[3]) bases.push(cm[3]);
      if (cm[4]) bases.push(...cm[4].split(',').map((s) => s.trim()).filter(Boolean));
      current = {
        name: cm[2], file: relPath, folder, line: i + 1,
        baseClasses: bases, methods: [], fields: []
      };
      classes.push(current);
      classDepth = depth;
    }

    if (current) {
      // ctor: [mods] ClassName(params)
      const ctorRe = new RegExp(`^\\s*((?:public|private|protected)\\s+)?${current.name}\\s*(\\([^;{}]*\\))\\s*(?:throws\\s+[^{]+)?\\s*[\\{;]?\\s*\\}?\\s*$`);
      const ctorM = ctorRe.exec(mline);
      if (ctorM) {
        const origCtor = ctorRe.exec(lines[i]);
        current.ctorSig = `${current.name}${origCtor?.[2] ?? ctorM[2]}`;
      } else {
        // method: [mods] [static] Type name(params) [throws..]
        const methM = /^\s*((?:(?:public|private|protected|static|final|abstract|synchronized|default)\s+)*)([\w<>\[\].,? ]+?)\s+([A-Za-z_]\w*)\s*(\([^;{}]*\))\s*(?:throws\s+[^{;]+)?\s*[{;]/.exec(mline);
        if (methM && !/^(if|for|while|switch|catch|return|new)$/.test(methM[3])) {
          const origMeth = /^\s*((?:(?:public|private|protected|static|final|abstract|synchronized|default)\s+)*)([\w<>\[\].,? ]+?)\s+([A-Za-z_]\w*)\s*(\([^;{}]*\))\s*(?:throws\s+[^{;]+)?\s*[{;]/.exec(lines[i]);
          current.methods.push({
            name: methM[3],
            sig: `${methM[3]}${origMeth?.[4] ?? methM[4]}${methM[2].trim() && methM[2].trim() !== methM[3] ? ': ' + methM[2].trim().split(/\s+/).pop() : ''}`,
            line: i + 1, visibility: visOf(methM[1], methM[3])
          });
        } else {
          // field: [mods] Type name [= val];
          const fieldM = /^\s*((?:(?:public|private|protected|static|final|volatile|transient)\s+)*)([\w<>\[\].]+)\s+([A-Za-z_]\w*)\s*(=\s*([^;]+))?;/.exec(mline);
          if (fieldM && !fieldM[0].includes('(')) {
            // avoid matching method-call statements: type must start uppercase or be primitive
            if (/^([A-Z]|byte|short|int|long|float|double|boolean|char|void)/.test(fieldM[2].trim())) {
              const origField = /^\s*((?:(?:public|private|protected|static|final|volatile|transient)\s+)*)([\w<>\[\].]+)\s+([A-Za-z_]\w*)\s*(=\s*([^;]+))?;/.exec(lines[i]);
              current.fields.push({
                name: fieldM[3], type: fieldM[2].trim(),
                defaultValue: (origField?.[5] ?? fieldM[5])?.trim(),
                line: i + 1, visibility: visOf(fieldM[1], fieldM[3])
              });
            }
          }
        }
      }
    } else {
      // top-level function cannot exist in Java outside class; skip
    }

    depth += braces(mline);
    if (current && depth <= classDepth) {
      current = null;
      classDepth = -1;
    }
  }

  void functions;
  void content;
  void lines;
  return { classes, functions };
}
