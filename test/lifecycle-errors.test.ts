import { describe, expect, it, vi } from "vitest";
import { createTool } from "../src/index.js";

const base = {
  mode: "tui", hasUI: true, cwd: "/tmp", model: undefined,
  ui: { input: vi.fn(), editor: vi.fn(), select: vi.fn(), confirm: vi.fn() },
} as any;

async function parsedFailure(promise: Promise<unknown>) {
  try { await promise; } catch (cause) { return JSON.parse((cause as Error).message); }
  throw new Error("Expected failure");
}

describe("question lifecycle failures", () => {
  it("bounds repeated validation failures per Agent-turn signal", async () => {
    const tool = createTool({ maxRetries: 1 });
    const signal = new AbortController().signal;
    expect((await parsedFailure(tool.execute("bad-1", { questions: 7 } as any, signal, undefined, base))).error.code).toBe("invalid_question_arguments");
    expect(await parsedFailure(tool.execute("bad-2", { questions: 7 } as any, signal, undefined, base))).toMatchObject({
      error: { code: "question_validation_failed", retryable: false, terminalCode: "QUESTION_VALIDATION_FAILED" },
    });
  });

  it("bounds cards that the host never acknowledges", async () => {
    vi.useFakeTimers();
    try {
      const tool = createTool({ maxRetries: 1, presentationTimeoutMs: 50 });
      const signal = new AbortController().signal;
      const ctx = { ...base, ui: { ...base.ui, custom: vi.fn(() => new Promise(() => {})) } } as any;
      const first = parsedFailure(tool.execute("timeout-1", { questions: [{ id: "x", question: "X" }] }, signal, undefined, ctx));
      await vi.advanceTimersByTimeAsync(50);
      expect(await first).toMatchObject({ error: { code: "question_presentation_timeout", retryable: true } });
      const second = parsedFailure(tool.execute("timeout-2", { questions: [{ id: "x", question: "X" }] }, signal, undefined, ctx));
      await vi.advanceTimersByTimeAsync(50);
      expect(await second).toMatchObject({ error: { code: "question_presentation_failed", retryable: false } });
    } finally {
      vi.useRealTimers();
    }
  });
});
