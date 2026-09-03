# Dano `ask_user_question` full migration specification

Status: approved for implementation

## Fixed baselines

- Dano behavior: `288171151096364d408e97f388e0bae683590a02`.
- Standalone starting point: `8080245573234f2b179e49f90fd0cd1208a6956d`.
- Supported Pi runtime: peer `^0.82.1`; development and acceptance use exact `0.82.1`; Pi 0.80.x is unsupported.
- Full migration means model-contract and user-workflow equivalence. Pi-native TUI layout, focus, navigation, and controls may differ from Dano's browser UI.
- No Pi upstream change is allowed.

## Public product contract

The extension keeps one-step installation and registers one sequential tool:

```ts
export function installAskUserQuestion(pi: ExtensionAPI): void;
```

The tool uses Pi 0.82.1 `prepareArguments` before TypeBox validation and declares `executionMode: "sequential"`.

The model-visible schema follows the pinned Dano contract, with only `dataSourceBaseUrl` added for the CLI environment. It does not expose remote request headers, cookies, credential profiles, environment variable names, or Field Assist model configuration.

`confirm:true` means confirmation of previously submitted grouped forms when canonically selected by `formIds`. Ordinary yes/no questions use a normal choice field. For backward compatibility, top-level `question + confirm:true` without `formId` or `formIds` remains an ordinary boolean confirmation.

Result details are:

```ts
type QuestionResult =
  | { status: "answered"; answer: Answer | Record<string, Answer>; formId?: string }
  | { status: "confirmed"; answer: Record<string, Answer>; confirmationOfToolCallId: string; forms: SubmittedFormResult[] }
  | { status: "cancelled" }
  | { status: "invalid"; error: StructuredQuestionError };
```

Grouped success sets `formId` to the grouped tool call id. Invalid calls preserve Dano's category/code/retryable/issues structure and aggregate independent path-addressed issues. User-visible errors receive only a sanitized projection.

## Module architecture

The default consumer sees only installation. A deep Durable question application owns compatibility preparation, live execution, and active-branch recovery:

```ts
interface DurableQuestionInteractionApplication {
  prepareArguments(raw: unknown): CanonicalArguments;
  execute(invocation: QuestionToolInvocation): Promise<QuestionToolResult>;
  recoverCurrentBranch(scope: RecoveryScope): Promise<RecoveryOutcome>;
}
```

The implementation contains a pure interaction reducer. Pi registration and event handlers are mechanical adapters and do not own business transitions, retries, credentials, or recovery policy.

The following are real internal seams with production and deterministic test adapters:

- `InteractionJournal`: Pi custom entries / in-memory active-branch journal.
- `QuestionSurface`: Pi TUI / scripted surface.
- `ContinuationSink`: visible Pi message / recording sink.
- `DataSourceCredentialResolver`: agent-directory configuration and process environment / in-memory rules.
- `RemoteOptionTransport`: fetch / controlled HTTP adapter.
- `FieldAssistModel`: isolated Pi child session / scripted model.

The package also exposes a public Question capability registry for additional field kinds. A capability must have a namespaced kind, schema version, canonical compiler, pure state transition and validation, projection, and serializable state. Missing or incompatible capability versions restore read-only and fail closed for mutations. Capabilities cannot replace authentication, journal persistence, branch recovery, continuation delivery, lifecycle safety, or Field Assist isolation policy.

## Interaction and persistence invariants

- Raw compatibility aliases and one-level JSON strings exist only before canonicalization.
- At most one nonterminal interaction exists on an active branch.
- `formId` is the original grouped tool call id; `interactionId` is a separate stable identity.
- Every mutating action carries `expectedRevision`; stale actions make no change and return the latest authoritative projection.
- Revision drafts do not alter canonical Submitted Form answers until explicit save. Cancelling revision restores the prior canonical answers.
- Interaction and form revisions increase monotonically. Terminal states are read-only.
- Each transition appends a versioned custom-entry snapshot. Active-branch replay chooses the highest valid revision for each interaction.
- Unknown versions or malformed entries do not break session loading, but cannot become actionable.
- Same-process completion settles the original tool execution exactly once and only after its terminal snapshot is appended.
- Cross-process recovery never fabricates an old `tool_result` or revives an old promise. It reopens only nonterminal UI. Completion appends a terminal snapshot, then uses the durable visible `custom_message` itself as the stable continuation marker and Agent-turn trigger. A separate pre-delivery marker is forbidden because it could suppress replay after a crash between marking and delivery.
- Branches are independent; abandoned-branch state is neither selected nor mutated.

## Form confirmation and revision TUI

- Show one complete read-only card containing all selected Submitted Forms.
- Actions are Confirm all, Return to modify, and Cancel.
- Return to modify opens a draft while keeping canonical answers unchanged.
- Save increments the revision and returns to the complete confirmation card.
- Cancel revision discards the draft and returns to the same canonical card.
- Confirm is unavailable while a draft is unsaved.
- A stale action is rejected in place and refreshes to the latest projection.
- Restart restores `awaiting_confirmation` or `revising`; terminal interactions render read-only.

## Remote data authentication

The Pi agent user directory contains rules keyed by normalized HTTPS origin and optional path prefix. The longest matching prefix wins. A rule stores only environment variable names; values are read from the current process at request time.

- The model cannot select a rule or provide credentials.
- No rule means an unauthenticated request; there is no fallback credential.
- Authenticated HTTP is allowed only for loopback development.
- Redirect handling is manual. Credentials never cross an origin, and an authenticated cross-origin redirect fails.
- Credential values, env names, request headers/cookies, raw bodies, and unavailable form ids never enter tool arguments, journal snapshots, results, errors, logs, or the Agent transcript.
- Search, pagination, tree mapping, typed ids, selected-option retention, stale response suppression, and field-local retry remain part of the core workflow.

