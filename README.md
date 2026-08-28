# WayFinder

WayFinder is a local-first VS Code extension research POC for explainable, SLM-native agent orchestration. **Gate 0** remains available as the historical provider baseline: it tests whether one logical VS Code model can select a different backend on successive agent inferences while VS Code retains the tool loop.

It does not yet claim to be a complete trajectory-aware router. The current rule is a transparent test fixture:

```text
no tool results  → Fast
one or two results → Deep
three or more results → Fast
```

This makes a Fast → Deep → Fast sequence observable in a trace without presenting a research policy as settled behaviour.

## What is implemented

- A public VS Code Language Model Chat Provider named `wayfinder` with `WayFinder Auto`, `WayFinder Fast`, and `WayFinder Deep` virtual models. This is explicitly the Gate 0 compatibility and comparison path.
- Per-invocation inspection of text parts, prior tool calls, and tool results, with a labelled character-based compatibility token estimate (not a tokenizer count).
- A deterministic Gate 0 backend selector; explicit Fast and Deep choices are never rerouted.
- A local ModelDeck OpenAI-compatible adapter that preserves text, tool calls, and tool-result correlation.
- Safe mock mode, enabled by default, which needs no model service.
- Append-only local JSONL traces containing counts and routing metadata, never prompt text, source content, environment variables, or credentials.
- A status-bar indicator and commands to view or clear the trace.
- An initial owned-runtime foundation, surfaced in the dedicated **WayFinder** Activity Bar view. It has serialisable execution state, a model-neutral request capsule, deterministic context budgets, a capability-based tool broker, bounded-loop transitions, cancellation, validation repair/escalation, and privacy-conscious diagnostics.

The owned-runtime chat surface currently exposes two bounded, read-only capabilities. It can list direct entries in the open workspace roots, then read one direct regular UTF-8 text file named by that listing (up to 12 KiB). It does not recurse, follow symbolic links, edit files, run commands, or make consequential calls. File content is transient model evidence for the next inference only; diagnostics remain metadata-only.

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

## Run the WayFinder sidebar

1. Run the extension in an Extension Development Host as above.
2. Open **WayFinder** from its Activity Bar icon or run **WayFinder: Open**. This surface owns the compact request capsule and loop rather than forwarding Copilot's assembled agent transcript.
3. Send a message and leave the compact model selector set to **Auto** (the default), or explicitly select **Fast** or **Deep** for that request. Auto starts Fast and may escalate to Deep after deterministic validation repairs; explicit tiers remain pinned. The view retains rendered turns until **New chat**, but each request remains an independent runtime task and prior turns are not sent to the model.
4. To exercise the bounded read-only path, configure a local ModelDeck backend, then ask: `What does Readme.md in this project say?` WayFinder first lists direct workspace entries, then may read the named file. Mock mode verifies the sidebar and trace path but does not request tools.
5. Use the sidebar's **Show runtime diagnostics** action or **WayFinder: Show Runtime Diagnostics** to inspect metadata-only JSONL records. It records mode, tier, budgets, context categories and provenance, exposed-tool size, validation outcomes, escalation, latency, and stop reasons—never prompts, source contents, arguments, or raw tool outputs.

## Configuration

| Setting | Default | Purpose |
| --- | --- | --- |
| `wayfinder.backendMode` | `mock` | Use deterministic mock replies or the local ModelDeck adapter. |
| `wayfinder.modelDeck.baseUrl` | `http://127.0.0.1:8600/v1` | OpenAI-compatible local API base URL. |
| `wayfinder.modelDeck.fastModel` | `fast-local` | Configured fast backend model ID. |
| `wayfinder.modelDeck.deepModel` | `deep-local` | Configured deep backend model ID. |
| `wayfinder.trace.enabled` | `true` | Enable local privacy-preserving Gate 0 traces. |
| `wayfinder.runtime.inputBudget` | `4096` | Estimated input budget for the owned runtime; not an asserted model context limit. |
| `wayfinder.runtime.outputBudget` | `512` | Estimated output budget for the owned runtime; chosen to fit the current bounded local-route defaults. |
| `wayfinder.runtime.maxIterations` | `5` | Bounded-loop iteration limit for the owned runtime. |

