import * as vscode from 'vscode';
import { join } from 'node:path';
import { JsonlRuntimeDiagnostics } from '../core/diagnostics';
import { createExecutionState, defaultBudget } from '../core/executionState';
import { BoundedAgentLoop, ModelGateway, denyConsequentialActions } from '../core/runtime';
import { ToolExecutor, ToolRegistry } from '../core/toolBroker';
import { ModelDeckSettings } from '../modeldeck/client';
import { ModelDeckOwnedGateway, OwnedMockGateway } from '../modeldeck/ownedGateway';

const PARTICIPANT_ID = 'wayfinder.runtime';

/**
 * The Chat Participant is an integration surface only. Core orchestration,
 * compact context construction, model choice, and termination remain owned by
 * the runtime modules.
 */
export function registerWayFinderRuntimeParticipant(
  context: vscode.ExtensionContext,
  configuration: vscode.WorkspaceConfiguration,
  onStatus: (text: string) => void,
): vscode.Disposable {
  const diagnostics = new JsonlRuntimeDiagnostics(join(context.globalStorageUri.fsPath, 'runtime.jsonl'));
  return vscode.chat.createChatParticipant(PARTICIPANT_ID, async (request, _chatContext, stream, token) => {
    const controller = new AbortController();
    const cancellation = token.onCancellationRequested(() => controller.abort());
    try {
      onStatus('WayFinder: compiling compact context');
      stream.progress('WayFinder is compiling the selected working set (task only; no tools exposed).');
      const state = createExecutionState(request.prompt, {
        budget: {
          input: { limit: configuration.get<number>('runtime.inputBudget', defaultBudget().input.limit), countKind: 'estimate' },
          output: { limit: configuration.get<number>('runtime.outputBudget', defaultBudget().output.limit), countKind: 'estimate' },
        },
        allowedCapabilities: [],
      });
      const runtime = new BoundedAgentLoop(
        gatewayFor(configuration),
        new ToolRegistry(),
        noToolsExecutor,
        diagnostics,
        {
          maxIterations: configuration.get<number>('runtime.maxIterations', 4),
          escalation: { repairAttemptsBeforeEscalation: 1, maximumValidationFailures: 3 },
          approval: denyConsequentialActions,
        },
      );
      stream.progress('WayFinder is invoking the selected local model.');
      const outcome = await runtime.run({ initialState: state, context: [], requestedDecision: 'Respond to the user request.' }, controller.signal);
      onStatus(`WayFinder: ${outcome.state.modelTier} → ${outcome.kind}`);
      if (outcome.kind === 'completed') {
        stream.markdown(outcome.response);
        return { metadata: { runtime: 'owned', modelTier: outcome.state.modelTier, status: outcome.kind } };
      }
      if (outcome.kind === 'awaiting-approval') {
        stream.markdown(`WayFinder requires approval before running \`${outcome.request.toolId}\`.`);
        return { metadata: { runtime: 'owned', status: outcome.kind } };
      }
      if (outcome.kind === 'cancelled') {
        stream.markdown('WayFinder cancelled the request.');
        return { metadata: { runtime: 'owned', status: outcome.kind } };
      }
      stream.markdown(`WayFinder stopped safely: ${outcome.reason}.`);
      return { metadata: { runtime: 'owned', status: outcome.kind, reason: outcome.reason } };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown WayFinder runtime failure.';
      onStatus('WayFinder: runtime error');
      return { errorDetails: { message } };
    } finally {
      cancellation.dispose();
    }
  });
}

function gatewayFor(configuration: vscode.WorkspaceConfiguration): ModelGateway {
  if (configuration.get<'mock' | 'modeldeck'>('backendMode', 'mock') === 'mock') return new OwnedMockGateway();
  const settings: ModelDeckSettings = {
    baseUrl: configuration.get<string>('modelDeck.baseUrl', 'http://127.0.0.1:8600/v1'),
    fastModel: configuration.get<string>('modelDeck.fastModel', 'fast-local'),
    deepModel: configuration.get<string>('modelDeck.deepModel', 'deep-local'),
  };
  return new ModelDeckOwnedGateway(settings);
}

const noToolsExecutor: ToolExecutor = {
  async execute(): Promise<never> {
    throw new Error('No tools are exposed by the initial WayFinder owned-runtime surface.');
  },
};
