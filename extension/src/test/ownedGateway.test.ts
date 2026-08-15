import assert from 'node:assert/strict';
import test from 'node:test';
import { createExecutionState } from '../core/executionState';
import { compileRequestCapsule } from '../core/requestCapsule';
import { ModelDeckOwnedGateway } from '../modeldeck/ownedGateway';

test('owned ModelDeck gateway renders only the compact capsule at the wire boundary', async () => {
  const originalFetch = globalThis.fetch;
  let body: Record<string, unknown> | undefined;
  globalThis.fetch = async (_input, init) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ choices: [{ message: { content: 'Done.', tool_calls: [] } }] }), { status: 200 });
  };

  try {
    const state = createExecutionState('Inspect the parser failure', {
      budget: {
        input: { limit: 25, countKind: 'estimate' },
        output: { limit: 9, countKind: 'estimate' },
      },
    });
    const capsule = compileRequestCapsule({
      state,
      candidates: [{
        id: 'instruction',
        type: 'instruction',
        content: 'Use concise evidence.',
        provenance: 'AGENTS.md',
        tokens: 4,
        tokenCountKind: 'estimate',
        priority: 1,
      }],
      tools: [{
        id: 'list_workspace_entries',
        description: 'List direct workspace entries.',
        inputSchema: { type: 'object' },
      }],
      toolRequestMode: 'required',
      requestedDecision: 'Diagnose the failure.',
    });
    const gateway = new ModelDeckOwnedGateway({
      baseUrl: 'http://127.0.0.1:8600/v1',
      fastModel: 'fast-local',
      deepModel: 'deep-local',
    });
    const response = await gateway.complete(capsule, new AbortController().signal);

    assert.deepEqual(response, { kind: 'final', text: 'Done.' });
    assert.equal(body?.model, 'fast-local');
    assert.equal(body?.max_tokens, 9);
    assert.deepEqual(body?.tools, [{
      type: 'function',
      function: {
        name: 'list_workspace_entries',
        description: 'List direct workspace entries.',
        parameters: { type: 'object' },
      },
    }]);
    assert.equal(body?.tool_choice, 'required');
    const messages = body?.messages as { role: string; content: string }[];
    assert.equal(messages[0].role, 'system');
    assert.match(messages[0].content, /Do not ask the user for a workspace path/);
    assert.equal(messages[1].role, 'user');
    assert.deepEqual(JSON.parse(messages[1].content), {
      task: 'Inspect the parser failure',
      phase: 'initialising',
      requestedDecision: 'Diagnose the failure.',
      context: [{ type: 'instruction', provenance: 'AGENTS.md', content: 'Use concise evidence.' }],
      evidence: [],
      constraints: [],
      responseContract: 'Return either a concise final response or one validated tool request.',
      toolRequestMode: 'required',
      inputBudget: { limit: 25, countKind: 'estimate' },
      outputBudget: { limit: 9, countKind: 'estimate' },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
