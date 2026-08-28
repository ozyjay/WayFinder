import { DiagnosticsSink, InferenceDiagnostic } from './diagnostics';
import { readFileEvidenceCoverage } from './evidenceCoverage';
import { Evidence, ExecutionMode, ExecutionState, isTerminal, transitionExecutionState } from './executionState';
import { CapsuleInput, ContextItem, RequestCapsule, compileRequestCapsule } from './requestCapsule';
import { ToolExecutionError, ToolExecutionFailureCode, ToolExecutionResult, ToolExecutor, ToolRegistry, ToolRequest } from './toolBroker';
import type { ModelDeckDiscoveryMetadata } from '../modeldeck/client';

export type ModelResponse =
  | { readonly kind: 'final'; readonly text: string }
  | { readonly kind: 'tool-request'; readonly request: ToolRequest }
  | { readonly kind: 'unsupported'; readonly reason: string };

export interface ModelGateway {
  complete(capsule: RequestCapsule, signal: AbortSignal): Promise<ModelResponse>;
  /** Optional per-inference ModelDeck discovery snapshot for experiment metadata. */
  discoveryMetadata?(): ModelDeckDiscoveryMetadata | undefined;
}

export interface ApprovalPolicy {
  decide(request: ToolRequest, state: ExecutionState): 'approved' | 'awaiting-approval' | 'rejected';
}

export interface EscalationPolicy {
  readonly repairAttemptsBeforeEscalation: number;
  readonly maximumValidationFailures: number;
}

export interface LoopOptions {
  readonly maxIterations: number;
  readonly executionMode: ExecutionMode;
  readonly escalation: EscalationPolicy;
  readonly approval: ApprovalPolicy;
}

export type LoopTraceEvent = {
  readonly kind: 'inference-started' | 'final-response' | 'backend-failed';
  readonly iteration: number;
  readonly modelTier: ExecutionState['modelTier'];
} | {
  readonly kind: 'tool-requested' | 'tool-completed';
  readonly iteration: number;
  readonly modelTier: ExecutionState['modelTier'];
  readonly toolId: string;
} | {
  readonly kind: 'tool-failed';
  readonly iteration: number;
  readonly modelTier: ExecutionState['modelTier'];
  readonly toolId: string;
  readonly failureCode: ToolExecutionFailureCode | 'unexpected';
  readonly safeMessage: string;
} | {
  readonly kind: 'validation-rejected';
  readonly iteration: number;
  readonly modelTier: ExecutionState['modelTier'];
  readonly validationCode: InferenceDiagnostic['validationCode'];
} | {
  readonly kind: 'escalated';
  readonly iteration: number;
  readonly modelTier: ExecutionState['modelTier'];
};

export interface LoopInput {
  readonly initialState: ExecutionState;
  readonly context: readonly ContextItem[];
  readonly requestedDecision: string;
  readonly constraints?: readonly string[];
  /** Optional deterministic policy for the next model action. */
  readonly toolRequestMode?: 'auto' | 'required';
  /** Ephemeral, privacy-safe progress for the active UI turn; never persisted. */
  readonly onTrace?: (event: LoopTraceEvent) => void;
}

export type LoopOutcome =
  | { readonly kind: 'completed'; readonly state: ExecutionState; readonly response: string }
  | { readonly kind: 'awaiting-approval'; readonly state: ExecutionState; readonly request: ToolRequest }
  | { readonly kind: 'cancelled'; readonly state: ExecutionState }
  | { readonly kind: 'stopped'; readonly state: ExecutionState; readonly reason: 'iteration-limit' }
  | { readonly kind: 'failed'; readonly state: ExecutionState; readonly reason: 'validation-limit' | 'tool-rejected' };

/**
 * A bounded, model-neutral inspect–reason–act–observe controller. The gateway
 * only receives a compact request capsule; it never receives durable raw state.
 */
export class BoundedAgentLoop {
  public constructor(
    private readonly gateway: ModelGateway,
    private readonly tools: ToolRegistry,
    private readonly executor: ToolExecutor,
    private readonly diagnostics: DiagnosticsSink,
    private readonly options: LoopOptions,
  ) {
    if (!Number.isInteger(options.maxIterations) || options.maxIterations < 1) {
      throw new Error('The loop iteration limit must be a positive integer.');
    }
  }

