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
| Model gateway | ModelDeck wire request/response conversion and Fast/Deep selection | Non-streaming ModelDeck and deterministic mock adapters; `/v1/models` identity/readiness snapshots are recorded for diagnostics. Health, streaming, and authoritative token limits are pending. |
| Execution state | Goal, phase, reduced evidence, completed actions, capabilities, tier, budgets, iterations, and terminal status | Implemented in `core/executionState.ts`; excludes chat transcript and raw tool output. |
| Request capsule | Compact, model-neutral selected working set | Implemented in `core/requestCapsule.ts`; prompt rendering occurs only in the ModelDeck adapter. |
| Context compiler | Deterministic priority/order selection, budget enforcement, exclusion provenance | Implemented for supplied candidates. Repository instruction, source, symbol, and failure collectors are future adapters. |
| Tool broker | Capability selection, schema presentation, argument validation, approval boundary, and evidence reduction | Contracts and validation are implemented. The UI can list direct workspace entries, then read one bounded direct UTF-8 text file. |
| Agent loop | Bounded inspect–reason–act–observe control, validation repairs, escalation, cancellation, and stop reasons | Implemented in `core/runtime.ts`. |
| Diagnostics | Privacy-conscious inference metadata | JSONL diagnostics record no prompt, source content, tool arguments, raw output, terminal output, environment values, or credentials. |
| VS Code surfaces | User request, progress, final result, cancellation, diagnostics | The dedicated WayFinder Activity Bar sidebar is the owned-runtime surface; the Gate 0 provider remains separate in `compatibility/`. |

## Core contracts

`ExecutionState` is serialisable durable state. It is not rendered history. `RequestCapsule` is a model-neutral one-inference representation containing task, phase, concise evidence, requested decision, selected context, shortlisted schemas, constraints, response contract, and labelled budgets. The ModelDeck adapter renders that capsule only at the wire boundary.

Every context item has a type, provenance, priority, token count, and token-count kind. `authoritative` means a real tokenizer or backend count supplied it; `estimate` does not. The initial configuration uses explicit estimates and never advertises them as exact backend capacity.

Tool results use a two-layer contract: the executor may retain raw output for inspection, while durable state receives only a concise attributable evidence summary. A bounded text-file read may additionally provide transient model context for the immediately following inference. That text never enters durable state or diagnostics, preventing indefinite source replay.

## Loop and autonomy policy

The first controller is deliberately narrow:

```text
initialise → compile capsule → select tier/tools → invoke model
→ validate response → approval boundary → execute tool → reduce evidence
→ continue, escalate, complete, cancel, or stop
```

The controller has a positive iteration limit, cancellation checks, explicit terminal statuses, validation-failure limits, and a deterministic Fast-to-Deep escalation policy. For the narrow direct-file-read slice, Auto also applies a deterministic evidence-coverage check: a final answer must retain at least 60% of the distinct source terms of sufficient length. A failed Fast answer receives one repair attempt, then escalates to Deep; the generic validation code and escalation are recorded without source terms. Explicit Fast and Deep tasks remain pinned and do not apply this Auto-only check. The default five-iteration limit leaves room for discovery, read, repair, escalation, and final response. It accepts one tool request per inference in this first slice.

The public WayFinder sidebar grants two bounded read-only capabilities. `list_workspace_entries` lists at most 40 direct entries in one call across the open workspace roots. After that discovery step, `read_workspace_text_file` can read one direct, regular UTF-8 file named by the listing, capped at 12 KiB. It does not recurse, accept nested paths, follow symbolic links, edit files, run commands, or make hidden consequential calls. The listing and file content are model-visible only after explicit tool requests. File content is transient context for the following inference only, and neither it nor the listing enters diagnostics. Later tool adapters must declare a stable ID, capability set, input schema, risk, approval requirement, availability condition, and evidence output class before they can be exposed.

## Measurement and comparison

Each diagnostic records the developer-selected execution mode, model tier, phase, context item types/provenance and character sizes, labelled budgets, exposed-tool count and schema size, stable-prefix identity, latency, validation result, coarse backend or tool-execution failure category, escalation, iteration, and stop reason. It deliberately excludes sensitive contents, including backend messages, paths, arguments, and raw tool results.

When a local ModelDeck endpoint exposes `/v1/models`, WayFinder also records a discovery-time snapshot. The explicit `modeldeck.route` identifies the stable public route. `modeldeck.primary_worker` is the configured Worker identity used for experimental identity: its worker ID, loaded model ID/revision, and `configuration_fingerprint`. `configuration_fingerprint` is configured identity; the optional `runtime_configuration_fingerprint` is separate ready-Worker evidence and must not replace it.

