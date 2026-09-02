import { describe, expect, it, vi } from "vitest";
import askUserQuestion from "../src/index.js";
import { createConfirmationInteraction, type SubmittedFormSnapshot } from "../src/interaction.js";
import { JOURNAL_CUSTOM_TYPES } from "../src/journal.js";

const theme = {
  fg: (_name: string, text: string) => text,
  bg: (_name: string, text: string) => text,
  bold: (text: string) => text,
};

describe("durable Pi recovery", () => {
  it("reopens an actionable interaction and injects one visible continuation", async () => {
    const form: SubmittedFormSnapshot = {
      formId: "form-1",
      revision: 0,
      title: "Leave request",
      questions: [{ id: "reason", question: "Reason", inputType: "text", kind: "text", required: true, fieldAssist: false }],
      answer: { reason: "Personal" },
    };
    const interaction = createConfirmationInteraction("confirm-1", [form]);
    const branch: any[] = [{
      type: "custom", id: "entry-1", parentId: null, timestamp: new Date().toISOString(),
      customType: JOURNAL_CUSTOM_TYPES.interaction, data: interaction,
    }];
    const handlers = new Map<string, Function>();
    const appendEntry = vi.fn((customType: string, data: unknown) => branch.push({
      type: "custom", id: `entry-${branch.length}`, parentId: null,
      timestamp: new Date().toISOString(), customType, data,
    }));
    const sendMessage = vi.fn((message: any) => branch.push({
      type: "custom_message", id: `entry-${branch.length}`, parentId: null,
      timestamp: new Date().toISOString(), ...message,
    }));
    const pi = {
      registerTool: vi.fn(), registerEntryRenderer: vi.fn(), registerMessageRenderer: vi.fn(),
      appendEntry, sendMessage,
      on: vi.fn((name: string, handler: Function) => handlers.set(name, handler)),
    } as any;
    askUserQuestion(pi);
    const ctx = {
      mode: "tui", hasUI: true, cwd: "/tmp/project", model: undefined,
      sessionManager: { getBranch: () => branch },
      ui: {
        custom: vi.fn(async (factory: any) => new Promise(resolve => {
          const surface = factory({ requestRender: vi.fn(), terminal: { rows: 30 } }, theme, {}, resolve);
          surface.handleInput("\r");
        })),
      },
    } as any;

    await handlers.get("session_start")?.({ type: "session_start", reason: "resume" }, ctx);
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(appendEntry).toHaveBeenCalledWith(JOURNAL_CUSTOM_TYPES.interaction, expect.objectContaining({ state: "confirmed" }));
    expect(appendEntry).not.toHaveBeenCalledWith(JOURNAL_CUSTOM_TYPES.continuation, expect.anything());
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      customType: JOURNAL_CUSTOM_TYPES.continuation,
      display: true,
      content: expect.stringContaining("Personal"),
    }), { triggerTurn: true });
    const renderer = pi.registerEntryRenderer.mock.calls.find((call: unknown[]) => call[0] === JOURNAL_CUSTOM_TYPES.interaction)?.[1];
    const terminal = appendEntry.mock.calls.find((call: unknown[]) => call[0] === JOURNAL_CUSTOM_TYPES.interaction)?.[1];
    const rendered = renderer({ data: terminal }, { expanded: true }, theme).render(80).join("\n");
    expect(rendered).toContain("Leave request");
    expect(rendered).toContain("Reason: Personal");

    await handlers.get("session_start")?.({ type: "session_start", reason: "reload" }, ctx);
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(ctx.ui.custom).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("delivers a terminal interaction left between snapshot and continuation append exactly once", async () => {
    const form: SubmittedFormSnapshot = {
      formId: "form-1", revision: 0,
      questions: [{ id: "reason", question: "Reason", inputType: "text", kind: "text", required: true, fieldAssist: false }],
      answer: { reason: "Personal" },
    };
    const terminal = { ...createConfirmationInteraction("confirm-terminal", [form]), revision: 1, state: "confirmed", continuationId: "confirm-terminal:r1" };
    const branch: any[] = [{
      type: "custom", id: "entry-terminal", parentId: null, timestamp: new Date().toISOString(),
      customType: JOURNAL_CUSTOM_TYPES.interaction, data: terminal,
    }];
    const handlers = new Map<string, Function>();
    const appendEntry = vi.fn((customType: string, data: unknown) => branch.push({
      type: "custom", id: `entry-${branch.length}`, parentId: null, timestamp: new Date().toISOString(), customType, data,
    }));
    const sendMessage = vi.fn((message: any) => branch.push({
      type: "custom_message", id: `entry-${branch.length}`, parentId: null,
      timestamp: new Date().toISOString(), ...message,
    }));
    askUserQuestion({
      registerTool: vi.fn(), registerEntryRenderer: vi.fn(), appendEntry, sendMessage,
      on: vi.fn((name: string, handler: Function) => handlers.set(name, handler)),
    } as any);
    const ctx = {
      mode: "tui", hasUI: true, cwd: "/tmp", model: undefined,
      sessionManager: { getBranch: () => branch }, ui: { custom: vi.fn() },
    } as any;
    await handlers.get("session_start")?.({ type: "session_start", reason: "resume" }, ctx);
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(ctx.ui.custom).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledOnce();
    await handlers.get("session_start")?.({ type: "session_start", reason: "reload" }, ctx);
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(sendMessage).toHaveBeenCalledOnce();
  });

  it("reports delivery failure and retries when sendMessage is not observable in the branch journal", async () => {
    const form: SubmittedFormSnapshot = {
      formId: "form-undelivered", revision: 0,
      questions: [{ id: "reason", question: "Reason", inputType: "text", kind: "text", required: true, fieldAssist: false }],
      answer: { reason: "Personal" },
    };
    const terminal = { ...createConfirmationInteraction("confirm-undelivered", [form]), revision: 1, state: "confirmed", continuationId: "confirm-undelivered:r1" };
    const branch: any[] = [{
      type: "custom", id: "entry-terminal", parentId: null, timestamp: new Date().toISOString(),
      customType: JOURNAL_CUSTOM_TYPES.interaction, data: terminal,
    }];
    const handlers = new Map<string, Function>();
    const sendMessage = vi.fn();
    const notify = vi.fn();
    askUserQuestion({
      registerTool: vi.fn(), registerEntryRenderer: vi.fn(), appendEntry: vi.fn(), sendMessage,
      on: vi.fn((name: string, handler: Function) => handlers.set(name, handler)),
    } as any);
    const ctx = {
      mode: "tui", hasUI: true, sessionManager: { getBranch: () => branch },
      ui: { custom: vi.fn(), notify },
    } as any;

    handlers.get("session_start")?.({ type: "session_start", reason: "resume" }, ctx);
    await vi.waitFor(() => expect(notify).toHaveBeenCalledWith("Unable to restore the pending question interaction.", "error"));
    handlers.get("session_start")?.({ type: "session_start", reason: "reload" }, ctx);
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2));
  });

  it("settles recovery on shutdown without consuming the pending interaction", async () => {
    const form: SubmittedFormSnapshot = {
      formId: "form-shutdown", revision: 0,
      questions: [{ id: "reason", question: "Reason", inputType: "text", kind: "text", required: true, fieldAssist: false }],
      answer: { reason: "Personal" },
    };
    const branch: any[] = [{
      type: "custom", id: "entry-open", parentId: null, timestamp: new Date().toISOString(),
      customType: JOURNAL_CUSTOM_TYPES.interaction,
      data: createConfirmationInteraction("confirm-shutdown", [form]),
    }];
    const handlers = new Map<string, Function>();
    const appendEntry = vi.fn((customType: string, data: unknown) => branch.push({
      type: "custom", id: `entry-${branch.length}`, parentId: null,
      timestamp: new Date().toISOString(), customType, data,
    }));
    const sendMessage = vi.fn();
    askUserQuestion({
      registerTool: vi.fn(), registerEntryRenderer: vi.fn(), appendEntry, sendMessage,
      on: vi.fn((name: string, handler: Function) => handlers.set(name, handler)),
    } as any);
    const ctx = {
      mode: "tui", hasUI: true, cwd: "/tmp", model: undefined,
      sessionManager: { getBranch: () => branch },
      ui: {
        notify: vi.fn(),
        custom: vi.fn(async (factory: any) => new Promise(resolve => {
          factory({ requestRender: vi.fn(), terminal: { rows: 30 } }, theme, {}, resolve);
        })),
      },
    } as any;
    handlers.get("session_start")?.({ type: "session_start", reason: "resume" }, ctx);
    await vi.waitFor(() => expect(ctx.ui.custom).toHaveBeenCalledOnce());
    await handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "resume" }, ctx);
    expect(branch.at(-1)?.data).toMatchObject({ state: "awaiting_confirmation" });
    expect(sendMessage).not.toHaveBeenCalled();

    const replacementHandlers = new Map<string, Function>();
    const replacementSendMessage = vi.fn((message: any) => branch.push({
      type: "custom_message", id: `entry-${branch.length}`, parentId: null,
      timestamp: new Date().toISOString(), ...message,
    }));
    askUserQuestion({
      registerTool: vi.fn(), registerEntryRenderer: vi.fn(), appendEntry,
      sendMessage: replacementSendMessage,
      on: vi.fn((name: string, handler: Function) => replacementHandlers.set(name, handler)),
    } as any);
    const replacementCtx = {
      ...ctx,
      ui: {
        notify: vi.fn(),
        custom: vi.fn(async (factory: any) => new Promise(resolve => {
          const surface = factory({ requestRender: vi.fn(), terminal: { rows: 30 } }, theme, {}, resolve);
          surface.handleInput("\r");
        })),
      },
    } as any;
    replacementHandlers.get("session_start")?.({ type: "session_start", reason: "resume" }, replacementCtx);
    await vi.waitFor(() => expect(replacementSendMessage).toHaveBeenCalledOnce());
    expect(branch.filter(entry => entry.customType === JOURNAL_CUSTOM_TYPES.interaction).at(-1)?.data)
      .toMatchObject({ state: "confirmed" });
  });
});