  public async run(input: LoopInput, signal: AbortSignal): Promise<LoopOutcome> {
    let state = input.initialState;
    let transientContext: readonly ContextItem[] = [];
    let validationFailures = 0;
    let repairsAtTier = 0;

    for (let iteration = 1; iteration <= this.options.maxIterations; iteration += 1) {
      if (signal.aborted) return this.cancel(state, iteration);
      state = transitionExecutionState(state, 'planning', 'active', { iteration });
      const capsule = this.capsule(state, input, transientContext);
      input.onTrace?.({ kind: 'inference-started', iteration, modelTier: state.modelTier });
      const startedAt = performance.now();
      let response: ModelResponse;
      try {
        response = await this.gateway.complete(capsule, signal);
      } catch (error: unknown) {
        if (signal.aborted) return this.cancel(state, iteration);
        input.onTrace?.({ kind: 'backend-failed', iteration, modelTier: state.modelTier });
        await this.recordFailure(capsule, state, Math.round(performance.now() - startedAt), 'backend-error');
        throw error;
      }
      const latencyMs = Math.round(performance.now() - startedAt);
      if (signal.aborted) return this.cancel(state, iteration);

      if (response.kind === 'final') {
        input.onTrace?.({ kind: 'final-response', iteration, modelTier: state.modelTier });
        const finalValidation = this.options.executionMode === 'auto'
          ? validateEvidenceCoverage(capsule, response.text)
          : undefined;
        if (finalValidation) {
          const next = this.addEvidence(state, {
            id: `validation-${iteration}`,
            type: 'validation',
            summary: finalValidation.message,
            provenance: 'final-response-validation',
          });
          await this.record(capsule, next, latencyMs, 'validation-rejected', finalValidation.code);
          input.onTrace?.({ kind: 'validation-rejected', iteration, modelTier: state.modelTier, validationCode: finalValidation.code });
          validationFailures += 1;
          const terminal = await this.maybeEscalate(next, capsule, latencyMs, validationFailures, repairsAtTier, finalValidation.code);
          if (terminal.kind === 'escalated') {
            state = terminal.state;
            input.onTrace?.({ kind: 'escalated', iteration, modelTier: state.modelTier });
            repairsAtTier = 0;
            continue;
          }
          repairsAtTier += 1;
          if (validationFailures >= this.options.escalation.maximumValidationFailures) {
            const failed = transitionExecutionState(next, 'failed', 'failed');
            return { kind: 'failed', state: failed, reason: 'validation-limit' };
          }
          state = next;
          continue;
        }
        const completed = transitionExecutionState(state, 'completed', 'completed');
        await this.record(capsule, completed, latencyMs, 'final');
        return { kind: 'completed', state: completed, response: response.text };
      }

      if (response.kind === 'tool-request') {
        input.onTrace?.({ kind: 'tool-requested', iteration, modelTier: state.modelTier, toolId: response.request.toolId });
        const validation = this.tools.validate(response.request, state);
        if (!validation.valid) {
          const next = this.addEvidence(state, {
            id: `validation-${iteration}`,
            type: 'validation',
            summary: validation.message,
            provenance: 'tool-request-validation',
          });
          await this.record(capsule, next, latencyMs, 'validation-rejected', validation.code);
          input.onTrace?.({ kind: 'validation-rejected', iteration, modelTier: state.modelTier, validationCode: validation.code });
          validationFailures += 1;
          const terminal = await this.maybeEscalate(next, capsule, latencyMs, validationFailures, repairsAtTier, validation.code);
          if (terminal.kind === 'escalated') {
            state = terminal.state;
            input.onTrace?.({ kind: 'escalated', iteration, modelTier: state.modelTier });
            repairsAtTier = 0;
            continue;
          }
          repairsAtTier += 1;
          if (validationFailures >= this.options.escalation.maximumValidationFailures) {
            const failed = transitionExecutionState(next, 'failed', 'failed');
            return { kind: 'failed', state: failed, reason: 'validation-limit' };
          }
          state = next;
          continue;
        }

        if (validation.tool.requiresApproval) {
          const decision = this.options.approval.decide(response.request, state);
          if (decision === 'awaiting-approval') {
            const awaiting = transitionExecutionState(state, 'awaiting-approval', 'awaiting-approval', { nextAction: validation.tool.id });
            await this.record(capsule, awaiting, latencyMs, 'approval-required');
            return { kind: 'awaiting-approval', state: awaiting, request: response.request };
          }
          if (decision === 'rejected') {
            const failed = transitionExecutionState(state, 'failed', 'failed');
            await this.record(capsule, failed, latencyMs, 'failed', undefined, undefined, 'tool-rejected');
            return { kind: 'failed', state: failed, reason: 'tool-rejected' };
          }
        }

        const acting = transitionExecutionState(state, 'acting', 'active', { nextAction: validation.tool.id });
        let toolResult: ToolExecutionResult;
        try {
          toolResult = await this.executor.execute({ tool: validation.tool, arguments: validation.arguments }, signal);
        } catch (error: unknown) {
          if (signal.aborted) return this.cancel(acting, iteration);
          const failure = safeToolFailure(error);
          input.onTrace?.({
            kind: 'tool-failed',
            iteration,
            modelTier: state.modelTier,
            toolId: validation.tool.id,
            ...failure,
          });
          await this.recordFailure(capsule, acting, Math.round(performance.now() - startedAt), 'tool-execution-error');
          throw error;
        }
        if (signal.aborted) return this.cancel(acting, iteration);
        state = this.observe(acting, validation.tool.id, toolResult, iteration);
        input.onTrace?.({ kind: 'tool-completed', iteration, modelTier: state.modelTier, toolId: validation.tool.id });
        if (toolResult.transientModelContext) {
          transientContext = [...transientContext, {
            ...toolResult.transientModelContext,
            id: `tool-context-${iteration}`,
          }];
        }
        await this.record(capsule, state, latencyMs, 'tool-request');
        continue;
      }

      const next = this.addEvidence(state, {
        id: `validation-${iteration}`,
        type: 'validation',
        summary: response.reason,
        provenance: 'model-response-validation',
      });
      await this.record(capsule, next, latencyMs, 'validation-rejected', 'unsupported-response');
      input.onTrace?.({ kind: 'validation-rejected', iteration, modelTier: state.modelTier, validationCode: 'unsupported-response' });
      validationFailures += 1;
      const terminal = await this.maybeEscalate(next, capsule, latencyMs, validationFailures, repairsAtTier, 'unsupported-response');
      if (terminal.kind === 'escalated') {
        state = terminal.state;
        input.onTrace?.({ kind: 'escalated', iteration, modelTier: state.modelTier });
        repairsAtTier = 0;
        continue;
      }
      repairsAtTier += 1;
      if (validationFailures >= this.options.escalation.maximumValidationFailures) {
        const failed = transitionExecutionState(next, 'failed', 'failed');
        return { kind: 'failed', state: failed, reason: 'validation-limit' };
      }
      state = next;
    }

    const stopped = transitionExecutionState(state, 'stopped', 'stopped');
    await this.record(this.capsule(stopped, input), stopped, 0, 'stopped', undefined, undefined, 'iteration-limit');
    return { kind: 'stopped', state: stopped, reason: 'iteration-limit' };
  }

