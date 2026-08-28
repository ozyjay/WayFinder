import * as vscode from 'vscode';
import {
  LIST_WORKSPACE_ENTRIES_TOOL_ID,
  MAX_WORKSPACE_TEXT_FILE_BYTES,
  READ_WORKSPACE_TEXT_FILE_TOOL_ID,
  WorkspaceEntryKind,
  WorkspaceRootEntries,
  isDirectWorkspaceFileName,
  summariseWorkspaceEntries,
} from '../core/workspaceTools';
import { ToolExecutionError, ToolExecutor } from '../core/toolBroker';

/** VS Code boundary for deliberately narrow workspace-observation capabilities. */
export class WorkspaceToolExecutor implements ToolExecutor {
  public async execute(
    request: Parameters<ToolExecutor['execute']>[0],
    signal: AbortSignal,
  ) {
    if (request.tool.id === LIST_WORKSPACE_ENTRIES_TOOL_ID) return this.list(signal);
    if (request.tool.id === READ_WORKSPACE_TEXT_FILE_TOOL_ID) return this.readTextFile(request.arguments, signal);
    throw new Error(`WorkspaceToolExecutor cannot execute '${request.tool.id}'.`);
  }

  private async list(signal: AbortSignal) {
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
        throw new ToolExecutionError('filesystem-error', 'The workspace root could not be listed.', error);
      }
      throwIfAborted(signal);
    }

    return {
      evidenceSummary: summariseWorkspaceEntries(roots),
      provenance: 'vscode.workspace.fs.readDirectory',
    };
  }

  private async readTextFile(arguments_: Readonly<Record<string, unknown>>, signal: AbortSignal) {
    throwIfAborted(signal);
    const path = arguments_.path;
    if (typeof path !== 'string' || !isDirectWorkspaceFileName(path)) {
      throw new ToolExecutionError('invalid-target', 'The requested path was not a direct workspace filename.');
    }

    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) throw new ToolExecutionError('workspace-unavailable', 'No workspace folder is open.');
    if (folders.length !== 1) throw new ToolExecutionError('workspace-unavailable', 'File reading requires exactly one open workspace root.');

    const uri = vscode.Uri.joinPath(folders[0].uri, path);
    let stat: vscode.FileStat;
    try {
      stat = await vscode.workspace.fs.stat(uri);
    } catch (error: unknown) {
      if (filesystemErrorCode(error) === 'FileNotFound') {
        throw new ToolExecutionError('file-not-found', 'The requested workspace file was not found. Use the exact filename from the workspace listing.', error);
      }
      throw new ToolExecutionError('filesystem-error', 'The requested workspace file could not be inspected.', error);
    }
    throwIfAborted(signal);
    if (!(stat.type & vscode.FileType.File) || (stat.type & vscode.FileType.SymbolicLink)) {
      throw new ToolExecutionError('invalid-target', 'The requested workspace entry is not an eligible regular file.');
    }
    if (stat.size > MAX_WORKSPACE_TEXT_FILE_BYTES) {
      throw new ToolExecutionError('file-too-large', `WayFinder can read files up to ${MAX_WORKSPACE_TEXT_FILE_BYTES} bytes.`);
    }

    let bytes: Uint8Array;
    try {
      bytes = await vscode.workspace.fs.readFile(uri);
    } catch (error: unknown) {
      throw new ToolExecutionError('filesystem-error', 'The requested workspace file could not be read.', error);
    }
    throwIfAborted(signal);
    if (bytes.byteLength > MAX_WORKSPACE_TEXT_FILE_BYTES) {
      throw new ToolExecutionError('file-too-large', `WayFinder can read files up to ${MAX_WORKSPACE_TEXT_FILE_BYTES} bytes.`);
    }
    const content = decodeUtf8Text(bytes);
    const modelContent = `Contents of requested workspace file '${path}':\n${content}`;
    return {
      evidenceSummary: 'Read one bounded workspace text file; its contents are available as transient evidence for the next inference.',
      provenance: 'vscode.workspace.fs.readFile',
      transientModelContext: {
        type: 'evidence' as const,
        content: modelContent,
        provenance: 'vscode.workspace.fs.readFile',
        tokens: Math.ceil(modelContent.length / 4),
        tokenCountKind: 'estimate' as const,
        priority: 100,
      },
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

function decodeUtf8Text(bytes: Uint8Array): string {
  if (bytes.includes(0)) throw new ToolExecutionError('not-text', 'The requested file appears to be binary rather than UTF-8 text.');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new ToolExecutionError('not-text', 'The requested file is not valid UTF-8 text.');
  }
}

function filesystemErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}
