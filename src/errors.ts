import type { AskUserQuestionResult, NormalizedRequest, StructuredQuestionError } from "./types.js";

export class QuestionInvalidError extends Error {
  readonly result: Extract<AskUserQuestionResult, { status: "invalid" }>;

  constructor(error: StructuredQuestionError) {
    const result = { status: "invalid" as const, error };
    super(JSON.stringify(result));
    this.result = result;
  }
}

export function duplicateQuestionCall(message: string): QuestionInvalidError {
  return new QuestionInvalidError({
    code: "duplicate_question_call", category: "duplicate_call", message, retryable: true,
    issues: [{ code: "duplicate_tool_call", message }],
  });
}

export function questionCancelled(message = "Question was aborted or the extension was disposed"): QuestionInvalidError {
  return new QuestionInvalidError({
    code: "question_cancelled", category: "lifecycle", message: "The question flow was cancelled.", retryable: false,
    issues: [{ code: "cancelled", message }], terminalCode: "QUESTION_CANCELLED",
  });
}

export class QuestionFailureBudget {
  private readonly validationFailures = new WeakMap<AbortSignal, number>();
  private readonly presentationFailures = new WeakMap<AbortSignal, number>();

  constructor(readonly maxRetries = 10) {}

  clearValidation(signal?: AbortSignal) { if (signal) this.validationFailures.delete(signal); }
  clearPresentation(signal?: AbortSignal) { if (signal) this.presentationFailures.delete(signal); }

  validation(source: QuestionInvalidError, signal?: AbortSignal): QuestionInvalidError {
    if (!signal) return source;
    const failures = (this.validationFailures.get(signal) ?? 0) + 1;
    if (signal) this.validationFailures.set(signal, failures);
    if (failures <= this.maxRetries) return source;
    return new QuestionInvalidError({
      code: "question_validation_failed", category: "lifecycle",
      message: "Repeated invalid ask_user_question calls exhausted automatic retries.", retryable: false,
      issues: [
        { code: "validation_retry_exhausted", message: "Stop this response and let the user retry." },
        ...source.result.error.issues,
      ],
      sourceCode: source.result.error.code,
      terminalCode: "QUESTION_VALIDATION_FAILED",
      ...(source.result.error.context ? { context: source.result.error.context } : {}),
    });
  }

  presentation(signal?: AbortSignal): QuestionInvalidError {
    const failures = signal ? (this.presentationFailures.get(signal) ?? 0) + 1 : this.maxRetries + 1;
    if (signal) this.presentationFailures.set(signal, failures);
    const terminal = failures > this.maxRetries;
    return new QuestionInvalidError({
      code: terminal ? "question_presentation_failed" : "question_presentation_timeout",
      category: "lifecycle",
      message: terminal
        ? "Pi could not display the question card after bounded retries."
        : "The accepted question card was not presented in time.",
      retryable: !terminal,
      issues: [{
        code: terminal ? "presentation_failed" : "presentation_timeout",
        message: terminal ? "Stop this response and let the user retry." : "Retry with one corrected native ask_user_question call.",
      }],
      terminalCode: terminal ? "QUESTION_PRESENTATION_FAILED" : "QUESTION_PRESENTATION_TIMEOUT",
    });
  }
}

export function invalidConfirmationSource(
  message = "No submitted grouped form is available for confirmation",
  suppliedContext?: NonNullable<NormalizedRequest["confirmationContext"]>,
): QuestionInvalidError {
  const context = suppliedContext ?? {
    receivedShape: { formIds: "omitted", formId: "omitted" },
    ignoredReasons: [],
    fallbackAttempted: true,
  };
  const targetMessage = (shape: string) => context.ignoredReasons.includes("unavailable_form_id")
    ? `The ${shape} confirmation target did not identify an available submitted form.`
    : context.ignoredReasons.some(reason => reason.startsWith("malformed_"))
      ? `The ${shape} confirmation target has an unsupported shape.`
      : `The ${shape} confirmation target did not identify a submitted form.`;
  const issues = (["formIds", "formId"] as const).flatMap(path => {
    const shape = context.receivedShape[path];
    return shape === "omitted" ? [] : [{ code: "invalid_confirmation_target", path, message: targetMessage(shape) }];
  });
  return new QuestionInvalidError({
    code: "invalid_confirmation_source",
    category: "confirmation",
    message,
    retryable: true,
    issues: issues.length ? issues : [{ code: "invalid_confirmation_target", path: "formIds", message: "No submitted grouped form target was provided." }],
    context,
  });
}
