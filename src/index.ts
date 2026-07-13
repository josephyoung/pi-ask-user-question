import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { description, parameters, promptGuidelines, promptSnippet } from "./contract.js";
import { createQuestionForm, type FormOutcome } from "./form.js";
import { isOtherOption, normalizeAnswer, normalizeRequest } from "./normalize.js";
import { groupedRetryError, PendingCallCoordinator } from "./pending.js";
import { requiresCustomPresentation, ResultPresentationStore } from "./presentation.js";
import type { Answer, AskUserQuestionResult, NormalizedQuestion, NormalizedRequest, RawRequest } from "./types.js";

export const ASK_USER_QUESTION_TOOL_NAME = "ask_user_question";
export { groupedRetryError };

function resultPayload(result: AskUserQuestionResult) {
  return {
    content: [{ type: "text" as const, text: result.status === "answered"
      ? `User answered the question: ${JSON.stringify(result.answer)}. Continue with this answer.`
      : "User cancelled the question. Stop the current workflow. Do not ask another question or retry unless the user sends a new message explicitly requesting it." }],
    details: result,
  };
}

async function primitive(question: NormalizedQuestion, signal: AbortSignal | undefined, ctx: ExtensionContext) {
  const opts = signal ? { signal } : undefined;
  if (question.kind === "confirm") return { answer: await ctx.ui.confirm(question.question, "", opts) };
  if (question.inputType === "textarea") return { answer: await ctx.ui.editor(question.question, typeof question.default === "string" ? question.default : "") };
  if (question.kind === "text") return { answer: await ctx.ui.input(question.question, typeof question.default === "string" ? question.default : undefined, opts) };
  const originalOptions = question.options ?? [];
  const recommendedIndex = originalOptions.findIndex(option => option.id === question.default);
  const options = recommendedIndex > 0
    ? [originalOptions[recommendedIndex]!, ...originalOptions.filter((_, index) => index !== recommendedIndex)]
    : originalOptions;
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
  const pendingCalls = new PendingCallCoordinator();
  const presentation = new ResultPresentationStore();
  return {
    name: ASK_USER_QUESTION_TOOL_NAME,
    label: "Ask User Question",
    description,
    promptSnippet,
    promptGuidelines,
    parameters,
    executionMode: "parallel" as const,
    async execute(toolCallId: string, params: RawRequest, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
      const request = normalizeRequest(params);
      if (!ctx.hasUI || ctx.mode !== "tui") throw new Error(`ask_user_question requires interactive TUI mode; current mode is ${ctx.mode}`);
      const advanced = requiresCustomPresentation(request);
      if (advanced && typeof ctx.ui.custom !== "function") throw new Error("ask_user_question requires ctx.ui.custom() for grouped or advanced interactions");
      const releasePending = pendingCalls.start(toolCallId, signal);
      try {
        if (advanced) {
          const outcome = await custom(request, signal, ctx);
          if (signal?.aborted) throw new Error("Question was aborted");
          if (outcome.kind === "aborted") throw new Error("Question was aborted");
          if (outcome.kind === "cancelled") return resultPayload({ status: "cancelled" });
          const answer = request.grouped ? outcome.answers : outcome.answers[request.questions[0]!.id]!;
          presentation.remember(toolCallId, request);
          return resultPayload({ status: "answered", answer });
        }
        const question = request.questions[0]!;
        if (signal?.aborted) throw new Error("Question was aborted");
        const { answer } = await primitive(question, signal, ctx);
        if (signal?.aborted) throw new Error("Question was aborted");
        if (answer === undefined) return resultPayload({ status: "cancelled" });
        const normalized = normalizeAnswer(question, answer) as Answer;
        presentation.remember(toolCallId, request);
        return resultPayload({ status: "answered", answer: normalized });
      } finally {
        releasePending();
      }
    },
    renderResult: presentation.render.bind(presentation),
  };
}

export default function askUserQuestion(pi: ExtensionAPI) {
  pi.registerTool(createTool());
}

export { description, parameters, promptGuidelines, promptSnippet } from "./contract.js";
export { loadOptions } from "./data-source.js";
export { normalizeAnswer, normalizeRequest } from "./normalize.js";
export type * from "./types.js";
