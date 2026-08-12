import { ExecutionMode } from '../core/executionState';

export type WayFinderViewMessage =
  | { readonly type: 'submit'; readonly goal: string; readonly mode: ExecutionMode }
  | { readonly type: 'cancel'; readonly taskId: string }
  | { readonly type: 'reset' }
  | { readonly type: 'showDiagnostics' };

/** Accept only the small, explicit message protocol exposed by the webview. */
export function parseViewMessage(value: unknown): WayFinderViewMessage | undefined {
  if (!isRecord(value) || typeof value.type !== 'string') return undefined;
  if (value.type === 'reset' || value.type === 'showDiagnostics') return { type: value.type };
  if (value.type === 'cancel' && typeof value.taskId === 'string' && value.taskId.length > 0) return { type: 'cancel', taskId: value.taskId };
  if (value.type === 'submit' && typeof value.goal === 'string' && value.goal.trim().length > 0 && isExecutionMode(value.mode)) {
    return { type: 'submit', goal: value.goal.trim(), mode: value.mode };
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isExecutionMode(value: unknown): value is ExecutionMode {
  return value === 'auto' || value === 'fast' || value === 'deep';
}
