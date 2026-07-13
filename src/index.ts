import type { AgentToolResult, ExtensionAPI, ExtensionContext, Theme, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { description, parameters, promptGuidelines, promptSnippet } from "./contract.js";
import { createQuestionForm, type FormOutcome } from "./form.js";
import { isOtherOption, normalizeAnswer, normalizeRequest } from "./normalize.js";
import { Text } from "@earendil-works/pi-tui";
import { flattenOptions } from "./options.js";
import { requiresCustomPresentation } from "./presentation.js";
import type { Answer, AskUserQuestionResult, NormalizedQuestion, NormalizedRequest, RawRequest } from "./types.js";

export const ASK_USER_QUESTION_TOOL_NAME = "ask_user_question";
export const groupedRetryError =
  "You called ask_user_question more than once in the same response while another question is still pending. Retry silently with exactly one native ask_user_question call using {\"questions\":[...]} so all fields render in one card with one submit button. Put every field's options, inputType, dateFormat, dataSource, multiple, required, and default inside its questions[] item. Do not explain this correction to the user.";

function resultPayload(result: AskUserQuestionResult) {
  return {
    content: [{ type: "text" as const, text: result.status === "answered"
      ? `User answered the question: ${JSON.stringify(result.answer)}. Continue with this answer.`
      : "User cancelled the question. Stop the current workflow. Do not ask another question or retry unless the user sends a new message explicitly requesting it." }],
    details: result,
  };
}

function displayQuestionAnswer(question: NormalizedQuestion, answer: Answer): Answer {
  if (question.kind !== "single" && question.kind !== "multiple") return answer;
  const options = flattenOptions(question.presentationOptions ?? question.options ?? []);
  const label = (value: string | number) => options.find(option => option.id === value)?.label ?? value;
  return Array.isArray(answer) ? answer.map(label) : typeof answer === "boolean" ? answer : label(answer);
}
function displayLines(request: NormalizedRequest, answer: Answer | Record<string, Answer>) {
  if (!request.grouped) return [`${request.questions[0]!.question}: ${formatDisplayed(displayQuestionAnswer(request.questions[0]!, answer as Answer))}`];
  const answers = answer as Record<string, Answer>;
  return request.questions.flatMap(question => question.id in answers
    ? [`${question.question}: ${formatDisplayed(displayQuestionAnswer(question, answers[question.id]!))}`]
    : []);
}

function formatDisplayed(value: Answer): string {
  return Array.isArray(value) ? value.join(", ") : String(value);
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
  const activeToolCalls = new Set<string>();
  const pendingToolCallBySignal = new WeakMap<AbortSignal, string>();
  const presentationRequests = new Map<string, NormalizedRequest>();
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
      if (activeToolCalls.has(toolCallId)) throw new Error(`Question is already pending: ${toolCallId}`);
      const pendingInCurrentTurn = signal ? pendingToolCallBySignal.get(signal) : undefined;
      if (pendingInCurrentTurn && activeToolCalls.has(pendingInCurrentTurn)) throw new Error(groupedRetryError);
      activeToolCalls.add(toolCallId);
      if (signal) pendingToolCallBySignal.set(signal, toolCallId);
      try {
        if (advanced) {
          const outcome = await custom(request, signal, ctx);
          if (outcome.kind === "aborted") throw new Error("Question was aborted");
          if (outcome.kind === "cancelled") return resultPayload({ status: "cancelled" });
          const answer = request.grouped ? outcome.answers : outcome.answers[request.questions[0]!.id]!;
          presentationRequests.set(toolCallId, request);
          return resultPayload({ status: "answered", answer });
        }
        const question = request.questions[0]!;
        if (signal?.aborted) throw new Error("Question was aborted");
        const { answer } = await primitive(question, signal, ctx);
        if (signal?.aborted) throw new Error("Question was aborted");
        if (answer === undefined) return resultPayload({ status: "cancelled" });
        const normalized = normalizeAnswer(question, answer) as Answer;
        presentationRequests.set(toolCallId, request);
        return resultPayload({ status: "answered", answer: normalized });
      } finally {
        activeToolCalls.delete(toolCallId);
        if (signal && pendingToolCallBySignal.get(signal) === toolCallId) pendingToolCallBySignal.delete(signal);
      }
    },
    renderResult(
      result: AgentToolResult<AskUserQuestionResult>,
      _options: ToolRenderResultOptions,
      theme: Theme,
      context: { args: RawRequest; toolCallId: string; state: { request?: NormalizedRequest } },
    ) {
      const details = result.details as AskUserQuestionResult | undefined;
      const first = result.content[0];
      if (!details) return new Text(first?.type === "text" ? first.text : "", 0, 0);
      if (details.status === "cancelled") return new Text(theme.fg("warning", "Cancelled"), 0, 0);
      let request = context.state.request ?? presentationRequests.get(context.toolCallId);
      if (!request) request = normalizeRequest(context.args);
      context.state.request = request;
      presentationRequests.delete(context.toolCallId);
      const lines = displayLines(request, details.answer).map(line => `${theme.fg("success", "✓ ")}${line}`);
      return new Text(lines.join("\n"), 0, 0);
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
