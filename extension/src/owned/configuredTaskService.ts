import * as vscode from 'vscode';
import { join } from 'node:path';
import { JsonlRuntimeDiagnostics } from '../core/diagnostics';
import { createExecutionState, defaultBudget } from '../core/executionState';
import { BoundedAgentLoop, ModelGateway, denyConsequentialActions } from '../core/runtime';
import { ToolRegistry } from '../core/toolBroker';
import {
  WORKSPACE_OBSERVE_CAPABILITY,
  WORKSPACE_READ_CAPABILITY,
  listWorkspaceEntriesTool,
  readWorkspaceTextFileTool,
} from '../core/workspaceTools';
import { ModelDeckSettings } from '../modeldeck/client';
import { ModelDeckOwnedGateway, OwnedMockGateway } from '../modeldeck/ownedGateway';
import { WorkspaceToolExecutor } from '../participant/workspaceListTool';
import { OwnedTaskService } from './taskService';

/** Wires VS Code configuration and workspace capabilities into the task service. */
export function createConfiguredTaskService(
  context: vscode.ExtensionContext,
  configuration: vscode.WorkspaceConfiguration,
): OwnedTaskService {
  const diagnostics = new JsonlRuntimeDiagnostics(join(context.globalStorageUri.fsPath, 'runtime.jsonl'));
  return new OwnedTaskService((mode) => new BoundedAgentLoop(
    gatewayFor(configuration),
    new ToolRegistry([listWorkspaceEntriesTool, readWorkspaceTextFileTool]),
    new WorkspaceToolExecutor(),
    diagnostics,
    {
      maxIterations: configuration.get<number>('runtime.maxIterations', 5),
      executionMode: mode,
      escalation: { repairAttemptsBeforeEscalation: 1, maximumValidationFailures: 3 },
      approval: denyConsequentialActions,
      exposeToolArgumentsInTrace: configuration.get<boolean>('runtime.showToolArgumentsInDebugTrace', false),
    },
  ), (goal, mode) => createExecutionState(goal, {
    modelTier: mode === 'deep' ? 'deep' : 'fast',
    budget: {
      input: { limit: configuration.get<number>('runtime.inputBudget', defaultBudget().input.limit), countKind: 'estimate' },
      output: { limit: configuration.get<number>('runtime.outputBudget', defaultBudget().output.limit), countKind: 'estimate' },
    },
    allowedCapabilities: [WORKSPACE_OBSERVE_CAPABILITY, WORKSPACE_READ_CAPABILITY],
  }));
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
