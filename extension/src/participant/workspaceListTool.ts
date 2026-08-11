import * as vscode from 'vscode';
import {
  LIST_WORKSPACE_ENTRIES_TOOL_ID,
  WorkspaceEntryKind,
  WorkspaceRootEntries,
  summariseWorkspaceEntries,
} from '../core/workspaceTools';
import { ToolExecutor } from '../core/toolBroker';

/** VS Code boundary for the deliberately narrow workspace-discovery capability. */
export class WorkspaceListToolExecutor implements ToolExecutor {
  public async execute(
    request: Parameters<ToolExecutor['execute']>[0],
    signal: AbortSignal,
  ) {
    if (request.tool.id !== LIST_WORKSPACE_ENTRIES_TOOL_ID) {
      throw new Error(`WorkspaceListToolExecutor cannot execute '${request.tool.id}'.`);
    }
    throwIfAborted(signal);

    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) {
      return {
        evidenceSummary: 'No workspace folder is open.',
        provenance: 'vscode.workspace.workspaceFolders',
      };
    }

    const roots: WorkspaceRootEntries[] = [];
    for (const folder of folders) {
      try {
        const entries = await vscode.workspace.fs.readDirectory(folder.uri);
        roots.push({
          name: folder.name,
          entries: entries.map(([name, type]) => ({ name, kind: entryKind(type) })),
        });
      } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : 'Unknown filesystem error.';
        throw new Error(`Could not list the workspace root '${folder.name}': ${detail}`);
      }
      throwIfAborted(signal);
    }

    return {
      evidenceSummary: summariseWorkspaceEntries(roots),
      provenance: 'vscode.workspace.fs.readDirectory',
    };
  }
}

function entryKind(type: vscode.FileType): WorkspaceEntryKind {
  if (type & vscode.FileType.Directory) return 'directory';
  if (type & vscode.FileType.File) return 'file';
  if (type & vscode.FileType.SymbolicLink) return 'symbolic-link';
  return 'unknown';
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('Workspace listing cancelled.', 'AbortError');
}
