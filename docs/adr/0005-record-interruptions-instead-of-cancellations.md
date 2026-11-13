# Record an interruption when a dialog is aborted, not a cancellation

`@earendil-works/pi-coding-agent@1.5.0` settles in-flight tool calls when the process exits: the running `ask_user_question` call receives an abort, records an error result, and the session ends. Treating that abort as a user cancellation made the durable interaction terminal, so the next session start had nothing to restore and the restart-recovery workflow stopped working.

An aborted dialog now appends the `interrupted` state instead of `cancelled`. `interrupted` is not terminal: the interrupted turn still rejects with `question_cancelled`, the same text the user saw before, but the interaction stays restorable. `recoveryCandidate` treats the newest `interrupted` interaction like an actionable one, and `run()` moves it back to `awaiting_confirmation` — or to `revising` when a draft revision was open — before it reopens the card, so the restored dialog keeps the shape it had when the process died.

Explicit user intent still ends the interaction: `Esc` and the Cancel row produce the `cancelled` state, which stays terminal and is never restored. The distinction is exactly "the dialog was torn down" versus "the user decided".

A consequence worth knowing: after an agent abort inside one session, no card reappears, because recovery runs only on session start. The unfinished confirmation is restored on the next start of that session instead of silently disappearing.
