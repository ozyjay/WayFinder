# WayFinder contributor guide

## Project scope

WayFinder is a local-first research POC for explainable, trajectory-aware routing of VS Code language-model requests. The current implementation is **Gate 0** only: it tests whether one virtual VS Code model can select different local backends across agent-loop iterations while VS Code retains ownership of tool execution.

Do not implement later research gates opportunistically. In particular, do not add semantic phase inference, learned routing, autonomous editing, broad developer surveillance, or a replacement agent harness until Gate 0 has been run and its outcome recorded.

## Repository layout

- `extension/` — TypeScript VS Code extension.
- `extension/src/core/` — VS Code-independent routing and trace logic; keep this straightforward to unit test.
- `extension/src/provider/` — public VS Code language-model provider adapter.
- `extension/src/modeldeck/` — local ModelDeck OpenAI-compatible client only.
- `protocol/` — language-neutral JSON schemas.
- `docs/` — feasibility protocol and architecture decisions.

## Development

Use the workspace scripts from the repository root:

```bash
npm install
npm test
```

`npm test` compiles the extension and runs its Node tests. Run it after every TypeScript or configuration change. To exercise the extension manually, open the repository in VS Code and use the **Run WayFinder Extension** launch configuration.

Keep `module` and `moduleResolution` aligned in `extension/tsconfig.json`; use the supported `Node16` modes, not deprecated `node`/`node10` resolution or deprecation suppressions.

## Gate 0 conventions

- `WayFinder Auto` uses an intentionally small deterministic fixture; it is not a production routing policy.
- `WayFinder Fast` and `WayFinder Deep` must remain explicit, non-rerouted choices.
- Default to mock mode. ModelDeck use must stay local and configured through VS Code settings; never add a cloud inference dependency or hard-code model IDs, keys, or endpoints.
- Preserve VS Code's agent/tool loop. If the provider route proves insufficient, document the evidence before proposing a chat-participant fallback.
- Changes affecting the acceptance criteria in `docs/gate-0.md` must update that protocol and its schema together.

## Privacy and instrumentation

Research traces are append-only local JSONL metadata. Do not record prompts, arbitrary source contents, tool arguments or results, terminal output, environment variables, secrets, or credentials by default. Keep operational errors coarse and non-sensitive.

Maintain the distinction between observed data, deterministic derivations, model inferences, and routing-policy decisions. Explanations must be derived from structured evidence, not generated as post-hoc claims.

## Code quality

- Prefer small, explicit TypeScript changes with `strict` type checking.
- Add focused tests for changes to routing, trace shape, or ModelDeck request/response conversion.
- Validate JSON manifests and schemas when changing them.
- Follow existing error and cancellation handling; do not silently swallow backend failures.
- Use Australian English in documentation and user-facing copy, except for established APIs and identifiers.
- Do not create commits, branches, pull requests, or publish VSIX packages unless explicitly asked.

## Response quality

- Always use pwsh examples
- Always create pwsh terminal scripts