import * as vscode from 'vscode';
import { FileFilterOptions, MinifyLevel, ToggleOptions } from './config';
import { SectionOptions } from './analysis/types';

export type PresetScope = 'global' | 'workspace';

export interface PresetData {
  toggles: ToggleOptions;
  minifyLevel: MinifyLevel;
  sections: SectionOptions;
  /** Master Analysis toggle (raw sub-section values live in `sections`). */
  analysisEnabled: boolean;
  fileFilter: FileFilterOptions;
}

export interface Preset extends PresetData {
  name: string;
  scope: PresetScope;
}

const GLOBAL_KEY = 'projectExporter.presets.global';
const WS_KEY_PREFIX = 'projectExporter.presets.ws.';
const MAX_NAME_LEN = 60;

/** Stable per-workspace key suffix (workspace file or folder list). */
function workspaceSuffix(): string {
  const ws = vscode.workspace;
  const raw = ws.workspaceFile?.toString() ?? ws.workspaceFolders?.map((f) => f.uri.toString()).join('|') ?? 'adhoc';
  let hash = 0;
  for (let i = 0; i < raw.length; i++) hash = (hash * 31 + raw.charCodeAt(i)) >>> 0;
  const label = ws.name ?? 'workspace';
  return `${label.replace(/[^\w\-.]+/g, '_').slice(0, 40)}-${hash.toString(36)}`;
}

function keyFor(scope: PresetScope): string {
  return scope === 'global' ? GLOBAL_KEY : WS_KEY_PREFIX + workspaceSuffix();
}

function readAll(context: vscode.ExtensionContext, scope: PresetScope): Record<string, PresetData> {
  return context.globalState.get<Record<string, PresetData>>(keyFor(scope), {});
}

/** All presets, global first then workspace-scoped. */
export function listPresets(context: vscode.ExtensionContext): Preset[] {
  const out: Preset[] = [];
  for (const [name, data] of Object.entries(readAll(context, 'global'))) {
    out.push({ name, scope: 'global', ...data });
  }
  for (const [name, data] of Object.entries(readAll(context, 'workspace'))) {
    out.push({ name, scope: 'workspace', ...data });
  }
  return out;
}

export function getPreset(
  context: vscode.ExtensionContext, name: string, scope: PresetScope
): Preset | undefined {
  const data = readAll(context, scope)[name];
  return data ? { name, scope, ...deepClone(data) } : undefined;
}

export function presetExists(
  context: vscode.ExtensionContext, name: string, scope: PresetScope
): boolean {
  return readAll(context, scope)[name] !== undefined;
}

export async function savePreset(
  context: vscode.ExtensionContext, name: string, scope: PresetScope, data: PresetData
): Promise<void> {
  const all = readAll(context, scope);
  all[name] = deepClone(data);
  await context.globalState.update(keyFor(scope), all);
}

export async function deletePreset(
  context: vscode.ExtensionContext, name: string, scope: PresetScope
): Promise<boolean> {
  const all = readAll(context, scope);
  if (!(name in all)) return false;
  delete all[name];
  await context.globalState.update(keyFor(scope), all);
  return true;
}

function deepClone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

const NAME_RE = /^[\w\-.][\w\-. ]*$/;

/** Prompts for a preset name + scope. Returns undefined when cancelled. */
export async function promptPresetTarget(
  context: vscode.ExtensionContext,
  suggestedName?: string
): Promise<{ name: string; scope: PresetScope } | undefined> {
  const name = (await vscode.window.showInputBox({
    title: 'Save export preset',
    prompt: 'Name for this preset (all panel settings except per-file picks)',
    value: suggestedName ?? '',
    validateInput: (v) => {
      const t = v.trim();
      if (!t) return 'Enter a name.';
      if (t.length > MAX_NAME_LEN) return `Max ${MAX_NAME_LEN} characters.`;
      if (!NAME_RE.test(t)) return 'Use letters, numbers, spaces, dash, dot or underscore.';
      return undefined;
    }
  }))?.trim();
  if (!name) return undefined;

  const scopePick = await vscode.window.showQuickPick(
    [
      { label: '$(globe) Global', description: 'Available in every workspace', scope: 'global' as PresetScope },
      { label: '$(folder) This workspace', description: vscode.workspace.name ?? 'Current workspace', scope: 'workspace' as PresetScope }
    ],
    { title: `Where should preset "${name}" live?`, placeHolder: 'Preset scope' }
  );
  if (!scopePick) return undefined;

  if (presetExists(context, name, scopePick.scope)) {
    const overwrite = await vscode.window.showQuickPick(['Overwrite', 'Cancel'], {
      title: `Preset "${name}" already exists (${scopePick.scope}). Overwrite?`
    });
    if (overwrite !== 'Overwrite') return undefined;
  }
  return { name, scope: scopePick.scope };
}

/** Prompts to choose an existing preset (for load/delete). */
export async function promptChoosePreset(
  context: vscode.ExtensionContext,
  title: string,
  emptyMessage: string
): Promise<Preset | undefined> {
  const presets = listPresets(context);
  if (presets.length === 0) {
    void vscode.window.showInformationMessage(emptyMessage);
    return undefined;
  }
  const pick = await vscode.window.showQuickPick(
    presets.map((p) => ({
      label: `${p.scope === 'global' ? '$(globe)' : '$(folder)'} ${p.name}`,
      description: p.scope === 'global' ? 'Global' : 'This workspace',
      preset: p
    })),
    { title, placeHolder: 'Choose a preset' }
  );
  return pick?.preset;
}
