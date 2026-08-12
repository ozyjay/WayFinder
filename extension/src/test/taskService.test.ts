import assert from 'node:assert/strict';
import test from 'node:test';
import { createExecutionState } from '../core/executionState';
import { LoopInput, LoopOutcome } from '../core/runtime';
import { OwnedTaskService, RuntimeRunner } from '../owned/taskService';
import { parseViewMessage } from '../view/messages';

function completed(input: LoopInput): LoopOutcome {
  return { kind: 'completed', state: { ...input.initialState, modelTier: input.initialState.modelTier }, response: 'Done.' };
}

test('owned task service selects the requested initial tier and reports completion', async () => {
  const modes: string[] = [];
  const tiers: string[] = [];
  const service = new OwnedTaskService((mode) => ({
    async run(input) {
      modes.push(mode);
      tiers.push(input.initialState.modelTier);
      return completed(input);
    },
  }));
  const updates: string[] = [];
  await service.run({ taskId: 'one', goal: 'Summarise this workspace', mode: 'deep' }, (update) => updates.push(update.state));

  assert.deepEqual(modes, ['deep']);
  assert.deepEqual(tiers, ['deep']);
  assert.deepEqual(updates, ['preparing', 'running', 'completed']);
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

test('webview messages accept only the explicit task protocol', () => {
  assert.deepEqual(parseViewMessage({ type: 'submit', goal: '  List files  ', mode: 'auto' }), { type: 'submit', goal: 'List files', mode: 'auto' });
  assert.deepEqual(parseViewMessage({ type: 'cancel', taskId: 'task-1' }), { type: 'cancel', taskId: 'task-1' });
  assert.equal(parseViewMessage({ type: 'submit', goal: '', mode: 'auto' }), undefined);
  assert.equal(parseViewMessage({ type: 'submit', goal: 'Task', mode: 'unknown' }), undefined);
  assert.equal(parseViewMessage({ type: 'inject', command: 'terminal.execute' }), undefined);
});
