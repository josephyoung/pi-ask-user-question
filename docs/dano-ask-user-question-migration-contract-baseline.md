# Dano `ask_user_question` migration contract baseline

## Decision

The migration contract is frozen to these two immutable baselines:

- Dano: [`288171151096364d408e97f388e0bae683590a02`](https://github.com/zhengchengqiaobusiness-arch/Dano/commit/288171151096364d408e97f388e0bae683590a02)
- standalone extension: [`8080245573234f2b179e49f90fd0cd1208a6956d`](https://github.com/josephyoung/pi-ask-user-question/commit/8080245573234f2b179e49f90fd0cd1208a6956d)

“Full migration” means model-contract and user-workflow equivalence. TUI-native
layout, focus, navigation, and control rendering may differ from the browser.
Dano changes after the pinned commit do not silently enter this contract.

Every model-visible rule, answer-mapping rule, state transition, and safety
boundary below is portable. Browser RPC, Svelte/DOM rendering, same-origin URL
resolution, and responsive widgets are host implementations and must be
translated rather than copied.

One already-approved destination requirement is intentionally stronger than
the Dano baseline: an open confirmation or revision must remain actionable after
restarting and reopening the same Pi session. Dano persists the state, but then
transitions open state to `interrupted` after restart/inactive-session recovery.

## Baseline gap at a glance

At the standalone baseline, the extension already supports the basic field
types, grouped TUI forms, option-id answer mapping, remote search/pagination,
and one-pending-call enforcement. It does **not** yet provide the complete
pinned contract:

| Area | Standalone baseline | Required pinned behavior |
| --- | --- | --- |
| Runtime | Pi `^0.80.2`, tested with `0.80.6` | Align package and acceptance runtime to Dano's Pi `0.82.1` |
| Normalization | A smaller alias set with early ordinary exceptions | Dano's tolerant canonicalization plus path-addressed aggregate failures |
| Defaults | Required at runtime | Recommended canonically, but omitted defaults are accepted without prefill |
| `confirm:true` | Ordinary yes/no question | Confirmation of one or more submitted grouped forms only |
| Results | `answered` / `cancelled` | `answered` with grouped `formId`, `confirmed`, `cancelled`, and structured `invalid` |
| Submitted forms | No durable identity | Same-Assistant-Turn `formId` selection and authoritative answers |
| Revision | None | Persisted optimistic-concurrency state machine |
| Lifecycle | Pending-call guard only | Presentation acknowledgement, bounded validation/presentation retry, abort and terminal states |
| Field Assist | None | Generate/polish with isolation, limits, warnings, output validation, and bounded semantic retry |
| Remote auth | Model-visible `headers` and `cookies` | No model-visible credentials; keep CLI base URL as a host adaptation and design user-owned auth separately |

The baseline evidence is the extension's
[`createTool`](https://github.com/josephyoung/pi-ask-user-question/blob/8080245573234f2b179e49f90fd0cd1208a6956d/src/index.ts#L47-L92),
[`normalizeRequest`](https://github.com/josephyoung/pi-ask-user-question/blob/8080245573234f2b179e49f90fd0cd1208a6956d/src/normalize.ts#L57-L183),
and current result/data-source types
([`src/types.ts`](https://github.com/josephyoung/pi-ask-user-question/blob/8080245573234f2b179e49f90fd0cd1208a6956d/src/types.ts#L1-L88)).
Dano itself pins Pi `0.82.1`
([`apps/dano/package.json`](https://github.com/zhengchengqiaobusiness-arch/Dano/blob/288171151096364d408e97f388e0bae683590a02/apps/dano/package.json#L14-L23)).

## 1. Model-facing input contract

### Canonical calls

- Only one native `ask_user_question` call may be pending in an Assistant Turn.
  Several fields belong in one `questions` array and one grouped submission.
- A single field uses top-level field properties. A grouped form uses a concise
  top-level `title` and `questions[]`; every actual field property belongs in
  the matching item.
- Canonical non-confirmation fields carry a context-based, non-empty `default`.
  This is prompt guidance, not a hard compatibility requirement: the runtime
  accepts an omitted default and renders no prefill.
- `required` defaults to `false`; it controls whether an empty answer can be
  submitted, independently of the recommendation to provide a default.
- `fieldAssist` applies only to text controls. It defaults to `false` for a
  single-line `text` input and `true` for `textarea`.
- A date requires `inputType:"date"` and `dateFormat`. The accepted format must
  include year, month, and day; optional time must use 24-hour hour and minute;
  seconds and time zones are excluded. The submitted formatted string is
  returned unchanged.
- `confirm:true` is **not** an ordinary Boolean prompt. Without `questions`, it
  means “confirm previously submitted grouped forms”, canonically with
  `formIds:[...]`. An ordinary yes/no decision must use a normal choice field.

The exact model description/guidelines and result schema are in
[`ask-user-question.ts`](https://github.com/zhengchengqiaobusiness-arch/Dano/blob/288171151096364d408e97f388e0bae683590a02/apps/dano/src/bridge/ask-user-question.ts#L37-L180)
and the tool definition
([same file](https://github.com/zhengchengqiaobusiness-arch/Dano/blob/288171151096364d408e97f388e0bae683590a02/apps/dano/src/bridge/ask-user-question.ts#L2200-L2261)).
Date validation is shared code, not a widget accident
([`ask-user-question-date.ts`](https://github.com/zhengchengqiaobusiness-arch/Dano/blob/288171151096364d408e97f388e0bae683590a02/apps/dano/types/ask-user-question-date.ts#L1-L49)).

### Canonical field vocabulary

The normalized field vocabulary is:

- identity/text: `id`, `question`
- control: `inputType`, `multiple`, `required`
- value sources: `options`, `dataSource`
- text/date behavior: `fieldAssist`, `dateFormat`
- prefill: `default`

Supported normalized `inputType` values are `text`, `textarea`, `date`,
`radio`, `checkbox`, `select`, `treeSelect`, and confirmation's internal
`confirm`. Options normalize to `{id: string | number, label: string,
extra?: object}`. Data sources expose only:

`type`, `endpoint`, `method`, `params`, `searchParam`, `pageParam`,
`pageSizeParam`, `pageSize`, `resultPath`, `totalPath`, `idField`, `labelField`,
`childrenField`, and `extraFields`.

The normalized browser-neutral protocol types are defined in
[`protocol.ts`](https://github.com/zhengchengqiaobusiness-arch/Dano/blob/288171151096364d408e97f388e0bae683590a02/apps/dano/types/protocol.ts#L225-L402).

## 2. Compatibility normalization

Normalization is best-effort only while rendering, submission, and answer
identity remain unambiguous. It parses one JSON layer where specified, drops
unknown/inapplicable presentation hints, and never leaks raw compatibility
input into the canonical request.

### Accepted aliases and deviations

| Canonical field | Accepted compatibility input |
| --- | --- |
| whole request | object or one JSON-stringified object |
| `questions` | object, array, or one JSON-stringified object/array |
| `id` | `id`, `key`, `name`; finite scalar values become trimmed strings |
| `question` | `question`, `label`, `prompt`; an item may also use `title` |
| `inputType` | `inputType`, `input_type`, `type`, `component` |
| `options` | `options`, `choices`; native or one JSON-stringified array |
| `fieldAssist` | `fieldAssist`, `field_assist`, `aiAssist`, `ai_assist` |
| `dataSource` | `dataSource`, `data_source`; object or one JSON-stringified object |
| `multiple` | `multiple`, `multi`, `multipleSelect` |
| `default` | `default`, `defaultValue`, `prefill`, `value` |
| confirmation targets | `formIds` or `formId`; native array, JSON-stringified array, or scalar string |

Input type aliases collapse punctuation/case and include `multiline`/`longtext`,
`input`/`string`, `datepicker`, `multiselect`, `dropdown`, `boolean`, and the
canonical names. Boolean compatibility accepts booleans, `0`/`1`, common
English on/off forms, and Chinese enabled/disabled forms. `fieldAssist` also
treats any non-zero number as true and recognizes enable/disable variants.

Option compatibility accepts:

- non-empty strings;
- finite numbers, becoming numeric ids with string labels;
- booleans, becoming string choices;
- objects whose id aliases are `id`/`value`/`key` and label aliases are
  `label`/`text`/`name`; either side may supply the other when unambiguous;
- optional `extra` records.

For `id`, question text, `inputType`, options, data source, `multiple`, and
default, aliases that normalize to different values produce a
`conflicting_aliases` issue. `fieldAssist` is the exception: it uses the first
recognized alias value. Malformed aliases may be ignored when another alias
safely supplies the value. Options must form a non-empty, wholly valid,
typed-id-unique set; question ids must be non-empty and unique in grouped
forms. A one-item grouped form may inherit missing inner field values from
top-level compatibility fields. For multiple grouped fields, top-level field
configuration is ignored and only `title`, optional instruction text, and the
items remain.

Data-source normalization requires case-insensitive `type:"api"` and a
non-empty endpoint. `method` normalizes to `GET` or `POST` when valid and is
otherwise omitted. Numeric-string `pageSize >= 1`, scalar string fields, a
record `params`, and scalar-or-array `extraFields` are normalized; unknown
fields are dropped. A data source implies `select` only when no input type was
given and is usable only by `select`/`treeSelect` (including their multiple
form).

These rules are implemented in the compatibility pass and strict canonical
pass
([`ask-user-question.ts` lines 728–1514](https://github.com/zhengchengqiaobusiness-arch/Dano/blob/288171151096364d408e97f388e0bae683590a02/apps/dano/src/bridge/ask-user-question.ts#L728-L1514),
[`1523–1740`](https://github.com/zhengchengqiaobusiness-arch/Dano/blob/288171151096364d408e97f388e0bae683590a02/apps/dano/src/bridge/ask-user-question.ts#L1523-L1740)).

### Control inference and validation

Absent an explicit type, normalization infers `checkbox` from `multiple`,
`radio` from options, `select` from a data source, otherwise `text`.
`checkbox` or `multiple:true` becomes multi-answer; `select` and `treeSelect`
remain identity-preserving choice controls. Choice controls require static
options or a remote source. `dateFormat` and unrelated options/data sources do
not affect non-date/non-choice controls.

Defaults are normalized through the same answer mapper. For text, finite
numbers and booleans become strings. A date default must match its format.
Empty strings and invalid/ambiguous choices fail. Although canonical calls are
instructed to supply defaults, the actual runtime normalization does not set
`requireDefault`, so omission is accepted.

## 3. Answer and result contract

### Answer normalization

- Text is trimmed; optional empty text returns `""`, while required empty text
  fails.
- Date answers must be strings. Required empty dates fail; otherwise the
  submitted string is retained as-is.
- A single choice resolves in this order: exact typed id, unique stringified id,
  typed-key compatibility, unique label. Ambiguous ids/labels fail.
- With a literal `其他`/`Other` option, selecting that literal without content
  fails; one unmatched string becomes the custom answer. Multiple choice allows
  at most one custom answer, rejects duplicate typed ids, and lets an optional
  field submit `[]`.
- A grouped answer contains only supplied known field ids; omitted required
  fields fail and omitted optional fields are absent.

The answer mapper is in
[`ask-user-question.ts` lines 1741–2200](https://github.com/zhengchengqiaobusiness-arch/Dano/blob/288171151096364d408e97f388e0bae683590a02/apps/dano/src/bridge/ask-user-question.ts#L1741-L2200).

### Result shapes

The authoritative details payload is one of:

```ts
{ status: "answered", answer, formId? }
{ status: "confirmed", answer, confirmationOfToolCallId, forms }
{ status: "cancelled" }
{ status: "invalid", error }
```

- A single answer has no `formId`.
- A grouped submission returns `formId === toolCallId` and a keyed answer
  record.
- Confirmation returns every selected form as `{formId, answer}`. The legacy
  convenience fields `answer` and `confirmationOfToolCallId` mirror the first
  confirmed form.
- The model-facing text instructs continuation for `answered`/`confirmed` and
  an immediate stop with no retry after cancellation.
- Runtime invalidity is serialized as the JSON `invalid` shape inside the
  thrown tool error, so Pi still exposes the same structured contract to the
  model.

Coordinator result construction and submitted-form ownership are in
[`ask-user-question.ts` lines 274–568](https://github.com/zhengchengqiaobusiness-arch/Dano/blob/288171151096364d408e97f388e0bae683590a02/apps/dano/src/bridge/ask-user-question.ts#L274-L568).

## 4. Structured failures and lifecycle

Every invalid result contains:

```ts
{
  status: "invalid",
  error: {
    code,
    category,
    message,
    retryable,
    issues: [{ code, path?, message }],
    sourceCode?,
    terminalCode?,
    context?
  }
}
```

Categories are `validation`, `confirmation`, `duplicate_call`, and
`lifecycle`. Top-level codes are:

- `invalid_question_arguments`
- `invalid_confirmation_source`
- `duplicate_question_call`
- `question_presentation_timeout`
- `question_presentation_failed`
- `question_validation_failed`
- `question_cancelled`

Issue codes are `invalid_request_shape`, `invalid_questions_json`,
`invalid_questions_shape`, `invalid_question_item`, `conflicting_aliases`,
`missing_question_id`, `duplicate_question_id`, `missing_question_text`,
`invalid_input_type`, `invalid_options`, `duplicate_option_id`,
`missing_choice_source`, `invalid_default`, `invalid_date_format`,
`invalid_data_source`, `invalid_confirmation_target`, `duplicate_tool_call`,
`presentation_timeout`, `presentation_failed`, `validation_retry_exhausted`,
and `cancelled`.

Independent field problems are aggregated in one result with precise paths.
Failure serialization excludes raw arguments, submitted answers, unavailable
form ids, scripts, and stacks. User-facing presentation receives only a
sanitized `{code, category, message, retryable}` projection; detailed issues
remain model-facing. The definitions and privacy boundary are in
[`protocol.ts`](https://github.com/zhengchengqiaobusiness-arch/Dano/blob/288171151096364d408e97f388e0bae683590a02/apps/dano/types/protocol.ts#L137-L225)
and
[`ask-user-question-errors.ts`](https://github.com/zhengchengqiaobusiness-arch/Dano/blob/288171151096364d408e97f388e0bae683590a02/apps/dano/src/bridge/ask-user-question-errors.ts#L1-L142).

Lifecycle behavior:

1. Accepted input enters `awaiting_presentation`.
2. The host must acknowledge actual presentation; acknowledgement is
   idempotent and enters `presented`.
3. Failure to present within 5 seconds is retryable until the configured
   per-Assistant-Turn retry budget is exhausted, then terminal.
4. Invalid calls use a separate per-Assistant-Turn retry counter and become
   `question_validation_failed` after the budget.
5. A second pending call in the same Assistant Turn is retryable invalid input;
   the replacement must combine fields into one call.
6. Abort/cancel is non-retryable and stops the workflow.
7. Completion cleans pending state. The tool declares sequential execution.

The coordinator counters are keyed by the Assistant Turn's `AbortSignal`, which
also scopes submitted-form eligibility
([`ask-user-question.ts` lines 274–671](https://github.com/zhengchengqiaobusiness-arch/Dano/blob/288171151096364d408e97f388e0bae683590a02/apps/dano/src/bridge/ask-user-question.ts#L274-L671)).

## 5. Submitted forms, confirmation, and revision

### Submitted-form identity and target selection

Only successfully submitted grouped forms are confirmation sources. They are
stored under the current Assistant Turn signal, so a form from another turn is
ineligible. Canonical confirmation names one or more returned ids:

```json
{"confirm":true,"formIds":["<formId>"]}
```

Target selection trims ids, preserves first-seen order, deduplicates, accepts
the `formId` alias and JSON-stringified arrays, and keeps every available target
from a partially valid list. If no requested target is available, it attempts
the latest eligible submitted form. If no eligible form exists, it returns
`invalid_confirmation_source` without exposing unavailable ids. Successful or
cancelled confirmation consumes the selected submitted forms.

Selection and the compatibility fallback are in
[`ask-user-question.ts` lines 1064–1250](https://github.com/zhengchengqiaobusiness-arch/Dano/blob/288171151096364d408e97f388e0bae683590a02/apps/dano/src/bridge/ask-user-question.ts#L1064-L1250).

### Persistent interaction state machine

The confirmation interaction is separate from the model result lifecycle and
is persisted as append-only Pi Session custom entries named
`dano.form-interaction.v1`.

| State | Allowed action | Next state | Revision effect |
| --- | --- | --- | --- |
| `awaiting_confirmation` | confirm | `confirmed` | interaction +1 |
| `awaiting_confirmation` | cancel | `cancelled` | interaction +1 |
| `awaiting_confirmation` | return to modify | `revising` | interaction +1; every form +1 |
| `revising` | save revision | `awaiting_confirmation` | interaction +1; answers replaced, form revision retained |
| `revising` | cancel revision | `awaiting_confirmation` | interaction +1; authoritative answers retained |
| open state | interrupt | `interrupted` | interaction +1 |

Terminal states expose no actions. Each projection includes `interactionId`,
state, interaction revision, allowed actions, and forms with their own revision,
questions, and authoritative answers. Replaying entries selects the highest
revision for each interaction and can reconstruct the confirmation card even
when the original browser projection is missing.

Every mutating command carries `expectedRevision`. Missing/stale revisions,
invalid transitions, and already-terminal requests fail with the authoritative
projection. Repeated return/cancel-revision and identical revision submission
have narrow idempotent-success cases; a competing different answer remains a
stale-revision failure.

The state machine and persistence format are in
[`form-interaction.ts`](https://github.com/zhengchengqiaobusiness-arch/Dano/blob/288171151096364d408e97f388e0bae683590a02/apps/dano/src/bridge/form-interaction.ts#L1-L410),
with concurrency enforcement in
[`bridge-rpc-adapter.ts`](https://github.com/zhengchengqiaobusiness-arch/Dano/blob/288171151096364d408e97f388e0bae683590a02/apps/dano/src/bridge/bridge-rpc-adapter.ts#L6220-L6305)
and
[`bridge-rpc-adapter.ts` command handling](https://github.com/zhengchengqiaobusiness-arch/Dano/blob/288171151096364d408e97f388e0bae683590a02/apps/dano/src/bridge/bridge-rpc-adapter.ts#L6670-L6925).

### Recovery boundary

Dano persists enough information to reload a `revising` or
`awaiting_confirmation` snapshot, but it deliberately interrupts open
interactions when a stored session is reopened after restart, on abort, or
after tree branching/navigation. It then reconstructs a read-only interrupted
card. Submitted-form eligibility is even shorter-lived: the coordinator holds
it in an in-process `WeakMap` keyed by the Assistant Turn's `AbortSignal`; the
tool call/result remain in JSONL for projection, but the eligible coordinator
registry and pending tool promise do not survive process exit.

The restart-to-interrupted behavior is an explicit first-party regression case
([`form-interaction.test.ts`](https://github.com/zhengchengqiaobusiness-arch/Dano/blob/288171151096364d408e97f388e0bae683590a02/apps/dano/src/bridge/__tests__/form-interaction.test.ts#L113-L134))
and inactive stored-session selection invokes the same transition
([`bridge-rpc-adapter.ts`](https://github.com/zhengchengqiaobusiness-arch/Dano/blob/288171151096364d408e97f388e0bae683590a02/apps/dano/src/bridge/bridge-rpc-adapter.ts#L3886-L3903)).

Therefore the destination requirement to continue after process restart must
reuse the persisted interaction schema **and** add two pieces absent from Dano:

1. reconstruct durable submitted-form eligibility from authoritative session
   entries; and
2. define how a restored confirmation completes or resumes model execution when
   the original pending tool promise and Assistant Turn no longer exist.

This is not literal Dano equivalence and must be resolved as a separate design
decision before implementation slicing.

## 6. Field Assist contract

Field Assist is available only for text fields when `fieldAssist` is true. It
supports `regenerate` and `polish` with payload fields `requestId`, action,
`fieldType` (`input`/`textarea`), `requestMethod` (`input`/`editor`), title,
optional placeholder, current value, and optional prefill. The result is
`{value, metadata}`; metadata records action, type, input/output length, elapsed
time, model, and optional warnings.

Required product behavior:

- `polish` rejects empty input. Current input is capped at 2,000 characters for
  single-line input and 12,000 for textarea.
- Obvious credential content in the current value is rejected before a model
  call. Sensitive-looking title/placeholder/prefill emits a
  `SENSITIVE_FIELD` warning but does not block.
- Output is whitespace-normalized and capped at 240/3,000 characters.
- Follow-up questions/tool requests, empty or punctuation-only polish,
  polish that adds guarded specific facts to very short input, and regenerate
  output equal to current value/prefill are semantic-invalid outputs.
- Only semantic `INVALID_MODEL_OUTPUT` is retried by the product layer, up to
  `1 + maxRetries` attempts (default `maxRetries` is 10). Provider retry remains
  Pi-owned. Each provider attempt defaults to a 60-second deadline.
- Errors distinguish empty input, disabled/not allowed, oversized request,
  unavailable model, timeout, abort, invalid output, rate limit, and internal
  failure.
- Concurrent field runs are isolated; stale completion is ignored, controls are
  disabled/read-only while running, and failure preserves the previous value.

The complete service rules are in
[`field-assist.ts`](https://github.com/zhengchengqiaobusiness-arch/Dano/blob/288171151096364d408e97f388e0bae683590a02/apps/dano/src/bridge/field-assist.ts#L1-L427),
and the field-level concurrency/preservation behavior is in
[`QuestionToolCard.svelte`](https://github.com/zhengchengqiaobusiness-arch/Dano/blob/288171151096364d408e97f388e0bae683590a02/apps/dano/web/src/components/QuestionToolCard.svelte#L490-L620).

Dano calls its current session's `ModelRuntime` directly. The standalone
extension must translate that host seam without changing the product behavior.
No Pi upstream change is required: the public-SDK pattern demonstrated by
`pi-btw` creates an in-memory sub-session with the current model and
`ctx.modelRegistry`, and its no-tool summarizer uses `thinkingLevel:"off"`,
`tools:[]`, a ResourceLoader that returns no extensions/skills/prompts, followed
by abort/dispose
([`pi-btw` resource isolation](https://github.com/dbachelder/pi-btw/blob/4f858102706910ee9d520a9666832f3103631b61/extensions/btw.ts#L172-L191),
[`pi-btw` isolated session](https://github.com/dbachelder/pi-btw/blob/4f858102706910ee9d520a9666832f3103631b61/extensions/btw.ts#L2149-L2187)).
The migration should apply that pattern to each bounded Field Assist request so
it reuses Pi authentication/model selection, does not recursively load this
extension, and does not pollute the main transcript.

## 7. Remote-data contract

The model-visible source describes request/query and response mapping, never
credentials. Runtime behavior is:

1. Default `method` is `GET`, default `pageSize` is 20, and default option
   fields are `id`, `label`, and `children`.
2. `params` is copied; non-empty search and configured page/page-size values are
   added under their configured parameter names.
3. GET adds non-null values as URL query strings. POST sends JSON with
   `content-type: application/json`.
4. `resultPath` and `totalPath` are dot-separated object paths. Non-array result
   data produces no options in Dano's browser renderer; numeric total controls
   pagination, otherwise a full page implies “has more”.
5. Rows without string/number ids and labels are skipped. `extraFields` are
   copied into option metadata. Tree children are depth-first flattened for
   display while preserving stable ids.
6. Static and remote options merge by typed id. A selected remote option is
   retained across replacement searches. Stale request sequences cannot replace
   newer results.
7. The first page loads automatically. Remote single-select search is debounced
   by 300 ms and supports clear, keyboard selection, retry, and load-more.
   Multiple remote choice has explicit search/retry/load-more behavior.
   Submission returns ids, never labels.

The browser fetch and mapping algorithm is in
[`QuestionToolCard.svelte`](https://github.com/zhengchengqiaobusiness-arch/Dano/blob/288171151096364d408e97f388e0bae683590a02/apps/dano/web/src/components/QuestionToolCard.svelte#L653-L802),
and combobox behavior in
[`QuestionRemoteCombobox.svelte`](https://github.com/zhengchengqiaobusiness-arch/Dano/blob/288171151096364d408e97f388e0bae683590a02/apps/dano/web/src/components/QuestionRemoteCombobox.svelte#L1-L135).

Dano resolves `endpoint` against `window.location.origin` and rejects a
different origin. That is a browser security boundary, not a portable URL
default. The CLI migration therefore keeps the existing
`dataSourceBaseUrl` host adaptation for relative endpoints, removes
`dataSource.headers` and `dataSource.cookies` from model-visible input, and
places any needed authentication in a separately designed user-owned
configuration boundary. The baseline extension currently exposes all three
model-side additions
([`src/contract.ts`](https://github.com/josephyoung/pi-ask-user-question/blob/8080245573234f2b179e49f90fd0cd1208a6956d/src/contract.ts#L17-L55)).

## 8. Browser-host behaviors to translate, not copy

| Dano browser implementation | TUI-equivalent requirement |
| --- | --- |
| WebSocket/RPC `present_question` after Svelte mount | Acknowledge only after the TUI interaction is actually installed and visible |
| 400 ms DOM delay hiding transient retry cards | Avoid transient invalid UI without delaying durable TUI interaction unnecessarily |
| Svelte card, DOM focus callback, ARIA live/busy state | One focused native TUI surface with equivalent actionable/non-actionable states |
| Desktop calendar popover and mobile native date input | Native TUI date/date-time entry that enforces the same format and returns the same string |
| Browser combobox/popover and responsive CSS | TUI search, keyboard selection, clear, retry, pagination, tree indentation, and disabled/read-only states |
| `window.location.origin` plus browser session cookies | Explicit CLI base URL plus a user-owned credential boundary outside tool arguments/transcript |
| Browser transcript projector and Svelte result cards | Pi session custom entries plus TUI result rendering/recovery using authoritative projections |
| Direct current-session `ModelRuntime` | Isolated in-memory Pi sub-session using current model/registry, no tools/extensions, abort/dispose |
| Browser-generated friendly error summaries | Sanitized TUI error summary while retaining full structured issues for the model |

Visual pixel parity, DOM attributes, CSS geometry, popover placement, and mobile
breakpoints are out of the migration contract. Answer identity, validation,
warnings, disabled/actionable state, focus ownership, persistence, concurrency,
and recovery semantics are in it. Dano's browser interaction logic that marks
submitted controls read-only and renders confirmation/revision actions is
visible in
[`QuestionToolCard.svelte`](https://github.com/zhengchengqiaobusiness-arch/Dano/blob/288171151096364d408e97f388e0bae683590a02/apps/dano/web/src/components/QuestionToolCard.svelte#L120-L460)
and its submitted/confirmation presentation
([same component](https://github.com/zhengchengqiaobusiness-arch/Dano/blob/288171151096364d408e97f388e0bae683590a02/apps/dano/web/src/components/QuestionToolCard.svelte#L815-L1210)).

## 9. Implementation seams implied by the contract

This research does not implement the migration, but it fixes the seams that a
later implementation must honor:

1. **Portable contract core:** TypeBox schema, compatibility normalization,
   structured failures, answer normalization, and model-facing result text.
2. **Form domain state:** submitted-form registry, confirmation target
   selection, persistent interaction snapshots, optimistic concurrency, and
   restart-continuation policy.
3. **TUI adapter:** field controls, actual-presentation acknowledgement, focus,
   revision/confirmation actions, and read-only result rendering.
4. **Host services:** remote URL/auth resolution and isolated Field Assist.

The portable contract and Field Assist migration are feasible without modifying
Pi upstream. The remaining route decision is the cross-process resumption
protocol described above. The two places where literal copying would be
incorrect are remote-data browser same-origin/auth behavior and Dano's
restart-to-`interrupted` lifecycle policy.
