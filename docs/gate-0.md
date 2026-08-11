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

## Observed result

The local Extension Development Host trial on 10 August 2026 demonstrated the provider feasibility mechanism. One `WayFinder Auto` session recorded the following relevant sequence in its local trace:

```text
toolResultCount=0  backend=fast  responseType=tool-call
toolResultCount=1  backend=deep  responseType=text
toolResultCount=2  backend=deep  responseType=tool-call
toolResultCount=3  backend=fast  responseType=text
```

VS Code executed the structured tool calls and supplied correlated results to later provider invocations. This is a **Pass** for the Gate 0 feasibility question: a stable virtual model can switch Fast → Deep → Fast while VS Code retains the tool loop.

The trial also identified operational limitations that are outside the pass criterion:

- A large Agent-mode prompt and tool catalogue can consume most of a small model's available context before the user request is considered.
- ModelDeck's default 32-token output budget truncated longer tool-call JSON. The provider now sends an explicit output-token budget.
- Repeated failing tool calls can create a loop and eventually leave local ModelDeck backends unavailable. Gate 0 has no loop-control policy yet.

## Historical follow-on — observability and tool-surface debugging

The following was the follow-on proposed when Gate 0 was recorded. It remains useful evidence, but the active architectural decision is now the owned-runtime foundation in [owned-runtime.md](owned-runtime.md). Gate 0 is retained as a compatibility and comparison condition; it is not the primary runtime architecture.

The next task is to improve WayFinder's privacy-preserving logging and debugging capabilities before introducing a more sophisticated routing policy. The objective is to make context pressure, tool availability, malformed calls, retries, backend failures, and loop behaviour explainable from structured evidence.

The implementation should record metadata only, never prompts, source contents, tool arguments, tool results, terminal output, environment variables, credentials, or raw filenames. Proposed fields include:

- observed request and response metadata: supplied and forwarded tool counts, tool names, tool-schema byte counts, response finish category, structured-call count, latency, and coarse backend error code;
- deterministic derivations: request-size and token estimates, remaining budget, and repeated-call fingerprints derived from canonicalised calls without retaining their arguments;
- routing-policy decisions: selected backend, forwarded-tool subset, escalation, retry, loop-stop, and termination reasons.

The trace schema and this protocol must be updated together when those fields are implemented. Tool names or fingerprints must be reviewed as metadata for the privacy model and must not become a route for recording source or user content.

This task investigates the following research hypothesis:

> Routing models without also routing their context and tool surface is incomplete.

A useful local routing policy may need to account for a backend's context budget, tool-call capability, available tool schemas, request/output budgets, and loop state—not just choose a model ID. Gate 1 now evaluates that hypothesis through a WayFinder-owned harness, while the existing provider remains the compatibility and controlled comparison path.

## Result record

Record the experiment as one of:

- **Pass** — all acceptance criteria met in the target VS Code environment.
- **Partial** — the provider works, but the host does not return usable tool-result parts or does not permit backend switching in agent mode.
- **Fail** — the virtual provider cannot participate in the desired agent loop.

For a Partial or Fail result, retain the trace and errors, then evaluate the chat-participant fallback. A participant can own the interaction flow, but would require WayFinder to implement the agent harness responsibilities that the provider approach intentionally leaves with VS Code.