  private capsule(state: ExecutionState, input: LoopInput, transientContext: readonly ContextItem[] = []): RequestCapsule {
    const capsuleInput: CapsuleInput = {
      state,
      candidates: [...input.context, ...transientContext],
      tools: this.tools.present(state),
      toolRequestMode: input.toolRequestMode,
      requestedDecision: input.requestedDecision,
      constraints: input.constraints,
    };
    return compileRequestCapsule(capsuleInput);
  }

  private async maybeEscalate(
    state: ExecutionState,
    capsule: RequestCapsule,
    latencyMs: number,
    failures: number,
    repairsAtTier: number,
    validationCode: InferenceDiagnostic['validationCode'],
  ): Promise<{ readonly kind: 'continue' } | { readonly kind: 'escalated'; readonly state: ExecutionState }> {
    if (this.options.executionMode !== 'auto' || state.modelTier !== 'fast' || repairsAtTier < this.options.escalation.repairAttemptsBeforeEscalation || failures >= this.options.escalation.maximumValidationFailures) {
      return { kind: 'continue' };
    }
    const escalated = this.addEvidence({ ...state, modelTier: 'deep' }, {
      id: `escalation-${state.iteration}`,
      type: 'escalation',
      summary: 'Escalated from Fast to Deep after deterministic validation repairs.',
      provenance: 'escalation-policy',
    });
    await this.record(capsule, escalated, latencyMs, 'validation-rejected', validationCode, 'fast-to-deep');
    return { kind: 'escalated', state: escalated };
  }

  private observe(state: ExecutionState, toolId: string, result: ToolExecutionResult, iteration: number): ExecutionState {
    return transitionExecutionState(state, 'observing', 'active', {
      nextAction: undefined,
      completedActions: [...state.completedActions, { toolId, summary: result.evidenceSummary }],
      evidence: [...state.evidence, {
        id: `observation-${iteration}`,
        type: 'observation',
        summary: result.evidenceSummary,
        provenance: result.provenance,
      }],
    });
  }

