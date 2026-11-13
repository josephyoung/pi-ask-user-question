# Report blocked program status through Pi instead of writing OSC 7501

While a question dialog waits for the user, the pane should show the terminal as blocked. Pi already owns that channel: `ctx.ui.custom(factory, { blocked })` makes Pi's `ProgramStatusReporter` write `OSC 7501` with `state=blocked`, deduplicates repeated reports, feature-detects terminal support, and clears the state when the dialog settles. This extension therefore never writes escape sequences itself and never has to restore the previous status.

## Coverage

Pi reports blocked on its own for extension selectors, confirmations, text inputs, and editors, so the primitive question paths need no change. Only the two `ctx.ui.custom` surfaces of this extension — the grouped form and the Submitted Form confirmation card — pass `{ blocked: { kind: "question", message } }`. Both stay `kind=question`: a confirmation card waits for review of a Submitted Form, not for permission.

## Message

The message is one user-configured line, because a terminal's program-status surface shows it to whoever looks at the pane. It defaults to `我需要你的帮助` and is read from `ask-user-question.json` in the Pi agent directory (`{ "version": 1, "blockedMessage": "..." }`), the same place as `ask-user-question.auth.json`. A missing, malformed, or unknown-version file falls back to the default instead of failing a question, and the text is reduced to one line of at most 120 characters so it cannot break the report. The file is read whenever a dialog opens, so an edit applies without restarting Pi.

## Runtime

The `blocked` option exists from `@earendil-works/pi-coding-agent@1.5.0`. The package still supports `>=1.4.0 <2.0.0`; on 1.4.x the option is ignored and no status is reported, while questions keep working. Development, typecheck, and acceptance run against the 1.5.x runtime.
