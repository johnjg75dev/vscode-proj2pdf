/** Shared data model for the optional analysis sections. */

export type Visibility = 'public' | 'private' | 'protected' | 'unknown';
export type SortMode = 'alpha' | 'file' | 'folder';
export type GroupMode = 'flat' | 'file' | 'folder';

export interface MethodInfo {
  name: string;
  sig: string;
  line: number;
  visibility: Visibility;
}

export interface FieldInfo {
  name: string;
  type?: string;
  defaultValue?: string;
  line: number;
  visibility: Visibility;
}

export interface ClassInfo {
  name: string;
  file: string;
  folder: string;
  line: number;
  ctorSig?: string;
  baseClasses: string[];
  methods: MethodInfo[];
  fields: FieldInfo[];
  heuristic?: boolean;
}

export interface FunctionInfo {
  name: string;
  file: string;
  folder: string;
  line: number;
  sig: string;
  parentClass?: string;
  exported?: boolean;
  heuristic?: boolean;
}

export interface StringRef {
  value: string;
  file: string;
  line: number;
}

export interface UsageRef {
  file: string;
  line: number;
  code: string;
}

export interface DepEdge {
  from: string;
  to: string;
  raw: string;
  resolved: boolean;
}

export interface AnalysisResult {
  classes: ClassInfo[];
  functions: FunctionInfo[];
  strings: StringRef[];
  dependencies: DepEdge[];
  /** Reverse index: file -> files that depend on it. Built by dependencies.ts. */
  dependents: Map<string, string[]>;
  classUsages: Map<string, UsageRef[]>;
  functionUsages: Map<string, UsageRef[]>;
  truncated: { usages: boolean; strings: boolean };
}

export interface ClassListOptions {
  enabled: boolean;
  sort: SortMode;
  groupBy: GroupMode;
  showCtor: boolean;
  showMethods: boolean;
  showFields: 'both' | 'public' | 'private' | 'none';
  showDefaults: boolean;
  showBaseClass: boolean;
}

export interface FunctionListOptions {
  enabled: boolean;
  sort: SortMode;
  groupBy: GroupMode;
  includeMethods: boolean;
  showSigs: boolean;
  showDefaults: boolean;
}

export interface UsagesOptions {
  enabledClasses: boolean;
  enabledFunctions: boolean;
  contextLines: number;
  maxHitsPerSymbol: number;
  /** Skip symbols with zero hits (do not render them). Default true. */
  skipEmpty: boolean;
  /** Combine all skipped zero-hit symbols into a single summary line. Default true. */
  summarizeEmpty: boolean;
}

export interface StringListOptions {
  enabled: boolean;
  sort: SortMode;
  groupBy: 'flat' | 'file';
  minLength: number;
  dedupe: boolean;
  maxItems: number;
}

export interface DependenciesOptions {
  enabled: boolean;
  direction: 'outgoing' | 'incoming' | 'both';
  showUnresolved: boolean;
}

export interface SectionOptions {
  classList: ClassListOptions;
  functionList: FunctionListOptions;
  usages: UsagesOptions;
  strings: StringListOptions;
  dependencies: DependenciesOptions;
  placement: 'before' | 'after';
  order: string[];
}

export function defaultSectionOptions(): SectionOptions {
  return {
    classList: {
      enabled: false, sort: 'alpha', groupBy: 'flat',
      showCtor: true, showMethods: false,
      showFields: 'none', showDefaults: true, showBaseClass: true
    },
    functionList: {
      enabled: false, sort: 'alpha', groupBy: 'flat',
      includeMethods: false, showSigs: true, showDefaults: true
    },
    usages: { enabledClasses: false, enabledFunctions: false, contextLines: 0, maxHitsPerSymbol: 50, skipEmpty: true, summarizeEmpty: true },
    strings: { enabled: false, sort: 'alpha', groupBy: 'flat', minLength: 2, dedupe: true, maxItems: 5000 },
    dependencies: { enabled: false, direction: 'outgoing', showUnresolved: true },
    placement: 'before',
    order: ['classList', 'functionList', 'usages', 'strings', 'dependencies']
  };
}

/** Returns a copy with every section switched off (master Analysis toggle). */
export function disableAllSections(s: SectionOptions): SectionOptions {
  const c: SectionOptions = JSON.parse(JSON.stringify(s)) as SectionOptions;
  c.classList.enabled = false;
  c.functionList.enabled = false;
  c.usages.enabledClasses = false;
  c.usages.enabledFunctions = false;
  c.strings.enabled = false;
  c.dependencies.enabled = false;
  return c;
}

/** True when at least one analysis section will be rendered. */
export function anySectionEnabled(s: SectionOptions): boolean {
  return s.classList.enabled || s.functionList.enabled ||
    s.usages.enabledClasses || s.usages.enabledFunctions ||
    s.strings.enabled || s.dependencies.enabled;
}
