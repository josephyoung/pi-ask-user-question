import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Text, type Component, type TUI } from "@earendil-works/pi-tui";
import { description, parameters, promptGuidelines, promptSnippet } from "./contract.js";
import { createQuestionForm, type FormOutcome } from "./form.js";
import { isOtherOption } from "./normalize.js";
import { groupedRetryError } from "./pending.js";
import { displayQuestionAnswer, formatDisplayed } from "./presentation.js";
import { createFieldAssistService, type FieldAssistModel } from "./field-assist.js";
import { createPiIsolatedFieldAssistModel } from "./field-assist-pi.js";
import { DurableQuestionInteractionApplication, type ContinuationSink } from "./application.js";
import { InMemoryInteractionJournal, JOURNAL_CUSTOM_TYPES, PiInteractionJournal, type InteractionJournal } from "./journal.js";
import { isFormInteractionSnapshot, isSubmittedFormSnapshot, type FormInteractionSnapshot, type SubmittedFormSnapshot } from "./interaction.js";
import { createAgentDataSourceCredentialResolver, type DataSourceCredentialResolver } from "./data-source-auth.js";
import { createConfirmationCard, type ConfirmationCardOutcome } from "./confirmation.js";
import type { RemoteOptionTransport } from "./data-source.js";
import { QuestionFailureBudget, questionCancelled } from "./errors.js";
import type { NormalizedQuestion, NormalizedRequest, RawRequest } from "./types.js";

export const ASK_USER_QUESTION_TOOL_NAME = "ask_user_question";
export { groupedRetryError };

async function primitive(question: NormalizedQuestion, signal: AbortSignal | undefined, ctx: ExtensionContext) {
  const opts = signal ? { signal } : undefined;
  if (question.kind === "confirm") return await ctx.ui.confirm(question.question, "", opts);
  if (question.inputType === "textarea") return await ctx.ui.editor(question.question, typeof question.default === "string" ? question.default : "");
  if (question.kind === "text") return await ctx.ui.input(question.question, typeof question.default === "string" ? question.default : undefined, opts);
  const originalOptions = question.options ?? [];
  const recommendedIndex = originalOptions.findIndex(option => option.id === question.default);
  const options = recommendedIndex > 0
    ? [originalOptions[recommendedIndex]!, ...originalOptions.filter((_, index) => index !== recommendedIndex)]
    : originalOptions;
  const labels = options.map(option => option.label);
  const selected = await ctx.ui.select(question.question, labels, opts);
  if (selected === undefined) return undefined;
  const option = options[labels.indexOf(selected)];
  if (option && isOtherOption(option)) {
    const custom = await ctx.ui.input("Other", undefined, opts);
    return custom;
  }
  return option?.id ?? selected;
}

async function custom(
  request: NormalizedRequest,
  signal: AbortSignal | undefined,
  ctx: ExtensionContext,
  fieldAssistModelFactory?: (ctx: ExtensionContext) => FieldAssistModel,
  dataSourceCredentials?: DataSourceCredentialResolver,
  remoteOptionTransport?: RemoteOptionTransport,
  failures?: QuestionFailureBudget,
  presentationTimeoutMs = 5_000,
): Promise<FormOutcome> {
  const model = fieldAssistModelFactory?.(ctx) ?? createPiIsolatedFieldAssistModel({
    cwd: ctx.cwd,
    model: ctx.model,
    modelRegistry: ctx.modelRegistry,
  });
  const fieldAssist = createFieldAssistService({ model });
  return presentCustom(ctx, signal, failures, presentationTimeoutMs, (tui, theme, done, scopedSignal) => createQuestionForm(
    tui, theme, done, request, scopedSignal,
    {
      fieldAssist: (input, options) => fieldAssist.assist(input, options),
      ...(dataSourceCredentials ? { dataSourceCredentials } : {}),
      ...(remoteOptionTransport ? { remoteOptionTransport } : {}),
    },
  ));
}

