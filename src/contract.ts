import { Type } from "typebox";

const OptionItem = Type.Object({
  id: Type.Union([Type.String({ minLength: 1 }), Type.Number()]),
  label: Type.String({ minLength: 1 }),
  extra: Type.Optional(Type.Record(Type.String(), Type.Any())),
});
const Option = Type.Union([Type.String({ minLength: 1 }), OptionItem]);
const AnswerInput = Type.Union([
  Type.String(), Type.Number(), OptionItem,
  Type.Array(Type.Union([Type.String(), Type.Number(), OptionItem])), Type.Boolean(),
], { description: "Default or answer value: string for text/single-choice labels, string or number option ids, option item objects, arrays for multiple-choice, boolean for confirmation." });
const Default = Type.Union([
  Type.String(), Type.Number(), OptionItem,
  Type.Array(Type.Union([Type.String(), Type.Number(), OptionItem])), Type.Boolean(),
], { description: "Required for every non-confirmation question. Provide a context-based recommended default value. String defaults must be non-empty and must not be placeholders such as \"\"." });
const InputType = Type.Union([
  Type.Literal("text"), Type.Literal("textarea"), Type.Literal("date"),
  Type.Literal("radio"), Type.Literal("checkbox"), Type.Literal("select"),
  Type.Literal("treeSelect"), Type.Literal("confirm"),
]);
const DataSource = Type.Object({
  type: Type.Literal("api"),
  endpoint: Type.String({ minLength: 1 }),
  method: Type.Optional(Type.Union([Type.Literal("GET"), Type.Literal("POST")])),
  params: Type.Optional(Type.Record(Type.String(), Type.Any())),
  headers: Type.Optional(Type.Record(Type.String(), Type.String())),
  cookies: Type.Optional(Type.Record(Type.String(), Type.String())),
  searchParam: Type.Optional(Type.String({ minLength: 1 })),
  pageParam: Type.Optional(Type.String({ minLength: 1 })),
  pageSizeParam: Type.Optional(Type.String({ minLength: 1 })),
  pageSize: Type.Optional(Type.Number({ minimum: 1 })),
  resultPath: Type.Optional(Type.String({ minLength: 1 })),
  totalPath: Type.Optional(Type.String({ minLength: 1 })),
  idField: Type.Optional(Type.String({ minLength: 1 })),
  labelField: Type.Optional(Type.String({ minLength: 1 })),
  childrenField: Type.Optional(Type.String({ minLength: 1 })),
  extraFields: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
});
const Fields = {
  question: Type.Optional(Type.String({ minLength: 1, description: "Single-question call: the clear, specific question to ask the user. With questions[], top-level question/title/label/prompt is treated only as optional form instruction text; each actual field question must be inside questions[]." })),
  title: Type.Optional(Type.String({ minLength: 1 })),
  label: Type.Optional(Type.String({ minLength: 1 })),
  prompt: Type.Optional(Type.String({ minLength: 1 })),
  options: Type.Optional(Type.Array(Option, { minItems: 2, description: "Choices for this question. Strings remain supported; objects use stable id plus label. Include '其他' or 'Other' to let the user enter one custom answer. Omit for free-text, confirmation, or remote dataSource input." })),
  choices: Type.Optional(Type.Array(Option, { minItems: 2 })),
  inputType: Type.Optional(InputType),
  type: Type.Optional(Type.String({ minLength: 1 })),
  input_type: Type.Optional(Type.String({ minLength: 1 })),
  component: Type.Optional(Type.String({ minLength: 1 })),
  dateFormat: Type.Optional(Type.String({ minLength: 1, description: "Required when inputType is \"date\". A frontend date-control format such as \"yyyy-MM-dd\" or \"yyyy-MM-dd HH:mm\"." })),
  dataSource: Type.Optional(DataSource),
  data_source: Type.Optional(DataSource),
  multiple: Type.Optional(Type.Boolean({ default: false, description: "Set true with options to allow multiple selections." })),
  multi: Type.Optional(Type.Boolean()),
  multipleSelect: Type.Optional(Type.Boolean()),
  required: Type.Optional(Type.Boolean({ description: "Set true to require a non-empty answer. Defaults to false." })),
  default: Type.Optional(Default),
  defaultValue: Type.Optional(Default),
  prefill: Type.Optional(Default),
  value: Type.Optional(Default),
};

