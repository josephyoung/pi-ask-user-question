# Pi 0.82.1 migration boundary

This note freezes the public Pi capabilities and constraints relevant to migrating the independent `ask_user_question` extension. It is based on the exact npm artifacts for `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `@earendil-works/pi-agent-core`, and `@earendil-works/pi-ai` version `0.82.1`, plus the public `pi-btw` implementation at commit `9b7819ab1c21d4b7edc28d618e8d84ed4defb53d`.

## Decision summary

Pi 0.82.1 can carry the migrated contract, sequential tool execution, Pi-native TUI, session-journal snapshots, branch-aware restoration, and an isolated Field Assist session without changing Pi upstream. The migration should use the following public seams:

- `prepareArguments` for Dano-compatible tolerant normalization before TypeBox validation;
- `executionMode: "sequential"` for the one-question-form-at-a-time contract;
- `pi.appendEntry` plus `pi.registerEntryRenderer` for non-LLM session state and read-only presentation;
- the active branch returned by `ctx.sessionManager` for restoration;
- `createAgentSession`, `SessionManager.inMemory`, a minimal `DefaultResourceLoader`, `tools: []`, `AgentSession.abort`, and `AgentSession.dispose` for Field Assist;
- an exact Pi 0.82.1 installed artifact in the real PTY acceptance gate.

Two constraints must remain visible in later decisions:

1. `ExtensionContext` exposes the current `model`, a compatibility `ModelRegistry`, and an abort signal, but not the current `ModelRuntime`. In 0.82.1, `createAgentSession` accepts `modelRuntime`, not `modelRegistry`. If the caller omits it, Pi creates a new runtime from persisted `auth.json` and `models.json`. An isolated session therefore reuses normal persisted credentials, but it cannot be assumed to inherit an ephemeral CLI `--api-key`, runtime-only provider registrations, or other authentication overrides owned only by the main runtime.
2. Custom entries can reconstruct extension state after restart, but they cannot resurrect an already-settled JavaScript promise or resume the original Agent tool execution. Cross-process continuation of a pending confirmation or revision is an extension-level workflow enhancement that must define both state eligibility and how the model execution continues.

## Contract preparation and execution ordering

Pi 0.82.1's public `ToolDefinition` includes `prepareArguments(args: unknown)`, explicitly documented as a compatibility shim that runs before schema validation. This is the correct seam for Dano's wide-entry, canonical-output normalization. The returned object remains subject to the declared TypeBox schema, so irrecoverable inputs still fail at the public contract boundary.

The same public definition includes `executionMode`. Setting it to `"sequential"` gives the question tool the Dano ordering policy instead of relying on an internal pending lock while the tool remains globally parallel.

Sources:

- [Pi 0.82.1 extension tool types](https://github.com/earendil-works/pi/blob/v0.82.1/packages/coding-agent/src/core/extensions/types.ts)
- [Pi 0.82.1 extension tool wrapper](https://github.com/earendil-works/pi/blob/v0.82.1/packages/coding-agent/src/core/extensions/wrapper.ts)

## Session persistence and rendering

`ExtensionAPI.appendEntry(customType, data)` writes a `CustomEntry` that is excluded from LLM context. `registerEntryRenderer` supplies its Pi-native read-only rendering. The session manager exposes entries and the active leaf, so restoration must reduce only the active branch rather than scanning unrelated abandoned branches.

This supports immutable snapshots for Submitted Form identity, answers, revision, allowed actions, and terminal state. A later snapshot with the same interaction identity supersedes an earlier one. The reducer must treat malformed or unknown-version entries as non-fatal diagnostics and fail closed for actions.

This mechanism proves durable state, not durable tool execution. On process restart there is no original pending `execute()` promise. A restored TUI action must therefore either start a new explicit tool/command continuation or record a result that the next Agent turn can consume; that choice belongs to the persistence decision ticket.

Sources:

- [Pi 0.82.1 extension API and context types](https://github.com/earendil-works/pi/blob/v0.82.1/packages/coding-agent/src/core/extensions/types.ts)
- [Pi 0.82.1 session manager](https://github.com/earendil-works/pi/blob/v0.82.1/packages/coding-agent/src/core/session-manager.ts)
- [Pi 0.82.1 session context projection](https://github.com/earendil-works/pi/blob/v0.82.1/packages/coding-agent/src/core/session-manager.ts)

## Field Assist isolation

The public SDK exports `createAgentSession`, `SessionManager.inMemory`, `DefaultResourceLoader`, and `AgentSession`. A Field Assist session can be created with:

- `model: ctx.model`;
- `thinkingLevel: "off"`;
- `tools: []`;
- `SessionManager.inMemory(ctx.cwd)`;
- a resource loader with extensions, skills, prompt templates, themes, and context files disabled;
- the same cwd only for stable SDK defaults, not project discovery.

The tool's abort signal and its own timeout must both call `session.abort()`. `session.dispose()` must run in `finally`, including failed creation, invalid output, timeout, and caller abort paths. The final assistant text is read only after `prompt()` settles; no sub-session message is appended to the main session.

`pi-btw` is primary implementation evidence for the isolated-session shape: it uses an in-memory journal, a separate resource loader, `createAgentSession`, explicit abort, and a private sub-session. Field Assist must be stricter than `pi-btw`: no copied main history, no tools, no project resources, and a single bounded request.

### Authentication boundary

Pi 0.82.1 changed the SDK runtime input from the 0.80.x `modelRegistry` option to `modelRuntime`. `ExtensionContext` does not expose that current runtime. Omitting `modelRuntime` invokes Pi's service creation path, which constructs one from the configured agent directory. Consequently:

- persisted provider credentials and model configuration are supported;
- an unavailable current model must return a structured Field Assist error;
- an ephemeral main-runtime API key or runtime-only provider must return a clear unavailable/authentication error rather than silently using another model;
- strict inheritance of every main-runtime authentication mode would require an upstream API and is outside this migration.

Sources:

- [Pi 0.82.1 SDK session options](https://github.com/earendil-works/pi/blob/v0.82.1/packages/coding-agent/src/core/sdk.ts)
- [Pi 0.82.1 session services](https://github.com/earendil-works/pi/blob/v0.82.1/packages/coding-agent/src/core/agent-session-services.ts)
- [Pi 0.82.1 model runtime](https://github.com/earendil-works/pi/blob/v0.82.1/packages/coding-agent/src/core/model-runtime.ts)
- [`pi-btw` isolated session implementation](https://github.com/L2ncE/pi-btw/blob/9b7819ab1c21d4b7edc28d618e8d84ed4defb53d/extensions/btw.ts)

## Resource isolation

`DefaultResourceLoader` accepts independent switches for extensions, skills, prompt templates, themes, and context files. Field Assist must disable all five. Disabling only tools is insufficient because loading this extension recursively could register behavior or prompts in the child session.

The minimal system prompt should contain only the generation or polishing instruction and the safety/output constraints. It must not inherit the main Agent transcript, project AGENTS files, skills, or append prompts.

Source: [Pi 0.82.1 resource loader](https://github.com/earendil-works/pi/blob/v0.82.1/packages/coding-agent/src/core/resource-loader.ts)

## Package and runtime alignment

The published 0.82.1 coding-agent package declares Node `>=22.19.0` and depends on the sibling Earendil Pi packages with `^0.82.1` ranges. The extension migration target is:

- peer dependency `@earendil-works/pi-coding-agent: ^0.82.1`;
- development dependencies pinned to `0.82.1` for coding-agent and TUI;
- TypeBox and related public types resolved consistently with that artifact;
- no Pi 0.80.x compatibility lane.

The repository's release gate must install the exact package source under test into isolated Pi and project state. Unit tests against imported types do not prove that the published extension loads or that custom TUI input works.

Sources:

- [`@earendil-works/pi-coding-agent@0.82.1` package manifest](https://github.com/earendil-works/pi/blob/v0.82.1/packages/coding-agent/package.json)
- [Repository E2E requirements](./e2e-test-requirements.md)

## Required acceptance evidence

The migration specification should require all of the following on the exact Pi 0.82.1 artifact:

1. tolerant raw arguments are normalized before schema validation and irrecoverable input returns the Dano-compatible structured error;
2. concurrent question calls execute sequentially;
3. Submitted Form snapshots restore from the active session branch and render read-only without entering LLM context;
4. stale revision actions are rejected and a same-process confirmation settles exactly once;
5. the chosen cross-process continuation protocol works after a real Pi process exit and session resume;
6. Field Assist uses no tools or discovered resources, leaves the main transcript unchanged, and handles no-model, persisted-auth failure, timeout, retry, abort, invalid output, credentials, and length bounds;
7. the existing grouped form, date, remote pagination/tree selection, cancellation, and Agent-continuation PTY scenarios remain green;
8. typecheck, unit tests, the complete real Pi PTY suite, and exact-package-source acceptance exit successfully.

## Consequence for the Wayfinder frontier

The Pi platform itself does not block the migration. Later tickets must decide:

- the user-owned remote-data authentication configuration;
- the cross-process continuation protocol for restored Submitted Forms;
- the exact TUI confirmation/revision workflow;
- Field Assist behavior when current-runtime-only authentication cannot be inherited;
- module boundaries and verification order.