async function presentCustom<T>(
  ctx: ExtensionContext,
  signal: AbortSignal | undefined,
  failures: QuestionFailureBudget | undefined,
  presentationTimeoutMs: number,
  factory: (tui: TUI, theme: Theme, done: (value: T) => void, signal: AbortSignal) => Component & { dispose?(): void },
): Promise<T> {
  const controller = new AbortController();
  let rejectAbort!: (cause: Error) => void;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const abort = () => {
    controller.abort();
    rejectAbort(questionCancelled());
  };
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  let acknowledge!: () => void;
  const acknowledged = new Promise<void>(resolve => { acknowledge = resolve; });
  let interaction: Promise<T>;
  try {
    interaction = ctx.ui.custom<T>((tui, theme, _keybindings, done) => {
      acknowledge();
      return factory(tui, theme, done, controller.signal);
    });
  } catch (cause) {
    signal?.removeEventListener("abort", abort);
    controller.abort();
    throw cause;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      acknowledged,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(failures?.presentation(signal) ?? new Error("Question presentation timed out")), presentationTimeoutMs);
      }),
      interaction.then(
        () => new Promise<never>(() => undefined),
        cause => Promise.reject(cause),
      ),
      aborted,
    ]);
    if (timer) clearTimeout(timer);
    failures?.clearPresentation(signal);
    return await interaction;
  } catch (cause) {
    controller.abort();
    void interaction.catch(() => undefined);
    throw cause;
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

function confirmation(
  snapshot: FormInteractionSnapshot,
  signal: AbortSignal | undefined,
  ctx: ExtensionContext,
  failures: QuestionFailureBudget,
  presentationTimeoutMs: number,
): Promise<ConfirmationCardOutcome> {
  return presentCustom(ctx, signal, failures, presentationTimeoutMs, (tui, theme, done, scopedSignal) =>
    createConfirmationCard(tui, theme, done, snapshot, scopedSignal));
}

export function createTool(options: {
  fieldAssistModelFactory?: (ctx: ExtensionContext) => FieldAssistModel;
  journal?: InteractionJournal;
  dataSourceCredentials?: DataSourceCredentialResolver;
  remoteOptionTransport?: RemoteOptionTransport;
  maxRetries?: number;
  presentationTimeoutMs?: number;
  application?: DurableQuestionInteractionApplication;
} = {}) {
  const application = options.application ?? createApplication(options);
  return {
    name: ASK_USER_QUESTION_TOOL_NAME,
    label: "Ask User Question",
    description,
    promptSnippet,
    promptGuidelines,
    parameters,
    prepareArguments: application.prepareArguments.bind(application),
    executionMode: "sequential" as const,
    async execute(toolCallId: string, params: RawRequest, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
      return application.execute({ toolCallId, params, signal, context: ctx });
    },
    renderResult: application.renderResult.bind(application),
  };
}

function createApplication(options: {
  fieldAssistModelFactory?: (ctx: ExtensionContext) => FieldAssistModel;
  journal?: InteractionJournal;
  dataSourceCredentials?: DataSourceCredentialResolver;
  remoteOptionTransport?: RemoteOptionTransport;
  maxRetries?: number;
  presentationTimeoutMs?: number;
  continuationSink?: ContinuationSink;
}) {
  const journal = options.journal ?? new InMemoryInteractionJournal();
  const presentationTimeoutMs = options.presentationTimeoutMs ?? 5_000;
  return new DurableQuestionInteractionApplication({
    journal,
    ...(options.maxRetries === undefined ? {} : { maxRetries: options.maxRetries }),
    ...(options.continuationSink ? { continuationSink: options.continuationSink } : {}),
    openPrimitive: primitive,
    openForm: (request, signal, ctx, failures) => {
      if (typeof ctx.ui.custom !== "function") throw new Error("ask_user_question requires ctx.ui.custom() for grouped or advanced interactions");
      return custom(
        request,
        signal,
        ctx,
        options.fieldAssistModelFactory,
        options.dataSourceCredentials,
        options.remoteOptionTransport,
        failures,
        presentationTimeoutMs,
      );
    },
    openConfirmation: (snapshot, signal, ctx, failures) => {
      if (typeof ctx.ui.custom !== "function") throw new Error("ask_user_question confirmation requires ctx.ui.custom()");
      return confirmation(snapshot, signal, ctx, failures, presentationTimeoutMs);
    },
  });
}

export function installAskUserQuestion(pi: ExtensionAPI) {
  const journal = new PiInteractionJournal(pi);
  const dataSourceCredentials = createAgentDataSourceCredentialResolver();
  const continuationSink: ContinuationSink = {
    deliver: async (continuation, context) => {
      pi.sendMessage({
        customType: JOURNAL_CUSTOM_TYPES.continuation,
        display: true,
        content: continuation.content,
        details: {
          continuationId: continuation.continuationId,
          interactionId: continuation.interactionId,
          result: continuation.result,
        },
      }, { triggerTurn: true });
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const persisted = journal.values("continuation", context)
          .some(value => typeof value === "object" && value !== null
            && (value as { continuationId?: unknown }).continuationId === continuation.continuationId);
        if (persisted) return;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      throw new Error("Recovered continuation was not observed in the active branch journal");
    },
  };
  const application = createApplication({ journal, dataSourceCredentials, continuationSink });
  pi.registerTool(createTool({ application }));
  pi.registerEntryRenderer<SubmittedFormSnapshot>(JOURNAL_CUSTOM_TYPES["submitted-form"], (entry, options, theme) => {
    const form = entry.data;
    return isSubmittedFormSnapshot(form)
      ? new Text(theme.fg("muted", `Submitted Form · ${form.title ?? form.formId} · revision ${form.revision}`), 0, 0)
      : new Text(theme.fg("warning", "Submitted Form · unavailable snapshot"), 0, 0);
  });
  pi.registerEntryRenderer<unknown>(JOURNAL_CUSTOM_TYPES.interaction, (entry, options, theme) => {
    const interaction = entry.data;
    if (!isFormInteractionSnapshot(interaction)) {
      return new Text(theme.fg("warning", "Form confirmation · unavailable snapshot"), 0, 0);
    }
    const lines = [`Form confirmation · ${interaction.state} · revision ${interaction.revision}`];
    if (options.expanded) {
      for (const form of interaction.forms) {
        lines.push(form.title ?? form.formId);
        for (const question of form.questions) {
          const value = form.answer[question.id];
          lines.push(`  ${question.question}: ${value === undefined ? "(optional)" : formatDisplayed(displayQuestionAnswer(question, value))}`);
        }
      }
    }
    return new Text(theme.fg(interaction.state === "confirmed" ? "success" : "muted", lines.join("\n")), 0, 0);
  });
  const recoveryRuns = new Set<{ controller: AbortController; promise: Promise<void> }>();
  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI || ctx.mode !== "tui") return;
    const controller = new AbortController();
    const promise = new Promise<void>(resolve => setTimeout(resolve, 0)).then(async () => {
        await application.recoverCurrentBranch(ctx, controller.signal);
      }).catch(() => {
        if (!controller.signal.aborted) ctx.ui.notify("Unable to restore the pending question interaction.", "error");
      }).finally(() => {
        recoveryRuns.delete(run);
      });
    const run = { controller, promise };
    recoveryRuns.add(run);
  });
  pi.on("session_shutdown", async () => {
    const active = [...recoveryRuns];
    for (const run of active) run.controller.abort();
    await Promise.allSettled(active.map(run => run.promise));
  });
}

export default installAskUserQuestion;

export { description, parameters, promptGuidelines, promptSnippet } from "./contract.js";
export { fetchRemoteOptionTransport, loadOptions } from "./data-source.js";
export type { RemoteOptionTransport } from "./data-source.js";
export {
  DATA_SOURCE_AUTH_CONFIG_FILE,
  createDataSourceCredentialResolver,
  fetchWithDataSourceCredentials,
  loadDataSourceAuthConfig,
} from "./data-source-auth.js";
export { normalizeAnswer, normalizeRequest } from "./normalize.js";
export { collectQuestionIssues, normalizeRequestStructured } from "./validation.js";
export { prepareArguments } from "./prepare.js";
export {
  QuestionCapabilityRegistry,
  questionCapabilities,
  registerQuestionCapability,
} from "./capabilities.js";
export type {
  CapabilityCommand,
  CapabilityValidation,
  QuestionCapability,
  RestoredCapability,
  SerializedCapabilityState,
} from "./capabilities.js";
export type * from "./types.js";
