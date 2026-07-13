import { describe, expect, it, vi } from "vitest";
import { createTool } from "../src/index.js";
import { normalizeRequest } from "../src/normalize.js";
import { ResultPresentationStore } from "../src/presentation.js";

const testTheme = { fg: (_name: string, text: string) => text, bg: (_name: string, text: string) => text, bold: (text: string) => text };
const testTui = (withTerminal = false) => ({ requestRender: vi.fn(), ...(withTerminal ? { terminal: { rows: 24 } } : {}) });

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

type TestFormComponent = { render(width: number): string[]; handleInput(data: string): void };

function formContext(interact: (component: TestFormComponent) => void | Promise<void>, withTerminal = false) {
  const ctx = context();
  ctx.ui.custom = vi.fn(async (factory: any) => {
    let finish!: (outcome: unknown) => void;
    const outcome = new Promise(resolve => { finish = resolve; });
    const component = factory(testTui(withTerminal), testTheme, {}, finish) as TestFormComponent;
    await interact(component);
    return outcome;
  });
  return ctx;
}

async function withFetchStub<T>(fetch: typeof globalThis.fetch, run: () => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch;
  vi.stubGlobal("fetch", fetch);
  try { return await run(); } finally { vi.stubGlobal("fetch", originalFetch); }
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
    const selected = await tool.execute("b", { question: "Pick", options: [{ id: 1, label: "One" }, { id: 2, label: "Two" }], default: 1 }, undefined, undefined, ctx);
    expect(selected.details).toEqual({ status: "answered", answer: 2 });
    expect(selected.content[0]?.text).toBe("User answered the question: 2. Continue with this answer.");
    expect((await tool.execute("c", { question: "Proceed?", confirm: true }, undefined, undefined, ctx)).details).toEqual({ status: "answered", answer: false });
    expect(ctx.ui.custom).not.toHaveBeenCalled();
  });

  it("puts a static single-choice recommendation under the primitive cursor", async () => {
    const ctx = context();
    ctx.ui.select.mockImplementation(async (_title: string, values: string[]) => values[0]);

    const result = await createTool().execute("single-default", {
      question: "Pick",
      options: [{ id: 1, label: "Alternative" }, { id: 2, label: "Recommended" }],
      default: "Recommended",
    }, undefined, undefined, ctx);

    expect(ctx.ui.select).toHaveBeenCalledWith("Pick", ["Recommended", "Alternative"], undefined);
    expect(result.details).toEqual({ status: "answered", answer: 2 });
  });

  it("renders question and option labels without changing the canonical tool result", async () => {
    const ctx = context();
    const tool = createTool();
    const args = { questions: [
      { id: "department", question: "Department", options: [{ id: 1, label: "Engineering" }, { id: 2, label: "Finance" }], default: 1 },
      { id: "language", question: "Language", options: [{ id: "ts", label: "TypeScript" }, { id: "py", label: "Python" }], default: "ts" },
    ] };
    ctx.ui.custom = vi.fn(async (factory: any) => new Promise(resolve => {
      const component = factory(testTui(), testTheme, {}, resolve);
      component.handleInput("\u001b[B");
      component.handleInput("\r");
      component.handleInput("\u001b[B");
      component.handleInput("\r");
    }));

    const result = await tool.execute("rendered", args, undefined, undefined, ctx);
    expect(result.details).toEqual({ status: "answered", answer: { department: 2, language: "py" } });
    expect(result.content[0]?.text).toContain('{"department":2,"language":"py"}');
    const rendered = tool.renderResult?.(result as any, { expanded: false, isPartial: false }, {
      fg: (_name: string, text: string) => text, bg: (_name: string, text: string) => text, bold: (text: string) => text,
    } as any, { args, toolCallId: "rendered", state: {}, lastComponent: undefined } as any).render(80).join("\n");
    expect(rendered).toContain("Department: Finance");
    expect(rendered).toContain("Language: Python");
  });

  it("renders labels for remote options loaded after the form opens", async () => {
    const originalFetch = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ rows: [{ id: 7, label: "Remote seven" }] }), {
      status: 200, headers: { "content-type": "application/json" },
    })));
    const ctx = context();
    const args = { questions: [{
      id: "remote", question: "Remote choice", inputType: "select", default: 7,
      dataSource: { type: "api", endpoint: "https://example.test/options", resultPath: "rows" },
    }] };
    ctx.ui.custom = vi.fn(async (factory: any) => {
      let finish!: (outcome: unknown) => void;
      const outcome = new Promise(resolve => { finish = resolve; });
      const component = factory(testTui(), testTheme, {}, finish);
      await vi.waitFor(() => expect(component.render(80).join("\n")).toContain("Remote seven"));
      component.handleInput("\r");
      return outcome;
    });

    try {
      const tool = createTool();
      const result = await tool.execute("remote-render", args, undefined, undefined, ctx);
      expect(result.details).toEqual({ status: "answered", answer: { remote: 7 } });
      expect(result.content[0]?.text).toContain('{"remote":7}');
      const rendered = tool.renderResult(result as any, { expanded: false, isPartial: false }, {
        fg: (_name: string, text: string) => text,
      } as any, { args, toolCallId: "remote-render", state: {} } as any).render(80).join("\n");
      expect(rendered).toContain("Remote choice: Remote seven");
    } finally {
      vi.stubGlobal("fetch", originalFetch);
    }
  });

  it("bounds remembered presentation requests when the host never renders results", () => {
    const store = new ResultPresentationStore(2);
    store.remember("one", normalizeRequest({ question: "One", default: "one" }));
    store.remember("two", normalizeRequest({ question: "Two", default: "two" }));
    store.remember("three", normalizeRequest({ question: "Three", default: "three" }));

    expect((store as any).requests.size).toBe(2);
    expect((store as any).requests.has("one")).toBe(false);
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
    const fakeTui = testTui(true);
    const theme = testTheme;
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

  it("opens a grouped single choice on its canonical recommended default", async () => {
    const fakeTui = testTui();
    const theme = testTheme;
    const custom = vi.fn(async (factory: any) => new Promise(resolve => {
      const component = factory(fakeTui, theme, {}, resolve);
      expect(component.render(80)).toContain(">  Recommended");
      component.handleInput("\r");
    }));
    const ctx = context(); ctx.ui.custom = custom;

    const result = await createTool().execute("recommended", { questions: [{
      id: "choice",
      question: "Pick",
      options: [{ id: "other", label: "Other choice" }, { id: 2, label: "Recommended" }],
      default: { id: 2, label: "Recommended" },
      required: true,
    }] }, undefined, undefined, ctx);

    expect(result.details).toEqual({ status: "answered", answer: { choice: 2 } });
  });

  it("lets an optional grouped select clear its recommendation and omits the answer", async () => {
    const fakeTui = testTui();
    const theme = testTheme;
    const custom = vi.fn(async (factory: any) => new Promise(resolve => {
      const component = factory(fakeTui, theme, {}, resolve);
      expect(component.render(80).join("\n")).toContain("Delete clear");
      component.handleInput("\u001b[3~");
      expect(component.render(80).join("\n")).toContain("Pick: (optional)");
      component.handleInput("\u0013");
    }));
    const ctx = context(); ctx.ui.custom = custom;

    const result = await createTool().execute("optional", { questions: [{
      id: "choice",
      question: "Pick",
      inputType: "select",
      options: ["Recommended", "Alternative"],
      default: "Recommended",
    }] }, undefined, undefined, ctx);

    expect(result.details).toEqual({ status: "answered", answer: {} });
  });

  it("shows hierarchy only for treeSelect question forms", async () => {
    const fakeTui = testTui();
    const theme = testTheme;
    const rendered: string[] = [];
    const ctx = context();
    ctx.ui.custom = vi.fn(async (factory: any) => new Promise(resolve => {
      const component = factory(fakeTui, theme, {}, resolve);
      rendered.push(component.render(80).join("\n"));
      component.handleInput("\u001b");
    }));
    const options = [{ id: "parent", label: "Parent", children: [{ id: "child", label: "Child" }] }];

    await createTool().execute("select", { questions: [{ id: "choice", question: "Flat", inputType: "select", options, default: "parent" }] }, undefined, undefined, ctx);
    await createTool().execute("tree", { questions: [{ id: "choice", question: "Tree", inputType: "treeSelect", options, default: "parent" }] }, undefined, undefined, ctx);

    expect(rendered[0]).toContain("Parent");
    expect(rendered[0]).not.toContain("Child");
    expect(rendered[1]).toContain("  Child");
  });

  it("attaches grouped validation errors to the failing question and preserves other answers", async () => {
    const fakeTui = testTui(true);
    const theme = testTheme;
    const ctx = context();
    ctx.ui.custom = vi.fn(async (factory: any) => new Promise(resolve => {
      const component = factory(fakeTui, theme, {}, resolve);
      component.handleInput("\t");
      component.handleInput("\u0013");
      const second = component.render(80).join("\n");
      expect(second).toContain("Reason: preserved");
      expect(second).not.toContain("Missing answer for grouped question: confirm");
      component.handleInput("\u001b[Z");
      expect(component.render(80).join("\n")).toContain("Missing answer for grouped question: confirm");
      component.handleInput("\u001b");
    }));

    await createTool().execute("validation", { questions: [
      { id: "confirm", question: "Confirm", confirm: true, required: true },
      { id: "reason", question: "Reason", default: "preserved", required: true },
    ] }, undefined, undefined, ctx);
  });

  it("distinguishes custom cancellation from abort", async () => {
    const fakeTui = testTui();
    const theme = testTheme;
    const make = (key: string) => vi.fn(async (factory: any) => new Promise(resolve => factory(fakeTui, theme, {}, (outcome: any) => {
      expect(outcome.disposeCount).toBe(1);
      resolve(outcome);
    }).handleInput(key)));
    const cancelled = context(); cancelled.ui.custom = make("\u001b");
    expect((await createTool().execute("cancel", { question: "Date", inputType: "date", dateFormat: "yyyy-MM-dd", default: "2026-07-13" }, undefined, undefined, cancelled)).details).toMatchObject({ status: "cancelled" });
    const aborted = context(); aborted.ui.custom = make("\u0003");
    await expect(createTool().execute("abort", { question: "Date", inputType: "date", dateFormat: "yyyy-MM-dd", default: "2026-07-13" }, undefined, undefined, aborted)).rejects.toThrow("Question was aborted");
  });

  it("does not report an undefined answer when the Agent aborts as custom UI settles", async () => {
    const controller = new AbortController();
    const ctx = context();
    ctx.ui.custom = vi.fn(async () => {
      controller.abort();
      return { kind: "answered", answers: {}, disposeCount: 1 };
    });

    await expect(createTool().execute("abort-race", {
      question: "Enable features",
      multiple: true,
      required: true,
      options: ["Search", "Export"],
      default: ["Search"],
    }, controller.signal, undefined, ctx)).rejects.toThrow("Question was aborted");
  });

  it("releases Agent-turn pending state after an unexpected host UI failure at the component seam", async () => {
    const tool = createTool();
    const controller = new AbortController();
    const failed = context();
    failed.ui.custom = vi.fn(async () => { throw new Error("unexpected UI failure"); });
    await expect(tool.execute("failed", { questions: [{ id: "first", question: "First", default: "one" }] }, controller.signal, undefined, failed))
      .rejects.toThrow("unexpected UI failure");

    const recovered = context();
    await expect(tool.execute("recovered", { question: "Recovered", default: "ready" }, controller.signal, undefined, recovered))
      .resolves.toMatchObject({ details: { status: "answered", answer: "edited" } });
  });

  it("rejects a second pending call in one Agent turn without settling the original form", async () => {
    const fakeTui = testTui();
    const theme = testTheme;
    let answerFirst: ((outcome: unknown) => void) | undefined;
    const ctx = context();
    ctx.ui.custom = vi.fn(async (factory: any) => new Promise(resolve => {
      factory(fakeTui, theme, {}, resolve);
      answerFirst = resolve;
    }));
    const tool = createTool();
    const controller = new AbortController();
    const first = tool.execute("first", { questions: [{ id: "first", question: "First", default: "kept" }] }, controller.signal, undefined, ctx);

    await expect(tool.execute("second", { questions: [{ id: "second", question: "Second", default: "retry" }] }, controller.signal, undefined, ctx))
      .rejects.toThrow("exactly one native ask_user_question call");
    expect(ctx.ui.custom).toHaveBeenCalledTimes(1);

    answerFirst?.({ kind: "answered", answers: { first: "kept" }, disposeCount: 1 });
    await expect(first).resolves.toMatchObject({ details: { status: "answered", answer: { first: "kept" } } });
    await expect(tool.execute("after", { question: "After", default: "ready" }, controller.signal, undefined, ctx))
      .resolves.toMatchObject({ details: { status: "answered", answer: "edited" } });
  });

  it("allows pending question forms from different Agent-turn signals", async () => {
    const fakeTui = testTui();
    const theme = testTheme;
    const complete: Array<(outcome: unknown) => void> = [];
    const ctx = context();
    ctx.ui.custom = vi.fn(async (factory: any) => new Promise(resolve => {
      factory(fakeTui, theme, {}, resolve);
      complete.push(resolve);
    }));
    const tool = createTool();
    const first = tool.execute("turn-1", { questions: [{ id: "one", question: "One", default: "first" }] }, new AbortController().signal, undefined, ctx);
    const second = tool.execute("turn-2", { questions: [{ id: "two", question: "Two", default: "second" }] }, new AbortController().signal, undefined, ctx);

    expect(ctx.ui.custom).toHaveBeenCalledTimes(2);
    complete[1]?.({ kind: "answered", answers: { two: "second" }, disposeCount: 1 });
    complete[0]?.({ kind: "answered", answers: { one: "first" }, disposeCount: 1 });
    await expect(second).resolves.toMatchObject({ details: { answer: { two: "second" } } });
    await expect(first).resolves.toMatchObject({ details: { answer: { one: "first" } } });
  });

  it("does not request another remote page after the reported total is loaded", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ rows: [
      { id: "one", label: "One" }, { id: "two", label: "Two" },
    ], total: 2 }), { status: 200, headers: { "content-type": "application/json" } }));
    const ctx = formContext(async component => {
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(component.render(80).join("\n")).toContain("Showing 2 of 2"));
      component.handleInput("n");
      await new Promise(done => setTimeout(done, 0));
      expect(fetch).toHaveBeenCalledTimes(1);
      component.handleInput("\u001b");
    });

    await withFetchStub(fetch, () => createTool().execute("remote-total", { questions: [{
        id: "remote", question: "Remote", inputType: "select", default: "one",
        dataSource: { type: "api", endpoint: "https://example.test/options", pageParam: "page", pageSizeParam: "limit", pageSize: 2, resultPath: "rows", totalPath: "total" },
      }] }, undefined, undefined, ctx));
  });

  it("continues after a full remote page and stops after a short page without total", async () => {
    const seen: string[] = [];
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      seen.push(url);
      const page = new URL(url).searchParams.get("page");
      const rows = page === "2" ? [{ id: "three", label: "Three" }] : [
        { id: "one", label: "One" }, { id: "two", label: "Two" },
      ];
      return new Response(JSON.stringify({ rows }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const ctx = formContext(async component => {
      await vi.waitFor(() => expect(component.render(80).join("\n")).toContain("Two"));
      component.handleInput("n");
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
      component.handleInput("n");
      await new Promise(done => setTimeout(done, 0));
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(component.render(80).join("\n")).toContain("Three");
      component.handleInput("\u001b");
    });

    await withFetchStub(fetch, async () => {
      await createTool().execute("remote-short", { questions: [{
        id: "remote", question: "Remote", inputType: "select", default: "one",
        dataSource: { type: "api", endpoint: "https://example.test/options", pageParam: "page", pageSizeParam: "limit", pageSize: 2, resultPath: "rows" },
      }] }, undefined, undefined, ctx);
      expect(seen.map(url => new URL(url).searchParams.get("page"))).toEqual(["1", "2"]);
    });
  });

  it("keeps a known remote total when an appended page omits it", async () => {
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const page = new URL(String(input)).searchParams.get("page");
      const payload = page === "2"
        ? { rows: [{ id: "three", label: "Three" }] }
        : { rows: [{ id: "one", label: "One" }, { id: "two", label: "Two" }], total: 3 };
      return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
    });
    const ctx = formContext(async component => {
      await vi.waitFor(() => expect(component.render(80).join("\n")).toContain("Showing 2 of 3"));
      component.handleInput("n");
      await vi.waitFor(() => expect(component.render(80).join("\n")).toContain("Showing 3 of 3"));
      component.handleInput("n");
      await new Promise(done => setTimeout(done, 0));
      expect(fetch).toHaveBeenCalledTimes(2);
      component.handleInput("\u001b");
    });

    await withFetchStub(fetch, () => createTool().execute("remote-known-total", { questions: [{
        id: "remote", question: "Remote", inputType: "select", default: "one",
        dataSource: { type: "api", endpoint: "https://example.test/options", pageParam: "page", pageSizeParam: "limit", pageSize: 2, resultPath: "rows", totalPath: "total" },
      }] }, undefined, undefined, ctx));
  });

  it("retries the failed page and resets pagination for a new remote search without losing the answer", async () => {
    const seen: URL[] = [];
    let pageTwoAttempts = 0;
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      seen.push(url);
      const page = url.searchParams.get("page");
      const query = url.searchParams.get("q");
      if (!query && page === "2" && pageTwoAttempts++ === 0) return new Response("retry", { status: 503 });
      const rows = query
        ? page === "2" ? [{ id: "search-three", label: "Search three" }] : [{ id: "search-one", label: "Search one" }, { id: "search-two", label: "Search two" }]
        : page === "2" ? [{ id: "three", label: "Three" }] : [{ id: "one", label: "One" }, { id: "two", label: "Two" }];
      return new Response(JSON.stringify({ rows }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const ctx = formContext(async component => {
      await vi.waitFor(() => expect(component.render(80).join("\n")).toContain("Two"));
      component.handleInput("n");
      await vi.waitFor(() => expect(component.render(80).join("\n")).toContain("HTTP 503"));
      expect(component.render(80).join("\n")).toContain("Remote: one");
      component.handleInput("r");
      await vi.waitFor(() => expect(component.render(80).join("\n")).toContain("Three"));
      component.handleInput("s");
      component.handleInput("needle");
      component.handleInput("\r");
      await vi.waitFor(() => expect(component.render(80).join("\n")).toContain("Search two"));
      expect(component.render(80).join("\n")).toContain("Remote: one");
      component.handleInput("n");
      await vi.waitFor(() => expect(component.render(80).join("\n")).toContain("Search three"));
      component.handleInput("\u001b");
    }, true);

    await withFetchStub(fetch, async () => {
      await createTool().execute("remote-retry", { questions: [{
        id: "remote", question: "Remote", inputType: "select", default: "one",
        dataSource: { type: "api", endpoint: "https://example.test/options", searchParam: "q", pageParam: "page", pageSizeParam: "limit", pageSize: 2, resultPath: "rows" },
      }] }, undefined, undefined, ctx);
      expect(seen.map(url => `${url.searchParams.get("q") ?? ""}:${url.searchParams.get("page")}`)).toEqual([":1", ":2", ":2", "needle:1", "needle:2"]);
    });
  });
});
