import { describe, expect, it, vi } from "vitest";
import { DurableQuestionInteractionApplication } from "../src/application.js";
import type { ConfirmationCardOutcome } from "../src/confirmation.js";
import { createTool } from "../src/index.js";
import { createConfirmationInteraction, reduceInteraction } from "../src/interaction.js";
import { InMemoryInteractionJournal } from "../src/journal.js";

const theme = {
  fg: (_name: string, text: string) => text,
  bg: (_name: string, text: string) => text,
  bold: (text: string) => text,
};
const tui = { requestRender: vi.fn(), terminal: { rows: 30 } };
type Surface = { render(width: number): string[]; handleInput(data: string): void; dispose?(): void };

function context(interact: (surface: Surface, callIndex: number) => void | Promise<void>) {
  let callIndex = 0;
  return {
    mode: "tui",
    hasUI: true,
    cwd: "/tmp/project",
    model: undefined,
    ui: {
      input: vi.fn(), editor: vi.fn(), select: vi.fn(), confirm: vi.fn(),
      custom: vi.fn(async (factory: any) => new Promise(resolve => {
        const surface = factory(tui, theme, {}, resolve) as Surface;
        void Promise.resolve(interact(surface, callIndex++)).catch(error => { throw error; });
      })),
    },
  } as any;
}

async function submitGrouped(tool: ReturnType<typeof createTool>, ctx: any, id = "form-1") {
  return tool.execute(id, {
    title: "Leave request",
    questions: [{ id: "reason", question: "Reason", default: "Personal", required: true }],
  }, undefined, undefined, ctx);
}