`modeldeck.selected_worker` and `selection_reason` record only the ordered-routing readiness snapshot: primary-ready, backup-ready, or no-ready-worker. A missing selected Worker is valid for `no_ready_worker`. This snapshot does **not** establish which Worker served the preceding or following completion. Older ModelDeck records with flat `model_id`, `revision`, `runtime`, and `configuration_fingerprint` remain diagnostic-compatible, but lack the clarified route and selection state.

The intended comparison conditions are:

1. Gate 0 Copilot provider passthrough;
2. a future mediated provider compatibility mode; and
3. the WayFinder-owned compact runtime.

The current implementation provides (1) and the foundation for (3). Condition (2) is a separate experiment, not silently conflated with either surface.

## Staged migration

1. **Gate 1a — foundation (implemented):** contracts, deterministic compiler, bounded loop, diagnostics, mock/ModelDeck gateway, and task-first sidebar.
2. **Gate 1b — safe observation (started):** bounded workspace listing and one direct UTF-8 text-file read are implemented. Language-service adapters, broader context collectors, and approval/resumption UI remain future work.
3. **Gate 1c — model truth:** extend the recorded ModelDeck discovery snapshot with availability, streaming, cancellation telemetry, and authoritative limits/token counts where ModelDeck can provide them.
4. **Gate 1d — evaluation:** `npm run eval:readback` is an opt-in live ModelDeck check of the fixed bounded-readback fixture under Fast, Deep, and Auto. For this fixture only, each inference with an exposed tool sets the standard OpenAI-compatible `tool_choice` value to `required`; ordinary sidebar tasks retain automatic tool choice. It asserts the list → read path and evidence coverage for Deep and Auto, then emits metadata-only tier, tool, validation, escalation, coverage-count, iteration, and latency results. The fixture is a first matched task; extend it before drawing broader routing conclusions.

## Gate 1d observed results

### Initial capability boundary — 15 August 2026

The first live readback evaluation against the configured local Fast and Deep routes did not pass. Before capability rehearsal, both explicit Fast and explicit Deep completed a first inference without a structured tool call, even when the fixture supplied tools and requested the standard OpenAI-compatible `tool_choice: "required"` setting. Auto also completed on Fast at the first inference, so no deterministic evidence validation or Fast-to-Deep escalation occurred.

After ModelDeck capability rehearsal, the same fixture produced explicit HTTP 422 backend errors for Fast, Deep, and Auto. ModelDeck correctly enforced the required-tool contract rather than silently accepting a text response, but the local Qwen Workers still did not emit native structured tool calls. This establishes a current Worker tool-call capability or chat-template limitation, not a WayFinder routing-policy failure, because the bounded list → read path never began. Preserve the metadata-only evaluation report and use a compatible tool-call template or Worker before extending WayFinder's autonomy boundary.

### Bounded readback pass — 16 August 2026

After the local routes were configured to emit native structured tool calls, the evaluation passed its Deep and Auto acceptance criteria. Both followed the bounded `list_workspace_entries` then `read_workspace_text_file` path. Deep completed in three iterations and met evidence coverage directly. Auto began on Fast, recorded three deterministic insufficient-evidence validations, escalated to Deep, and completed with the required evidence coverage in five iterations.

Fast also completed the safe tool path in three iterations but did not meet the evidence-coverage threshold. This is expected comparison evidence: the fixture requires Deep and Auto to pass, while Fast remains informative about the smaller model's limits. The measured end-to-end model latency was approximately 51 seconds for Deep and 29 seconds for Auto; this is operational evidence to consider before widening the runtime's scope.
5. **Only after evidence:** consider bounded edits and terminal actions with separate approval controls. Do not add learned phase inference or unrestricted autonomy opportunistically.

## Open questions and risks

- The sidebar is an integration surface, not a guarantee that every distribution or policy permits the same experience. It must remain replaceable.
- The ModelDeck API has not yet established authoritative model limits or tokenizer support. Configured budgets are estimates.
- The direct file-read adapter has explicit size, path, type, and transient-context rules. Broader source collection still needs equally explicit provenance, truncation, and privacy rules.
- Approval resumption needs a stable pending-action store and UI decisions before any consequential tool adapter is enabled.
- The existing provider’s host-owned loop is intentionally retained for comparison; it should not be treated as owned-runtime evidence.