No token, API key, or model identity is hard-coded. The supplied URL and model IDs are placeholders and must be set to match the local ModelDeck installation.

## Run the live readback evaluation

The automated readback evaluation runs the same harmless, fixed `Readme.md` fixture through Fast, Deep, and Auto. For this fixture only, every inference that exposes a tool sends the standard OpenAI-compatible `tool_choice: "required"` setting; normal sidebar tasks retain automatic tool choice. The evaluation verifies the bounded list → read evidence path and requires Deep and Auto answers to meet the deterministic evidence-coverage threshold. It prints metadata only: tiers, iterations, latency, tool IDs, validation and coarse backend-error codes, escalation, and coverage counts—never model replies or source text.

It is deliberately separate from `npm test`, because it sends live requests to the local ModelDeck service. Provide the same local route details used by WayFinder:

```powershell
$env:WAYFINDER_EVAL_BASE_URL = 'http://127.0.0.1:8600/v1'
$env:WAYFINDER_EVAL_FAST_MODEL = 'fast-local'
$env:WAYFINDER_EVAL_DEEP_MODEL = 'deep-local'
npm run eval:readback
```

Fast is reported for comparison but may be incomplete. Auto passes whether Fast meets the threshold directly or it performs the recorded Fast-to-Deep escalation; Deep and Auto must both meet the threshold.

## Architecture and feasibility status

The public API supports the **mechanism**: multiple virtual models, request-history access, structured tool-call responses, structured tool-result inputs, and per-request provider execution. A local Extension Development Host trial has now demonstrated the Gate 0 Fast → Deep → Fast sequence while VS Code retained tool execution. The provider mechanism therefore passed Gate 0 in that environment; the captured trace remains the experiment artefact.

The trial also showed that model routing alone is insufficient for small local models. Copilot Agent mode can supply a large instruction set and tool catalogue, and malformed or repeated tool calls can create runaway loops. The next research task is privacy-preserving observability and tool-surface debugging: measure request and tool metadata, explain routing decisions, and identify truncation, retry, and loop behaviour without recording prompts, source contents, tool arguments, or tool results. See [the Gate 0 protocol](docs/gate-0.md) for the recorded result and scoped follow-up.

Gate 1 begins the owned-runtime transition without rewriting the Gate 0 result. Its core is independent of VS Code UI and ModelDeck wire format: task state, context selection, tool contracts, response validation, loop control, and diagnostics are unit-testable without live inference. The existing provider remains available for controlled comparison.

This does not guarantee that every VS Code Chat distribution or organisation policy will expose local providers in every agent experience. In particular, the provider guide notes that organisations can disable bring-your-own-key models through Copilot policy.

WayFinder's dedicated sidebar is the first owned-runtime integration surface. This is not a claim that the UI alone makes WayFinder autonomous: the runtime core, not the sidebar, owns its model-visible working set and loop. The model-picker entries `WayFinder Auto`, `WayFinder Fast`, and `WayFinder Deep` remain the separate Gate 0 provider compatibility and comparison path. Capability adapters, approvals, and consequential actions remain intentionally unimplemented in this slice.

See [the Gate 0 protocol](docs/gate-0.md) for the historical acceptance criteria and limitations, [the owned-runtime architecture](docs/owned-runtime.md) for the active design, and the trace schemas in `protocol/` for recorded fields.

## Repository layout

```text
extension/  VS Code extension, compatibility adapter, and owned runtime
protocol/   Language-neutral trace and diagnostic schemas
docs/       Gate evidence and owned-runtime architecture
```

Future gates will add further read-only capability adapters, approval presentation and resumption, model discovery/tokenizer integration, selected repository context, and replay evaluation. Those are intentionally excluded from the present foundation.
