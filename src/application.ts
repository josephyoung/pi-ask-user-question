import type { AgentToolResult, ExtensionContext, Theme, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { createConfirmationCard, type ConfirmationCardOutcome } from "./confirmation.js";
import { invalidConfirmationSource, QuestionFailureBudget, QuestionInvalidError, questionCancelled } from "./errors.js";
import type { FormOutcome } from "./form.js";
import {
  createConfirmationInteraction,
  InteractionConflictError,
  isSubmittedFormSnapshot,
  reduceInteraction,
  replayInteractions,
  type FormInteractionSnapshot,
  type SubmittedFormSnapshot,
} from "./interaction.js";
import type { InteractionJournal } from "./journal.js";
import { normalizeAnswer } from "./normalize.js";
import { PendingCallCoordinator } from "./pending.js";
import { requiresCustomPresentation, ResultPresentationStore } from "./presentation.js";
import { prepareArguments as prepareCompatibilityArguments } from "./prepare.js";
import type { Answer, AskUserQuestionResult, NormalizedQuestion, NormalizedRequest, RawRequest } from "./types.js";
import { normalizeRequestStructured } from "./validation.js";

export interface QuestionToolInvocation {
  toolCallId: string;
  params: RawRequest;
  signal: AbortSignal | undefined;
  context: ExtensionContext;
}

export interface RecoveredContinuation {
  continuationId: string;
  interactionId: string;
  result: AskUserQuestionResult;
  content: string;
}

export interface ContinuationSink {
  deliver(continuation: RecoveredContinuation, context: ExtensionContext): Promise<void>;
}

export interface DurableApplicationOptions {
  journal: InteractionJournal;
  openForm: (
    request: NormalizedRequest,
    signal: AbortSignal | undefined,
    context: ExtensionContext,
    failures: QuestionFailureBudget,
  ) => Promise<FormOutcome>;
  openPrimitive?: (
    question: NormalizedQuestion,
    signal: AbortSignal | undefined,
    context: ExtensionContext,
  ) => Promise<Answer | undefined>;
  openConfirmation?: (
    snapshot: FormInteractionSnapshot,
    signal: AbortSignal | undefined,
    context: ExtensionContext,
    failures: QuestionFailureBudget,
  ) => Promise<ConfirmationCardOutcome>;
  maxRetries?: number;
  continuationSink?: ContinuationSink;
}

function resultPayload(result: AskUserQuestionResult) {
  const text = result.status === "answered"
    ? `User answered the question: ${JSON.stringify(result.answer)}.${result.formId ? ` Submitted Form ID: ${result.formId}.` : ""} Continue with this answer.`
    : result.status === "confirmed"
      ? `User confirmed the Submitted Form answers: ${JSON.stringify(result.answer)}. Continue with these authoritative answers.`
      : result.status === "invalid"
        ? JSON.stringify(result)
        : "User cancelled the question. Stop the current workflow. Do not ask another question or retry unless the user sends a new message explicitly requesting it.";
  return { content: [{ type: "text" as const, text }], details: result };
}

function latestSubmittedForms(values: unknown[]): Map<string, SubmittedFormSnapshot> {
  const forms = new Map<string, SubmittedFormSnapshot>();
  for (const value of values) {
    if (!isSubmittedFormSnapshot(value)) continue;
    const previous = forms.get(value.formId);
    if (!previous || value.revision > previous.revision) forms.set(value.formId, value);
  }
  return forms;
}

function selectForms(
  journal: InteractionJournal,
  context: ExtensionContext,
  requestedFormIds?: string[],
  selectionContext?: NormalizedRequest["confirmationContext"],
): SubmittedFormSnapshot[] {
  const submitted = latestSubmittedForms(journal.values("submitted-form", context));
  const replay = replayInteractions(journal.values("interaction", context));
  if (replay.actionable || replay.diagnostics.some(diagnostic => diagnostic.code === "multiple_open_interactions")) {
    throw invalidConfirmationSource("Another Submitted Form confirmation is already pending on the active branch", selectionContext);
  }
  const confirmed = new Set(
    [...replay.interactions.values()]
      .filter(snapshot => snapshot.state === "confirmed")
      .flatMap(snapshot => snapshot.forms.map(form => form.formId)),
  );
  const eligible = new Map(
    [...submitted.entries()].filter(([formId]) => !confirmed.has(formId)),
  );
  const selected = new Map<string, SubmittedFormSnapshot>();
  const ignoredReasons = new Set(selectionContext?.ignoredReasons ?? []);
  for (const formId of requestedFormIds ?? []) {
    const form = eligible.get(formId);
    if (form) selected.set(formId, form);
    else ignoredReasons.add("unavailable_form_id");
  }
  if (selected.size > 0) return [...selected.values()];
  const fallback = [...eligible.values()].slice(-1);
  if (!fallback.length) {
    throw invalidConfirmationSource(
      "The requested Submitted Form is missing, already confirmed, or not on the active branch",
      {
        receivedShape: selectionContext?.receivedShape ?? { formIds: "omitted", formId: "omitted" },
        ignoredReasons: [...ignoredReasons],
        fallbackAttempted: true,
      },
    );
  }
  return fallback;
}

function revisionRequest(form: SubmittedFormSnapshot): NormalizedRequest {
  const questions = structuredClone(form.questions);
  return {
    kind: "questions",
    grouped: true,
    ...(form.title ? { title: form.title } : {}),
    questions: questions.map(question => {
      const value = form.answer[question.id] ?? question.default;
      return value === undefined ? { ...question } : { ...question, default: value };
    }),
  };
}

async function openConfirmationCard(
  snapshot: FormInteractionSnapshot,
  signal: AbortSignal | undefined,
  context: ExtensionContext,
): Promise<ConfirmationCardOutcome> {
  return context.ui.custom<ConfirmationCardOutcome>((tui, theme, _keybindings, done) =>
    createConfirmationCard(tui, theme, done, snapshot, signal));
}

function confirmedResult(snapshot: FormInteractionSnapshot): Extract<AskUserQuestionResult, { status: "confirmed" }> {
  return {
    status: "confirmed",
    answer: Object.assign({}, ...snapshot.forms.map(form => form.answer)),
    confirmationOfToolCallId: snapshot.forms[0]!.formId,
    forms: snapshot.forms.map(form => ({ formId: form.formId, answer: { ...form.answer } })),
  };
}

export function terminalInteractionResult(snapshot: FormInteractionSnapshot): AskUserQuestionResult | undefined {
  if (snapshot.state === "confirmed") return confirmedResult(snapshot);
  if (snapshot.state === "cancelled") return { status: "cancelled" };
  return undefined;
}

export class DurableQuestionInteractionApplication {
  private readonly failures: QuestionFailureBudget;
  private readonly pendingCalls = new PendingCallCoordinator();
  private readonly presentation = new ResultPresentationStore();
  private readonly recovering = new Set<string>();

  constructor(private readonly options: DurableApplicationOptions) {
    this.failures = new QuestionFailureBudget(options.maxRetries ?? 10);
  }

  prepareArguments(raw: unknown): Record<string, unknown> {
    return prepareCompatibilityArguments(raw);
  }

  async execute(invocation: QuestionToolInvocation) {
    const { toolCallId, params, signal, context } = invocation;
    let request: NormalizedRequest;
    try {
      request = normalizeRequestStructured(params);
    } catch (cause) {
      throw cause instanceof QuestionInvalidError ? this.failures.validation(cause, signal) : cause;
    }
    if (!context.hasUI || context.mode !== "tui") {
      throw new Error(`ask_user_question requires interactive TUI mode; current mode is ${context.mode}`);
    }
    const releasePending = this.pendingCalls.start(toolCallId, signal);
    try {
      if (request.kind === "confirmation") {
        try {
          const result = await this.confirm(toolCallId, request.formIds, signal, context, request.confirmationContext);
          this.failures.clearValidation(signal);
          return resultPayload(result);
        } catch (cause) {
          throw cause instanceof QuestionInvalidError && cause.result.error.category === "confirmation"
            ? this.failures.validation(cause, signal)
            : cause;
        }
      }
      this.failures.clearValidation(signal);
      if (requiresCustomPresentation(request)) {
        const outcome = await this.options.openForm(request, signal, context, this.failures);
        if (signal?.aborted || outcome.kind === "aborted") throw questionCancelled();
        if (outcome.kind === "cancelled") return resultPayload({ status: "cancelled" });
        const answer = request.grouped ? outcome.answers : outcome.answers[request.questions[0]!.id]!;
        this.presentation.remember(toolCallId, request);
        if (request.grouped) {
          this.recordSubmittedForm(toolCallId, request, outcome.answers, context, outcome.capabilityStates);
          return resultPayload({ status: "answered", formId: toolCallId, answer });
        }
        return resultPayload({ status: "answered", answer });
      }
      if (!this.options.openPrimitive) throw new Error("Primitive question surface is unavailable");
      if (signal?.aborted) throw questionCancelled();
      const question = request.questions[0]!;
      const answer = await this.options.openPrimitive(question, signal, context);
      if (signal?.aborted) throw questionCancelled();
      if (answer === undefined) return resultPayload({ status: "cancelled" });
      const normalized = normalizeAnswer(question, answer) as Answer;
      this.presentation.remember(toolCallId, request);
      return resultPayload({ status: "answered", answer: normalized });
    } finally {
      releasePending();
    }
  }

  renderResult(
    result: AgentToolResult<AskUserQuestionResult>,
    options: ToolRenderResultOptions,
    theme: Theme,
    context: { args: RawRequest; toolCallId: string; state: { request?: NormalizedRequest } },
  ) {
    return this.presentation.render(result, options, theme, context);
  }

  recordSubmittedForm(
    formId: string,
    request: NormalizedRequest,
    answer: Record<string, import("./types.js").Answer>,
    context: ExtensionContext,
    capabilityStates: Record<string, import("./capabilities.js").SerializedCapabilityState> = {},
  ): SubmittedFormSnapshot {
    const snapshot: SubmittedFormSnapshot = {
      formId,
      revision: 0,
      questions: request.questions.map(question => {
        const snapshot = capabilityStates[question.id];
        return snapshot && question.capability
          ? { ...structuredClone(question), capability: { ...structuredClone(question.capability), state: structuredClone(snapshot.state) } }
          : structuredClone(question);
      }),
      answer: { ...answer },
      ...(request.title ? { title: request.title } : {}),
    };
    this.options.journal.append("submitted-form", snapshot, context);
    return snapshot;
  }

  async confirm(
    interactionId: string,
    formIds: string[] | undefined,
    signal: AbortSignal | undefined,
    context: ExtensionContext,
    selectionContext?: NormalizedRequest["confirmationContext"],
  ): Promise<AskUserQuestionResult> {
    const forms = selectForms(this.options.journal, context, formIds, selectionContext);
    let snapshot = createConfirmationInteraction(interactionId, forms);
    this.options.journal.append("interaction", snapshot, context);
    return (await this.run(snapshot, signal, context)).result;
  }

  async resume(
    snapshot: FormInteractionSnapshot,
    signal: AbortSignal | undefined,
    context: ExtensionContext,
  ): Promise<AskUserQuestionResult> {
    return (await this.run(snapshot, signal, context)).result;
  }

  async resumeWithSnapshot(
    snapshot: FormInteractionSnapshot,
    signal: AbortSignal | undefined,
    context: ExtensionContext,
    persistCancellationOnAbort = true,
  ): Promise<{ result: AskUserQuestionResult; snapshot: FormInteractionSnapshot }> {
    return this.run(snapshot, signal, context, persistCancellationOnAbort);
  }

  actionable(context: ExtensionContext): FormInteractionSnapshot | undefined {
    const replay = replayInteractions(this.options.journal.values("interaction", context));
    return replay.diagnostics.some(diagnostic => diagnostic.code === "multiple_open_interactions")
      ? undefined
      : replay.actionable;
  }

  private recoveryCandidate(context: ExtensionContext): { snapshot: FormInteractionSnapshot; needsInteraction: boolean } | undefined {
    const replay = replayInteractions(this.options.journal.values("interaction", context));
    if (replay.diagnostics.some(diagnostic => diagnostic.code === "multiple_open_interactions")) return undefined;
    if (replay.actionable) return { snapshot: replay.actionable, needsInteraction: true };
    const continued = new Set((this.options.journal.values("continuation", context) as Array<{ continuationId?: unknown }>)
      .flatMap(value => typeof value?.continuationId === "string" ? [value.continuationId] : []));
    const terminal = [...replay.interactions.values()]
      .filter(snapshot => snapshot.continuationId
        && !continued.has(snapshot.continuationId)
        && !this.options.journal.hasToolResult?.(snapshot.interactionId, context))
      .sort((left, right) => right.revision - left.revision)[0];
    return terminal ? { snapshot: terminal, needsInteraction: false } : undefined;
  }

  async recoverCurrentBranch(
    context: ExtensionContext,
    signal?: AbortSignal,
  ): Promise<{ snapshot: FormInteractionSnapshot; result: AskUserQuestionResult; continuation: RecoveredContinuation } | undefined> {
    const recovery = this.recoveryCandidate(context);
    if (!recovery || this.recovering.has(recovery.snapshot.interactionId)) return undefined;
    this.recovering.add(recovery.snapshot.interactionId);
    try {
      const resumed = recovery.needsInteraction
        ? await this.resumeWithSnapshot(recovery.snapshot, signal, context, false)
        : { snapshot: recovery.snapshot, result: terminalInteractionResult(recovery.snapshot) };
      if (signal?.aborted || !resumed.result) return undefined;
      const continuationId = resumed.snapshot.continuationId
        ?? `${recovery.snapshot.interactionId}:r${resumed.snapshot.revision}`;
      const continuation: RecoveredContinuation = {
        continuationId,
        interactionId: recovery.snapshot.interactionId,
        result: resumed.result,
        content: resumed.result.status === "confirmed"
          ? `Recovered Submitted Form confirmation completed with authoritative answers: ${JSON.stringify(resumed.result.answer)}.`
          : "Recovered Submitted Form confirmation was cancelled by the user.",
      };
      if (!this.options.continuationSink) throw new Error("Recovered continuation sink is unavailable");
      await this.options.continuationSink.deliver(continuation, context);
      return { snapshot: resumed.snapshot, result: resumed.result, continuation };
    } finally {
      this.recovering.delete(recovery.snapshot.interactionId);
    }
  }

  private authoritative(snapshot: FormInteractionSnapshot, context: ExtensionContext): FormInteractionSnapshot {
    return replayInteractions(this.options.journal.values("interaction", context)).interactions.get(snapshot.interactionId) ?? snapshot;
  }

  private transition(
    snapshot: FormInteractionSnapshot,
    command: Parameters<typeof reduceInteraction>[1],
    context: ExtensionContext,
  ): FormInteractionSnapshot {
    const current = this.authoritative(snapshot, context);
    const next = reduceInteraction(current, { ...command, expectedRevision: snapshot.revision });
    this.options.journal.append("interaction", next, context);
    return next;
  }

  private cancelForAbort(snapshot: FormInteractionSnapshot, context: ExtensionContext): FormInteractionSnapshot {
    const current = this.authoritative(snapshot, context);
    if (current.state === "confirmed" || current.state === "cancelled") return current;
    const cancelled = reduceInteraction(current, { type: "cancel", expectedRevision: current.revision });
    this.options.journal.append("interaction", cancelled, context);
    return cancelled;
  }

  private async run(
    initial: FormInteractionSnapshot,
    signal: AbortSignal | undefined,
    context: ExtensionContext,
    persistCancellationOnAbort = true,
  ): Promise<{ result: AskUserQuestionResult; snapshot: FormInteractionSnapshot }> {
    let snapshot = initial;
    while (true) {
      if (signal?.aborted) {
        if (persistCancellationOnAbort) this.cancelForAbort(snapshot, context);
        throw questionCancelled();
      }
      if (snapshot.state === "revising") {
        const answers: Record<string, Record<string, import("./types.js").Answer>> = {};
        const capabilityStates: Record<string, Record<string, import("./capabilities.js").SerializedCapabilityState>> = {};
        let cancelled = false;
        for (const form of snapshot.forms) {
          let outcome: FormOutcome;
          try {
            outcome = await this.options.openForm(revisionRequest(form), signal, context, this.failures);
          } catch (cause) {
            if (signal?.aborted || cause instanceof QuestionInvalidError && cause.result.error.code === "question_cancelled") {
              if (persistCancellationOnAbort) this.cancelForAbort(snapshot, context);
            }
            throw cause;
          }
          if (outcome.kind === "aborted") {
            if (persistCancellationOnAbort) this.cancelForAbort(snapshot, context);
            throw questionCancelled();
          }
          if (outcome.kind === "cancelled") {
            cancelled = true;
            break;
          }
          answers[form.formId] = outcome.answers;
          capabilityStates[form.formId] = outcome.capabilityStates;
        }
        try {
          snapshot = this.transition(snapshot, {
            type: cancelled ? "cancel_revision" : "save_revision",
            expectedRevision: snapshot.revision,
            ...(cancelled ? {} : { answers, capabilityStates }),
          } as Parameters<typeof reduceInteraction>[1], context);
          if (!cancelled) {
            for (const form of snapshot.forms) {
              this.options.journal.append("submitted-form", structuredClone(form), context);
            }
          }
        } catch (cause) {
          if (!(cause instanceof InteractionConflictError) || cause.code !== "stale_revision") throw cause;
          snapshot = cause.current;
        }
        continue;
      }

      if (snapshot.state === "confirmed") return { result: confirmedResult(snapshot), snapshot };
      if (snapshot.state === "cancelled") return { result: { status: "cancelled" }, snapshot };
      let outcome: ConfirmationCardOutcome;
      try {
        outcome = this.options.openConfirmation
          ? await this.options.openConfirmation(snapshot, signal, context, this.failures)
          : await openConfirmationCard(snapshot, signal, context);
      } catch (cause) {
        if (signal?.aborted || cause instanceof QuestionInvalidError && cause.result.error.code === "question_cancelled") {
          if (persistCancellationOnAbort) this.cancelForAbort(snapshot, context);
        }
        throw cause;
      }
      if (outcome.kind === "aborted") {
        if (persistCancellationOnAbort) this.cancelForAbort(snapshot, context);
        throw questionCancelled();
      }
      try {
        snapshot = this.transition(snapshot, {
          type: outcome.kind,
          expectedRevision: snapshot.revision,
        }, context);
      } catch (cause) {
        if (!(cause instanceof InteractionConflictError) || cause.code !== "stale_revision") throw cause;
        snapshot = cause.current;
        continue;
      }
      if (snapshot.state === "confirmed") return { result: confirmedResult(snapshot), snapshot };
      if (snapshot.state === "cancelled") return { result: { status: "cancelled" }, snapshot };
    }
  }
}
