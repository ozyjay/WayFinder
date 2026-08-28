import { ExecutionMode, ExecutionState, createExecutionState } from '../core/executionState';
import { LoopInput, LoopOutcome, LoopTraceEvent } from '../core/runtime';
import { ToolExecutionError } from '../core/toolBroker';
import { LIST_WORKSPACE_ENTRIES_TOOL_ID, READ_WORKSPACE_TEXT_FILE_TOOL_ID, WORKSPACE_OBSERVE_CAPABILITY, WORKSPACE_READ_CAPABILITY } from '../core/workspaceTools';
import { ModelDeckError } from '../modeldeck/client';

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
  readonly traceEvent?: OwnedTaskTraceEvent;
}

export interface OwnedTaskTraceEvent {
  readonly iteration: number;
  readonly kind: 'working' | 'success' | 'warning' | 'error';
  readonly message: string;
}

export interface RuntimeRunner {
  run(input: LoopInput, signal: AbortSignal): Promise<LoopOutcome>;
}

export type RuntimeFactory = (mode: ExecutionMode) => RuntimeRunner;
export type InitialStateFactory = (goal: string, mode: ExecutionMode) => ExecutionState;

/** Shared policy text for the sidebar and repeatable local-model evaluation. */
export const WORKSPACE_TASK_REQUESTED_DECISION = 'Answer the task using supplied evidence. For a question about the workspace, project, repository, or files, gather the available workspace listing before a final answer when it is offered.';
export const WORKSPACE_TASK_CONSTRAINTS = [
  'The open workspace root is already available through the listed read-only tools; do not ask the user for its path.',
  'A workspace listing identifies direct entry names only. If a file-content question needs more evidence and a read tool is available, request that tool; do not claim to know contents unless they are supplied as evidence.',
  'In Auto mode, a response based on read file evidence must retain enough distinctive source terms to meet the deterministic evidence-coverage requirement.',
] as const;

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
        requestedDecision: WORKSPACE_TASK_REQUESTED_DECISION,
        constraints: WORKSPACE_TASK_CONSTRAINTS,
        onTrace: (event) => report({
          state: 'running',
          modelTier: event.modelTier,
          message: `Running locally with ${labelTier(event.modelTier)}.`,
          traceEvent: taskTraceEvent(event),
        }),
      }, controller.signal);
      report(outcomeUpdate(outcome));
    } catch (error: unknown) {
      report({ state: 'error', message: taskErrorMessage(error, request.mode) });
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
  return { state: 'failed', modelTier: outcome.state.modelTier, message: 'WayFinder stopped after repeated invalid or unsuccessful tool requests.' };
}

function labelTier(tier: ExecutionState['modelTier']): string {
  return tier === 'fast' ? 'Fast' : 'Deep';
}

function taskErrorMessage(error: unknown, mode: ExecutionMode): string {
  if (error instanceof ToolExecutionError) {
    const policy = mode === 'auto' ? ' Auto does not retry operational filesystem failures.' : '';
    return `WayFinder could not complete this task. ${error.safeMessage}${policy}`;
  }
  if (error instanceof ModelDeckError && error.status) {
    if (error.status === 400 || error.status === 422) {
      return `The selected ModelDeck route rejected WayFinder's general chat request (HTTP ${error.status}). Check that the route supports chat, tools, and the configured output budget.`;
    }
    return `The local ModelDeck request failed (HTTP ${error.status}). Check the selected route and try again.`;
  }
  if (error instanceof TypeError) {
    return 'WayFinder could not reach the local ModelDeck endpoint. Check that ModelDeck is running and the configured URL is correct.';
  }
  return 'WayFinder could not complete this task. Check the local runtime configuration and try again.';
}

function taskTraceEvent(event: LoopTraceEvent): OwnedTaskTraceEvent {
  const tier = labelTier(event.modelTier);
  if (event.kind === 'inference-started') {
    return { iteration: event.iteration, kind: 'working', message: `${tier} inference started.` };
  }
  if (event.kind === 'final-response') {
    const sanitised = event.removedControlTokens?.length
      ? ` Removed leaked backend terminator${event.removedControlTokens.length === 1 ? '' : 's'}: ${event.removedControlTokens.join(', ')}.`
      : '';
    return { iteration: event.iteration, kind: sanitised ? 'warning' : 'success', message: `${tier} returned a final response.${sanitised}` };
  }
  if (event.kind === 'backend-failed') {
    return { iteration: event.iteration, kind: 'error', message: `${tier} failed in the local model backend.` };
  }
  if (event.kind === 'tool-requested') {
    const details = event.debugArguments === undefined ? '' : ` with arguments ${event.debugArguments}`;
    return { iteration: event.iteration, kind: 'working', message: `${tier} requested ${toolLabel(event.toolId)}${details}.` };
  }
  if (event.kind === 'tool-completed') {
    return { iteration: event.iteration, kind: 'success', message: `${toolLabel(event.toolId)} completed.` };
  }
  if (event.kind === 'tool-failed') {
    return { iteration: event.iteration, kind: 'error', message: `${toolLabel(event.toolId)} failed: ${event.safeMessage}` };
  }
  if (event.kind === 'escalated') {
    return { iteration: event.iteration, kind: 'warning', message: 'Auto escalated from Fast to Deep after deterministic validation repairs.' };
  }
  return {
    iteration: event.iteration,
    kind: 'warning',
    message: `Response validation rejected the result (${'validationCode' in event ? event.validationCode : 'unknown'}).`,
  };
}

function toolLabel(toolId: string): string {
  if (toolId === LIST_WORKSPACE_ENTRIES_TOOL_ID) return `workspace listing (${toolId})`;
  if (toolId === READ_WORKSPACE_TEXT_FILE_TOOL_ID) return `workspace file read (${toolId})`;
  return `tool ${toolId}`;
}
