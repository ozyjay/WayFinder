import { InMemoryDiagnostics } from '../core/diagnostics';
import { readFileEvidenceCoverage } from '../core/evidenceCoverage';
import { createExecutionState, ExecutionMode } from '../core/executionState';
import { BoundedAgentLoop, LoopOutcome } from '../core/runtime';
import { ToolExecutor, ToolRegistry } from '../core/toolBroker';
import {
  LIST_WORKSPACE_ENTRIES_TOOL_ID,
  READ_WORKSPACE_TEXT_FILE_TOOL_ID,
  WORKSPACE_OBSERVE_CAPABILITY,
  WORKSPACE_READ_CAPABILITY,
  listWorkspaceEntriesTool,
  readWorkspaceTextFileTool,
} from '../core/workspaceTools';
import { ModelDeckError, ModelDeckSettings } from '../modeldeck/client';
import { ModelDeckOwnedGateway } from '../modeldeck/ownedGateway';
import { WORKSPACE_TASK_CONSTRAINTS, WORKSPACE_TASK_REQUESTED_DECISION } from '../owned/taskService';

const FIXTURE_FILE_NAME = 'Readme.md';
const FIXTURE_FILE_CONTENT = '# Hello World\nWayFinder test marker: cobalt-kookaburra';
const FIXTURE_CONTEXT_CONTENT = `Contents of requested workspace file '${FIXTURE_FILE_NAME}':\n${FIXTURE_FILE_CONTENT}`;

interface TrialReport {
  readonly mode: ExecutionMode;
  readonly finalTier: 'fast' | 'deep';
  readonly outcome: LoopOutcome['kind'] | 'backend-error';
  readonly backendErrorCode?: string;
  readonly iterations: number;
  readonly latencyMs: number;
  readonly toolIds: readonly string[];
  readonly followedBoundedReadPath: boolean;
  readonly validationCodes: readonly string[];
  readonly escalated: boolean;
  readonly evidenceCoverage?: {
    readonly sourceTermCount: number;
    readonly coveredTermCount: number;
    readonly requiredTermCount: number;
    readonly meetsRequirement: boolean;
  };
}

/**
 * Live local-model evaluation for the bounded README readback path. It emits
 * metadata only; model replies and fixture source text are never printed.
 */
async function main(): Promise<void> {
  const settings = settingsFromEnvironment(process.env);
  const reports: TrialReport[] = [];
  for (const mode of ['fast', 'deep', 'auto'] as const) {
    reports.push(await runTrial(mode, settings));
  }

  process.stdout.write(`${JSON.stringify({
    fixture: 'bounded-readback-v1',
    trials: reports,
  }, null, 2)}\n`);

  const deep = reports.find((report) => report.mode === 'deep');
  const auto = reports.find((report) => report.mode === 'auto');
  if (!deep?.followedBoundedReadPath) {
    throw new Error('Deep did not follow the bounded workspace-listing and file-read path.');
  }
  if (!deep.evidenceCoverage?.meetsRequirement) {
    throw new Error('Deep did not meet the readback evidence-coverage requirement.');
  }
  if (!auto?.followedBoundedReadPath) {
    throw new Error('Auto did not follow the bounded workspace-listing and file-read path.');
  }
  if (!auto.evidenceCoverage?.meetsRequirement) {
    throw new Error('Auto did not produce an answer meeting the readback evidence-coverage requirement.');
  }

}

async function runTrial(mode: ExecutionMode, settings: ModelDeckSettings): Promise<TrialReport> {
  const diagnostics = new InMemoryDiagnostics();
  const executor = new ReadbackFixtureExecutor();
  const initialState = createExecutionState(`What does ${FIXTURE_FILE_NAME} in this project say?`, {
    modelTier: mode === 'deep' ? 'deep' : 'fast',
    allowedCapabilities: [WORKSPACE_OBSERVE_CAPABILITY, WORKSPACE_READ_CAPABILITY],
  });
  const loop = new BoundedAgentLoop(
    new ModelDeckOwnedGateway(settings),
    new ToolRegistry([listWorkspaceEntriesTool, readWorkspaceTextFileTool]),
    executor,
    diagnostics,
    {
      maxIterations: 5,
      executionMode: mode,
      escalation: { repairAttemptsBeforeEscalation: 1, maximumValidationFailures: 3 },
      approval: { decide: () => 'approved' },
    },
  );
  let outcome: LoopOutcome;
  try {
    outcome = await loop.run({
      initialState,
      context: [],
      requestedDecision: WORKSPACE_TASK_REQUESTED_DECISION,
      constraints: WORKSPACE_TASK_CONSTRAINTS,
      toolRequestMode: 'required',
    }, new AbortController().signal);
  } catch (error: unknown) {
    return failedTrialReport(mode, initialState, diagnostics, executor, error);
  }

  const expectedToolIds = [LIST_WORKSPACE_ENTRIES_TOOL_ID, READ_WORKSPACE_TEXT_FILE_TOOL_ID];
  const followedBoundedReadPath = JSON.stringify(executor.toolIds) === JSON.stringify(expectedToolIds);
  const evidenceCoverage = outcome.kind === 'completed'
    ? readFileEvidenceCoverage([{ id: 'fixture-readme', ...fixtureContextItem() }], outcome.response)
    : undefined;

  return {
    mode,
    finalTier: outcome.state.modelTier,
    outcome: outcome.kind,
    iterations: Math.max(0, ...diagnostics.entries.map((entry) => entry.iteration)),
    latencyMs: diagnostics.entries.reduce((total, entry) => total + entry.latencyMs, 0),
    toolIds: executor.toolIds,
    followedBoundedReadPath,
    validationCodes: diagnostics.entries.flatMap((entry) => entry.validationCode ? [entry.validationCode] : []),
    escalated: diagnostics.entries.some((entry) => entry.escalation === 'fast-to-deep'),
    evidenceCoverage,
  };
}

