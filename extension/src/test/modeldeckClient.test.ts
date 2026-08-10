import assert from 'node:assert/strict';
import test from 'node:test';
import { ModelDeckClient } from '../modeldeck/client';

test('ModelDeck requests include the configured output-token budget', async () => {
  const originalFetch = globalThis.fetch;
  let requestUrl: string | undefined;
  let requestInit: RequestInit | undefined;
  globalThis.fetch = async (input, init) => {
    requestUrl = String(input);
    requestInit = init;
    return new Response(JSON.stringify({
      choices: [{ message: { content: 'Done.', tool_calls: [] } }],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  try {
    const client = new ModelDeckClient({
      baseUrl: 'http://127.0.0.1:8600/v1/',
      fastModel: 'fast-local',
      deepModel: 'deep-local',
    });

    const response = await client.complete({
      backend: 'deep',
      messages: [{ role: 'user', content: 'Use the tool.' }],
      tools: [{
        type: 'function',
        function: {
          name: 'read_file',
          description: 'Read a file.',
          parameters: { type: 'object' },
        },
      }],
      toolChoice: 'required',
      maxTokens: 4_096,
    }, new AbortController().signal);

    assert.equal(requestUrl, 'http://127.0.0.1:8600/v1/chat/completions');
    const requestBody = requestInit?.body;
    assert.equal(typeof requestBody, 'string');
    assert.deepEqual(JSON.parse(requestBody as string), {
      model: 'deep-local',
      messages: [{ role: 'user', content: 'Use the tool.' }],
      tools: [{
        type: 'function',
        function: {
          name: 'read_file',
          description: 'Read a file.',
          parameters: { type: 'object' },
        },
      }],
      tool_choice: 'required',
      max_tokens: 4_096,
      stream: false,
    });
    assert.deepEqual(response, { text: 'Done.', toolCalls: [] });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
