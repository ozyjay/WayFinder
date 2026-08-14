import { ToolDefinition } from './toolBroker';

export const WORKSPACE_OBSERVE_CAPABILITY = 'workspace.observe';
export const WORKSPACE_READ_CAPABILITY = 'workspace.read';
export const LIST_WORKSPACE_ENTRIES_TOOL_ID = 'list_workspace_entries';
export const READ_WORKSPACE_TEXT_FILE_TOOL_ID = 'read_workspace_text_file';
export const MAX_WORKSPACE_ENTRIES = 40;
export const MAX_WORKSPACE_TEXT_FILE_BYTES = 12 * 1024;

export type WorkspaceEntryKind = 'file' | 'directory' | 'symbolic-link' | 'unknown';

export interface WorkspaceEntry {
  readonly name: string;
  readonly kind: WorkspaceEntryKind;
}

export interface WorkspaceRootEntries {
  readonly name: string;
  readonly entries: readonly WorkspaceEntry[];
}

/**
 * The first owned-runtime capability: bounded, non-recursive workspace
 * discovery. File names enter the model-visible evidence only after a model
 * explicitly requests this tool; diagnostics never retain the listing.
 */
export const listWorkspaceEntriesTool: ToolDefinition = {
  id: LIST_WORKSPACE_ENTRIES_TOOL_ID,
  capabilities: [WORKSPACE_OBSERVE_CAPABILITY],
  description: `List up to ${MAX_WORKSPACE_ENTRIES} direct entries in the open workspace roots. This is non-recursive and read-only.`,
  inputSchema: { type: 'object' },
  risk: 'read-only',
  requiresApproval: false,
  expectedOutputClass: 'evidence',
  isAvailable: (state) => !state.completedActions.some((action) => action.toolId === LIST_WORKSPACE_ENTRIES_TOOL_ID),
};

/**
 * A single direct UTF-8 text-file read, available only after workspace
 * discovery. Its bounded content becomes transient model context for the next
 * inference; it never enters task state or diagnostics.
 */
export const readWorkspaceTextFileTool: ToolDefinition = {
  id: READ_WORKSPACE_TEXT_FILE_TOOL_ID,
  capabilities: [WORKSPACE_READ_CAPABILITY],
  description: `Read one direct UTF-8 text file from the open workspace root, up to ${MAX_WORKSPACE_TEXT_FILE_BYTES} bytes. Use the exact file name returned by the workspace listing.`,
  inputSchema: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } },
  risk: 'read-only',
  requiresApproval: false,
  expectedOutputClass: 'evidence',
  isAvailable: (state) => state.completedActions.some((action) => action.toolId === LIST_WORKSPACE_ENTRIES_TOOL_ID)
    && !state.completedActions.some((action) => action.toolId === READ_WORKSPACE_TEXT_FILE_TOOL_ID),
};

/** Only direct file names are accepted: no nested paths, traversal, or NULs. */
export function isDirectWorkspaceFileName(value: string): boolean {
  return Boolean(value)
    && value !== '.'
    && value !== '..'
    && !value.includes('/')
    && !value.includes('\\')
    && !value.includes('\0');
}

export function summariseWorkspaceEntries(
  roots: readonly WorkspaceRootEntries[],
  maximumEntries = MAX_WORKSPACE_ENTRIES,
): string {
  if (!Number.isInteger(maximumEntries) || maximumEntries < 1) {
    throw new Error('The workspace-entry limit must be a positive integer.');
  }
  if (!roots.length) return 'No workspace folder is open.';

  const totalEntries = roots.reduce((total, root) => total + root.entries.length, 0);
  const rendered: string[] = [];
  let remaining = maximumEntries;

  for (const root of roots) {
    if (!remaining) break;
    const entries = [...root.entries]
      .sort((left, right) => left.name.localeCompare(right.name))
      .slice(0, remaining);
    if (!entries.length) continue;
    rendered.push(`${clip(root.name)}: ${entries.map((entry) => `${clip(entry.name)} (${entry.kind})`).join(', ')}`);
    remaining -= entries.length;
  }

  const displayed = maximumEntries - remaining;
  return `Top-level workspace entries (showing ${displayed} of ${totalEntries}): ${rendered.join('; ')}`;
}

function clip(value: string): string {
  const maximumLength = 120;
  return value.length <= maximumLength ? value : `${value.slice(0, maximumLength - 1)}…`;
}
