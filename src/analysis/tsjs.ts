import { ClassInfo, FunctionInfo, Visibility } from './types';
import { folderOf } from './mask';

function visOf(name: string, modifiers: string): Visibility {
  if (/private/.test(modifiers) || name.startsWith('#')) return 'private';
  if (/protected/.test(modifiers)) return 'protected';
  if (/public/.test(modifiers)) return 'public';
  return 'public';
}

export function extractTsJs(relPath: string, content: string, masked: string): { classes: ClassInfo[]; functions: FunctionInfo[] } {
  const classes: ClassInfo[] = [];
  const functions: FunctionInfo[] = [];
  const lines = content.split('\n');
  const mlines = masked.split('\n');
  const folder = folderOf(relPath);

  const classRe = /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)\s*(?:extends\s+([A-Za-z_$][\w$.]*))?\s*(?:implements\s+([A-Za-z_$][\w$.,\s]*))?/;

  interface Ctx { cls: ClassInfo; braceDepth: number; startDepth: number; }
  const stack: Ctx[] = [];
  let depth = 0;

  const countBraces = (s: string): number => {
    let d = 0;
    for (const ch of s) {
      if (ch === '{') d++;
      else if (ch === '}') d--;
    }
    return d;
  };

  for (let i = 0; i < lines.length; i++) {
    const mline = mlines[i];
    const line = lines[i];
    const cm = classRe.exec(mline);
    if (cm) {
      const bases: string[] = [];
      if (cm[2]) bases.push(cm[2]);
      if (cm[3]) bases.push(...cm[3].split(',').map((s) => s.trim()).filter(Boolean));
      const cls: ClassInfo = {
        name: cm[1], file: relPath, folder, line: i + 1,
        baseClasses: bases, methods: [], fields: []
      };
      classes.push(cls);
      stack.push({ cls, braceDepth: depth, startDepth: depth });
    }

    // member / function detection inside class context
    const inClass = stack.length > 0 ? stack[stack.length - 1] : null;

    // constructor (detect on masked line, capture params from the original
    // so string defaults survive the mask)
    const ctorM = /^\s*(?:public|private|protected)?\s*constructor\s*(\([^)]*\))/.exec(mline);
    if (ctorM && inClass) {
      const origCtor = /^\s*(?:public|private|protected)?\s*constructor\s*(\([^)]*\))/.exec(line);
      inClass.cls.ctorSig = `constructor${origCtor?.[1] ?? ctorM[1]}`;
      // ctor params with `private x: T` / `public readonly` become fields
      const inner = ctorM[1].slice(1, -1);
      for (const p of inner.split(',').map((s) => s.trim()).filter(Boolean)) {
        const pm = /(private|protected|public|readonly)[\s\w]*?(\w+)\s*(?::\s*([^=]+))?\s*(=\s*(.+))?/.exec(p);
        if (pm && /(private|protected|public)/.test(pm[1])) {
          inClass.cls.fields.push({
            name: pm[2], type: pm[3]?.trim(), defaultValue: pm[5]?.trim(),
            line: i + 1, visibility: visOf(pm[2], pm[1])
          });
        }
      }
    }

    // method: [modifiers] name(params): ret {
    const methM = /^\s*(public|private|protected)?\s*(static\s+)?(async\s+)?[*]?\s*([A-Za-z_$][\w$]*)\s*(\([^;{}]*\))\s*(?::\s*([^{;=]+))?/.exec(mline);
    if (methM && inClass && !/^(if|for|while|switch|catch|constructor|function)$/.test(methM[4])) {
      const after = mline.slice((methM[0] as string).length);
      // heuristic: method if followed by { or is on one line with body/abstract/; (declaration)
      if (/^\s*[{;]/.test(after) || /[{;]\s*$/.test(mline)) {
        const origMeth = /^\s*(public|private|protected)?\s*(static\s+)?(async\s+)?[*]?\s*([A-Za-z_$][\w$]*)\s*(\([^;{}]*\))\s*(?::\s*([^{;=]+))?/.exec(line);
        const sig = `${methM[4]}${origMeth?.[5] ?? methM[5]}${(origMeth?.[6] ?? methM[6]) ? ': ' + (origMeth?.[6] ?? methM[6]).trim() : ''}`;
        inClass.cls.methods.push({
          name: methM[4], sig: sig.trim(), line: i + 1,
          visibility: visOf(methM[4], methM[1] ?? '')
        });
      }
    }

    // field: [modifiers] name[: type] [= default];
    const fieldM = /^\s*(public|private|protected)?\s*(static\s+)?(readonly\s+)?([A-Za-z_$][\w$]*)\s*(?::\s*([^=;]+))?\s*=\s*([^;]+);?\s*$/.exec(mline);
    if (fieldM && inClass && !fieldM[0].includes('(')) {
      const origField = /^\s*(public|private|protected)?\s*(static\s+)?(readonly\s+)?([A-Za-z_$][\w$]*)\s*(?::\s*([^=;]+))?\s*=\s*([^;]+);?\s*$/.exec(line);
      const mods = `${fieldM[1] ?? ''}`;
      inClass.cls.fields.push({
        name: fieldM[4], type: (origField?.[5] ?? fieldM[5])?.trim(), defaultValue: (origField?.[6] ?? fieldM[6])?.trim(),
        line: i + 1, visibility: visOf(fieldM[4], mods)
      });
    } else {
      const fieldDeclM = /^\s*(public|private|protected)\s+([A-Za-z_$][\w$]*)\s*(?::\s*([^=;]+))?\s*;/.exec(mline);
      if (fieldDeclM && inClass) {
        inClass.cls.fields.push({
          name: fieldDeclM[2], type: fieldDeclM[3]?.trim(),
          line: i + 1, visibility: visOf(fieldDeclM[2], fieldDeclM[1])
        });
      }
    }

    // top-level function: [export] [async] function name(params)
    const fnM = /^\s*(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s*[*]?\s*([A-Za-z_$][\w$]*)\s*(\([^)]*\))/.exec(mline);
    if (fnM) {
      const origFn = /^\s*(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s*[*]?\s*([A-Za-z_$][\w$]*)\s*(\([^)]*\))/.exec(line);
      functions.push({
        name: fnM[1], file: relPath, folder, line: i + 1,
        sig: `function ${fnM[1]}${origFn?.[2] ?? fnM[2]}`,
        exported: /^\s*export/.test(mline)
      });
    } else {
      // const name = (...) =>  / function expression
      const arrowM = /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(async\s*)?(\([^)]*\)\s*=>|\(?[\w$,{\s}:]*\)?\s*:\s*[\w<>\[\]|]+\s*=>)/.exec(mline);
      if (arrowM && !inClass) {
        functions.push({
          name: arrowM[1], file: relPath, folder, line: i + 1,
          sig: `${arrowM[1]} = ${line.trim().slice(line.indexOf('=') + 1).slice(0, 120)}`,
          exported: /^\s*export/.test(mline)
        });
      }
    }

    depth += countBraces(mline);
    while (stack.length > 0 && depth <= stack[stack.length - 1].braceDepth && countBraces(mline) < 0) {
      stack.pop();
    }
    // pop classes whose block closed: if depth returned to startDepth and we saw a { since
    while (stack.length > 0 && depth < stack[stack.length - 1].startDepth + 1 && stack[stack.length - 1].braceDepth >= depth) {
      // keep simple: only pop when depth <= braceDepth and at least one line passed
      if (depth <= stack[stack.length - 1].braceDepth) stack.pop();
      else break;
    }
  }

  return { classes, functions };
}
