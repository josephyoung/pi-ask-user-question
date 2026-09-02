import { describe, expect, it } from "vitest";
import {
  QuestionCapabilityRegistry,
  type QuestionCapability,
} from "../src/capabilities.js";

type Rating = { min: number; max: number };
type RatingState = { value: number };

const ratingCapability: QuestionCapability<Rating, RatingState, number> = {
  kind: "example/rating",
  version: 1,
  compile(input) {
    const record = input as Record<string, unknown>;
    return { min: Number(record.min ?? 1), max: Number(record.max ?? 5) };
  },
  initialize(question) { return { value: question.min }; },
  reduce(_question, state, command) {
    return command.type === "set" ? { value: Number(command.value) } : state;
  },
  validate(question, state) {
    return state.value >= question.min && state.value <= question.max
      ? { ok: true, answer: state.value }
      : { ok: false, message: "Rating is out of range" };
  },
  project(question, state) { return { kind: "rating", label: `${state.value}/${question.max}` }; },
  serialize(state) { return state; },
  restore(value) {
    const state = value as RatingState;
    if (!Number.isFinite(state?.value)) throw new Error("Invalid rating state");
    return state;
  },
};

describe("public Question capability registry", () => {
  it("registers a namespaced, versioned field capability", () => {
    const registry = new QuestionCapabilityRegistry();
    const unregister = registry.register(ratingCapability);
    expect(registry.get("example/rating")).toBe(ratingCapability);
    expect(() => registry.register(ratingCapability)).toThrow(/already registered/);
    unregister();
    expect(registry.get("example/rating")).toBeUndefined();
  });

  it("rejects unnamespaced or unversioned capabilities", () => {
    const registry = new QuestionCapabilityRegistry();
    expect(() => registry.register({ ...ratingCapability, kind: "rating" })).toThrow(/namespaced/);
    expect(() => registry.register({ ...ratingCapability, version: 0 })).toThrow(/version/);
  });

  it("restores matching state and fails closed when a capability is missing or incompatible", () => {
    const registry = new QuestionCapabilityRegistry();
    registry.register(ratingCapability);
    expect(registry.restore({ kind: "example/rating", version: 1, state: { value: 4 } })).toEqual({
      kind: "ready",
      capability: ratingCapability,
      state: { value: 4 },
    });
    expect(registry.restore({ kind: "missing/field", version: 1, state: { value: 4 } })).toMatchObject({
      kind: "unavailable",
      readOnly: true,
      reason: "missing_capability",
    });
    expect(registry.restore({ kind: "example/rating", version: 2, state: { value: 4 } })).toMatchObject({
      kind: "unavailable",
      readOnly: true,
      reason: "incompatible_version",
    });
  });
});
