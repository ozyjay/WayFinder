# WayFinder-owned SLM runtime — Gate 1 foundation

## Decision

WayFinder is evolving from a local model provider inside Copilot's agent loop into an SLM-native IDE agent runtime. The runtime owns its model-visible working set, model tier, policy, budgets, tool surface, execution state, validation, stopping, and evaluation telemetry.

The existing VS Code Language Model Chat Provider is retained unchanged in purpose as the **Gate 0 compatibility and research baseline**. It is not the architectural constraint for the owned runtime.

## Why this boundary exists

Gate 0 passed: a stable virtual VS Code model selected Fast, Deep, and Fast backends while VS Code executed tools. The recorded trial also showed that routing model IDs alone cannot protect small local models from a large host instruction prefix, complete tool catalogue, verbose schemas, replayed history, or raw tool outputs.

Prompt caching may reduce repeated prefill cost, but it neither restores context capacity nor makes a crowded tool surface easier to use. WayFinder therefore routes this complete inference configuration:

```text
model + selected context + tools + policy + input/output budgets + autonomy boundary
```

## Component boundaries

| Component | Owns | Current Gate 1 status |
| --- | --- | --- |
| Model gateway | ModelDeck wire request/response conversion and Fast/Deep selection | Non-streaming ModelDeck and deterministic mock adapters; discovery, health, streaming, and authoritative token limits are pending. |
| Execution state | Goal, phase, reduced evidence, completed actions, capabilities, tier, budgets, iterations, and terminal status | Implemented in `core/executionState.ts`; excludes chat transcript and raw tool output. |
| Request capsule | Compact, model-neutral selected working set | Implemented in `core/requestCapsule.ts`; prompt rendering occurs only in the ModelDeck adapter. |
| Context compiler | Deterministic priority/order selection, budget enforcement, exclusion provenance | Implemented for supplied candidates. Repository instruction, source, symbol, and failure collectors are future adapters. |
| Tool broker | Capability selection, schema presentation, argument validation, approval boundary, and evidence reduction | Contracts and validation are implemented. No live tools are exposed by the first UI surface. |
| Agent loop | Bounded inspect–reason–act–observe control, validation repairs, escalation, cancellation, and stop reasons | Implemented in `core/runtime.ts`. |
| Diagnostics | Privacy-conscious inference metadata | JSONL diagnostics record no prompt, source content, tool arguments, raw output, terminal output, environment values, or credentials. |
| VS Code surfaces | User request, progress, final result, cancellation, diagnostics | `@wayfinder` is the initial owned-runtime surface; the Gate 0 provider remains separate in `compatibility/`. |

## Core contracts

`ExecutionState` is serialisable durable state. It is not rendered history. `RequestCapsule` is a model-neutral one-inference representation containing task, phase, concise evidence, requested decision, selected context, shortlisted schemas, constraints, response contract, and labelled budgets. The ModelDeck adapter renders that capsule only at the wire boundary.

Every context item has a type, provenance, priority, token count, and token-count kind. `authoritative` means a real tokenizer or backend count supplied it; `estimate` does not. The initial configuration uses explicit estimates and never advertises them as exact backend capacity.

Tool results use a two-layer contract: the executor may retain raw output for inspection, while the next state receives only a concise attributable evidence summary. This prevents indefinite raw-output replay.

## Loop and autonomy policy

The first controller is deliberately narrow:

```text
initialise → compile capsule → select tier/tools → invoke model
→ validate response → approval boundary → execute tool → reduce evidence
→ continue, escalate, complete, cancel, or stop
```

The controller has a positive iteration limit, cancellation checks, explicit terminal statuses, validation-failure limits, and a deterministic Fast-to-Deep escalation policy. It accepts one tool request per inference in this first slice.

The public `@wayfinder` surface grants no capabilities and exposes no tools. This means it cannot edit files, run commands, or make hidden consequential calls. Later tool adapters must declare a stable ID, capability set, input schema, risk, approval requirement, availability condition, and evidence output class before they can be exposed.

## Measurement and comparison

Each diagnostic records model tier, phase, context item types/provenance and character sizes, labelled budgets, exposed-tool count and schema size, stable-prefix identity, latency, validation result, escalation, iteration, and stop reason. It deliberately excludes sensitive contents.

The intended comparison conditions are:

1. Gate 0 Copilot provider passthrough;
2. a future mediated provider compatibility mode; and
3. the WayFinder-owned compact runtime.

The current implementation provides (1) and the foundation for (3). Condition (2) is a separate experiment, not silently conflated with either surface.

## Staged migration

1. **Gate 1a — foundation (implemented):** contracts, deterministic compiler, bounded loop, diagnostics, mock/ModelDeck gateway, and minimal chat participant.
2. **Gate 1b — safe observation:** add explicitly scoped read-only workspace and language-service capability adapters, context collectors, tool-result reduction policies, and approval/resumption UI.
3. **Gate 1c — model truth:** add ModelDeck discovery, immutable identity, availability, streaming, cancellation telemetry, and authoritative limits/token counts where ModelDeck can provide them.
4. **Gate 1d — evaluation:** run matched tasks under the three conditions and compare compactness, latency, tool validity, loop length, escalation, and task outcome.
5. **Only after evidence:** consider bounded edits and terminal actions with separate approval controls. Do not add learned phase inference or unrestricted autonomy opportunistically.

## Open questions and risks

- VS Code Chat Participant is an integration surface, not a guarantee that every distribution or policy permits the same experience. The participant must remain replaceable.
- The ModelDeck API has not yet established authoritative model limits or tokenizer support. Configured budgets are estimates.
- Choosing source excerpts safely needs explicit provenance, truncation, and privacy rules before collecting broad workspace content.
- Approval resumption needs a stable pending-action store and UI decisions before any consequential tool adapter is enabled.
- The existing provider’s host-owned loop is intentionally retained for comparison; it should not be treated as owned-runtime evidence.
