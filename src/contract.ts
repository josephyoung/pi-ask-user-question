import { Type } from "typebox";

const Fields = {
  question: Type.Optional(Type.Any({
    description: "Single-question call: the clear, specific question to ask the user. With questions[], top-level question/title/label/prompt is treated only as optional form instruction text; each actual field question must be inside questions[].",
  })),
  title: Type.Optional(Type.Any({
    description: "Canonical grouped-form title. If omitted or malformed with questions, Dano uses the configured product default title.",
  })),
  label: Type.Optional(Type.Any()),
  prompt: Type.Optional(Type.Any()),
  options: Type.Optional(Type.Any({
    description: "Canonical choices array for this question. Dano also accepts a one-level JSON-stringified array and the choices alias. Strings remain supported; objects use stable id plus label. Include '其他' or 'Other' to let the user enter one custom answer. Omit for free-text, confirmation, or remote dataSource input.",
  })),
  choices: Type.Optional(Type.Any()),
  inputType: Type.Optional(Type.Any()),
  type: Type.Optional(Type.Any()),
  input_type: Type.Optional(Type.Any()),
  component: Type.Optional(Type.Any()),
  fieldAssist: Type.Optional(Type.Any({
    description: "Controls whether text fields show Field Assist generation and polishing actions. Single-line text defaults to false; textarea defaults to true. Enable it when drafting or polishing business text would help; factual short values usually omit it.",
  })),
  dateFormat: Type.Optional(Type.Any({
    description: "Required when inputType is \"date\". A frontend date-control format such as \"yyyy-MM-dd\" or \"yyyy-MM-dd HH:mm\".",
  })),
  dataSource: Type.Optional(Type.Any()),
  data_source: Type.Optional(Type.Any()),
  multiple: Type.Optional(Type.Any({ default: false, description: "Set true with options to allow multiple selections." })),
  multi: Type.Optional(Type.Any()),
  multipleSelect: Type.Optional(Type.Any()),
  required: Type.Optional(Type.Any({ description: "Set true to require a non-empty answer. Defaults to false." })),
  default: Type.Optional(Type.Any()),
  defaultValue: Type.Optional(Type.Any()),
  prefill: Type.Optional(Type.Any()),
  value: Type.Optional(Type.Any()),
};

export const parameters = Type.Object({
  ...Fields,
  confirm: Type.Optional(Type.Any({
    description: "Confirm one or more previously submitted grouped forms. Use {confirm:true,formIds:[\"<formId>\"]}; Dano supplies each selected form's title and latest submitted answers.",
  })),
  formIds: Type.Optional(Type.Any({
    description: "Standard grouped-form confirmation target: an array of formId strings returned by earlier grouped form submissions in this Assistant Turn.",
  })),
  questions: Type.Optional(Type.Any({
    description: "Preferred for collecting more than one answer. Make exactly one ask_user_question call with questions: [{ id, question, default, options?, multiple?, inputType?, fieldAssist?, dateFormat?, required?, dataSource? }, ...]. Every canonical non-confirmation questions[] item should include a context-based, non-empty default. A single question object or one-level JSON-stringified object/array is also accepted and normalized to an array. If title is omitted or malformed, Dano uses the configured product default. When questions is present, put each field's options, inputType, fieldAssist, dateFormat, required, dataSource, multiple, and default inside its questions[] item. Do not include top-level confirm or top-level field configuration with questions.",
  })),
  dataSourceBaseUrl: Type.Optional(Type.String({ minLength: 1, description: "Base URL used to resolve relative dataSource.endpoint values." })),
});

