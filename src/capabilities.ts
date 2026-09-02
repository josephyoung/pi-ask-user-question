export type CapabilityCommand = { type: string; [key: string]: unknown };

export interface CapabilityProjection {
  lines?: string[];
  bindings?: Array<{ key: string; label?: string; command: CapabilityCommand }>;
  [key: string]: unknown;
}

export type CapabilityValidation<Answer> =
  | { ok: true; answer: Answer }
  | { ok: false; message: string };

export interface QuestionCapability<Canonical = unknown, State = unknown, Answer = unknown> {
  readonly kind: string;
  readonly version: number;
  compile(input: unknown): Canonical;
  initialize(question: Canonical): State;
  reduce(question: Canonical, state: State, command: CapabilityCommand): State;
  validate(question: Canonical, state: State): CapabilityValidation<Answer>;
  project(question: Canonical, state: State): CapabilityProjection;
  serialize(state: State): unknown;
  restore(value: unknown): State;
}

export interface SerializedCapabilityState {
  kind: string;
  version: number;
  state: unknown;
}

export type RestoredCapability =
  | { kind: "ready"; capability: QuestionCapability<any, any, any>; state: unknown }
  | {
      kind: "unavailable";
      readOnly: true;
      reason: "missing_capability" | "incompatible_version" | "invalid_state";
      snapshot: SerializedCapabilityState;
    };

const namespacedKind = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+[\/:][a-z0-9._/-]+$/i;

export class QuestionCapabilityRegistry {
  private readonly capabilities = new Map<string, QuestionCapability<any, any, any>>();

  register(capability: QuestionCapability<any, any, any>): () => void {
    if (!namespacedKind.test(capability.kind)) {
      throw new Error("Question capability kind must be namespaced, for example example/rating");
    }
    if (!Number.isInteger(capability.version) || capability.version < 1) {
      throw new Error("Question capability version must be a positive integer");
    }
    if (this.capabilities.has(capability.kind)) {
      throw new Error(`Question capability is already registered: ${capability.kind}`);
    }
    this.capabilities.set(capability.kind, capability);
    return () => {
      if (this.capabilities.get(capability.kind) === capability) this.capabilities.delete(capability.kind);
    };
  }

  get(kind: string): QuestionCapability<any, any, any> | undefined {
    return this.capabilities.get(kind);
  }

  restore(snapshot: SerializedCapabilityState): RestoredCapability {
    const capability = this.capabilities.get(snapshot.kind);
    if (!capability) {
      return { kind: "unavailable", readOnly: true, reason: "missing_capability", snapshot };
    }
    if (capability.version !== snapshot.version) {
      return { kind: "unavailable", readOnly: true, reason: "incompatible_version", snapshot };
    }
    try {
      return { kind: "ready", capability, state: capability.restore(snapshot.state) };
    } catch {
      return { kind: "unavailable", readOnly: true, reason: "invalid_state", snapshot };
    }
  }
}

export const questionCapabilities = new QuestionCapabilityRegistry();

export function registerQuestionCapability(
  capability: QuestionCapability<any, any, any>,
): () => void {
  return questionCapabilities.register(capability);
}