function failedTrialReport(
  mode: ExecutionMode,
  initialState: ReturnType<typeof createExecutionState>,
  diagnostics: InMemoryDiagnostics,
  executor: ReadbackFixtureExecutor,
  error: unknown,
): TrialReport {
  const expectedToolIds = [LIST_WORKSPACE_ENTRIES_TOOL_ID, READ_WORKSPACE_TEXT_FILE_TOOL_ID];
  return {
    mode,
    finalTier: initialState.modelTier,
    outcome: 'backend-error',
    backendErrorCode: error instanceof ModelDeckError && error.status ? `http-${error.status}` : 'backend-error',
    iterations: Math.max(0, ...diagnostics.entries.map((entry) => entry.iteration)),
    latencyMs: diagnostics.entries.reduce((total, entry) => total + entry.latencyMs, 0),
    toolIds: executor.toolIds,
    followedBoundedReadPath: JSON.stringify(executor.toolIds) === JSON.stringify(expectedToolIds),
    validationCodes: diagnostics.entries.flatMap((entry) => entry.validationCode ? [entry.validationCode] : []),
    escalated: diagnostics.entries.some((entry) => entry.escalation === 'fast-to-deep'),
  };
}

class ReadbackFixtureExecutor implements ToolExecutor {
  public readonly toolIds: string[] = [];

  public async execute(request: Parameters<ToolExecutor['execute']>[0], signal: AbortSignal) {
    if (signal.aborted) throw new DOMException('Readback evaluation cancelled.', 'AbortError');
    this.toolIds.push(request.tool.id);
    if (request.tool.id === LIST_WORKSPACE_ENTRIES_TOOL_ID) {
      return {
        evidenceSummary: `Top-level workspace entries: ${FIXTURE_FILE_NAME} (file).`,
        provenance: 'evaluation.fixture.workspace-listing',
      };
    }
    if (request.tool.id === READ_WORKSPACE_TEXT_FILE_TOOL_ID) {
      return {
        evidenceSummary: 'Read the bounded evaluation text fixture; content is transient evidence.',
        provenance: 'evaluation.fixture.file-read',
        transientModelContext: fixtureContextItem(),
      };
    }
    throw new Error(`Unexpected evaluation tool '${request.tool.id}'.`);
  }
}

function fixtureContextItem() {
  return {
    type: 'evidence' as const,
    content: FIXTURE_CONTEXT_CONTENT,
    provenance: 'vscode.workspace.fs.readFile',
    tokens: Math.ceil(FIXTURE_CONTEXT_CONTENT.length / 4),
    tokenCountKind: 'estimate' as const,
    priority: 100,
  };
}

function settingsFromEnvironment(environment: NodeJS.ProcessEnv): ModelDeckSettings {
  const baseUrl = environment.WAYFINDER_EVAL_BASE_URL;
  const fastModel = environment.WAYFINDER_EVAL_FAST_MODEL;
  const deepModel = environment.WAYFINDER_EVAL_DEEP_MODEL;
  if (!baseUrl || !fastModel || !deepModel) {
    throw new Error('Set WAYFINDER_EVAL_BASE_URL, WAYFINDER_EVAL_FAST_MODEL, and WAYFINDER_EVAL_DEEP_MODEL before running this live evaluation.');
  }
  return { baseUrl, fastModel, deepModel };
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown error.';
  process.stderr.write(`WayFinder readback evaluation failed: ${message}\n`);
  process.exitCode = 1;
});