export const parameters = Type.Object({
  ...Fields,
  confirm: Type.Optional(Type.Literal(true, { description: "Set true without options to ask for confirmation." })),
  questions: Type.Optional(Type.Any({ description: "Preferred for collecting more than one answer. Make exactly one ask_user_question call with questions: [{ id, question, default, options?, multiple?, inputType?, dateFormat?, required?, dataSource? }, ...]. Every non-confirmation questions[] item must include a context-based, non-empty default. A single question object is also accepted and normalized to an array. When questions is present, put each field's options, inputType, dateFormat, required, dataSource, multiple, and default inside its questions[] item. Do not include top-level confirm or top-level field configuration with questions." })),
  dataSourceBaseUrl: Type.Optional(Type.String({ minLength: 1, description: "Base URL used to resolve relative dataSource.endpoint values." })),
});

export const description = `Ask the user for structured input during execution.

When the user asks to fill in a form, complete a form, or provide form fields, use ask_user_question to collect the fields instead of asking in assistant text. Every non-confirmation question must include a context-based recommended default so the user can usually submit directly. String defaults must be non-empty; never use default:"". required:true controls whether the user may submit an empty answer.

Use exactly one ask_user_question call per assistant response. If you need more than one answer, use only the questions array: {"questions":[{"id":"leave_type","question":"请假类型？","options":["事假",{"id":"sick","label":"病假"}],"default":"事假","required":true},{"id":"start_at","question":"开始时间？","inputType":"date","dateFormat":"yyyy-MM-dd HH:mm","default":"2026-07-08 09:00","required":true},{"id":"reason","question":"原因？","default":"个人事务","required":true}]}. When questions is present, put every field's options, inputType, dateFormat, required, dataSource, multiple, and default inside the matching questions[] item; do not include top-level confirm or top-level field configuration.

For a single question, use top-level question/options/inputType/dateFormat/required/dataSource/multiple/default/confirm. For multiple questions, use questions[]. Dates require inputType:"date" plus dateFormat, for example "yyyy-MM-dd" or "yyyy-MM-dd HH:mm"; Dano returns the user's submitted date value as-is. required defaults to false; set required:true when an empty answer must not be submitted. default is still required for non-confirmation questions whether required is true or false, and string defaults must be non-empty. Use inputType:"select" or inputType:"treeSelect" with dataSource for remote API-backed choices. Confirmation is a separate single-question call with question + confirm: true and no options/multiple/questions. The answer is returned as a tool result and execution then continues.`;
export const promptSnippet = "Ask the user one native question card; for several fields use one questions array with one submit button";
export const promptGuidelines = [
  "Use ask_user_question whenever you need user input to continue; do not ask the question only in assistant text.",
  "When the user asks to fill in a form, complete a form, or provide form fields, collect the fields with ask_user_question.",
  "Call ask_user_question at most once per assistant response. If you need several answers, put every item in one questions array.",
  "If the user cancels ask_user_question, stop the current workflow. Do not ask again or retry unless the user sends a new message explicitly requesting it.",
  "Invoke ask_user_question as a native tool call. Never print, describe, or wrap a tool call in <question> tags, XML, JSON, Markdown, or other assistant text.",
  "If ask_user_question returns a validation error, retry silently with a corrected native tool call; do not explain the correction to the user.",
  "Give every non-confirmation question a context-based recommended non-empty default. Do not use empty string or placeholder defaults.",
  "Set required:true only when an answer is mandatory. required defaults to false.",
  "For date fields, use inputType:\"date\" and provide dateFormat such as \"yyyy-MM-dd\" or \"yyyy-MM-dd HH:mm\". The dateFormat configures the frontend date control display and submitted output.",
  "Dano returns the user's date answer as submitted; convert it yourself if a downstream interface needs another business format.",
  "When using questions, put each field's id, question, options, inputType, dateFormat, required, dataSource, multiple, and default inside its questions item. Do not put top-level field configuration beside questions.",
  "For forms, applications, or other user-reviewed summaries, call ask_user_question with confirm: true after presenting the final summary and before treating it as confirmed, ready to submit, or complete.",
];
