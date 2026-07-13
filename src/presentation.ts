import type { AgentToolResult, Theme, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { normalizeRequest } from "./normalize.js";
import { flattenOptions } from "./options.js";
import type { Answer, AskUserQuestionResult, NormalizedQuestion, NormalizedRequest, RawRequest } from "./types.js";

export const usesTextEditor = (question: Pick<NormalizedQuestion, "kind">) =>
  question.kind === "text" || question.kind === "date";

export const requiresCustomPresentation = (request: NormalizedRequest) => {
  const question = request.questions[0]!;
  return request.grouped
    || question.kind === "multiple"
    || question.kind === "date"
    || question.inputType === "treeSelect"
    || Boolean(question.dataSource);
};

function displayQuestionAnswer(question: NormalizedQuestion, answer: Answer): Answer {
  if (question.kind !== "single" && question.kind !== "multiple") return answer;
  const options = flattenOptions(question.presentationOptions ?? question.options ?? []);
  const label = (value: string | number) => options.find(option => option.id === value)?.label ?? value;
  return Array.isArray(answer) ? answer.map(label) : typeof answer === "boolean" ? answer : label(answer);
}

function formatDisplayed(value: Answer): string {
  return Array.isArray(value) ? value.join(", ") : String(value);
}

function displayLines(request: NormalizedRequest, answer: Answer | Record<string, Answer>) {
  if (!request.grouped) return [`${request.questions[0]!.question}: ${formatDisplayed(displayQuestionAnswer(request.questions[0]!, answer as Answer))}`];
  const answers = answer as Record<string, Answer>;
  return request.questions.flatMap(question => question.id in answers
    ? [`${question.question}: ${formatDisplayed(displayQuestionAnswer(question, answers[question.id]!))}`]
    : []);
}

type ResultPresentationContext = { args: RawRequest; toolCallId: string; state: { request?: NormalizedRequest } };

export class ResultPresentationStore {
  private readonly requests = new Map<string, NormalizedRequest>();

  constructor(private readonly maxRetainedRequests = 64) {}

  remember(toolCallId: string, request: NormalizedRequest): void {
    this.requests.delete(toolCallId);
    this.requests.set(toolCallId, request);
    while (this.requests.size > this.maxRetainedRequests) {
      const oldestToolCallId = this.requests.keys().next().value;
      if (oldestToolCallId === undefined) break;
      this.requests.delete(oldestToolCallId);
    }
  }

  render(
    result: AgentToolResult<AskUserQuestionResult>,
    _options: ToolRenderResultOptions,
    theme: Theme,
    context: ResultPresentationContext,
  ) {
    const details = result.details as AskUserQuestionResult | undefined;
    const first = result.content[0];
    if (!details) return new Text(first?.type === "text" ? first.text : "", 0, 0);
    if (details.status === "cancelled") return new Text(theme.fg("warning", "Cancelled"), 0, 0);
    const request = context.state.request ?? this.requests.get(context.toolCallId) ?? normalizeRequest(context.args);
    context.state.request = request;
    this.requests.delete(context.toolCallId);
    const lines = displayLines(request, details.answer).map(line => `${theme.fg("success", "✓ ")}${line}`);
    return new Text(lines.join("\n"), 0, 0);
  }
}
