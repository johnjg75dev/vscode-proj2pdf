import { compareNames } from './util';

export type TreeStyle = 'unicode' | 'ascii';

interface TreeNode {
  children: Map<string, TreeNode>;
  isFile: boolean;
}

const GLYPHS: Record<TreeStyle, { branch: string; last: string; pipe: string; blank: string }> = {
  unicode: { branch: '├── ', last: '└── ', pipe: '│   ', blank: '    ' },
  ascii: { branch: '|-- ', last: '`-- ', pipe: '|   ', blank: '    ' }
};

/** Builds an explorer-style tree (folders first) from a list of relative POSIX paths. */
export function buildTreeLines(paths: string[], rootName: string, style: TreeStyle): string[] {
  const root: TreeNode = { children: new Map(), isFile: false };

  for (const p of paths) {
    const parts = p.split('/');
    let node = root;
    for (let i = 0; i < parts.length; i++) {
      let child = node.children.get(parts[i]);
      if (!child) {
        child = { children: new Map(), isFile: i === parts.length - 1 };
        node.children.set(parts[i], child);
      }
      node = child;
    }
  }

  const g = GLYPHS[style];
  const lines: string[] = [`${rootName}/`];

  const walk = (node: TreeNode, prefix: string): void => {
    const entries = [...node.children.entries()].sort(([an, a], [bn, b]) => {
      if (a.isFile !== b.isFile) return a.isFile ? 1 : -1;
      return compareNames(an, bn);
    });
    entries.forEach(([name, child], idx) => {
      const last = idx === entries.length - 1;
      lines.push(prefix + (last ? g.last : g.branch) + name + (child.isFile ? '' : '/'));
      if (!child.isFile) walk(child, prefix + (last ? g.blank : g.pipe));
    });
  };

  walk(root, '');
  return lines;
}
