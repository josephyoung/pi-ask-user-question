import { describe, expect, it } from "vitest";
import {
  InteractionConflictError,
  createConfirmationInteraction,
  reduceInteraction,
  replayInteractions,
  type FormInteractionSnapshot,
  type SubmittedFormSnapshot,
} from "../src/interaction.js";

const forms = [{
  formId: "form-1",
  revision: 0,
  title: "Leave request",
  questions: [{ id: "reason", question: "Reason", inputType: "text", kind: "text", required: true, fieldAssist: false }],
  answer: { reason: "Personal" },
}] satisfies SubmittedFormSnapshot[];

describe("durable Submitted Form interaction", () => {
  it("keeps canonical answers unchanged until an explicit revision save", () => {
    const initial = createConfirmationInteraction("interaction-1", forms);
    expect(initial).toMatchObject({ state: "awaiting_confirmation", revision: 0, forms });

    const revising = reduceInteraction(initial, { type: "return_to_modify", expectedRevision: 0 });
    expect(revising).toMatchObject({ state: "revising", revision: 1 });
    expect(revising.forms[0]).toMatchObject({ revision: 0, answer: { reason: "Personal" } });
    expect(revising.draftAnswers).toEqual({ "form-1": { reason: "Personal" } });

    const saved = reduceInteraction(revising, {
      type: "save_revision",
      expectedRevision: 1,
      answers: { "form-1": { reason: "Medical appointment" } },
    });
    expect(saved).toMatchObject({ state: "awaiting_confirmation", revision: 2 });
    expect(saved.forms[0]).toMatchObject({ revision: 1, answer: { reason: "Medical appointment" } });
    expect(saved).not.toHaveProperty("draftAnswers");
  });

  it("cancels a revision without changing canonical answers", () => {
    const revising = reduceInteraction(
      createConfirmationInteraction("interaction-2", forms),
      { type: "return_to_modify", expectedRevision: 0 },
    );
    const cancelled = reduceInteraction(revising, { type: "cancel_revision", expectedRevision: 1 });
    expect(cancelled).toMatchObject({
      state: "awaiting_confirmation",
      revision: 2,
      forms: [{ answer: { reason: "Personal" }, revision: 0 }],
    });
  });

  it("rejects stale and invalid transitions with the authoritative projection", () => {
    const current = reduceInteraction(
      createConfirmationInteraction("interaction-3", forms),
      { type: "return_to_modify", expectedRevision: 0 },
    );
    expect(() => reduceInteraction(current, { type: "confirm", expectedRevision: 0 }))
      .toThrow(InteractionConflictError);
    try {
      reduceInteraction(current, { type: "confirm", expectedRevision: 0 });
    } catch (error) {
      expect(error).toMatchObject({ code: "stale_revision", current });
    }
    expect(() => reduceInteraction(current, { type: "confirm", expectedRevision: 1 }))
      .toThrowError(/not allowed/);
  });

  it("creates read-only terminal snapshots and stable continuation ids", () => {
    const confirmed = reduceInteraction(
      createConfirmationInteraction("interaction-4", forms),
      { type: "confirm", expectedRevision: 0 },
    );
    expect(confirmed).toMatchObject({
      state: "confirmed",
      revision: 1,
      continuationId: "interaction-4:r1",
    });
    expect(() => reduceInteraction(confirmed, { type: "cancel", expectedRevision: 1 }))
      .toThrowError(/terminal/);
  });

  it("replays only highest valid revisions and fails closed on competing open interactions", () => {
    const first = createConfirmationInteraction("interaction-a", forms);
    const firstTerminal = reduceInteraction(first, { type: "cancel", expectedRevision: 0 });
    const second = createConfirmationInteraction("interaction-b", forms);
    const third = createConfirmationInteraction("interaction-c", forms);
    const replayed = replayInteractions([
      { schemaVersion: 99, interactionId: "future" },
      firstTerminal,
      { nonsense: true },
      first,
      second,
      third,
    ]);
    expect(replayed.interactions.get("interaction-a")).toEqual(firstTerminal);
    expect(replayed.actionable).toBeUndefined();
    expect(replayed.diagnostics.map(item => item.code)).toContain("multiple_open_interactions");
    expect(replayed.diagnostics.map(item => item.code)).toContain("unsupported_snapshot_version");
  });

  it("restores one nonterminal interaction from the active branch", () => {
    const snapshot: FormInteractionSnapshot = reduceInteraction(
      createConfirmationInteraction("interaction-r", forms),
      { type: "return_to_modify", expectedRevision: 0 },
    );
    const replayed = replayInteractions([snapshot]);
    expect(replayed.actionable).toEqual(snapshot);
  });

  it("rejects interaction snapshots without any Submitted Forms", () => {
    const replayed = replayInteractions([{
      schemaVersion: 1,
      interactionId: "interaction-empty",
      revision: 0,
      state: "awaiting_confirmation",
      forms: [],
    }, {
      schemaVersion: 1,
      interactionId: "interaction-malformed-question",
      revision: 0,
      state: "awaiting_confirmation",
      forms: [{ formId: "form-bad", revision: 0, questions: [null], answer: {} }],
    }]);
    expect(replayed.actionable).toBeUndefined();
    expect(replayed.diagnostics.filter(item => item.code === "malformed_snapshot")).toHaveLength(2);
    expect(replayed.diagnostics).toContainEqual({
      code: "malformed_snapshot",
      message: "Malformed interaction snapshot",
    });
  });
});
