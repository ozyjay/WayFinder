import * as vscode from 'vscode';
import { BackendId, InvocationObservation, TraceEntry, VirtualModelId } from '../core/types';
import { selectBackend } from '../core/router';
import { JsonlTrace } from '../core/trace';
import { ModelDeckClient, ModelDeckError, ModelDeckSettings, OpenAiMessage, OpenAiToolCall } from '../modeldeck/client';

const MODELS: readonly vscode.LanguageModelChatInformation[] = [
  model('wayfinder-auto', 'WayFinder Auto', 'Routes each inference at a tool boundary using the Gate 0 fixture.'),
  model('wayfinder-fast', 'WayFinder Fast', 'Always uses the configured fast local backend.'),
  model('wayfinder-deep', 'WayFinder Deep', 'Always uses the configured deep local backend.'),
];

export class WayFinderLanguageModelProvider implements vscode.LanguageModelChatProvider {
  private requestNumber = 0;

  public constructor(
    private readonly trace: JsonlTrace,
    private readonly configuration: vscode.WorkspaceConfiguration,
    private readonly onRouted: (backend: BackendId, virtualModel: VirtualModelId) => void,
  ) {}

  public provideLanguageModelChatInformation(): vscode.ProviderResult<vscode.LanguageModelChatInformation[]> {
    return [...MODELS];
  }

  public async provideLanguageModelChatResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const virtualModel = asVirtualModelId(model.id);
    const observation = observe(++this.requestNumber, messages);
    const decision = selectBackend(virtualModel, observation);
    const startedAt = performance.now();
    this.onRouted(decision.backend, virtualModel);

    let responseType: TraceEntry['responseType'] = 'empty';
    let errorCode: string | undefined;
    try {
      const response = await this.complete(decision.backend, messages, options, model.maxOutputTokens, token);
      if (response.text) {
        progress.report(new vscode.LanguageModelTextPart(response.text));
        responseType = 'text';
      }
      for (const call of response.toolCalls) {
        const input = parseToolInput(call.function.arguments, call.function.name);
        progress.report(new vscode.LanguageModelToolCallPart(call.id, call.function.name, input));
        responseType = 'tool-call';
      }
    } catch (error: unknown) {
      responseType = 'error';
      errorCode = error instanceof ModelDeckError && error.status ? `http-${error.status}` : 'backend-error';
      const message = error instanceof Error ? error.message : 'Unknown local backend failure.';
      throw new vscode.LanguageModelError(message, { cause: error });
    } finally {
      if (this.configuration.get<boolean>('trace.enabled', true)) {
        await this.trace.append({
          timestamp: new Date().toISOString(),
          ...observation,
          virtualModel,
          backend: decision.backend,
          routingReason: decision.reason,
          responseType,
          latencyMs: Math.round(performance.now() - startedAt),
          backendMode: this.backendMode(),
          ...(errorCode ? { errorCode } : {}),
        });
      }
    }
  }

  public provideTokenCount(
    _model: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatRequestMessage,
  ): Thenable<number> {
    const value = typeof text === 'string' ? text : text.content.map(partText).join(' ');
    return Promise.resolve(Math.ceil(value.length / 4));
  }

  private async complete(
    backend: BackendId,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    maxOutputTokens: number,
    token: vscode.CancellationToken,
  ): Promise<{ text: string; toolCalls: readonly OpenAiToolCall[] }> {
    if (this.backendMode() === 'mock') {
      return { text: `[WayFinder Gate 0 mock: ${backend}]`, toolCalls: [] };
    }

    const controller = new AbortController();
    const cancellation = token.onCancellationRequested(() => controller.abort());
    try {
      return await new ModelDeckClient(this.modelDeckSettings()).complete({
        backend,
        messages: convertMessages(messages),
        tools: options.tools?.map((tool) => ({
          type: 'function' as const,
          function: { name: tool.name, description: tool.description, parameters: tool.inputSchema ?? { type: 'object' } },
        })),
        toolChoice: options.toolMode === vscode.LanguageModelChatToolMode.Required ? 'required' : 'auto',
        maxTokens: maxOutputTokens,
      }, controller.signal);
    } finally {
      cancellation.dispose();
    }
  }

  private backendMode(): 'mock' | 'modeldeck' {
    return this.configuration.get<'mock' | 'modeldeck'>('backendMode', 'mock');
  }

  private modelDeckSettings(): ModelDeckSettings {
    return {
      baseUrl: this.configuration.get<string>('modelDeck.baseUrl', 'http://127.0.0.1:8600/v1'),
      fastModel: this.configuration.get<string>('modelDeck.fastModel', 'fast-local'),
      deepModel: this.configuration.get<string>('modelDeck.deepModel', 'deep-local'),
    };
  }
}

