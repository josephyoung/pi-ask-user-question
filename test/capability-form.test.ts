import { describe, expect, it, vi } from "vitest";
import { registerQuestionCapability } from "../src/capabilities.js";
import { createTool } from "../src/index.js";
import { InMemoryInteractionJournal } from "../src/journal.js";

const theme = { fg: (_name: string, text: string) => text, bg: (_name: string, text: string) => text, bold: (text: string) => text };

describe("Question capability form integration", () => {
  it("compiles, runs, validates, and persists a public capability field", async () => {
    const unregister = registerQuestionCapability({
      kind: "example/rating",
      version: 1,
      compile(input) {
        const raw = input as { min?: number; max?: number };
        return { min: Number(raw.min ?? 1), max: Number(raw.max ?? 5) };
      },
      initialize(question) { return { value: question.min }; },
      reduce(_question, state, command) { return command.type === "up" ? { value: state.value + 1 } : state; },
      validate(question, state) { return state.value <= question.max ? { ok: true, answer: state.value } : { ok: false, message: "Too high" }; },
      project(question, state) {
        return { lines: [`Rating ${state.value}/${question.max}`], bindings: [{ key: "]", label: "increase", command: { type: "up" } }] };
      },
      serialize(state) { return state; },
      restore(value) {
        const state = value as { value: number };
        if (!Number.isFinite(state?.value)) throw new Error("invalid");
        return state;
      },
    });
    try {
      const journal = new InMemoryInteractionJournal();
      const tool = createTool({ journal });
      const ctx = {
        mode: "tui", hasUI: true, cwd: "/tmp", model: undefined,
        ui: {
          custom: vi.fn(async (factory: any) => new Promise(resolve => {
            const surface = factory({ requestRender: vi.fn(), terminal: { rows: 30 } }, theme, {}, resolve);
            expect(surface.render(80).join("\n")).toContain("Rating 1/5");
            surface.handleInput("]");
            expect(surface.render(80).join("\n")).toContain("Rating 2/5");
            surface.handleInput("\u0013");
          })),
        },
      } as any;
      const result = await tool.execute("custom-form", {
        title: "Review",
        questions: [{ id: "rating", question: "Rating", inputType: "example/rating", min: 1, max: 5 }],
      }, undefined, undefined, ctx);
      expect(result.details).toEqual({ status: "answered", formId: "custom-form", answer: { rating: 2 } });
      expect(journal.values("submitted-form")).toMatchObject([{
        questions: [{ capability: { kind: "example/rating", version: 1, state: { value: 2 } } }],
      }]);
    } finally {
      unregister();
    }
  });

  it("restores a missing capability as read-only and fails closed for revision", async () => {
    const journal = new InMemoryInteractionJournal();
    journal.append("submitted-form", {
      formId: "custom-form",
      revision: 0,
      title: "Review",
      questions: [{
        id: "rating", question: "Rating", inputType: "missing/rating", kind: "capability",
        required: true, fieldAssist: false,
        capability: { kind: "missing/rating", version: 1, canonical: { min: 1, max: 5 }, state: { value: 2 } },
      }],
      answer: { rating: 2 },
    });
    let call = 0;
    const ctx = {
      mode: "tui", hasUI: true, cwd: "/tmp", model: undefined,
      ui: {
        custom: vi.fn(async (factory: any) => new Promise(resolve => {
          const surface = factory({ requestRender: vi.fn(), terminal: { rows: 30 } }, theme, {}, resolve);
          if (call++ === 0) {
            surface.handleInput("\u001b[B");
            surface.handleInput("\r");
          } else if (call === 2) {
            expect(surface.render(80).join("\n")).toContain("Capability unavailable · read-only");
            surface.handleInput("\u001b");
          } else {
            surface.handleInput("\u001b");
          }
        })),
      },
    } as any;
    const result = await createTool({ journal }).execute("confirm-missing", {
      confirm: true, formIds: ["custom-form"],
    }, undefined, undefined, ctx);
    expect(result.details).toEqual({ status: "cancelled" });
  });
});