  private addEvidence(state: ExecutionState, evidence: Evidence): ExecutionState {
    return { ...state, evidence: [...state.evidence, evidence] };
  }

  private async cancel(state: ExecutionState, iteration: number): Promise<LoopOutcome> {
    const cancelled = transitionExecutionState(state, 'cancelled', 'cancelled', { iteration });
    if (!isTerminal(cancelled)) throw new Error('Cancellation must produce a terminal state.');
    await this.diagnostics.record({
      timestamp: new Date().toISOString(),
      iteration,
      executionMode: this.options.executionMode,
      modelTier: cancelled.modelTier,
      phase: cancelled.phase,
      contextItemTypes: [],
      contextProvenance: [],
      contextCharactersByType: emptyContextCharacterCounts(),
      inputBudget: cancelled.budget.input,
      outputBudget: cancelled.budget.output,
      exposedToolCount: 0,
      exposedToolSchemaBytes: 0,
      stablePrefixId: stablePrefixId(cancelled),
      latencyMs: 0,
      outcome: 'cancelled',
      stopReason: 'cancelled',
    });
    return { kind: 'cancelled', state: cancelled };
  }

  private async recordFailure(
    capsule: RequestCapsule,
    state: ExecutionState,
    latencyMs: number,
    failureCode: InferenceDiagnostic['failureCode'],
  ): Promise<void> {
    const failed = transitionExecutionState(state, 'failed', 'failed');
    await this.record(capsule, failed, latencyMs, 'failed', undefined, undefined, undefined, failureCode);
  }

  private async record(
    capsule: RequestCapsule,
    state: ExecutionState,
    latencyMs: number,
    outcome: InferenceDiagnostic['outcome'],
    validationCode?: InferenceDiagnostic['validationCode'],
    escalation?: InferenceDiagnostic['escalation'],
    stopReason?: InferenceDiagnostic['stopReason'],
    failureCode?: InferenceDiagnostic['failureCode'],
  ): Promise<void> {
    const counts = emptyContextCharacterCounts();
    for (const item of capsule.context) counts[item.type] += item.content.length;
    const modelDeckDiscovery = this.gateway.discoveryMetadata?.();
    await this.diagnostics.record({
      timestamp: new Date().toISOString(),
      iteration: state.iteration,
      executionMode: this.options.executionMode,
      modelTier: state.modelTier,
      phase: state.phase,
      contextItemTypes: capsule.context.map((item) => item.type),
      contextProvenance: capsule.context.map((item) => item.provenance),
      contextCharactersByType: counts,
      inputBudget: capsule.budget.input,
      outputBudget: capsule.budget.output,
      exposedToolCount: capsule.tools.length,
      exposedToolSchemaBytes: capsule.tools.reduce((total, tool) => total + JSON.stringify(tool.inputSchema).length, 0),
      stablePrefixId: stablePrefixId(state),
      latencyMs,
      outcome,
      ...(validationCode ? { validationCode } : {}),
      ...(failureCode ? { failureCode } : {}),
      ...(escalation ? { escalation } : {}),
      ...(stopReason ? { stopReason } : {}),
      ...(modelDeckDiscovery ? { modelDeckDiscovery } : {}),
    });
  }
}

function safeToolFailure(error: unknown): { readonly failureCode: ToolExecutionFailureCode | 'unexpected'; readonly safeMessage: string } {
  if (error instanceof ToolExecutionError) {
    return { failureCode: error.code, safeMessage: error.safeMessage };
  }
  return { failureCode: 'unexpected', safeMessage: 'The tool failed unexpectedly.' };
}

export const denyConsequentialActions: ApprovalPolicy = {
  decide: () => 'awaiting-approval',
};

function emptyContextCharacterCounts(): Record<'goal' | 'instruction' | 'evidence' | 'code' | 'selection' | 'failure', number> {
  return { goal: 0, instruction: 0, evidence: 0, code: 0, selection: 0, failure: 0 };
}

function stablePrefixId(state: ExecutionState): string {
  return `wayfinder:${state.modelTier}:${state.phase}:${state.budget.input.limit}:${state.budget.output.limit}`;
}

function validateEvidenceCoverage(
  capsule: RequestCapsule,
  response: string,
): { readonly code: 'insufficient-evidence-coverage'; readonly message: string } | undefined {
  const coverage = readFileEvidenceCoverage(capsule.context, response);
  if (!coverage || coverage.meetsRequirement) return undefined;
  return {
    code: 'insufficient-evidence-coverage',
    message: 'Final response did not meet the deterministic evidence-coverage requirement.',
  };
}
