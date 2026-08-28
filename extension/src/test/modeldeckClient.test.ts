import assert from 'node:assert/strict';
import test from 'node:test';
import { findDiscoveryMetadata, ModelDeckClient, normaliseCompletionText } from '../modeldeck/client';

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
      temperature: 0,
      max_tokens: 4_096,
      stream: false,
    });
    assert.deepEqual(response, { text: 'Done.', toolCalls: [] });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('known leaked chat-template terminators are removed only from the end of completion text', () => {
  assert.deepEqual(normaliseCompletionText('TestWayFinder: Readme.md<turn|>'), {
    text: 'TestWayFinder: Readme.md',
    removedControlTokens: ['<turn|>'],
  });
  assert.deepEqual(normaliseCompletionText('Answer<|im_end|>\n<end_of_turn>\n'), {
    text: 'Answer',
    removedControlTokens: ['<end_of_turn>', '<|im_end|>'],
  });
  assert.deepEqual(normaliseCompletionText('Discuss <turn|> as literal text.'), {
    text: 'Discuss <turn|> as literal text.',
    removedControlTokens: [],
  });
});

test('discovery records configured identity and primary-ready routing state separately', () => {
  const metadata = findDiscoveryMetadata({ data: [{ id: 'fast-local', modeldeck: {
    route: {
      public_model_id: 'fast-local', capability_id: 'chat', routing_profile_id: 'fast', routing_profile_revision: '3',
    },
    primary_worker: worker('fast-primary', 'model-fast', 'r1', 'configured-fast'),
    selected_worker: worker('fast-primary', 'model-fast', 'r1', 'configured-fast', 'runtime-fast'),
    selection_reason: 'primary_ready',
  } }] }, 'fast-local');

  assert.deepEqual(metadata, {
    source: 'explicit',
    route: { publicModelId: 'fast-local', capabilityId: 'chat', routingProfileId: 'fast', routingProfileRevision: '3' },
    configuredWorker: {
      workerId: 'fast-primary', modelId: 'model-fast', revision: 'r1', configurationFingerprint: 'configured-fast', runtime: 'llama.cpp', accelerator: 'cuda',
    },
    selectedWorker: {
      workerId: 'fast-primary', modelId: 'model-fast', revision: 'r1', configurationFingerprint: 'configured-fast', runtimeConfigurationFingerprint: 'runtime-fast', runtime: 'llama.cpp', accelerator: 'cuda',
    },
    selectionReason: 'primary_ready',
  });
});

test('discovery preserves a backup selected Worker as point-in-time state', () => {
  const metadata = findDiscoveryMetadata({ data: [{ id: 'deep-local', modeldeck: {
    route: { public_model_id: 'deep-local' },
    primary_worker: worker('deep-primary', 'model-deep', 'r8', 'configured-primary'),
    selected_worker: worker('deep-backup', 'model-deep-backup', 'r9', 'configured-backup'),
    selection_reason: 'backup_ready',
  } }] }, 'deep-local');

  assert.deepEqual(metadata?.configuredWorker, {
    workerId: 'deep-primary', modelId: 'model-deep', revision: 'r8', configurationFingerprint: 'configured-primary', runtime: 'llama.cpp', accelerator: 'cuda',
  });
  assert.deepEqual(metadata?.selectedWorker, {
    workerId: 'deep-backup', modelId: 'model-deep-backup', revision: 'r9', configurationFingerprint: 'configured-backup', runtime: 'llama.cpp', accelerator: 'cuda',
  });
  assert.equal(metadata?.selectionReason, 'backup_ready');
});

test('discovery safely records no-ready-worker without a selected identity', () => {
  const metadata = findDiscoveryMetadata({ data: [{ id: 'fast-local', modeldeck: {
    route: { public_model_id: 'fast-local' },
    primary_worker: worker('fast-primary', 'model-fast', 'r1', 'configured-fast'),
    selected_worker: null,
    selection_reason: 'no_ready_worker',
  } }] }, 'fast-local');

  assert.equal(metadata?.selectedWorker, undefined);
  assert.equal(metadata?.selectionReason, 'no_ready_worker');
});

test('discovery falls back to legacy flat ModelDeck identity metadata', () => {
  const metadata = findDiscoveryMetadata({ data: [{ id: 'fast-local', modeldeck: {
    model_id: 'legacy-model', revision: 'legacy-r1', runtime: 'legacy-runtime', configuration_fingerprint: 'legacy-config',
  } }] }, 'fast-local');

  assert.deepEqual(metadata, {
    source: 'legacy',
    configuredWorker: {
      modelId: 'legacy-model', revision: 'legacy-r1', runtime: 'legacy-runtime', configurationFingerprint: 'legacy-config',
    },
  });
});

function worker(workerId: string, modelId: string, revision: string, configurationFingerprint: string, runtimeConfigurationFingerprint?: string): Record<string, string> {
  return {
    worker_id: workerId,
    model_id: modelId,
    revision,
    configuration_fingerprint: configurationFingerprint,
    ...(runtimeConfigurationFingerprint ? { runtime_configuration_fingerprint: runtimeConfigurationFingerprint } : {}),
    runtime: 'llama.cpp',
    accelerator: 'cuda',
  };
}
