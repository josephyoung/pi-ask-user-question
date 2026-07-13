import type { NormalizedQuestion, NormalizedRequest } from "./types.js";

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
