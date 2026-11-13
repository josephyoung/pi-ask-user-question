import { describe, expect, it, vi } from "vitest";
import { createTool } from "../src/index.js";
import { InMemoryInteractionJournal } from "../src/journal.js";
import {
  DEFAULT_BLOCKED_MESSAGE,
  PROGRAM_STATUS_CONFIG_FILE,
  loadBlockedMessage,
  normalizeBlockedMessage,
} from "../src/program-status.js";

const theme = { fg: (_name: string, text: string) => text, bg: (_name: string, text: string) => text, bold: (text: string) => text };
const tui = { requestRender: vi.fn() };

type Surface = { render(width: number): string[]; handleInput(data: string): void };

const reader = (body: string) => (requested: string) => {
  expect(requested).toBe(`/agent/${PROGRAM_STATUS_CONFIG_FILE}`);
  return body;
};

function context(interact: (surface: Surface, call: number) => void) {
  let call = 0;
  return {
    mode: "tui",
    hasUI: true,
    cwd: "/project",
    ui: {
      input: vi.fn(async () => "typed"),
      editor: vi.fn(async () => "long typed"),
      select: vi.fn(async (_title: string, values: string[]) => values[0]),
      confirm: vi.fn(async () => true),
      custom: vi.fn(async (factory: any) => new Promise(resolve => {
        const surface = factory(tui, theme, {}, resolve) as Surface;
        interact(surface, call++);
      })),
    },
  } as any;
}

const blockedOf = (ctx: any, index: number) => (ctx.ui.custom.mock.calls[index][1] as { blocked?: { kind: string; message: string } } | undefined)?.blocked;

async function submitGrouped(tool: ReturnType<typeof createTool>, ctx: any, id = "form-1") {
  return tool.execute(id, {
    title: "Leave request",
    questions: [{ id: "reason", question: "Reason", default: "Personal", required: true }],
  }, undefined, undefined, ctx);
}

describe("blocked program status message", () => {
  it("reads the message from the Pi agent directory and defaults when the file is absent", () => {
    expect(loadBlockedMessage("/agent", reader('{"version":1,"blockedMessage":"请先回答我"}'))).toBe("请先回答我");
    expect(loadBlockedMessage("/agent", () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); })).toBe(DEFAULT_BLOCKED_MESSAGE);
    expect(DEFAULT_BLOCKED_MESSAGE).toBe("我需要你的帮助");
  });

  it("falls back to the default for malformed, unknown-version, or non-string configuration", () => {
    for (const body of ['{"version":1,"blockedMessage":42}', '{"version":2,"blockedMessage":"x"}', '{"version":1}', "[]", "not json"]) {
      expect(loadBlockedMessage("/agent", reader(body))).toBe(DEFAULT_BLOCKED_MESSAGE);
    }
  });

  it("keeps one bounded line so a configured message cannot break the status report", () => {
    expect(normalizeBlockedMessage("  help\nme  ")).toBe("help me");
    expect(normalizeBlockedMessage("line\u0007bell")).toBe("line bell");
    expect(normalizeBlockedMessage("   ")).toBe(DEFAULT_BLOCKED_MESSAGE);
    expect(normalizeBlockedMessage(undefined)).toBe(DEFAULT_BLOCKED_MESSAGE);
    expect([...normalizeBlockedMessage("é".repeat(200))]).toHaveLength(120);
  });
});

describe("blocked program status wiring", () => {
  it("reports blocked for grouped form and confirmation, and clears it once each dialog settles", async () => {
    const tool = createTool({ journal: new InMemoryInteractionJournal() });
    const ctx = context(surface => surface.handleInput("\r"));

    expect((await submitGrouped(tool, ctx)).details).toMatchObject({ status: "answered", formId: "form-1" });
    expect((await tool.execute("confirm-1", { confirm: true, formIds: ["form-1"] }, undefined, undefined, ctx)).details)
      .toMatchObject({ status: "confirmed" });

    expect(ctx.ui.custom).toHaveBeenCalledTimes(2);
    expect(blockedOf(ctx, 0)).toEqual({ kind: "question", message: DEFAULT_BLOCKED_MESSAGE });
    expect(blockedOf(ctx, 1)).toEqual({ kind: "question", message: DEFAULT_BLOCKED_MESSAGE });
  });

  it("reads the configured message for every dialog so an edited file applies without a restart", async () => {
    const messages = ["第一次", "第二次"];
    let index = 0;
    const tool = createTool({ journal: new InMemoryInteractionJournal(), blockedMessage: () => messages[Math.min(index++, 1)]! });
    const ctx = context(surface => surface.handleInput("\r"));

    await submitGrouped(tool, ctx);
    await tool.execute("confirm-1", { confirm: true, formIds: ["form-1"] }, undefined, undefined, ctx);

    expect([blockedOf(ctx, 0)?.message, blockedOf(ctx, 1)?.message]).toEqual(messages);
  });

  it("leaves primitive questions on Pi's own blocked reporting", async () => {
    const ctx = context(() => undefined);
    await createTool().execute("text", { question: "Name?" }, undefined, undefined, ctx);
    expect(ctx.ui.custom).not.toHaveBeenCalled();
    expect(ctx.ui.input).toHaveBeenCalledTimes(1);
  });
});
