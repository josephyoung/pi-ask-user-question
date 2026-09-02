import type { Answer, NormalizedQuestion } from "./types.js";
import type { SerializedCapabilityState } from "./capabilities.js";

export const FORM_INTERACTION_ENTRY = "ask-user-question.form-interaction.v1";
export const FORM_INTERACTION_SCHEMA_VERSION = 1 as const;

export type FormInteractionState =
  | "awaiting_confirmation"
  | "revising"
  | "confirmed"
  | "cancelled";

export interface SubmittedFormSnapshot {
  formId: string;
  revision: number;
  title?: string;
  questions: NormalizedQuestion[];
  answer: Record<string, Answer>;
}

export interface FormInteractionSnapshot {
  schemaVersion: typeof FORM_INTERACTION_SCHEMA_VERSION;
  interactionId: string;
  revision: number;
  state: FormInteractionState;
  forms: SubmittedFormSnapshot[];
  draftAnswers?: Record<string, Record<string, Answer>>;
  continuationId?: string;
}

export type InteractionCommand =
  | { type: "confirm"; expectedRevision: number }
  | { type: "return_to_modify"; expectedRevision: number }
  | {
      type: "save_revision";
      expectedRevision: number;
      answers: Record<string, Record<string, Answer>>;
      capabilityStates?: Record<string, Record<string, SerializedCapabilityState>>;
    }
  | { type: "cancel_revision"; expectedRevision: number }
  | { type: "cancel"; expectedRevision: number };

export class InteractionConflictError extends Error {
  constructor(
    readonly code: "stale_revision" | "invalid_transition" | "state_unavailable",
    readonly current: FormInteractionSnapshot,
    message: string,
  ) {
    super(message);
  }
}

const copyAnswers = (answer: Record<string, Answer>) => structuredClone(answer);
const copyForm = (form: SubmittedFormSnapshot): SubmittedFormSnapshot => ({
  ...form,
  questions: structuredClone(form.questions),
  answer: copyAnswers(form.answer),
});

export function createConfirmationInteraction(
  interactionId: string,
  forms: SubmittedFormSnapshot[],
): FormInteractionSnapshot {
  return {
    schemaVersion: FORM_INTERACTION_SCHEMA_VERSION,
    interactionId,
    revision: 0,
    state: "awaiting_confirmation",
    forms: forms.map(copyForm),
  };
}

export function reduceInteraction(
  current: FormInteractionSnapshot,
  command: InteractionCommand,
): FormInteractionSnapshot {
  if (command.expectedRevision !== current.revision) {
    throw new InteractionConflictError(
      "stale_revision",
      current,
      `Stale interaction revision: expected ${command.expectedRevision}, current ${current.revision}`,
    );
  }
  if (current.state === "confirmed" || current.state === "cancelled") {
    throw new InteractionConflictError("invalid_transition", current, "Interaction is terminal");
  }

  const nextRevision = current.revision + 1;
  if (current.state === "awaiting_confirmation") {
    if (command.type === "confirm") {
      return {
        ...current,
        revision: nextRevision,
        state: "confirmed",
        continuationId: `${current.interactionId}:r${nextRevision}`,
      };
    }
    if (command.type === "cancel") {
      return {
        ...current,
        revision: nextRevision,
        state: "cancelled",
        continuationId: `${current.interactionId}:r${nextRevision}`,
      };
    }
    if (command.type === "return_to_modify") {
      return {
        ...current,
        revision: nextRevision,
        state: "revising",
        forms: current.forms.map(copyForm),
        draftAnswers: Object.fromEntries(current.forms.map(form => [form.formId, copyAnswers(form.answer)])),
      };
    }
    throw new InteractionConflictError(
      "invalid_transition",
      current,
      `${command.type} is not allowed while awaiting confirmation`,
    );
  }

  if (command.type === "save_revision") {
    const expectedFormIds = new Set(current.forms.map(form => form.formId));
    if (Object.keys(command.answers).some(formId => !expectedFormIds.has(formId))) {
      throw new InteractionConflictError("state_unavailable", current, "Revision contains an unknown form");
    }
    const { draftAnswers: _draftAnswers, ...base } = current;
    return {
      ...base,
      revision: nextRevision,
      state: "awaiting_confirmation",
      forms: current.forms.map(form => ({
        ...copyForm(form),
        revision: form.revision + 1,
        answer: copyAnswers(command.answers[form.formId] ?? form.answer),
        questions: form.questions.map(question => {
          const snapshot = command.capabilityStates?.[form.formId]?.[question.id];
          return snapshot && question.capability
            ? { ...question, capability: { ...question.capability, state: snapshot.state } }
            : { ...question };
        }),
      })),
    };
  }
  if (command.type === "cancel_revision") {
    const { draftAnswers: _draftAnswers, ...base } = current;
    return {
      ...base,
      revision: nextRevision,
      state: "awaiting_confirmation",
    };
  }
  if (command.type === "cancel") {
    const { draftAnswers: _draftAnswers, ...base } = current;
    return {
      ...base,
      revision: nextRevision,
      state: "cancelled",
      continuationId: `${current.interactionId}:r${nextRevision}`,
    };
  }
  throw new InteractionConflictError(
    "invalid_transition",
    current,
    `${command.type} is not allowed while revising`,
  );
}