describe("Durable question application", () => {
  it("records grouped submissions and confirms their authoritative answers", async () => {
    const journal = new InMemoryInteractionJournal();
    const tool = createTool({ journal });
    const ctx = context((surface, call) => {
      if (call === 0) surface.handleInput("\u0013");
      else {
        expect(surface.render(90).join("\n")).toContain("Leave request");
        expect(surface.render(90).join("\n")).toContain("Reason: Personal");
        surface.handleInput("\r");
      }
    });

    const submitted = await submitGrouped(tool, ctx);
    expect(submitted.details).toEqual({
      status: "answered",
      formId: "form-1",
      answer: { reason: "Personal" },
    });

    const confirmed = await tool.execute("confirm-1", {
      confirm: true,
      formIds: ["form-1"],
    }, undefined, undefined, ctx);
    expect(confirmed.details).toEqual({
      status: "confirmed",
      answer: { reason: "Personal" },
      confirmationOfToolCallId: "form-1",
      forms: [{ formId: "form-1", answer: { reason: "Personal" } }],
    });
    expect(journal.values("interaction").at(-1)).toMatchObject({ state: "confirmed" });
  });

  it("returns to modify, saves a new revision, and reconfirms the full card", async () => {
    const journal = new InMemoryInteractionJournal();
    const tool = createTool({ journal });
    const ctx = context((surface, call) => {
      if (call === 0) { surface.handleInput("\u0013"); return; }
      if (call === 1) {
        surface.handleInput("\u001b[B");
        surface.handleInput("\r");
        return;
      }
      if (call === 2) {
        surface.handleInput("\u0015");
        surface.handleInput("Medical appointment");
        surface.handleInput("\u0013");
        return;
      }
      expect(surface.render(90).join("\n")).toContain("Reason: Medical appointment");
      surface.handleInput("\r");
    });

    await submitGrouped(tool, ctx);
    const result = await tool.execute("confirm-revision", { confirm: true, formIds: ["form-1"] }, undefined, undefined, ctx);
    expect(result.details).toMatchObject({
      status: "confirmed",
      forms: [{ formId: "form-1", answer: { reason: "Medical appointment" } }],
    });
    expect(journal.values("interaction").map(value => (value as any).state)).toEqual([
      "awaiting_confirmation",
      "revising",
      "awaiting_confirmation",
      "confirmed",
    ]);
  });

  it("uses a saved revision as the authoritative source after the first confirmation is cancelled", async () => {
    const journal = new InMemoryInteractionJournal();
    const submitted = {
      formId: "form-revised", revision: 0,
      questions: [{ id: "reason", question: "Reason", inputType: "text", kind: "text", required: true, fieldAssist: false }],
      answer: { reason: "Old" },
    } as any;
    journal.append("submitted-form", submitted);
    const outcomes: ConfirmationCardOutcome[] = [
      { kind: "return_to_modify" },
      { kind: "cancel" },
      { kind: "confirm" },
    ];
    const openConfirmation = vi.fn(async (_snapshot: any) => outcomes.shift()!);
    const application = new DurableQuestionInteractionApplication({
      journal,
      openForm: vi.fn(async () => ({
        kind: "answered", answers: { reason: "New" }, capabilityStates: {}, disposeCount: 1,
      } as const)),
      openConfirmation,
    });

    await expect(application.confirm("confirm-revise-cancel", ["form-revised"], undefined, {} as any))
      .resolves.toEqual({ status: "cancelled" });
    const confirmed = await application.confirm("confirm-later", ["form-revised"], undefined, {} as any);

    expect(confirmed).toMatchObject({ status: "confirmed", answer: { reason: "New" } });
    expect((openConfirmation.mock.calls[2]?.[0] as any).forms[0]).toMatchObject({
      formId: "form-revised", revision: 1, answer: { reason: "New" },
    });
    expect(journal.values("submitted-form")).toHaveLength(2);
  });

  it("ignores unavailable requested form IDs and falls back to the latest eligible form", async () => {
    const journal = new InMemoryInteractionJournal();
    const makeForm = (formId: string) => ({
      formId, revision: 0,
      questions: [{ id: "value", question: "Value", inputType: "text", kind: "text", required: true, fieldAssist: false }],
      answer: { value: formId },
    }) as any;
    journal.append("submitted-form", makeForm("form-a"));
    journal.append("submitted-form", makeForm("form-b"));
    const application = new DurableQuestionInteractionApplication({
      journal,
      openForm: vi.fn(),
      openConfirmation: vi.fn(async () => ({ kind: "confirm" } as const)),
    });

    const partial = await application.confirm("confirm-partial", ["missing", "form-a"], undefined, {} as any);
    expect(partial).toMatchObject({ status: "confirmed", forms: [{ formId: "form-a" }] });

    const fallback = await application.confirm("confirm-fallback", ["missing"], undefined, {} as any);
    expect(fallback).toMatchObject({ status: "confirmed", forms: [{ formId: "form-b" }] });
  });

  it("restores submitted form eligibility through a new application instance", async () => {
    const journal = new InMemoryInteractionJournal();
    const submitCtx = context(surface => surface.handleInput("\u0013"));
    await submitGrouped(createTool({ journal }), submitCtx);

    const restoreCtx = context(surface => surface.handleInput("\r"));
    const result = await createTool({ journal }).execute("confirm-restored", {
      confirm: true,
      formIds: ["form-1"],
    }, undefined, undefined, restoreCtx);
    expect(result.details).toMatchObject({ status: "confirmed", confirmationOfToolCallId: "form-1" });
  });

  it("rejects ordinary confirm:true when no Submitted Form is eligible", async () => {
    const tool = createTool({ journal: new InMemoryInteractionJournal() });
    await expect(tool.execute("ordinary", {
      question: "Proceed?",
      confirm: true,
    }, undefined, undefined, context(() => {}))).rejects.toSatisfy((error: unknown) => {
      const parsed = JSON.parse((error as Error).message);
      return parsed.status === "invalid"
        && parsed.error.code === "invalid_confirmation_source"
        && parsed.error.retryable === true;
    });
  });

  it("returns Dano-compatible confirmation target shapes, reasons, fallback, and issue paths", async () => {
    const tool = createTool({ journal: new InMemoryInteractionJournal() });
    let caught: unknown;
    try {
      await tool.execute("invalid-targets", {
        confirm: true,
        formIds: { secret: "must-not-serialize" },
        formId: "missing-form",
      }, undefined, undefined, context(() => {}));
    } catch (cause) {
      caught = cause;
    }
    const parsed = JSON.parse((caught as Error).message);
    expect(parsed.error).toMatchObject({
      code: "invalid_confirmation_source",
      issues: [
        { code: "invalid_confirmation_target", path: "formIds" },
        { code: "invalid_confirmation_target", path: "formId" },
      ],
      context: {
        receivedShape: { formIds: "object", formId: "string" },
        ignoredReasons: expect.arrayContaining(["malformed_formIds", "unavailable_form_id"]),
        fallbackAttempted: true,
      },
    });
    expect(JSON.stringify(parsed)).not.toContain("must-not-serialize");
    expect(JSON.stringify(parsed)).not.toContain("missing-form");
  });

  it("rejects a second confirmation while another interaction is open", async () => {
    const journal = new InMemoryInteractionJournal();
    const ctx = context(surface => surface.handleInput("\u0013"));
    await submitGrouped(createTool({ journal }), ctx);
    const submitted = journal.values("submitted-form")[0] as Parameters<typeof createConfirmationInteraction>[1][number];
    journal.append("interaction", createConfirmationInteraction("confirm-open", [submitted]));

    await expect(createTool({ journal }).execute("confirm-second", {
      confirm: true,
      formIds: ["form-1"],
    }, undefined, undefined, ctx)).rejects.toSatisfy((error: unknown) => {
      const parsed = JSON.parse((error as Error).message);
      return parsed.status === "invalid"
        && parsed.error.code === "invalid_confirmation_source"
        && parsed.error.message.includes("already pending");
    });
  });

  it("persists cancellation before an aborted confirmation rejects", async () => {
    const journal = new InMemoryInteractionJournal();
    const ctx = context((surface, call) => {
      if (call === 0) surface.handleInput("\u0013");
      else surface.handleInput("\u0003");
    });
    const tool = createTool({ journal });
    await submitGrouped(tool, ctx);
    await expect(tool.execute("confirm-abort", {
      confirm: true,
      formIds: ["form-1"],
    }, undefined, undefined, ctx)).rejects.toSatisfy((error: unknown) => {
      return JSON.parse((error as Error).message).error.code === "question_cancelled";
    });
    expect(journal.values("interaction").at(-1)).toMatchObject({ state: "cancelled" });
  });

  it("rejects a stale action in place and adopts the authoritative journal revision", async () => {
    const journal = new InMemoryInteractionJournal();
    const submitted = {
      formId: "form-stale", revision: 0,
      questions: [{ id: "reason", question: "Reason", inputType: "text", kind: "text", required: true, fieldAssist: false }],
      answer: { reason: "Personal" },
    } as const;
    const initial = createConfirmationInteraction("confirm-stale", [submitted as any]);
    journal.append("interaction", initial);
    const authoritative = reduceInteraction(initial, { type: "confirm", expectedRevision: 0 });
    const application = new DurableQuestionInteractionApplication({
      journal,
      openForm: vi.fn(),
      openConfirmation: vi.fn(async () => {
        journal.append("interaction", authoritative);
        return { kind: "confirm" } as const;
      }),
    });
    const result = await application.resume(initial, undefined, {} as any);
    expect(result).toMatchObject({ status: "confirmed", answer: { reason: "Personal" } });
    expect(journal.values("interaction").filter(value => (value as any).revision === 1)).toHaveLength(1);
  });

  it("owns recovered continuation delivery and deduplicates through the journal seam", async () => {
    const journal = new InMemoryInteractionJournal();
    const submitted = {
      formId: "form-terminal", revision: 0,
      questions: [{ id: "reason", question: "Reason", inputType: "text", kind: "text", required: true, fieldAssist: false }],
      answer: { reason: "Personal" },
    } as any;
    const terminal = reduceInteraction(
      createConfirmationInteraction("confirm-terminal", [submitted]),
      { type: "confirm", expectedRevision: 0 },
    );
    journal.append("interaction", terminal);
    const deliver = vi.fn(async (continuation: any) => {
      journal.append("continuation", { continuationId: continuation.continuationId });
    });
    const application = new DurableQuestionInteractionApplication({
      journal, openForm: vi.fn(), continuationSink: { deliver },
    });
    const recovered = await application.recoverCurrentBranch({} as any);
    expect(recovered).toMatchObject({
      result: { status: "confirmed", answer: { reason: "Personal" } },
      continuation: { continuationId: "confirm-terminal:r1" },
    });
    await expect(application.recoverCurrentBranch({} as any)).resolves.toBeUndefined();
    expect(deliver).toHaveBeenCalledOnce();
  });
});
