import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { description, parameters, promptGuidelines, promptSnippet } from "./contract.js";
import { createQuestionForm, type FormOutcome } from "./form.js";
import { isOtherOption, normalizeAnswer, normalizeRequest } from "./normalize.js";
import { flattenOptions } from "./options.js";
import { requiresCustomPresentation } from "./presentation.js";
import type { Answer, AskUserQuestionResult, NormalizedQuestion, NormalizedRequest, RawRequest } from "./types.js";

export const ASK_USER_QUESTION_TOOL_NAME = "ask_user_question";

function resultPayload(result: AskUserQuestionResult, displayedAnswer?: unknown) {
  return {
    content: [{ type: "text" as const, text: result.status === "answered"
      ? `User answered the question: ${JSON.stringify(displayedAnswer ?? result.answer)}. Continue with this answer.`
      : "User cancelled the question. Stop the current workflow. Do not ask another question or retry unless the user sends a new message explicitly requesting it." }],
    details: result,
  };
}

function displayQuestionAnswer(question: NormalizedQuestion, answer: Answer): Answer {
  if (question.kind !== "single" && question.kind !== "multiple") return answer;
  const options = flattenOptions(question.options ?? []);
  const label = (value: string | number) => options.find(option => option.id === value)?.label ?? value;
  return Array.isArray(answer) ? answer.map(label) : typeof answer === "boolean" ? answer : label(answer);
}
function displayAnswer(request: NormalizedRequest, answer: Answer | Record<string, Answer>) {
  if (!request.grouped) return displayQuestionAnswer(request.questions[0]!, answer as Answer);
  const answers = answer as Record<string, Answer>;
  return Object.fromEntries(Object.entries(answers).map(([id, value]) => {
    const question = request.questions.find(candidate => candidate.id === id);
    return [id, question ? displayQuestionAnswer(question, value) : value];
  }));
}

async function primitive(question: NormalizedQuestion, signal: AbortSignal | undefined, ctx: ExtensionContext) {
  const opts = signal ? { signal } : undefined;
  if (question.kind === "confirm") return { answer: await ctx.ui.confirm(question.question, "", opts) };
  if (question.inputType === "textarea") return { answer: await ctx.ui.editor(question.question, typeof question.default === "string" ? question.default : "") };
  if (question.kind === "text") return { answer: await ctx.ui.input(question.question, typeof question.default === "string" ? question.default : undefined, opts) };
  const options = question.options ?? [];
  const labels = options.map(option => option.label);
  const selected = await ctx.ui.select(question.question, labels, opts);
  if (selected === undefined) return { answer: undefined };
  const option = options[labels.indexOf(selected)];
  if (option && isOtherOption(option)) {
    const custom = await ctx.ui.input("Other", undefined, opts);
    return { answer: custom };
  }
  return { answer: option?.id ?? selected };
}

async function custom(request: NormalizedRequest, signal: AbortSignal | undefined, ctx: ExtensionContext): Promise<FormOutcome> {
  const outcome = await ctx.ui.custom<FormOutcome>((tui, theme, _keybindings, done) => createQuestionForm(tui, theme, done, request, signal));
  return outcome;
}

export function createTool() {
  return {
    name: ASK_USER_QUESTION_TOOL_NAME,
    label: "Ask User Question",
    description,
    promptSnippet,
    promptGuidelines,
    parameters,
    executionMode: "sequential" as const,
    async execute(_toolCallId: string, params: RawRequest, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
      const request = normalizeRequest(params);
      if (!ctx.hasUI || ctx.mode !== "tui") throw new Error(`ask_user_question requires interactive TUI mode; current mode is ${ctx.mode}`);
      const advanced = requiresCustomPresentation(request);
      if (advanced) {
        if (typeof ctx.ui.custom !== "function") throw new Error("ask_user_question requires ctx.ui.custom() for grouped or advanced interactions");
        const outcome = await custom(request, signal, ctx);
        if (outcome.kind === "aborted") throw new Error("Question was aborted");
        if (outcome.kind === "cancelled") return resultPayload({ status: "cancelled" });
        const answer = request.grouped ? outcome.answers : outcome.answers[request.questions[0]!.id]!;
        return resultPayload({ status: "answered", answer }, displayAnswer(request, answer));
      }
      const question = request.questions[0]!;
      if (signal?.aborted) throw new Error("Question was aborted");
      const { answer } = await primitive(question, signal, ctx);
      if (signal?.aborted) throw new Error("Question was aborted");
      if (answer === undefined) return resultPayload({ status: "cancelled" });
      const normalized = normalizeAnswer(question, answer) as Answer;
      return resultPayload({ status: "answered", answer: normalized }, displayAnswer(request, normalized));
    },
  };
}

export default function askUserQuestion(pi: ExtensionAPI) {
  pi.registerTool(createTool());
}

export { description, parameters, promptGuidelines, promptSnippet } from "./contract.js";
export { loadOptions } from "./data-source.js";
export { normalizeAnswer, normalizeRequest } from "./normalize.js";
export type * from "./types.js";
