import { ModelGateway, ModelResponse } from '../core/runtime';
import { RequestCapsule } from '../core/requestCapsule';
import { ModelDeckClient, ModelDeckSettings, OpenAiMessage } from './client';

/** Renders the model-neutral capsule only at the ModelDeck wire boundary. */
export class ModelDeckOwnedGateway implements ModelGateway {
  public constructor(private readonly settings: ModelDeckSettings) {}

  public async complete(capsule: RequestCapsule, signal: AbortSignal): Promise<ModelResponse> {
    const response = await new ModelDeckClient(this.settings).complete({
      backend: capsule.modelTier,
      messages: [{ role: 'user', content: renderCapsule(capsule) }],
      tools: capsule.tools.map((tool) => ({
        type: 'function' as const,
        function: { name: tool.id, description: tool.description, parameters: tool.inputSchema },
      })),
      toolChoice: 'auto',
      maxTokens: capsule.budget.output.limit,
    }, signal);

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
