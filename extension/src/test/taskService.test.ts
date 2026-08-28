import assert from 'node:assert/strict';
import test from 'node:test';
import { createExecutionState } from '../core/executionState';
import { LoopInput, LoopOutcome } from '../core/runtime';
import { ToolExecutionError } from '../core/toolBroker';
import { ModelDeckError } from '../modeldeck/client';
import { OwnedTaskService, RuntimeRunner } from '../owned/taskService';
import { parseViewMessage } from '../view/messages';

function completed(input: LoopInput): LoopOutcome {
  return { kind: 'completed', state: { ...input.initialState, modelTier: input.initialState.modelTier }, response: 'Done.' };
}

test('owned task service selects the requested initial tier and reports completion', async () => {
  const modes: string[] = [];
  const tiers: string[] = [];
  let requestedDecision: string | undefined;
  let constraints: readonly string[] | undefined;
  const service = new OwnedTaskService((mode) => ({
    async run(input) {
      modes.push(mode);
      tiers.push(input.initialState.modelTier);
      requestedDecision = input.requestedDecision;
      constraints = input.constraints;
      return completed(input);
    },
  }));
  const updates: string[] = [];
  await service.run({ taskId: 'one', goal: 'Summarise this workspace', mode: 'deep' }, (update) => updates.push(update.state));

  assert.deepEqual(modes, ['deep']);
  assert.deepEqual(tiers, ['deep']);
  assert.deepEqual(updates, ['preparing', 'running', 'completed']);
  assert.match(requestedDecision ?? '', /gather the available workspace listing/);
  assert.match(constraints?.join(' ') ?? '', /do not ask the user for its path/);
});

test('a superseded task cannot publish a stale completion', async () => {
  let completeFirst: ((outcome: LoopOutcome) => void) | undefined;
  let call = 0;
  const service = new OwnedTaskService((): RuntimeRunner => ({
    async run(input) {
      call += 1;
      if (call === 1) return new Promise<LoopOutcome>((resolve) => { completeFirst = resolve; });
      return completed(input);
    },
  }));
  const updates: string[] = [];
  const first = service.run({ taskId: 'first', goal: 'First task', mode: 'auto' }, (update) => updates.push(`${update.taskId}:${update.state}`));
  const second = service.run({ taskId: 'second', goal: 'Second task', mode: 'fast' }, (update) => updates.push(`${update.taskId}:${update.state}`));
  await second;
  completeFirst?.({ kind: 'completed', state: createExecutionState('First task'), response: 'Stale result.' });
  await first;

  assert.deepEqual(updates, ['first:preparing', 'first:running', 'second:preparing', 'second:running', 'second:completed']);
});

test('owned task service reports an actionable ModelDeck contract error', async () => {
  const service = new OwnedTaskService(() => ({
    async run() {
      throw new ModelDeckError('Backend detail must not be shown.', 422);
    },
  }));
  const messages: string[] = [];

  await service.run({ taskId: 'rejected', goal: 'List files', mode: 'fast' }, (update) => messages.push(update.message));

  assert.match(messages.at(-1) ?? '', /HTTP 422/);
  assert.match(messages.at(-1) ?? '', /supports chat, tools, and the configured output budget/);
  assert.equal(messages.some((message) => message.includes('Backend detail')), false);
});

test('owned task service exposes privacy-safe live trace events and an actionable tool failure', async () => {
  const service = new OwnedTaskService(() => ({
    async run(input) {
      input.onTrace?.({ kind: 'inference-started', iteration: 1, modelTier: 'fast' });
      input.onTrace?.({ kind: 'tool-requested', iteration: 1, modelTier: 'fast', toolId: 'read_workspace_text_file' });
      input.onTrace?.({
        kind: 'tool-failed',
        iteration: 1,
        modelTier: 'fast',
        toolId: 'read_workspace_text_file',
        failureCode: 'file-not-found',
        safeMessage: 'The requested workspace file was not found. Use the exact filename from the workspace listing.',
      });
      throw new ToolExecutionError(
        'file-not-found',
        'The requested workspace file was not found. Use the exact filename from the workspace listing.',
        new Error('Private path: /workspace/readme'),
      );
    },
  }));
  const updates: Parameters<Parameters<OwnedTaskService['run']>[1]>[0][] = [];

  await service.run({ taskId: 'missing', goal: 'Read the readme', mode: 'auto' }, (update) => updates.push(update));

  assert.deepEqual(updates.flatMap((update) => update.traceEvent?.message ?? []), [
    'Fast inference started.',
    'Fast requested workspace file read (read_workspace_text_file).',
    'workspace file read (read_workspace_text_file) failed: The requested workspace file was not found. Use the exact filename from the workspace listing.',
  ]);
  assert.match(updates.at(-1)?.message ?? '', /Auto currently escalates validation failures, not tool-execution failures/);
  assert.equal(JSON.stringify(updates).includes('/workspace/readme'), false);
});

test('webview messages accept only the explicit task protocol', () => {
  assert.deepEqual(parseViewMessage({ type: 'submit', goal: '  List files  ', mode: 'auto' }), { type: 'submit', goal: 'List files', mode: 'auto' });
  assert.deepEqual(parseViewMessage({ type: 'cancel', taskId: 'task-1' }), { type: 'cancel', taskId: 'task-1' });
  assert.equal(parseViewMessage({ type: 'submit', goal: '', mode: 'auto' }), undefined);
  assert.equal(parseViewMessage({ type: 'submit', goal: 'Task', mode: 'unknown' }), undefined);
  assert.equal(parseViewMessage({ type: 'inject', command: 'terminal.execute' }), undefined);
});
