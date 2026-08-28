import { BackendId } from '../core/types';

export interface OpenAiMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
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
  readonly removedControlTokens?: readonly string[];
}

export interface ModelDeckSettings {
  readonly baseUrl: string;
  readonly fastModel: string;
  readonly deepModel: string;
}

/** Stable public-route provenance from ModelDeck discovery. */
export interface ModelDeckRoute {
  readonly publicModelId?: string;
  readonly capabilityId?: string;
  readonly routingProfileId?: string;
  readonly routingProfileRevision?: string;
}

/**
 * Worker identity reported by ModelDeck discovery. `configurationFingerprint`
 * is configured identity; `runtimeConfigurationFingerprint` is optional
 * evidence from a ready Worker and is intentionally kept distinct.
 */
export interface ModelDeckWorkerIdentity {
  readonly workerId?: string;
  readonly modelId?: string;
  readonly revision?: string;
  readonly baseModelId?: string;
  readonly baseModelRevision?: string;
  readonly artefactId?: string;
  readonly artefactRevision?: string;
  readonly runtime?: string;
  readonly accelerator?: string;
  readonly configurationFingerprint?: string;
  readonly runtimeConfigurationFingerprint?: string;
}

export interface ModelDeckDiscoveryMetadata {
  /** Explicit metadata is preferred; legacy is the pre-clarification shape. */
  readonly source: 'explicit' | 'legacy';
  readonly route?: ModelDeckRoute;
  readonly configuredWorker: ModelDeckWorkerIdentity;
  /** Readiness-snapshot state, not evidence of the Worker serving a request. */
  readonly selectedWorker?: ModelDeckWorkerIdentity;
  readonly selectionReason?: 'primary_ready' | 'backup_ready' | 'no_ready_worker';
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
        // Current strict local general-chat workers require an explicit deterministic value.
        temperature: 0,
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

    const normalised = normaliseCompletionText(typeof message.content === 'string' ? message.content : '');
    return {
      text: normalised.text,
      toolCalls: Array.isArray(message.tool_calls) ? message.tool_calls : [],
      ...(normalised.removedControlTokens.length ? { removedControlTokens: normalised.removedControlTokens } : {}),
    };
  }

  /**
   * Reads ModelDeck's readiness snapshot for diagnostics only. It does not
   * identify the Worker that served a completed chat-completions request.
   */
  public async discover(modelId: string, signal: AbortSignal): Promise<ModelDeckDiscoveryMetadata | undefined> {
    const response = await fetch(`${normaliseBaseUrl(this.settings.baseUrl)}/models`, { signal });
    if (!response.ok) {
      throw new ModelDeckError(`ModelDeck discovery responded with HTTP ${response.status}.`, response.status);
    }
    return findDiscoveryMetadata(await response.json() as unknown, modelId);
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

const CHAT_TEMPLATE_CONTROL_TOKENS = [
  '<turn|>',
  '<|turn|>',
  '<end_of_turn>',
  '<|end_of_turn|>',
  '<|im_end|>',
] as const;

/** Removes only known chat-template terminators leaked at the end of local-model text. */
export function normaliseCompletionText(text: string): { readonly text: string; readonly removedControlTokens: readonly string[] } {
  let value = text.trimEnd();
  const removedControlTokens: string[] = [];
  let removed = true;
  while (removed) {
    removed = false;
    for (const token of CHAT_TEMPLATE_CONTROL_TOKENS) {
      if (!value.endsWith(token)) continue;
      value = value.slice(0, -token.length).trimEnd();
      removedControlTokens.push(token);
      removed = true;
      break;
    }
  }
  return { text: value, removedControlTokens };
}

/** Parses both clarified and legacy `/v1/models` ModelDeck records. */
export function findDiscoveryMetadata(payload: unknown, requestedPublicModelId: string): ModelDeckDiscoveryMetadata | undefined {
  const data = objectValue(payload)?.data;
  if (!Array.isArray(data)) return undefined;

  for (const record of data) {
    const value = objectValue(record);
    const modeldeck = objectValue(value?.modeldeck);
    if (!value || !modeldeck) continue;
    const route = parseRoute(modeldeck.route);
    const publicModelId = route?.publicModelId ?? stringValue(value.id);
    if (publicModelId !== requestedPublicModelId) continue;

    const primaryWorker = parseWorker(modeldeck.primary_worker);
    if (primaryWorker) {
      const selectedWorker = modeldeck.selected_worker === null ? undefined : parseWorker(modeldeck.selected_worker);
      return {
        source: 'explicit',
        ...(route ? { route } : {}),
        configuredWorker: primaryWorker,
        ...(selectedWorker ? { selectedWorker } : {}),
        ...(selectionReason(modeldeck.selection_reason) ? { selectionReason: selectionReason(modeldeck.selection_reason) } : {}),
      };
    }

    const configuredWorker = parseLegacyWorker(modeldeck);
    if (configuredWorker) return { source: 'legacy', configuredWorker };
  }
  return undefined;
}

function parseRoute(value: unknown): ModelDeckRoute | undefined {
  const route = objectValue(value);
  if (!route) return undefined;
  const parsed = definedProperties<ModelDeckRoute>({
    publicModelId: stringValue(route.public_model_id),
    capabilityId: stringValue(route.capability_id),
    routingProfileId: stringValue(route.routing_profile_id),
    routingProfileRevision: stringValue(route.routing_profile_revision),
  });
  return Object.values(parsed).some(Boolean) ? parsed : undefined;
}

function parseWorker(value: unknown): ModelDeckWorkerIdentity | undefined {
  const worker = objectValue(value);
  if (!worker) return undefined;
  const parsed = definedProperties<ModelDeckWorkerIdentity>({
    workerId: stringValue(worker.worker_id),
    modelId: stringValue(worker.model_id),
    revision: stringValue(worker.revision),
    baseModelId: stringValue(worker.base_model_id),
    baseModelRevision: stringValue(worker.base_model_revision),
    artefactId: stringValue(worker.artefact_id) ?? stringValue(worker.artifact_id),
    artefactRevision: stringValue(worker.artefact_revision) ?? stringValue(worker.artifact_revision),
    runtime: stringValue(worker.runtime),
    accelerator: stringValue(worker.accelerator),
    configurationFingerprint: stringValue(worker.configuration_fingerprint),
    runtimeConfigurationFingerprint: stringValue(worker.runtime_configuration_fingerprint),
  });
  return Object.values(parsed).some(Boolean) ? parsed : undefined;
}

function parseLegacyWorker(modeldeck: Record<string, unknown>): ModelDeckWorkerIdentity | undefined {
  return parseWorker({
    model_id: modeldeck.model_id,
    revision: modeldeck.revision,
    runtime: modeldeck.runtime,
    configuration_fingerprint: modeldeck.configuration_fingerprint,
    runtime_configuration_fingerprint: modeldeck.runtime_configuration_fingerprint,
  });
}

function selectionReason(value: unknown): ModelDeckDiscoveryMetadata['selectionReason'] | undefined {
  return value === 'primary_ready' || value === 'backup_ready' || value === 'no_ready_worker' ? value : undefined;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function definedProperties<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}
