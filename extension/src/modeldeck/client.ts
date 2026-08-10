import { BackendId } from '../core/types';

export interface OpenAiMessage {
  readonly role: 'user' | 'assistant' | 'tool';
  readonly content: string | null;
  readonly tool_call_id?: string;
  readonly tool_calls?: readonly OpenAiToolCall[];
}

export interface OpenAiToolCall {
  readonly id: string;
  readonly type: 'function';
  readonly function: {
    readonly name: string;
    readonly arguments: string;
  };
}

export interface ModelDeckRequest {
  readonly backend: BackendId;
  readonly messages: readonly OpenAiMessage[];
  readonly tools?: readonly { type: 'function'; function: { name: string; description: string; parameters: object } }[];
  readonly toolChoice: 'auto' | 'required';
  readonly maxTokens: number;
}

export interface ModelDeckResponse {
  readonly text: string;
  readonly toolCalls: readonly OpenAiToolCall[];
}

export interface ModelDeckSettings {
  readonly baseUrl: string;
  readonly fastModel: string;
  readonly deepModel: string;
}

/** Minimal adapter for ModelDeck's OpenAI-compatible non-streaming endpoint. */
export class ModelDeckClient {
  public constructor(private readonly settings: ModelDeckSettings) {}

  public async complete(request: ModelDeckRequest, signal: AbortSignal): Promise<ModelDeckResponse> {
    const response = await fetch(`${normaliseBaseUrl(this.settings.baseUrl)}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal,
      body: JSON.stringify({
        model: request.backend === 'fast' ? this.settings.fastModel : this.settings.deepModel,
        messages: request.messages,
        tools: request.tools,
        tool_choice: request.tools?.length ? request.toolChoice : undefined,
        max_tokens: request.maxTokens,
        stream: false,
      }),
    });

    if (!response.ok) {
      throw new ModelDeckError(`ModelDeck responded with HTTP ${response.status}.`, response.status);
    }

    const payload = await response.json() as OpenAiCompletion;
    const message = payload.choices?.[0]?.message;
    if (!message) {
      throw new ModelDeckError('ModelDeck response did not include a completion message.');
    }

    return {
      text: typeof message.content === 'string' ? message.content : '',
      toolCalls: Array.isArray(message.tool_calls) ? message.tool_calls : [],
    };
  }
}

export class ModelDeckError extends Error {
  public constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = 'ModelDeckError';
  }
}

interface OpenAiCompletion {
  readonly choices?: readonly {
    readonly message?: {
      readonly content?: unknown;
      readonly tool_calls?: unknown;
    };
  }[];
}

function normaliseBaseUrl(url: string): string {
  return url.replace(/\/+$/, '');
}