export const description = `Ask the user for structured input during execution.

When the user asks to fill in a form, complete a form, or provide form fields, use ask_user_question to collect the fields instead of asking in assistant text. Every non-confirmation question must include a context-based recommended default so the user can usually submit directly. String defaults must be non-empty; never use default:"". required:true controls whether the user may submit an empty answer.

Use exactly one ask_user_question call per assistant response. If you need more than one answer, provide a form title and use only the questions array: {"title":"请假申请","questions":[{"id":"leave_type","question":"请假类型？","options":["事假",{"id":"sick","label":"病假"}],"default":"事假","required":true},{"id":"start_at","question":"开始时间？","inputType":"date","dateFormat":"yyyy-MM-dd HH:mm","default":"2026-07-08 09:00","required":true},{"id":"reason","question":"原因？","default":"个人事务","fieldAssist":true,"required":true}]}. When questions is present, put every field's options, inputType, fieldAssist, dateFormat, required, dataSource, multiple, and default inside the matching questions[] item; do not include top-level confirm or top-level field configuration.

For a single question, use top-level question/options/inputType/fieldAssist/dateFormat/required/dataSource/multiple/default. For multiple questions, use title plus questions[]. fieldAssist controls generation and polishing actions for text fields; it defaults to false for single-line text and true for textarea. Dates require inputType:"date" plus dateFormat, for example "yyyy-MM-dd" or "yyyy-MM-dd HH:mm"; Dano returns the user's submitted date value as-is. required defaults to false; set required:true when an empty answer must not be submitted. Canonical calls should provide a non-empty default; compatibility input without one renders without a prefill. Use inputType:"select" or inputType:"treeSelect" with dataSource for remote API-backed choices. Dano normalizes unambiguous aliases, safe scalar deviations, and one-level JSON-stringified collections; it uses the configured product title when a grouped title is missing, ignores unknown or inapplicable optional fields, and rejects only inputs that cannot preserve rendering, submission, or answer mapping. When the workflow needs final confirmation for submitted grouped forms, call {"confirm":true,"formIds":["<formId>"]} with the formId values returned by those submissions. This is only for grouped-form confirmation; use a normal single-choice question to confirm an ordinary sentence or operation. If final confirmation is not needed, continue without this call.

Failures use one JSON result shape: {"status":"invalid","error":{"code":"...","category":"...","message":"...","retryable":true,"issues":[{"code":"...","path":"questions[0].id","message":"..."}]}}. Correct every reported issue path in one replacement call only when retryable is true. Never retry terminal or cancelled failures.`;
export const promptSnippet = "Ask the user one native question card; for several fields use one questions array with one submit button";
export const promptGuidelines = [
  "Use ask_user_question whenever you need user input to continue; do not ask the question only in assistant text.",
  "When the user asks to fill in a form, complete a form, or provide form fields, collect the fields with ask_user_question.",
  "Call ask_user_question at most once per assistant response. If you need several answers, put every item in one questions array.",
  "If the user cancels ask_user_question, stop the current workflow. Do not ask again or retry unless the user sends a new message explicitly requesting it.",
  "Invoke ask_user_question as a native tool call. Never print, describe, or wrap a tool call in <question> tags, XML, JSON, Markdown, or other assistant text.",
  "If ask_user_question returns status:invalid, inspect error.code, category, retryable, and every issues[] entry. Retry silently with one corrected native tool call only when retryable is true; correct all reported paths together and do not explain the correction to the user.",
  "Do not retry question_presentation_failed, question_validation_failed, or question_cancelled results. Stop the current response and let the user decide whether to try again.",
  "Use the documented canonical parameters. Dano treats model-generated arguments as best-effort input, normalizes safe aliases and one-level JSON collection strings, uses the configured product title when a grouped title is missing, and admits an omitted default without a prefill. It still rejects ambiguity that could change rendering, submission, or answer mapping.",
  "Give every non-confirmation question a context-based recommended non-empty default. Do not use empty string or placeholder defaults.",
  "Set required:true only when an answer is mandatory. required defaults to false.",
  "For date fields, use inputType:\"date\" and provide dateFormat such as \"yyyy-MM-dd\" or \"yyyy-MM-dd HH:mm\". The dateFormat configures the frontend date control display and submitted output.",
  "Dano returns the user's date answer as submitted; convert it yourself if a downstream interface needs another business format.",
  "Use fieldAssist to control generation and polishing actions on text fields. It defaults to false for single-line text and true for textarea; enable it when drafting or polishing business text would help, while factual short values usually omit it.",
  "When using questions, provide a concise top-level title and put each field's id, question, options, inputType, fieldAssist, dateFormat, required, dataSource, multiple, and default inside its questions item.",
  "When one or more submitted grouped forms require final confirmation, call ask_user_question with {confirm:true,formIds:[\"<formId>\"]} using their returned formId values. Do not send confirmation text or prior answers. If confirmation is not required, continue normally.",
  "Use confirm:true only for submitted grouped forms. To confirm an ordinary sentence or operation, ask a normal single-choice question instead.",
];
