# WayFinder

WayFinder is a local-first VS Code extension research POC for explainable, trajectory-aware routing between local language models. It deliberately begins with **Gate 0**: testing whether one logical VS Code model can select a different backend on successive agent inferences while VS Code retains the tool loop.

It does not yet claim to be a complete trajectory-aware router. The current rule is a transparent test fixture:

```text
no tool results  → Fast
one or two results → Deep
three or more results → Fast
```

This makes a Fast → Deep → Fast sequence observable in a trace without presenting a research policy as settled behaviour.

## What is implemented

- A public VS Code Language Model Chat Provider named `wayfinder` with `WayFinder Auto`, `WayFinder Fast`, and `WayFinder Deep` virtual models.
- Per-invocation inspection of text parts, prior tool calls, and tool results.
- A deterministic Gate 0 backend selector; explicit Fast and Deep choices are never rerouted.
- A local ModelDeck OpenAI-compatible adapter that preserves text, tool calls, and tool-result correlation.
- Safe mock mode, enabled by default, which needs no model service.
- Append-only local JSONL traces containing counts and routing metadata, never prompt text, source content, environment variables, or credentials.
- A status-bar indicator and commands to view or clear the trace.

The implementation follows VS Code's public [Language Model Chat Provider API](https://code.visualstudio.com/api/extension-guides/ai/language-model-chat-provider). That API supplies the complete message sequence to the provider and permits text, tool-call, and tool-result response parts. VS Code's current API reference also documents tool results as input parts, which is the critical evidence required for per-invocation routing.

## Run Gate 0

1. Install dependencies and build:

   ```bash
   npm install
   npm test
   ```

2. Open this repository in VS Code and start **Run WayFinder Extension** (`F5`). The supplied launch configuration opens an Extension Development Host.
3. In the development host's Chat model picker, select **WayFinder Auto**.
4. Start in the default mock mode to confirm that the provider appears and writes a trace. The reply identifies the selected mock backend.
5. To test VS Code's real tool loop, set `wayfinder.backendMode` to `modeldeck`, set the three `wayfinder.modelDeck.*` settings to your local service and model IDs, then run an agent task that makes tools available.
6. Run **WayFinder: Show Gate 0 Trace**. A successful tool-loop trial should contain backend selections analogous to `fast` (no results), `deep` (one result), and `fast` (three results). Preserve this JSONL file as the Gate 0 artefact.

The mock response intentionally does not manufacture tool calls. It verifies provider registration and trace behaviour; a ModelDeck-backed agent task is required to prove that VS Code invokes tools and returns their results to a later provider invocation.

## Configuration

| Setting | Default | Purpose |
| --- | --- | --- |
| `wayfinder.backendMode` | `mock` | Use deterministic mock replies or the local ModelDeck adapter. |
| `wayfinder.modelDeck.baseUrl` | `http://127.0.0.1:8600/v1` | OpenAI-compatible local API base URL. |
| `wayfinder.modelDeck.fastModel` | `fast-local` | Configured fast backend model ID. |
| `wayfinder.modelDeck.deepModel` | `deep-local` | Configured deep backend model ID. |
| `wayfinder.trace.enabled` | `true` | Enable local privacy-preserving Gate 0 traces. |

No token, API key, or model identity is hard-coded. The supplied URL and model IDs are placeholders and must be set to match the local ModelDeck installation.

## Feasibility status

The public API supports the **mechanism**: multiple virtual models, request-history access, structured tool-call responses, structured tool-result inputs, and per-request provider execution. It does not itself guarantee that every VS Code Chat distribution or organisation policy will expose local providers in every agent experience. In particular, the provider guide notes that organisations can disable bring-your-own-key models through Copilot policy. Gate 0 is therefore **implemented but not passed** until it is run in the intended VS Code build with a local backend and its trace is inspected.

If the real trial does not return tool results to a subsequent provider call, the documented fallback is a WayFinder chat participant. That would make WayFinder own tool selection, invocation, approvals, cancellation, conversation/history construction, edits, terminal/task integration, and result presentation. This is deliberately not implemented before the provider experiment fails, because it would no longer preserve VS Code's normal agent loop.

See [the Gate 0 protocol](docs/gate-0.md) for the exact acceptance criteria and limitations, and [the trace schema](protocol/gate-zero-trace.schema.json) for the recorded fields.

## Repository layout

```text
extension/  VS Code extension and deterministic routing fixture
protocol/   Language-neutral Gate 0 trace schema
docs/       Feasibility protocol and architecture notes
```

Future gates will add semantic trajectory state, configurable capability profiles, observer output validation, mixed-initiative controls, developer-side boundary events, and replay evaluation. Those are intentionally excluded from Gate 0.
