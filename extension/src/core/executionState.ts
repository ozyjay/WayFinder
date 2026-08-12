export type ModelTier = 'fast' | 'deep';

/** How a developer selected the tier for one owned-runtime task. */
export type ExecutionMode = 'auto' | 'fast' | 'deep';

export type ExecutionPhase =
  | 'initialising'
  | 'planning'
  | 'acting'
  | 'observing'
  | 'awaiting-approval'
  | 'completed'
  | 'cancelled'
  | 'failed'
  | 'stopped';

export type ExecutionStatus = 'active' | 'awaiting-approval' | 'completed' | 'cancelled' | 'failed' | 'stopped';

export interface Evidence {
  readonly id: string;
  readonly type: 'observation' | 'validation' | 'escalation' | 'user-context';
  /** A concise, attributable reduction. Raw tool output is intentionally excluded. */
  readonly summary: string;
  readonly provenance: string;
}

export interface CompletedAction {
  readonly toolId: string;
  readonly summary: string;
}

export interface ContextBudget {
  readonly input: TokenBudget;
  readonly output: TokenBudget;
}

export interface TokenBudget {
  readonly limit: number;
  readonly countKind: 'authoritative' | 'estimate';
}

/**
 * The durable task representation. It is deliberately independent of rendered
 * chat history, raw tool output, and any model-specific prompt format.
 */
export interface ExecutionState {
  readonly goal: string;
  readonly phase: ExecutionPhase;
  readonly hypotheses: readonly string[];
  readonly evidence: readonly Evidence[];
  readonly completedActions: readonly CompletedAction[];
  readonly nextAction?: string;
  readonly selectedContext: readonly string[];
  readonly allowedCapabilities: readonly string[];
  readonly modelTier: ModelTier;
  readonly budget: ContextBudget;
  readonly iteration: number;
  readonly status: ExecutionStatus;
}

export interface ExecutionStateOptions {
  readonly modelTier?: ModelTier;
  readonly budget?: ContextBudget;
  readonly allowedCapabilities?: readonly string[];
}

export function createExecutionState(goal: string, options: ExecutionStateOptions = {}): ExecutionState {
  if (!goal.trim()) {
    throw new Error('A WayFinder task needs a non-empty goal.');
  }

  const budget = options.budget ?? defaultBudget();
  validateBudget(budget);
  return {
    goal,
    phase: 'initialising',
    hypotheses: [],
    evidence: [],
    completedActions: [],
    selectedContext: [],
    allowedCapabilities: options.allowedCapabilities ?? [],
    modelTier: options.modelTier ?? 'fast',
    budget,
    iteration: 0,
    status: 'active',
  };
}

function validateBudget(budget: ContextBudget): void {
  for (const [kind, value] of Object.entries(budget) as readonly [keyof ContextBudget, TokenBudget][]) {
    if (!Number.isInteger(value.limit) || value.limit < 1) {
      throw new Error(`The ${kind} token budget must be a positive integer.`);
    }
  }
}

export function defaultBudget(): ContextBudget {
  return {
    // This is a conservative runtime budget, not a claim about a backend's context window.
    input: { limit: 4_096, countKind: 'estimate' },
    output: { limit: 1_024, countKind: 'estimate' },
  };
}

export function isTerminal(state: ExecutionState): boolean {
  return state.status === 'completed' || state.status === 'cancelled' || state.status === 'failed' || state.status === 'stopped';
}

const ALLOWED_PHASE_TRANSITIONS: Readonly<Record<ExecutionPhase, readonly ExecutionPhase[]>> = {
  initialising: ['planning', 'cancelled', 'failed'],
  planning: ['planning', 'acting', 'awaiting-approval', 'completed', 'cancelled', 'failed', 'stopped'],
  acting: ['observing', 'cancelled', 'failed'],
  observing: ['planning', 'cancelled', 'failed', 'stopped'],
  'awaiting-approval': ['planning', 'cancelled', 'failed'],
  completed: [],
  cancelled: [],
  failed: [],
  stopped: [],
};

export function transitionExecutionState(
  state: ExecutionState,
  phase: ExecutionPhase,
  status: ExecutionStatus,
  updates: Partial<Omit<ExecutionState, 'phase' | 'status'>> = {},
): ExecutionState {
  if (!ALLOWED_PHASE_TRANSITIONS[state.phase].includes(phase)) {
    throw new Error(`Invalid WayFinder state transition: ${state.phase} → ${phase}.`);
  }
  if ((phase === 'completed') !== (status === 'completed')
    || (phase === 'cancelled') !== (status === 'cancelled')
    || (phase === 'failed') !== (status === 'failed')
    || (phase === 'stopped') !== (status === 'stopped')
    || (phase === 'awaiting-approval') !== (status === 'awaiting-approval')) {
    throw new Error(`WayFinder state phase '${phase}' and status '${status}' disagree.`);
  }
  if (['initialising', 'planning', 'acting', 'observing'].includes(phase) && status !== 'active') {
    throw new Error(`Active WayFinder phase '${phase}' must have active status.`);
  }
  return { ...state, ...updates, phase, status };
}
