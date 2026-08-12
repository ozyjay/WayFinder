import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryDiagnostics } from '../core/diagnostics';
import { createExecutionState, transitionExecutionState } from '../core/executionState';
import { ContextItem, compileRequestCapsule, selectContextWithinBudget } from '../core/requestCapsule';
import { BoundedAgentLoop, ModelGateway, ModelResponse } from '../core/runtime';
import { ToolExecutor, ToolRegistry } from '../core/toolBroker';
import { selectBackend } from '../core/router';
import {
  MAX_WORKSPACE_ENTRIES,
  WORKSPACE_OBSERVE_CAPABILITY,
  listWorkspaceEntriesTool,
  summariseWorkspaceEntries,
} from '../core/workspaceTools';

class SequenceGateway implements ModelGateway {
  public readonly capsules = [] as ReturnType<typeof compileRequestCapsule>[];
  private readonly queuedResponses: ModelResponse[];

  public constructor(responses: readonly ModelResponse[]) {
    this.queuedResponses = [...responses];
  }

  public async complete(capsule: ReturnType<typeof compileRequestCapsule>): Promise<ModelResponse> {
    this.capsules.push(capsule);
    return this.queuedResponses.shift() ?? { kind: 'unsupported', reason: 'No scripted response remains.' };
  }
}

const executor: ToolExecutor = {
  async execute() {
    return {
      rawOutput: 'A very long raw tool response that must never enter the next model request.',
      evidenceSummary: 'Parser test fails in parser.test.ts at line 14.',
      provenance: 'workspace.read',
    };
  },
};

function state(capabilities: readonly string[] = []) {
  return createExecutionState('Fix the failing parser test', {
    allowedCapabilities: capabilities,
    budget: {
      input: { limit: 10, countKind: 'estimate' },
      output: { limit: 5, countKind: 'estimate' },
    },
  });
}

function readRegistry(approval = false): ToolRegistry {
  return new ToolRegistry([{
    id: 'workspace.readFile',
    capabilities: ['workspace.read'],
    description: 'Read a workspace file.',
    inputSchema: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } },
    risk: 'read-only',
    requiresApproval: approval,
    expectedOutputClass: 'evidence',
  }]);
}

function loop(gateway: ModelGateway, registry = new ToolRegistry(), diagnostics = new InMemoryDiagnostics(), overrides = {}) {
  return {
    controller: new BoundedAgentLoop(gateway, registry, executor, diagnostics, {
      maxIterations: 4,
      executionMode: 'auto',
      escalation: { repairAttemptsBeforeEscalation: 1, maximumValidationFailures: 5 },
      approval: { decide: () => 'approved' as const },
      ...overrides,
    }),
    diagnostics,
  };
}

test('execution state starts serialisable and transitions to completed', async () => {
  const gateway = new SequenceGateway([{ kind: 'final', text: 'The parser test is fixed.' }]);
  const { controller } = loop(gateway);
  const outcome = await controller.run({ initialState: state(), context: [], requestedDecision: 'Respond.' }, new AbortController().signal);

  assert.equal(outcome.kind, 'completed');
  assert.equal(outcome.state.phase, 'completed');
  assert.equal(outcome.state.status, 'completed');
  assert.equal(JSON.parse(JSON.stringify(outcome.state)).goal, 'Fix the failing parser test');
  assert.throws(() => transitionExecutionState(createExecutionState('task'), 'completed', 'completed'), /Invalid WayFinder state transition/);
});

test('context-budget enforcement is deterministic and preserves exclusion provenance', () => {
  const items: ContextItem[] = [
    { id: 'low', type: 'code', content: 'low', provenance: 'workspace', tokens: 4, tokenCountKind: 'estimate', priority: 1 },
    { id: 'high', type: 'instruction', content: 'high', provenance: 'AGENTS.md', tokens: 4, tokenCountKind: 'estimate', priority: 2 },
    { id: 'middle', type: 'evidence', content: 'middle', provenance: 'tool', tokens: 3, tokenCountKind: 'estimate', priority: 1 },
  ];
  const selection = selectContextWithinBudget(items, 7);

  assert.deepEqual(selection.included.map((item) => item.id), ['high', 'middle']);
  assert.deepEqual(selection.excluded, [{ id: 'low', reason: 'input-budget' }]);
});

