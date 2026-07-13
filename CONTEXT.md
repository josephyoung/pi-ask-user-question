# Ask User Question

This project provides human-in-the-loop questioning as an independent capability in the Pi ecosystem.

## Language

**Pi extension**:
An independently installable capability for Pi Coding Agent, owned and validated outside any consuming application.
_Avoid_: Dano extension, Dano extraction

**Supported Pi runtime**:
The `@earendil-works/pi-coding-agent` runtime family against which the extension publishes and verifies compatibility.
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
The current Dano `ask_user_question` parameter schema adopted as the extension's initial model-facing schema and verified within Pi Coding Agent, with explicitly added data-source base URL, header, and cookie parameters.
_Avoid_: Dano runtime dependency, unrelated schema redesign

**Consuming application**:
An application that integrates the Pi extension without owning its core contract.
_Avoid_: Extension host