## Field Assist

Field Assist is available only for text fields. It defaults off for single-line text and on for textarea. Generate and Polish are separate explicit actions.

- Preserve the previous value until validated output succeeds; every failure or abort retains/restores it and leaves the form open.
- Potentially sensitive title/placeholder/prefill metadata produces a visible warning. Obvious credential content is rejected before a child session is created.
- Input limits are 2,000 characters for single-line and 12,000 for textarea. Output limits are 240 and 3,000 characters.
- Each model attempt has a 60 second timeout. Only invalid semantic output is retried, up to 10 additional attempts.
- Generation cannot repeat current/prefill content. Polish cannot be punctuation/whitespace-only, ask follow-up questions, or introduce concrete facts absent from the source.
- Use `createAgentSession`, `SessionManager.inMemory`, the current `ctx.model`, `thinkingLevel:"off"`, `tools:[]`, and a ResourceLoader that disables extensions, skills, prompt templates, themes, and context files.
- Parent abort and Field Assist cancellation call child `abort`; all paths call `dispose` in `finally`.
- Child prompts and output never enter the main transcript or main journal.
- Persisted provider authentication may be reused. If the current model depends only on an ephemeral CLI key or runtime-only provider, report model/auth unavailable without switching models.

## Implementation slices

Each slice replaces its predecessor immediately; the repository must not retain parallel orchestrators.

1. Upgrade runtime/package types to Pi 0.82.1 and establish the Durable question application plus public capability registry.
2. Port compatibility normalization, canonical schema, answer mapping, structured errors, result shapes, `prepareArguments`, and sequential execution.
3. Move current form behavior behind the application and pure reducer; preserve existing text/date/static/remote workflows.
4. Add append-only Submitted Form journal, identities, revision state, active-branch replay, and read-only renderer.
5. Add same-process confirmation/revision, restart recovery, stable continuation markers, and Recovered continuation.
6. Replace model-visible remote credentials with the agent-directory resolver and protected transport.
7. Add Field Assist preflight/validation, isolated-session adapter, and field-level TUI states.
8. Remove superseded pending/presentation/direct-fetch paths and complete documentation/package cleanup.

## TDD seams

Tests are written before each slice through these approved interfaces:

1. Compatibility fixtures call the registered tool's `prepareArguments` and `execute`, not private normalization helpers.
2. Durable interaction tests use the application with scripted surface and in-memory journal/continuation adapters.
3. Capability contract tests register a versioned sample field and prove live submit, snapshot, recovery, missing-version read-only behavior, and mutation fail-closed.
4. Remote tests use a controlled HTTP server plus in-memory credential rules/environment and assert received requests and sanitized failures.
5. Field Assist tests use a scripted model adapter; SDK isolation is proven separately through a real Pi process.
6. TUI behavior is ultimately proven through the real Pi CLI PTY, not direct component calls alone.

## Completion gates

All gates are required; a narrower check cannot substitute for a broader one.

### Static and deterministic tests

```sh
npm run typecheck
npm test
```

The suite must cover:

- pinned Dano compatibility fixtures, aggregate errors, aliases, omitted defaults, result text/details, and ordinary-confirm rejection;
- field types, defaults, typed ids, Other, dates, grouped atomicity, cancellation, abort races, presentation acknowledgement, retry budgets, and sequential calls;
- Submitted Form selection/consumption, revision transitions, stale writes, idempotency, active-branch replay, malformed/unknown entries, exactly-once settlement, and continuation deduplication;
- capability registration, versioned state, missing capability recovery, and protected host policies;
- credential longest-prefix matching, request-time env lookup, anonymous fallback, loopback HTTP, same-origin redirect, cross-origin refusal, and secret-free errors/journal/transcript;
- Field Assist defaults, warning/rejection, limits, output normalization/validation, bounded retry, model unavailable, timeout, abort, disposal, and main-session isolation.

### Controlled remote scenario

Run `npm run mock:api` and the documented search, pagination, tree-selection, selected-label, canonical-id, retry, and authentication scenarios. The test must inspect the mock server's received requests to prove credentials are applied only by the user-owned resolver.

### Real Pi 0.82.1 PTY

The acceptance suite must launch the real `pi` executable in an interactive PTY with isolated Pi/project state and no global extensions or project context. It must drive real keys and prove:

- the complete existing core matrix in `docs/e2e-test-requirements.md`;
- compatibility preparation before TypeBox validation and structured retry;
- sequential duplicate-call behavior and presentation acknowledgement;
- Submitted Form confirmation, return/save/cancel revision, stale revision handling, and read-only terminal rendering;
- actual process exit followed by same-session resume, automatic nonterminal reopening, new visible continuation, and no synthetic old result;
- remote auth/search/pagination/tree behavior;
- Field Assist success, invalid-output retry, credential rejection, timeout/abort, child cleanup, current-model failure, and unchanged main transcript;
- clean continuation and process exit code `0`.

### Package artifact

Create an npm tarball without publishing. Install that exact tarball into isolated acceptance state by setting `PI_ACCEPTANCE_PACKAGE_SOURCE`, rerun the complete real Pi suite, inspect tarball contents, and prove the supported runtime metadata is Pi `^0.82.1` with exact development/acceptance `0.82.1`.

No npm publish, version bump, tag, or release is part of this migration unless separately authorized.

## Completion definition

The migration is complete only when every implementation slice is present, old incompatible paths are absent, every gate above passes from the current branch and exact tarball, a Standards and Spec code review has no unresolved finding, and the completed work is committed. Publishing remains out of scope.
