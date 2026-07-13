import { describe, expect, it, vi } from "vitest";
import { createTool } from "../src/index.js";

function context(overrides: Record<string, unknown> = {}) {
  return {
    mode: "tui", hasUI: true,
    ui: {
      input: vi.fn(async () => "edited"), editor: vi.fn(async () => "long edited"),
      select: vi.fn(async (_title: string, values: string[]) => values[1]), confirm: vi.fn(async () => false),
      custom: vi.fn(),
    },
    ...overrides,
  } as any;
}

describe("extension public tool", () => {
  it("routes simple text to input without constructing custom UI", async () => {
    const ctx = context();
    const result = await createTool().execute("call", { question: "Name?", default: "Ada" }, undefined, undefined, ctx);
    expect(ctx.ui.input).toHaveBeenCalledWith("Name?", "Ada", undefined);
    expect(ctx.ui.custom).not.toHaveBeenCalled();
    expect(result.details).toEqual({ status: "answered", answer: "edited" });
  });

  it("routes textarea, static single choice and confirmation to matching primitives", async () => {
    const ctx = context(); const tool = createTool();
    expect((await tool.execute("a", { question: "Bio", inputType: "textarea", default: "bio" }, undefined, undefined, ctx)).details).toEqual({ status: "answered", answer: "long edited" });
    expect((await tool.execute("b", { question: "Pick", options: [{ id: 1, label: "One" }, { id: 2, label: "Two" }], default: 1 }, undefined, undefined, ctx)).details).toEqual({ status: "answered", answer: 2 });
    expect((await tool.execute("c", { question: "Proceed?", confirm: true }, undefined, undefined, ctx)).details).toEqual({ status: "answered", answer: false });
    expect(ctx.ui.custom).not.toHaveBeenCalled();
  });

  it("collects a custom answer after selecting Other without constructing custom UI", async () => {
    const ctx = context(); ctx.ui.select.mockResolvedValue("Other"); ctx.ui.input.mockResolvedValue("custom");
    const result = await createTool().execute("other", { question: "Pick", options: ["Known", "Other"], default: "Known" }, undefined, undefined, ctx);
    expect(ctx.ui.input).toHaveBeenCalledWith("Other", undefined, undefined);
    expect(ctx.ui.custom).not.toHaveBeenCalled();
    expect(result.details).toEqual({ status: "answered", answer: "custom" });
  });

  it("fails explicitly when the required UI mode is unavailable", async () => {
    await expect(createTool().execute("call", { question: "Name?", default: "Ada" }, undefined, undefined, context({ mode: "print", hasUI: false }))).rejects.toThrow("requires interactive TUI mode");
  });

  it("submits grouped defaults atomically and disposes custom UI exactly once", async () => {
    const fakeTui = { requestRender: vi.fn() };
    const theme = { fg: (_name: string, text: string) => text, bg: (_name: string, text: string) => text, bold: (text: string) => text };
    const custom = vi.fn(async (factory: any) => new Promise(resolve => {
      const component = factory(fakeTui, theme, {}, (outcome: any) => { expect(outcome.disposeCount).toBe(1); resolve(outcome); });
      component.handleInput("\u0013");
      component.dispose(); component.dispose();
    }));
    const ctx = context(); ctx.ui.custom = custom;
    const result = await createTool().execute("group", { questions: [
      { id: "name", question: "Name", default: "Ada", required: true },
      { id: "confirm", question: "Confirm", confirm: true },
    ] }, undefined, undefined, ctx);
    expect(result.details).toEqual({ status: "answered", answer: { name: "Ada" } });
    expect(ctx.ui.input).not.toHaveBeenCalled(); expect(ctx.ui.confirm).not.toHaveBeenCalled();
  });

  it("distinguishes custom cancellation from abort", async () => {
    const fakeTui = { requestRender: vi.fn() };
    const theme = { fg: (_name: string, text: string) => text, bg: (_name: string, text: string) => text, bold: (text: string) => text };
    const make = (key: string) => vi.fn(async (factory: any) => new Promise(resolve => factory(fakeTui, theme, {}, resolve).handleInput(key)));
    const cancelled = context(); cancelled.ui.custom = make("\u001b");
    expect((await createTool().execute("cancel", { question: "Date", inputType: "date", dateFormat: "yyyy-MM-dd", default: "2026-07-13" }, undefined, undefined, cancelled)).details).toMatchObject({ status: "cancelled" });
    const aborted = context(); aborted.ui.custom = make("\u0003");
    await expect(createTool().execute("abort", { question: "Date", inputType: "date", dateFormat: "yyyy-MM-dd", default: "2026-07-13" }, undefined, undefined, aborted)).rejects.toThrow("Question was aborted");
  });
});
