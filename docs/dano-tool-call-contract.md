# Dano `ask_user_question` contract baseline

This package targets Dano commit `288171151096364d408e97f388e0bae683590a02`.
The executable snapshot in `test/contract.test.ts` is the authoritative
model-facing contract. `docs/dano-full-migration-spec.md` records the approved
workflow and persistence decisions.

## Parameters

The contract accepts Dano's tolerant aliases and one-level JSON-stringified
collections through Pi 0.82.1 `prepareArguments`. Canonical calls use either:

- one question's top-level fields;
- `title` plus `questions[]`, with every field setting inside its item; or
- `{ "confirm": true, "formIds": ["<submitted-form-id>"] }`.

Current Dano fields include `fieldAssist` and Submitted Form confirmation.
The standalone CLI adds only `dataSourceBaseUrl` to resolve relative remote
endpoints. Remote headers, cookies, credential rules, environment names, and
Field Assist model settings are deliberately absent from model arguments.

`confirm:true` never means an ordinary boolean prompt. It selects previously
submitted grouped forms. Ordinary yes/no decisions use a normal choice field.

## Results

```ts
type AskUserQuestionResult =
  | { status: "answered"; answer: Answer | Record<string, Answer>; formId?: string }
  | {
      status: "confirmed";
      answer: Record<string, Answer>;
      confirmationOfToolCallId: string;
      forms: Array<{ formId: string; answer: Record<string, Answer> }>;
    }
  | { status: "cancelled" }
  | { status: "invalid"; error: StructuredQuestionError };
```

Invalid results retain Dano's stable `code`, `category`, `retryable`, and
path-addressed `issues` fields. Independent input problems are aggregated.
Lifecycle failures use bounded retry metadata and terminal codes. Grouped
success returns the original tool call id as `formId`.

## Workflow invariants

- The tool executes sequentially.
- Submitted Forms are durable session entries, not process-local memory.
- Final confirmation can return to a revision draft without mutating canonical
  answers until Save.
- Cross-process recovery reopens a nonterminal interaction and produces one new
  visible continuation; it never fabricates an old tool result.
- Field Assist runs in an isolated, tool-free, in-memory Pi child session.
- Remote authentication is user-owned and applied only in the transport layer.
