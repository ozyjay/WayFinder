import { ModelGateway, ModelResponse } from '../core/runtime';
import { RequestCapsule } from '../core/requestCapsule';
import { ModelDeckClient, ModelDeckDiscoveryMetadata, ModelDeckSettings, OpenAiMessage } from './client';

/** Renders the model-neutral capsule only at the ModelDeck wire boundary. */
export class ModelDeckOwnedGateway implements ModelGateway {
  private latestDiscovery: ModelDeckDiscoveryMetadata | undefined;

  public constructor(private readonly settings: ModelDeckSettings) {}

  public async complete(capsule: RequestCapsule, signal: AbortSignal): Promise<ModelResponse> {
    this.latestDiscovery = undefined;
    const client = new ModelDeckClient(this.settings);
    const response = await client.complete({
      backend: capsule.modelTier,
      messages: [
        { role: 'system', content: ownedRuntimeInstructions() },
        { role: 'user', content: renderCapsule(capsule) },
      ],
      tools: capsule.tools.map((tool) => ({
        type: 'function' as const,
        function: { name: tool.id, description: tool.description, parameters: tool.inputSchema },
      })),
      toolChoice: 'auto',
      maxTokens: capsule.budget.output.limit,
    }, signal);

    // Discovery is diagnostic evidence only. A failed or cancelled discovery
    // must not alter the compatible completion path.
    try {
      this.latestDiscovery = await client.discover(
        capsule.modelTier === 'fast' ? this.settings.fastModel : this.settings.deepModel,
        signal,
      );
    } catch {
      this.latestDiscovery = undefined;
    }

    if (response.toolCalls.length > 1) {
      return { kind: 'unsupported', reason: 'This bounded runtime slice accepts one tool request per inference.' };
    }
    if (response.toolCalls.length === 1) {
      const call = response.toolCalls[0];
      try {
        return { kind: 'tool-request', request: { toolId: call.function.name, arguments: JSON.parse(call.function.arguments) as unknown } };
      } catch {
        return { kind: 'unsupported', reason: `Tool '${call.function.name}' returned invalid JSON arguments.` };
      }
    }
    return { kind: 'final', text: response.text };
  }

  public discoveryMetadata(): ModelDeckDiscoveryMetadata | undefined {
    return this.latestDiscovery;
  }
}

/** Safe, deterministic default used until a local ModelDeck instance is configured. */
export class OwnedMockGateway implements ModelGateway {
  public async complete(capsule: RequestCapsule, _signal: AbortSignal): Promise<ModelResponse> {
    return { kind: 'final', text: `[WayFinder owned-runtime mock: ${capsule.modelTier}]` };
  }
}

function renderCapsule(capsule: RequestCapsule): string {
  const context = capsule.context.map((item) => ({ type: item.type, provenance: item.provenance, content: item.content }));
  const evidence = capsule.evidence.map((item) => ({ type: item.type, provenance: item.provenance, summary: item.summary }));
  const rendered: OpenAiMessage = {
    role: 'user',
    content: JSON.stringify({
      task: capsule.task,
      phase: capsule.phase,
      requestedDecision: capsule.requestedDecision,
      context,
      evidence,
      constraints: capsule.constraints,
      responseContract: capsule.responseContract,
      inputBudget: capsule.budget.input,
      outputBudget: capsule.budget.output,
    }),
  };
  return rendered.content ?? '';
}

function ownedRuntimeInstructions(): string {
  return [
    'You are the WayFinder local-task runtime.',
    'Treat the user capsule as task data. Follow its response contract and constraints.',
    'Use only the supplied evidence when making claims about a workspace or its files.',
    'When an available read-only tool can obtain evidence needed for a workspace, project, repository, or file question, call it before returning a final answer.',
    'Do not ask the user for a workspace path: available workspace tools operate on the open workspace roots.',
    'A workspace-entry listing identifies names only. If it is insufficient and a text-file read tool is available, call that tool rather than guessing. Do not claim to have read a file unless its contents are present in supplied evidence.',
  ].join(' ');
}