test('a valid tool request executes and only reduced evidence enters the next capsule', async () => {
  const gateway = new SequenceGateway([
    { kind: 'tool-request', request: { toolId: 'workspace.readFile', arguments: { path: 'parser.test.ts' } } },
    { kind: 'final', text: 'The parser test fails because the fixture is stale.' },
  ]);
  const { controller } = loop(gateway, readRegistry());
  const outcome = await controller.run({ initialState: state(['workspace.read']), context: [], requestedDecision: 'Diagnose.' }, new AbortController().signal);

  assert.equal(outcome.kind, 'completed');
  assert.equal(gateway.capsules.length, 2);
  assert.equal(gateway.capsules[1].evidence[0].summary, 'Parser test fails in parser.test.ts at line 14.');
  assert.equal(JSON.stringify(gateway.capsules[1]).includes('very long raw tool response'), false);
});

test('the broker rejects unknown tools and malformed tool arguments', () => {
  const registry = readRegistry();
  const current = state(['workspace.read']);

  assert.deepEqual(registry.validate({ toolId: 'terminal.execute', arguments: {} }, current), {
    valid: false,
    code: 'unknown-tool',
    message: "Tool 'terminal.execute' is not available for this step.",
  });
  assert.deepEqual(registry.validate({ toolId: 'workspace.readFile', arguments: { path: 7 } }, current), {
    valid: false,
    code: 'malformed-arguments',
    message: "Tool 'workspace.readFile' received malformed arguments.",
  });
});

test('workspace discovery is exposed only with its read-only capability and bounds its evidence', () => {
  const registry = new ToolRegistry([listWorkspaceEntriesTool]);
  assert.deepEqual(registry.present(state()), []);
  assert.deepEqual(registry.present(state([WORKSPACE_OBSERVE_CAPABILITY])).map((tool) => tool.id), ['list_workspace_entries']);
  assert.deepEqual(
    registry.present({
      ...state([WORKSPACE_OBSERVE_CAPABILITY]),
      completedActions: [{ toolId: 'list_workspace_entries', summary: 'Workspace listing returned.' }],
    }),
    [],
  );

  const entries = Array.from({ length: MAX_WORKSPACE_ENTRIES + 2 }, (_, index) => ({
    name: `entry-${String(index).padStart(2, '0')}`,
    kind: 'file' as const,
  }));
  const summary = summariseWorkspaceEntries([{ name: 'workspace', entries }]);
  assert.match(summary, new RegExp(`showing ${MAX_WORKSPACE_ENTRIES} of ${MAX_WORKSPACE_ENTRIES + 2}`));
  assert.equal(summary.includes('entry-41'), false);
  assert.throws(() => summariseWorkspaceEntries([], 0), /positive integer/);
});

test('workspace discovery is removed from the next inference after one successful call', async () => {
  const gateway = new SequenceGateway([
    { kind: 'tool-request', request: { toolId: 'list_workspace_entries', arguments: {} } },
    { kind: 'final', text: 'The workspace contains README.md.' },
  ]);
  const { controller } = loop(gateway, new ToolRegistry([listWorkspaceEntriesTool]));
  const outcome = await controller.run({
    initialState: state([WORKSPACE_OBSERVE_CAPABILITY]),
    context: [],
    requestedDecision: 'List the workspace.',
  }, new AbortController().signal);

  assert.equal(outcome.kind, 'completed');
  assert.deepEqual(gateway.capsules.map((capsule) => capsule.tools.map((tool) => tool.id)), [
    ['list_workspace_entries'],
    [],
  ]);
});

test('an approval-required tool stops at an explicit approval boundary', async () => {
  const gateway = new SequenceGateway([{ kind: 'tool-request', request: { toolId: 'workspace.readFile', arguments: { path: 'parser.test.ts' } } }]);
  const { controller } = loop(gateway, readRegistry(true), new InMemoryDiagnostics(), {
    approval: { decide: () => 'awaiting-approval' as const },
  });
  const outcome = await controller.run({ initialState: state(['workspace.read']), context: [], requestedDecision: 'Inspect.' }, new AbortController().signal);

  assert.equal(outcome.kind, 'awaiting-approval');
  assert.equal(outcome.state.phase, 'awaiting-approval');
});

