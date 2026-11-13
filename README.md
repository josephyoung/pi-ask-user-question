# pi-ask-user-question

Native `ask_user_question` extension for Pi Coding Agent. Simple single questions use Pi's built-in dialogs; grouped forms and advanced fields use one atomic `ctx.ui.custom()` form.

## Install

```sh
pi install npm:@josephyoung/pi-ask-user-question
```

To install directly from GitHub instead, use `pi install git:github.com/josephyoung/pi-ask-user-question`.

The package supports `@earendil-works/pi-coding-agent` versions `>=1.4.0 <2.0.0`; development and real CLI acceptance use exact `1.5.2`, the runtime that also reports blocked program status.

## Tool behavior

- Simple text and static single-choice questions use Pi primitives; grouped and advanced questions use the native TUI form.
- Multiple choice, date, tree selection, remote options, and every grouped form route to `ctx.ui.custom()`.
- Grouped answers are submitted atomically and return a durable `formId`.
- `confirm:true` with `formIds` confirms one or more Submitted Forms. It supports a complete review card, return-to-modify revisions, restart recovery, and a visible continuation into a new Agent turn. For compatibility, top-level `question` plus `confirm:true` without a form target opens an ordinary boolean confirmation; canonical ordinary yes/no decisions use a normal choice question.
- Text fields support isolated Field Assist generation and polishing. The child session uses the current Pi model with reusable persisted provider authentication, without loading tools, extensions, skills, prompts, themes, or project context.
- Namespaced, versioned custom field kinds can be added through the public Question capability registry; capability state is serialized into Submitted Form snapshots and restores read-only when unavailable.
- Remote sources support GET/POST, params, search, pagination, mapping, relative endpoints, user-owned authentication, and field-local retry.
- While the grouped form or the Submitted Form confirmation waits, Pi reports the pane as blocked (`OSC 7501`, `kind=question`) and clears it once the dialog settles. Primitive questions use Pi's own reporting.

Remote credentials stay outside model-visible tool calls. Put origin/path rules in
`$PI_CODING_AGENT_DIR/ask-user-question.auth.json`; each configured header or
cookie value is the name of an environment variable read at request time.

```json
{
  "version": 1,
  "rules": [{
    "origin": "https://oa.example.com",
    "pathPrefix": "/api/",
    "headers": { "Authorization": "OA_AUTHORIZATION" },
    "cookies": { "session": "OA_SESSION" }
  }]
}
```
- Cancellation returns `{ "status": "cancelled" }`; Agent abort is a structured terminal lifecycle error.


The blocked program-status message shown in the pane is configurable in
`$PI_CODING_AGENT_DIR/ask-user-question.json`, read whenever a dialog opens:

```json
{ "version": 1, "blockedMessage": "我需要你的帮助" }
```

A missing or malformed file falls back to `我需要你的帮助`. The `OSC 7501` report itself needs
`@earendil-works/pi-coding-agent` 1.5.0 or newer; on 1.4.x the option is ignored and questions still work.
Relative remote endpoints require `dataSourceBaseUrl` in the tool call. This is request context, not Pi or project configuration.

## Verify

```sh
npm run typecheck
npm run test:unit
npm run test:acceptance
npm test
```

The acceptance suite creates temporary project and Pi-state directories, installs a snapshot of this package through a real Git URL, launches the system `pi` executable in a PTY, and removes all temporary resources afterward. See [E2E test requirements](docs/e2e-test-requirements.md) for the required automated and manual scenarios, including the remote pagination mock API.
