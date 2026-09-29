import { ClassInfo, FunctionInfo, Visibility } from './types';
import { folderOf } from './mask';

export function extractCpp(relPath: string, content: string, masked: string): { classes: ClassInfo[]; functions: FunctionInfo[] } {
  const classes: ClassInfo[] = [];
  const functions: FunctionInfo[] = [];
  const lines = content.split('\n');
  const mlines = masked.split('\n');
  const folder = folderOf(relPath);
  const byName = new Map<string, ClassInfo>();

  const getOrCreate = (name: string, line: number, bases: string[]): ClassInfo => {
    let cls = byName.get(name);
    if (!cls) {
      cls = { name, file: relPath, folder, line, baseClasses: bases, methods: [], fields: [] };
      byName.set(name, cls);
      classes.push(cls);
    } else {
      for (const b of bases) if (!cls.baseClasses.includes(b)) cls.baseClasses.push(b);
    }
    return cls;
  };

  const classRe = /^\s*(?:template\s*<[^>]*>\s*)?(?:class|struct)\s+([A-Za-z_]\w*)\s*(?::\s*([^{;]+))?\s*[{;]/;
  let current: ClassInfo | null = null;
  let visibility: Visibility = 'private'; // class default
  let classIsStruct = false;
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

  for (let i = 0; i < mlines.length; i++) {
    const mline = mlines[i];
    const cm = classRe.exec(mline);
    if (cm) {
      const isStruct = /^\s*(?:template[^;]*?)?struct\s/.test(mline);
      const bases = (cm[2] ?? '').split(',').map((s) => s.replace(/^(public|private|protected|virtual)\s+/, '').trim()).filter(Boolean);
      current = getOrCreate(cm[1], i + 1, bases);
      classIsStruct = isStruct;
      visibility = isStruct ? 'public' : 'private';
      classDepth = depth;
      void classIsStruct;
    }

    if (current) {
      const visM = /^\s*(public|private|protected)\s*:\s*$/.exec(mline);
      if (visM) visibility = visM[1] as Visibility;

      // ctor decl: ClassName(params)  (inside class) or ClassName::ClassName outside
      const ctorIn = new RegExp(`^\\s*(?:explicit\\s+)?${current.name}\\s*(\\([^;{}]*\\))\\s*(?::[^{;]*)?\\s*[;{]`);
      const ctorOut = new RegExp(`^\\s*(?:[\\w:<>*&~\\s]+?\\s+)?${current.name}::${current.name}\\s*(\\([^;{}]*\\))`);
      let m = ctorIn.exec(mline) ?? ctorOut.exec(mline);
      if (m) {
        const om = ctorIn.exec(lines[i]) ?? ctorOut.exec(lines[i]);
        if (!current.ctorSig) current.ctorSig = `${current.name}${om?.[1] ?? m[1]}`;
      } else {
        // method decl/def: [Type] [Class::]name(params) [const] [;{]
        const methIn = /^\s*(?:virtual\s+|static\s+|explicit\s+|inline\s+|constexpr\s+|friend\s+)*([\w:<>*&,\s]+?)\s+([A-Za-z_~]\w*)\s*(\([^;{}]*\))\s*(?:const\s*)?(?:override\s*)?(?:final\s*)?(?:=\s*0\s*)?[;{]/;
        const mm = methIn.exec(mline);
        if (mm && !/^(if|for|while|switch|catch|return|sizeof)$/.test(mm[2])) {
          // destructor counts as method
          const isMember = !mm[0].includes('::') || mm[0].includes(`${current.name}::`);
          if (isMember && mm[2] !== current.name) {
            const name = mm[2].replace(/^~/, '');
            if (!current.methods.some((x) => x.name === name && x.line === i + 1)) {
              const omm = methIn.exec(lines[i]);
              current.methods.push({ name, sig: `${mm[2]}${omm?.[3] ?? mm[3]}`, line: i + 1, visibility });
            }
          }
        } else {
          // field: Type name [= v];
          const fieldM = /^\s*([\w:<>*&,\s]+?)\s+([A-Za-z_]\w*)\s*(=\s*([^;]+))?;/.exec(mline);
          if (fieldM && !fieldM[0].includes('(') && depth === classDepth + 1) {
            if (/^([A-Z]|int|long|short|char|bool|float|double|unsigned|signed|std::|const |static |mutable |virtual )/.test(fieldM[1].trim())) {
              const origField = /^\s*([\w:<>*&,\s]+?)\s+([A-Za-z_]\w*)\s*(=\s*([^;]+))?;/.exec(lines[i]);
              current.fields.push({
                name: fieldM[2], type: fieldM[1].trim(),
                defaultValue: (origField?.[4] ?? fieldM[4])?.trim(), line: i + 1, visibility
              });
            }
          }
        }
      }
    }

    // free function: Type name(params) {  (outside class scope)
    if (!current) {
      const fnM = /^\s*(?:static\s+|inline\s+|constexpr\s+|extern\s+)*(?:template\s*<[^>]*>\s*)?([\w:<>*&,\s]+?)\s+([A-Za-z_]\w*(?:::[A-Za-z_]\w*)?)\s*(\([^;{}]*\))\s*(?:const\s*)?\{/.exec(mline);
      if (fnM && !/^(if|for|while|switch|catch)$/.test(fnM[2])) {
        const fullName = fnM[2];
        if (fullName.includes('::')) {
          const [clsName, meth] = fullName.split('::');
          const cls = byName.get(clsName);
          if (cls) {
            if (meth === clsName) {
              if (!cls.ctorSig) cls.ctorSig = `${clsName}${fnM[3]}`;
            } else if (!cls.methods.some((x) => x.name === meth)) {
              cls.methods.push({ name: meth, sig: `${meth}${fnM[3]}`, line: i + 1, visibility: 'public' });
            }
            depth += braces(mline);
            continue;
          }
        }
        functions.push({ name: fullName, file: relPath, folder, line: i + 1, sig: `${fullName}${fnM[3]}` });
      }
    }

    depth += braces(mline);
    if (current && depth <= classDepth) {
      current = null;
      classDepth = -1;
    }
  }

  return { classes, functions };
}
