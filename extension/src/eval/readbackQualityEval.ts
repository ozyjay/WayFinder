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
import { ModelDeckSettings } from '../modeldeck/client';
import { ModelDeckOwnedGateway } from '../modeldeck/ownedGateway';
import { WORKSPACE_TASK_CONSTRAINTS, WORKSPACE_TASK_REQUESTED_DECISION } from '../owned/taskService';

const FIXTURE_FILE_NAME = 'Readme.md';
const FIXTURE_FILE_CONTENT = '# Hello World\nWayFinder test marker: cobalt-kookaburra';
const FIXTURE_CONTEXT_CONTENT = `Contents of requested workspace file '${FIXTURE_FILE_NAME}':\n${FIXTURE_FILE_CONTENT}`;

interface TrialReport {
  readonly mode: ExecutionMode;
  readonly finalTier: 'fast' | 'deep';
  readonly iterations: number;
  readonly latencyMs: number;
  readonly toolIds: readonly string[];
  readonly validationCodes: readonly string[];
  readonly escalated: boolean;
  readonly evidenceCoverage: {
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

  const deep = reports.find((report) => report.mode === 'deep');
  const auto = reports.find((report) => report.mode === 'auto');
  if (!deep?.evidenceCoverage.meetsRequirement) {
    throw new Error('Deep did not meet the readback evidence-coverage requirement.');
  }
  if (!auto?.evidenceCoverage.meetsRequirement) {
    throw new Error('Auto did not produce an answer meeting the readback evidence-coverage requirement.');
  }

  process.stdout.write(`${JSON.stringify({
    fixture: 'bounded-readback-v1',
    trials: reports,
  }, null, 2)}\n`);
}

async function runTrial(mode: ExecutionMode, settings: ModelDeckSettings): Promise<TrialReport> {
  const diagnostics = new InMemoryDiagnostics();
  const executor = new ReadbackFixtureExecutor();
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
  const outcome = await loop.run({
    initialState: createExecutionState(`What does ${FIXTURE_FILE_NAME} in this project say?`, {
      modelTier: mode === 'deep' ? 'deep' : 'fast',
      allowedCapabilities: [WORKSPACE_OBSERVE_CAPABILITY, WORKSPACE_READ_CAPABILITY],
    }),
    context: [],
    requestedDecision: WORKSPACE_TASK_REQUESTED_DECISION,
    constraints: WORKSPACE_TASK_CONSTRAINTS,
  }, new AbortController().signal);

  const response = completedResponse(outcome, mode);
  const evidenceCoverage = readFileEvidenceCoverage([{ id: 'fixture-readme', ...fixtureContextItem() }], response);
  if (!evidenceCoverage) throw new Error(`${mode} did not receive readback evidence.`);
  const expectedToolIds = [LIST_WORKSPACE_ENTRIES_TOOL_ID, READ_WORKSPACE_TEXT_FILE_TOOL_ID];
  if (JSON.stringify(executor.toolIds) !== JSON.stringify(expectedToolIds)) {
    throw new Error(`${mode} did not follow the bounded workspace-listing and file-read path.`);
  }

  return {
    mode,
    finalTier: outcome.state.modelTier,
    iterations: Math.max(...diagnostics.entries.map((entry) => entry.iteration)),
    latencyMs: diagnostics.entries.reduce((total, entry) => total + entry.latencyMs, 0),
    toolIds: executor.toolIds,
    validationCodes: diagnostics.entries.flatMap((entry) => entry.validationCode ? [entry.validationCode] : []),
    escalated: diagnostics.entries.some((entry) => entry.escalation === 'fast-to-deep'),
    evidenceCoverage,
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

function completedResponse(outcome: LoopOutcome, mode: ExecutionMode): string {
  if (outcome.kind !== 'completed') {
    throw new Error(`${mode} did not complete the bounded readback evaluation.`);
  }
  return outcome.response;
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