export interface ReplayDiagnostic {
  code: "malformed_snapshot" | "unsupported_snapshot_version" | "multiple_open_interactions";
  message: string;
}

export interface InteractionReplay {
  interactions: Map<string, FormInteractionSnapshot>;
  actionable?: FormInteractionSnapshot;
  diagnostics: ReplayDiagnostic[];
}

function isAnswer(value: unknown): value is Answer {
  return typeof value === "string"
    || typeof value === "number" && Number.isFinite(value)
    || typeof value === "boolean"
    || Array.isArray(value) && value.every(item => typeof item === "string" || typeof item === "number" && Number.isFinite(item));
}

function isOption(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const option = value as { id?: unknown; label?: unknown; children?: unknown };
  const validId = typeof option.id === "string" && option.id.length > 0
    || typeof option.id === "number" && Number.isFinite(option.id);
  return validId && typeof option.label === "string" && option.label.length > 0
    && (option.children === undefined || Array.isArray(option.children) && option.children.every(isOption));
}

function isNormalizedQuestion(value: unknown): value is NormalizedQuestion {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const normalized = value as Partial<NormalizedQuestion>;
  const validOptions = (normalized.options === undefined || Array.isArray(normalized.options) && normalized.options.every(isOption))
    && (normalized.presentationOptions === undefined || Array.isArray(normalized.presentationOptions) && normalized.presentationOptions.every(isOption));
  const validCapability = normalized.kind !== "capability"
    || typeof normalized.capability === "object" && normalized.capability !== null
      && typeof normalized.capability.kind === "string" && normalized.capability.kind.length > 0
      && Number.isInteger(normalized.capability.version);
  return typeof normalized.id === "string" && normalized.id.length > 0
    && typeof normalized.question === "string" && normalized.question.length > 0
    && typeof normalized.inputType === "string" && normalized.inputType.length > 0
    && ["text", "date", "single", "multiple", "confirm", "capability"].includes(normalized.kind ?? "")
    && typeof normalized.required === "boolean"
    && typeof normalized.fieldAssist === "boolean"
    && validOptions
    && validCapability;
}

export function isSubmittedFormSnapshot(value: unknown): value is SubmittedFormSnapshot {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const submitted = value as Partial<SubmittedFormSnapshot>;
  const questionIds = Array.isArray(submitted.questions)
    ? submitted.questions.flatMap(question => isNormalizedQuestion(question) ? [question.id] : [])
    : [];
  return typeof submitted.formId === "string" && submitted.formId.length > 0
    && Number.isInteger(submitted.revision)
    && Array.isArray(submitted.questions) && submitted.questions.length > 0
    && submitted.questions.every(isNormalizedQuestion)
    && new Set(questionIds).size === submitted.questions.length
    && typeof submitted.answer === "object" && submitted.answer !== null && !Array.isArray(submitted.answer)
    && Object.entries(submitted.answer).every(([id, answer]) => questionIds.includes(id) && isAnswer(answer));
}

export function isFormInteractionSnapshot(value: unknown): value is FormInteractionSnapshot {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Partial<FormInteractionSnapshot>;
  const validForms = Array.isArray(candidate.forms)
    && candidate.forms.length > 0
    && candidate.forms.every(isSubmittedFormSnapshot);
  return candidate.schemaVersion === FORM_INTERACTION_SCHEMA_VERSION
    && typeof candidate.interactionId === "string"
    && Number.isInteger(candidate.revision)
    && ["awaiting_confirmation", "revising", "confirmed", "cancelled"].includes(candidate.state ?? "")
    && validForms
    && (candidate.continuationId === undefined || typeof candidate.continuationId === "string");
}

export function replayInteractions(values: unknown[]): InteractionReplay {
  const diagnostics: ReplayDiagnostic[] = [];
  const interactions = new Map<string, FormInteractionSnapshot>();
  for (const value of values) {
    if (typeof value === "object" && value !== null && "schemaVersion" in value
      && (value as { schemaVersion?: unknown }).schemaVersion !== FORM_INTERACTION_SCHEMA_VERSION) {
      diagnostics.push({ code: "unsupported_snapshot_version", message: "Unsupported interaction snapshot version" });
      continue;
    }
    if (!isFormInteractionSnapshot(value)) {
      diagnostics.push({ code: "malformed_snapshot", message: "Malformed interaction snapshot" });
      continue;
    }
    const previous = interactions.get(value.interactionId);
    if (!previous || value.revision > previous.revision) interactions.set(value.interactionId, value);
  }
  const open = [...interactions.values()].filter(item => item.state === "awaiting_confirmation" || item.state === "revising");
  if (open.length > 1) {
    diagnostics.push({ code: "multiple_open_interactions", message: "More than one open interaction exists on the active branch" });
    return { interactions, diagnostics };
  }
  return open[0]
    ? { interactions, actionable: open[0], diagnostics }
    : { interactions, diagnostics };
}
