# pi-ask-user-question

Native `ask_user_question` extension for Pi Coding Agent. Simple single questions use Pi's built-in dialogs; grouped forms and advanced fields use one atomic `ctx.ui.custom()` form.

## Install

```sh
pi install npm:@josephyoung/pi-ask-user-question
```

To install directly from GitHub instead, use `pi install git:github.com/josephyoung/pi-ask-user-question`.

The package supports `@earendil-works/pi-coding-agent` versions `>=0.80.2 <0.81.0`.

## Tool behavior

- Single text, textarea, static single-choice, and confirmation questions route to `input`, `editor`, `select`, and `confirm` respectively.
- Multiple choice, date, tree selection, remote options, and every grouped form route to `ctx.ui.custom()`.
- Grouped answers are submitted atomically and keyed by question identity.
- Remote sources support GET/POST, params, search, pagination, mapping, headers, cookies, relative endpoints, and field-local retry.
- Cancellation returns `{ "status": "cancelled" }`; Agent abort remains an execution error.

Relative remote endpoints require `dataSourceBaseUrl` in the tool call. This is request context, not Pi or project configuration.

## Verify

```sh
npm run typecheck
npm run test:unit
npm run test:acceptance
npm test
```

The acceptance suite creates temporary project and Pi-state directories, installs a snapshot of this package through a real Git URL, launches the system `pi` executable in a PTY, and removes all temporary resources afterward.
