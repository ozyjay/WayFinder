import { ContextBudget, Evidence, ExecutionState, ModelTier } from './executionState';
import { PresentedTool } from './toolBroker';

export type ContextItemType = 'goal' | 'instruction' | 'evidence' | 'code' | 'selection' | 'failure';

export interface ContextItem {
  readonly id: string;
  readonly type: ContextItemType;
  readonly content: string;
  readonly provenance: string;
  /** Exact only when supplied by an authoritative tokenizer. */
  readonly tokens: number;
  readonly tokenCountKind: 'authoritative' | 'estimate';
  readonly priority: number;
}

export interface ExcludedContextItem {
  readonly id: string;
  readonly reason: 'input-budget';
}

/** The model-neutral, selected working set for one inference. */
export interface RequestCapsule {
  readonly task: string;
  readonly modelTier: ModelTier;
  readonly phase: ExecutionState['phase'];
  readonly evidence: readonly Evidence[];
  readonly requestedDecision: string;
  readonly context: readonly ContextItem[];
  readonly excludedContext: readonly ExcludedContextItem[];
  readonly tools: readonly PresentedTool[];
  readonly constraints: readonly string[];
  readonly responseContract: string;
  readonly budget: ContextBudget;
}

export interface CapsuleInput {
  readonly state: ExecutionState;
  readonly candidates: readonly ContextItem[];
  readonly tools: readonly PresentedTool[];
  readonly requestedDecision: string;
  readonly constraints?: readonly string[];
}

export function compileRequestCapsule(input: CapsuleInput): RequestCapsule {
  const selected = selectContextWithinBudget(input.candidates, input.state.budget.input.limit);
  return {
    task: input.state.goal,
    modelTier: input.state.modelTier,
    phase: input.state.phase,
    evidence: input.state.evidence,
    requestedDecision: input.requestedDecision,
    context: selected.included,
    excludedContext: selected.excluded,
    tools: input.tools,
    constraints: input.constraints ?? [],
    responseContract: 'Return either a concise final response or one validated tool request.',
    budget: input.state.budget,
  };
}

/**
 * A stable priority/order rule makes context selection reproducible. The caller
 * retains provenance for every selected and excluded item.
 */
export function selectContextWithinBudget(
  items: readonly ContextItem[],
  limit: number,
): { readonly included: readonly ContextItem[]; readonly excluded: readonly ExcludedContextItem[] } {
  if (!Number.isInteger(limit) || limit < 0) {
    throw new Error('The input context budget must be a non-negative integer.');
  }

  const ordered = items
    .map((item, index) => ({ item, index }))
    .sort((left, right) => right.item.priority - left.item.priority || left.index - right.index);
  const included: ContextItem[] = [];
  const excluded: ExcludedContextItem[] = [];
  let used = 0;
  for (const { item } of ordered) {
    if (!Number.isInteger(item.tokens) || item.tokens < 0) {
      throw new Error(`Context item '${item.id}' has an invalid token count.`);
    }
    if (used + item.tokens <= limit) {
      included.push(item);
      used += item.tokens;
    } else {
      excluded.push({ id: item.id, reason: 'input-budget' });
    }
  }
  return { included, excluded };
}
