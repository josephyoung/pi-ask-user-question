# Ask User Question

This project provides human-in-the-loop questioning as an independent capability in the Pi ecosystem.

## Language

**Pi extension**:
An independently installable capability for Pi Coding Agent, owned and validated outside any consuming application.
_Avoid_: Dano extension, Dano extraction

**Supported Pi runtime**:
The `@earendil-works/pi-coding-agent@^0.82.1` runtime family aligned with the pinned Dano baseline and used for publishing and compatibility verification; Pi 0.80.x is outside the migration target.
_Avoid_: Dano runtime

**Question**:
A form field that requests one text, single-choice, multiple-choice, confirmation, or date answer.
_Avoid_: Prompt, dialog

**Question form**:
One or more questions presented and submitted as a single atomic interaction.
_Avoid_: Questionnaire sequence, chained dialogs

**Data source**:
A remote API that supplies options for a choice question as part of the core form interaction.
_Avoid_: Static options, post-P0 enhancement

**Compatibility schema**:
The model-facing parameter schema aligned to the pinned current Dano `ask_user_question` baseline and verified within Pi Coding Agent, with an explicitly added data-source base URL for the CLI environment.
_Avoid_: Dano runtime dependency, unrelated schema redesign

**Data source credentials**:
User-owned authentication material resolved from environment variables by origin- and path-scoped configuration in the Pi agent directory, without appearing in model-visible tool arguments or the Agent transcript.
_Avoid_: Model-supplied headers, model-supplied cookies

**Consuming application**:
An application that integrates the Pi extension without owning its core contract.
_Avoid_: Extension host

**Full functionality**:
Model-contract and user-workflow equivalence with the current Dano `ask_user_question`, while allowing TUI-native visual, focus, and navigation behavior and requiring no Pi upstream changes.
_Avoid_: Pixel-identical Dano UI, browser UI parity

**Submitted form**:
A completed grouped question form that has a stable identity and remains available for later confirmation or revision in the same interaction scope.
_Avoid_: Answer object, completed questionnaire

**Recovered continuation**:
A new, visible Agent turn carrying the canonical outcome of a restored form interaction after its original tool execution no longer exists.
_Avoid_: Synthetic tool result, resurrected tool promise

**Form confirmation**:
Confirmation of one or more submitted forms by their stable identities; ordinary yes-or-no decisions are choice questions rather than this confirmation protocol.
Legacy top-level `question + confirm:true` without a form target remains accepted as an ordinary boolean confirmation compatibility input.
_Avoid_: Using the compatibility input for new canonical calls, generic confirmation

**Field Assist**:
Optional generation and polishing assistance for text questions, isolated from the main Agent transcript and subject to the same safety and lifecycle boundaries as the form interaction.
_Avoid_: Main-session completion, hidden transcript turn

**Field Assist run**:
One field-scoped generation or polishing attempt that retains the previous value until validated output succeeds and always disposes its isolated child session.
_Avoid_: Assistant turn, form submission

**Durable question application**:
The deep module that owns compatibility preparation, live execution, active-branch recovery, Submitted Form lifecycle, and result projection behind the extension's one-step installation interface.
_Avoid_: TUI controller, workflow service

**Question capability**:
A public, namespaced, versioned extension for one field kind, with serializable recoverable state; it cannot replace authentication, persistence, recovery, or lifecycle safety policy.
_Avoid_: Host adapter, unrestricted plugin hook
