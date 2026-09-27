import hljs from 'highlight.js';
import { Segment } from './util';

interface TokenStyle {
  color: string;
  bold?: boolean;
  italic?: boolean;
}

export const DEFAULT_TEXT_COLOR = '#1f2328';

// GitHub-light inspired palette (prints well on white paper).
const C = {
  red: '#cf222e', purple: '#8250df', blue: '#0550ae', navy: '#0a3069',
  orange: '#953800', gray: '#6e7781', green: '#116329', brown: '#7d4e00'
};

const THEME: Record<string, TokenStyle> = {
  keyword: { color: C.red },
  doctag: { color: C.red },
  'template-tag': { color: C.red },
  'template-variable': { color: C.red },
  type: { color: C.red },
  'variable.language': { color: C.red },
  title: { color: C.purple },
  'title.class': { color: C.orange },
  'title.function': { color: C.purple },
  attr: { color: C.blue },
  attribute: { color: C.blue },
  literal: { color: C.blue },
  meta: { color: C.blue },
  number: { color: C.blue },
  operator: { color: C.blue },
  variable: { color: C.blue },
  'selector-attr': { color: C.blue },
  'selector-class': { color: C.blue },
  'selector-id': { color: C.blue },
  string: { color: C.navy },
  regexp: { color: C.navy },
  built_in: { color: C.orange },
  symbol: { color: C.orange },
  comment: { color: C.gray, italic: true },
  code: { color: C.gray },
  formula: { color: C.gray },
  name: { color: C.green },
  quote: { color: C.green },
  'selector-tag': { color: C.green },
  'selector-pseudo': { color: C.green },
  subst: { color: DEFAULT_TEXT_COLOR },
  section: { color: C.blue, bold: true },
  bullet: { color: C.brown },
  emphasis: { color: DEFAULT_TEXT_COLOR, italic: true },
  strong: { color: DEFAULT_TEXT_COLOR, bold: true },
  addition: { color: C.green },
  deletion: { color: '#82071e' }
};

const EXT_ALIASES: Record<string, string> = {
  tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  vue: 'xml', svelte: 'xml', astro: 'xml', htm: 'xml', html: 'xml', svg: 'xml',
  mdx: 'markdown', h: 'cpp', hpp: 'cpp', hh: 'cpp', hxx: 'cpp', cc: 'cpp', cxx: 'cpp',
  jsonc: 'json', yml: 'yaml', toml: 'ini', tf: 'ini', zsh: 'bash', sh: 'bash', fish: 'bash',
  ps1: 'powershell', psm1: 'powershell', bat: 'dos', cmd: 'dos', sass: 'scss',
  gql: 'graphql', proto: 'protobuf', exs: 'elixir', hrl: 'erlang', mli: 'ocaml',
  cljs: 'clojure', pm: 'perl', sol: 'javascript',
  dockerfile: 'dockerfile', makefile: 'makefile', 'cmakelists.txt': 'cmake',
  gemfile: 'ruby', rakefile: 'ruby', jenkinsfile: 'groovy'
};

export function resolveLanguage(ext: string): string | undefined {
  const candidate = EXT_ALIASES[ext] ?? ext;
  return hljs.getLanguage(candidate) ? candidate : undefined;
}

/** Language tag for Markdown code fences (clipboard output). */
export function fenceLanguage(ext: string): string {
  const special: Record<string, string> = {
    'cmakelists.txt': 'cmake', gemfile: 'ruby', rakefile: 'ruby', jenkinsfile: 'groovy'
  };
  return special[ext] ?? ext;
}

export function plainLines(text: string): Segment[][] {
  return text.split('\n').map((line) => (line ? [{ text: line }] : []));
}

/** Returns one array of colored segments per source line. */
export function highlightToLines(text: string, ext: string): Segment[][] {
  const language = resolveLanguage(ext);
  if (!language || !text) return plainLines(text);
  try {
    const html = hljs.highlight(text, { language, ignoreIllegals: true }).value;
    return htmlToLines(html);
  } catch {
    return plainLines(text);
  }
}

function styleForClasses(classAttr: string): TokenStyle | undefined {
  const names = classAttr.split(/\s+/).filter(Boolean).map((c) => c.replace(/^hljs-/, ''));
  if (names.length === 0) return undefined;
  if (names.length > 1) {
    const compound = `${names[0]}.${names[1].replace(/_$/, '')}`;
    if (THEME[compound]) return THEME[compound];
  }
  for (const n of names) if (THEME[n]) return THEME[n];
  return undefined;
}

function decodeEntity(entity: string): string {
  switch (entity) {
    case 'amp': return '&';
    case 'lt': return '<';
    case 'gt': return '>';
    case 'quot': return '"';
    case 'apos': return "'";
  }
  const code = entity.startsWith('#x') ? parseInt(entity.slice(2), 16)
    : entity.startsWith('#') ? parseInt(entity.slice(1), 10) : NaN;
  return Number.isFinite(code) ? String.fromCodePoint(code) : `&${entity};`;
}

/** Parses highlight.js HTML output (nested <span class="hljs-*">) into styled lines. */
function htmlToLines(html: string): Segment[][] {
  const lines: Segment[][] = [[]];
  const stack: (TokenStyle | undefined)[] = [];
  let buf = '';

  const currentStyle = (): TokenStyle | undefined => {
    for (let k = stack.length - 1; k >= 0; k--) if (stack[k]) return stack[k];
    return undefined;
  };

  const flush = () => {
    if (!buf) return;
    const style = currentStyle();
    const parts = buf.split('\n');
    parts.forEach((part, idx) => {
      if (idx > 0) lines.push([]);
      if (part) {
        lines[lines.length - 1].push({
          text: part, color: style?.color, bold: style?.bold, italic: style?.italic
        });
      }
    });
    buf = '';
  };

  let i = 0;
  while (i < html.length) {
    const ch = html[i];
    if (ch === '<') {
      const end = html.indexOf('>', i);
      if (end === -1) { buf += html.slice(i); break; }
      const tag = html.slice(i + 1, end);
      flush();
      if (tag.startsWith('/')) {
        stack.pop();
      } else {
        const m = /class="([^"]*)"/.exec(tag);
        stack.push(m ? styleForClasses(m[1]) : undefined);
      }
      i = end + 1;
    } else if (ch === '&') {
      const end = html.indexOf(';', i);
      if (end !== -1 && end - i <= 10) {
        buf += decodeEntity(html.slice(i + 1, end));
        i = end + 1;
      } else {
        buf += ch;
        i++;
      }
    } else {
      buf += ch;
      i++;
    }
  }
  flush();
  return lines;
}