test('the loop terminates deterministically at its iteration limit', async () => {
  const gateway = new SequenceGateway([
    { kind: 'unsupported', reason: 'Malformed response one.' },
    { kind: 'unsupported', reason: 'Malformed response two.' },
  ]);
  const { controller } = loop(gateway, new ToolRegistry(), new InMemoryDiagnostics(), {
    maxIterations: 2,
    escalation: { repairAttemptsBeforeEscalation: 99, maximumValidationFailures: 99 },
  });
  const outcome = await controller.run({ initialState: state(), context: [], requestedDecision: 'Respond.' }, new AbortController().signal);

  assert.equal(outcome.kind, 'stopped');
  assert.equal(outcome.reason, 'iteration-limit');
});

test('a cancelled token produces a terminal cancellation state without inference', async () => {
  const gateway = new SequenceGateway([{ kind: 'final', text: 'Not reached.' }]);
  const { controller } = loop(gateway);
  const cancellation = new AbortController();
  cancellation.abort();
  const outcome = await controller.run({ initialState: state(), context: [], requestedDecision: 'Respond.' }, cancellation.signal);

  assert.equal(outcome.kind, 'cancelled');
  assert.equal(gateway.capsules.length, 0);
});

test('validation repairs escalate Fast to Deep under the explicit policy', async () => {
  const gateway = new SequenceGateway([
    { kind: 'unsupported', reason: 'Malformed response one.' },
    { kind: 'unsupported', reason: 'Malformed response two.' },
    { kind: 'final', text: 'Deep response.' },
  ]);
  const { controller, diagnostics } = loop(gateway);
  const outcome = await controller.run({ initialState: state(), context: [], requestedDecision: 'Respond.' }, new AbortController().signal);

  assert.equal(outcome.kind, 'completed');
  assert.deepEqual(gateway.capsules.map((capsule) => capsule.modelTier), ['fast', 'fast', 'deep']);
  assert.equal(diagnostics.entries.some((entry) => entry.escalation === 'fast-to-deep'), true);
  assert.equal(diagnostics.entries.every((entry) => entry.executionMode === 'auto'), true);
});

test('explicit Fast and Deep modes remain pinned during validation repairs', async () => {
  for (const initialTier of ['fast', 'deep'] as const) {
    const gateway = new SequenceGateway([
      { kind: 'unsupported', reason: 'Malformed response.' },
      { kind: 'final', text: `${initialTier} response.` },
    ]);
    const { controller, diagnostics } = loop(gateway, new ToolRegistry(), new InMemoryDiagnostics(), { executionMode: initialTier });
    const outcome = await controller.run({ initialState: { ...state(), modelTier: initialTier }, context: [], requestedDecision: 'Respond.' }, new AbortController().signal);
    assert.equal(outcome.kind, 'completed');
    assert.deepEqual(gateway.capsules.map((capsule) => capsule.modelTier), [initialTier, initialTier]);
    assert.equal(diagnostics.entries.some((entry) => entry.escalation === 'fast-to-deep'), false);
    assert.equal(diagnostics.entries.every((entry) => entry.executionMode === initialTier), true);
  }
});

test('the Gate 0 compatibility fixture is isolated from owned-runtime model state', async () => {
  const gateway = new SequenceGateway([{ kind: 'final', text: 'Deep response.' }]);
  const { controller } = loop(gateway);
  const initial = { ...state(), modelTier: 'deep' as const };
  const outcome = await controller.run({ initialState: initial, context: [], requestedDecision: 'Respond.' }, new AbortController().signal);

  assert.equal(outcome.kind, 'completed');
  assert.equal(gateway.capsules[0].modelTier, 'deep');
  assert.equal(selectBackend('wayfinder-auto', {
    requestNumber: 1,
    messageCount: 1,
    textPartCount: 1,
    toolCallCount: 0,
    toolResultCount: 0,
    messageTokenEstimate: 1,
    tokenCountKind: 'character-approximation',
  }).backend, 'fast');
});
