# Gate 0 — VS Code provider feasibility protocol

## Question

Can a single logical `WayFinder Auto` model choose Fast, Deep, and Fast backends across successive VS Code agent inferences while VS Code continues to execute tools and provide their results?

## Public API findings

The design uses the stable, public Language Model Chat Provider API. A provider publishes one or more selectable models and handles each inference in `provideLanguageModelChatResponse`. Each call receives the supplied conversation as heterogeneous message parts. Those parts include `LanguageModelToolCallPart` and `LanguageModelToolResultPart`; the provider can emit text and structured tool calls. See the official [provider guide](https://code.visualstudio.com/api/extension-guides/ai/language-model-chat-provider) and [API reference](https://code.visualstudio.com/api/references/vscode-api#LanguageModelChatProvider).

This makes backend changes between provider invocations technically possible: the virtual model ID is stable, but the provider chooses the ModelDeck backend anew on every call. It does not prove that a particular Chat/agent host will make every required tool available or return all tool results to a provider. The experiment below checks that integration boundary.

The API exposes model metadata (name, family, version, context limits, and tool capability). It does not standardise a reasoning/thinking channel for a provider to forward to an OpenAI-compatible local backend. Gate 0 therefore forwards only regular text and structured tool parts, and does not infer state from hidden reasoning.

## Procedure

1. Build the extension and run it in an Extension Development Host.
2. Set `wayfinder.backendMode` to `modeldeck`; configure Fast and Deep with clearly distinguishable local model IDs or endpoints.
3. Select `WayFinder Auto` in Chat agent mode.
4. Issue a task that reliably causes multiple tool calls, such as asking the agent to inspect files, make a small reversible edit, and run a test.
5. Open **WayFinder: Show Gate 0 Trace** after the session.
6. Record the VS Code version, enabled Chat/Copilot extensions, local ModelDeck version, configured model IDs, task text (separately from the trace), and the trace file location.

## Acceptance criteria

The gate passes only when one agent task produces trace rows equivalent to:

```text
request=1  toolResultCount=0  backend=fast
request=2  toolResultCount=1  backend=deep
request=3  toolResultCount=3  backend=fast
```

The exact number of supplied messages may vary. The required evidence is that the later requests include tool-result parts that correlate with earlier structured tool calls, and the configured backend changes without VS Code abandoning the agent loop.

## What the trace can establish

- Provider invocation order and the virtual model selected.
- Counts of supplied text, tool-call, and tool-result parts.
- Backend selected and the deterministic reason.
- Backend mode, response type, latency, and coarse backend error code.

## What it cannot establish

- Prompt/source contents, tool arguments/results, or hidden reasoning content.
- Correctness or quality of model output.
- A semantic phase transition, capability assessment, or human-centred explanation.
- Complete interception of arbitrary integrated-terminal activity.

## Result record

Record the experiment as one of:

- **Pass** — all acceptance criteria met in the target VS Code environment.
- **Partial** — the provider works, but the host does not return usable tool-result parts or does not permit backend switching in agent mode.
- **Fail** — the virtual provider cannot participate in the desired agent loop.

For a Partial or Fail result, retain the trace and errors, then evaluate the chat-participant fallback. A participant can own the interaction flow, but would require WayFinder to implement the agent harness responsibilities that the provider approach intentionally leaves with VS Code.

