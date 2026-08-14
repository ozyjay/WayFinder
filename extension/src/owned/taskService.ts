import { ExecutionMode, ExecutionState, createExecutionState } from '../core/executionState';
import { LoopInput, LoopOutcome } from '../core/runtime';
import { READ_WORKSPACE_TEXT_FILE_TOOL_ID, WORKSPACE_OBSERVE_CAPABILITY, WORKSPACE_READ_CAPABILITY } from '../core/workspaceTools';

export interface OwnedTaskRequest {
  readonly taskId: string;
  readonly goal: string;
  readonly mode: ExecutionMode;
}

export interface OwnedTaskUpdate {
  readonly taskId: string;
  readonly state: 'preparing' | 'running' | 'completed' | 'awaiting-approval' | 'cancelled' | 'stopped' | 'failed' | 'error';
  readonly modelTier?: ExecutionState['modelTier'];
  readonly message: string;
  readonly response?: string;
}

export interface RuntimeRunner {
  run(input: LoopInput, signal: AbortSignal): Promise<LoopOutcome>;
}

export type RuntimeFactory = (mode: ExecutionMode) => RuntimeRunner;
export type InitialStateFactory = (goal: string, mode: ExecutionMode) => ExecutionState;

/**
 * UI-neutral owner for one bounded WayFinder task. It keeps no chat history
 * and exposes only coarse progress suitable for any VS Code surface.
 */
export class OwnedTaskService {
  private active: { readonly taskId: string; readonly controller: AbortController } | undefined;

  public constructor(
    private readonly createRuntime: RuntimeFactory,
    private readonly createInitialState: InitialStateFactory = defaultInitialState,
  ) {}

  public async run(request: OwnedTaskRequest, onUpdate: (update: OwnedTaskUpdate) => void): Promise<void> {
    if (!request.goal.trim()) return;
    this.active?.controller.abort();
    const controller = new AbortController();
    this.active = { taskId: request.taskId, controller };
    const report = (update: Omit<OwnedTaskUpdate, 'taskId'>) => {
      if (this.active?.taskId === request.taskId) onUpdate({ taskId: request.taskId, ...update });
    };

    try {
      const initialState = this.createInitialState(request.goal, request.mode);
      const initialTier = initialState.modelTier;
      report({ state: 'preparing', modelTier: initialTier, message: 'Preparing a compact task context.' });
      report({ state: 'running', modelTier: initialTier, message: `Running locally with ${labelTier(initialTier)}. Bounded read-only workspace evidence is available if needed.` });
      const outcome = await this.createRuntime(request.mode).run({
        initialState,
        context: [],
        requestedDecision: 'Answer the task using supplied evidence. For a question about the workspace, project, repository, or files, gather the available workspace listing before a final answer when it is offered.',
        constraints: [
          'The open workspace root is already available through the listed read-only tools; do not ask the user for its path.',
          'A workspace listing identifies direct entry names only. If a file-content question needs more evidence and a read tool is available, request that tool; do not claim to know contents unless they are supplied as evidence.',
          'In Auto mode, a response based on read file evidence must retain enough distinctive source terms to meet the deterministic evidence-coverage requirement.',
        ],
      }, controller.signal);
      report(outcomeUpdate(outcome));
    } catch {
      report({ state: 'error', message: 'WayFinder could not complete this task. Check the local runtime configuration and try again.' });
    } finally {
      if (this.active?.taskId === request.taskId) this.active = undefined;
    }
  }

  public cancel(taskId: string): boolean {
    if (this.active?.taskId !== taskId) return false;
    this.active.controller.abort();
    return true;
  }
}

function defaultInitialState(goal: string, mode: ExecutionMode): ExecutionState {
  return createExecutionState(goal, {
    modelTier: mode === 'deep' ? 'deep' : 'fast',
    allowedCapabilities: [WORKSPACE_OBSERVE_CAPABILITY, WORKSPACE_READ_CAPABILITY],
  });
}

function outcomeUpdate(outcome: LoopOutcome): Omit<OwnedTaskUpdate, 'taskId'> {
  if (outcome.kind === 'completed') {
    const toolSummary = outcome.state.completedActions.some((action) => action.toolId === READ_WORKSPACE_TEXT_FILE_TOOL_ID)
      ? ' Used bounded read-only workspace evidence.'
      : outcome.state.completedActions.length ? ' Used the bounded read-only workspace listing.' : '';
    return { state: 'completed', modelTier: outcome.state.modelTier, message: `Completed with ${labelTier(outcome.state.modelTier)}.${toolSummary}`, response: outcome.response };
  }
  if (outcome.kind === 'awaiting-approval') {
    return { state: 'awaiting-approval', modelTier: outcome.state.modelTier, message: `Approval is required before running ${outcome.request.toolId}.` };
  }
  if (outcome.kind === 'cancelled') return { state: 'cancelled', modelTier: outcome.state.modelTier, message: 'WayFinder cancelled the task.' };
  if (outcome.kind === 'stopped') return { state: 'stopped', modelTier: outcome.state.modelTier, message: 'WayFinder stopped safely at the iteration limit.' };
  return { state: 'failed', modelTier: outcome.state.modelTier, message: 'WayFinder stopped after repeated invalid tool requests.' };
}

function labelTier(tier: ExecutionState['modelTier']): string {
  return tier === 'fast' ? 'Fast' : 'Deep';
}