function model(id: VirtualModelId, name: string, detail: string): vscode.LanguageModelChatInformation {
  return {
    id,
    name,
    family: 'wayfinder',
    version: '0.1.0-gate0',
    maxInputTokens: 32_768,
    maxOutputTokens: 4_096,
    detail,
    tooltip: detail,
    capabilities: { toolCalling: true },
  };
}

function asVirtualModelId(id: string): VirtualModelId {
  if (id === 'wayfinder-fast' || id === 'wayfinder-deep' || id === 'wayfinder-auto') {
    return id;
  }
  throw new Error(`Unknown WayFinder virtual model: ${id}`);
}

function observe(requestNumber: number, messages: readonly vscode.LanguageModelChatRequestMessage[]): InvocationObservation {
  let textPartCount = 0;
  let toolCallCount = 0;
  let toolResultCount = 0;
  for (const message of messages) {
    for (const part of message.content) {
      if (part instanceof vscode.LanguageModelTextPart) textPartCount += 1;
      if (part instanceof vscode.LanguageModelToolCallPart) toolCallCount += 1;
      if (part instanceof vscode.LanguageModelToolResultPart) toolResultCount += 1;
    }
  }
  return { requestNumber, messageCount: messages.length, textPartCount, toolCallCount, toolResultCount };
}

function convertMessages(messages: readonly vscode.LanguageModelChatRequestMessage[]): OpenAiMessage[] {
  const converted: OpenAiMessage[] = [];
  for (const message of messages) {
    const text = message.content.filter((part) => part instanceof vscode.LanguageModelTextPart).map(partText).join('');
    const toolCalls = message.content
      .filter((part): part is vscode.LanguageModelToolCallPart => part instanceof vscode.LanguageModelToolCallPart)
      .map((part) => ({ id: part.callId, type: 'function' as const, function: { name: part.name, arguments: JSON.stringify(part.input) } }));
    const results = message.content.filter(
      (part): part is vscode.LanguageModelToolResultPart => part instanceof vscode.LanguageModelToolResultPart,
    );
    if (results.length) {
      for (const result of results) {
        converted.push({ role: 'tool', tool_call_id: result.callId, content: result.content.map(partText).join('') });
      }
      continue;
    }
    converted.push({
      role: message.role === vscode.LanguageModelChatMessageRole.Assistant ? 'assistant' : 'user',
      content: text || null,
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    });
  }
  return converted;
}

function partText(part: unknown): string {
  if (part instanceof vscode.LanguageModelTextPart) return part.value;
  if (part instanceof vscode.LanguageModelToolResultPart) return part.content.map(partText).join('');
  return '';
}

function parseToolInput(value: string, toolName: string): object {
  try {
    const parsed: unknown = JSON.parse(value || '{}');
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return parsed;
  } catch {
    // The backend produced invalid arguments. Failing here makes the failure visible to the agent loop.
  }
  throw new ModelDeckError(`ModelDeck returned invalid JSON arguments for tool '${toolName}'.`);
}
