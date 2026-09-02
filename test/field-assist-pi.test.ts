import { describe, expect, it, vi } from "vitest";
import { createPiIsolatedFieldAssistModel } from "../src/field-assist-pi.js";

const messages = [
  { role: "system" as const, content: "Only return a field value" },
  { role: "user" as const, content: "draft" },
];

describe("Pi isolated Field Assist model", () => {
  it("uses an in-memory tool-free resource-isolated session and always disposes it", async () => {
    const reload = vi.fn(async () => {});
    const resourceLoader = {
      reload,
      getExtensions: () => ({ extensions: [], errors: [], runtime: undefined }),
      getSkills: () => ({ skills: [], diagnostics: [] }),
      getPrompts: () => ({ prompts: [], diagnostics: [] }),
      getThemes: () => ({ themes: [], diagnostics: [] }),
      getAgentsFiles: () => ({ agentsFiles: [] }),
      getSystemPrompt: () => "Only return a field value",
      getAppendSystemPrompt: () => [],
      extendResources: vi.fn(),
    };
    const abort = vi.fn(async () => {});
    const dispose = vi.fn();
    const session = {
      messages: [] as any[],
      prompt: vi.fn(async (prompt: string) => {
        session.messages.push({ role: "user", content: prompt });
        session.messages.push({ role: "assistant", content: [{ type: "text", text: "polished" }] });
      }),
      abort,
      dispose,
    };
    const createSession = vi.fn(async () => ({ session, extensionsResult: resourceLoader.getExtensions() }));
    const resourceLoaderFactory = vi.fn(() => resourceLoader as any);
    const modelRuntime = { marker: "current-runtime-auth", getProvider: () => ({}), hasConfiguredAuth: () => true };
    const modelRuntimeFactory = vi.fn(async () => modelRuntime as any);
    const modelRegistry = { getProviderAuth: vi.fn() } as any;
    const model = createPiIsolatedFieldAssistModel({
      cwd: "/tmp/project",
      agentDir: "/tmp/pi-agent",
      model: { provider: "acceptance", id: "local" } as any,
      modelRegistry,
      createSession: createSession as any,
      resourceLoaderFactory,
      modelRuntimeFactory,
    });

    await expect(model.generateText({ messages, signal: new AbortController().signal })).resolves.toBe("polished");
    expect(resourceLoaderFactory).toHaveBeenCalledWith(expect.objectContaining({
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: "Only return a field value",
    }));
    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({
      thinkingLevel: "off",
      tools: [],
      noTools: "all",
      model: expect.objectContaining({ id: "local" }),
      modelRuntime,
      resourceLoader,
      settingsManager: expect.any(Object),
    }));
    expect(modelRuntimeFactory).toHaveBeenCalledWith(modelRegistry, expect.objectContaining({ id: "local" }), "/tmp/pi-agent");
    expect(session.prompt).toHaveBeenCalledWith("draft");
    expect(abort).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("aborts the child when the parent signal fires", async () => {
    const controller = new AbortController();
    let release!: () => void;
    const prompt = new Promise<void>(resolve => { release = resolve; });
    const abort = vi.fn(async () => release());
    const dispose = vi.fn();
    const session = { messages: [], prompt: vi.fn(() => prompt), abort, dispose };
    const loader = {
      reload: vi.fn(async () => {}), getExtensions: () => ({ extensions: [], errors: [] }),
      getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }),
      getThemes: () => ({ themes: [], diagnostics: [] }), getAgentsFiles: () => ({ agentsFiles: [] }),
      getSystemPrompt: () => "system", getAppendSystemPrompt: () => [], extendResources: vi.fn(),
    };
    const model = createPiIsolatedFieldAssistModel({
      cwd: "/tmp/project",
      agentDir: "/tmp/pi-agent",
      model: { provider: "acceptance", id: "local" } as any,
      modelRegistry: {} as any,
      createSession: vi.fn(async () => ({ session, extensionsResult: loader.getExtensions() })) as any,
      resourceLoaderFactory: () => loader as any,
      modelRuntimeFactory: vi.fn(async () => ({} as any)),
    });
    const result = model.generateText({ messages, signal: controller.signal });
    controller.abort();
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(abort).toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("fails clearly when the current model is unavailable", async () => {
    const model = createPiIsolatedFieldAssistModel({ cwd: "/tmp/project", model: undefined });
    await expect(model.generateText({ messages, signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: "MODEL_UNAVAILABLE" });
  });

  it.each([
    { name: "ephemeral CLI authentication", registered: undefined, persistedProvider: undefined, persistedAuth: false },
    { name: "runtime-only provider", registered: {}, persistedProvider: {}, persistedAuth: true },
  ])("rejects $name before creating a child session", async ({ registered, persistedProvider, persistedAuth }) => {
    const modelRuntimeFactory = vi.fn(async () => ({
      getProvider: () => persistedProvider,
      hasConfiguredAuth: () => persistedAuth,
    }) as any);
    const createSession = vi.fn();
    const model = createPiIsolatedFieldAssistModel({
      cwd: "/tmp/project",
      model: { provider: "acceptance", id: "local" } as any,
      modelRegistry: {
        getProviderAuthStatus: vi.fn(() => ({ configured: true, source: registered ? "stored" : "runtime" })),
        getRegisteredNativeProvider: vi.fn(() => registered),
        getRegisteredProviderConfig: vi.fn(() => undefined),
      } as any,
      modelRuntimeFactory,
      createSession: createSession as any,
    });

    await expect(model.generateText({ messages, signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: "MODEL_UNAVAILABLE" });
    expect(createSession).not.toHaveBeenCalled();
  });

  it("classifies a child assistant authentication error without semantic retries", async () => {
    const session = {
      messages: [] as any[], abort: vi.fn(async () => {}), dispose: vi.fn(),
      prompt: vi.fn(async () => {
        session.messages.push({ role: "assistant", content: [], stopReason: "error", errorMessage: "provider authentication failed" });
      }),
    };
    const loader = {
      reload: vi.fn(async () => {}), getExtensions: () => ({ extensions: [], errors: [] }),
      getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }),
      getThemes: () => ({ themes: [], diagnostics: [] }), getAgentsFiles: () => ({ agentsFiles: [] }),
      getSystemPrompt: () => "system", getAppendSystemPrompt: () => [], extendResources: vi.fn(),
    };
    const model = createPiIsolatedFieldAssistModel({
      cwd: "/tmp/project", model: { provider: "acceptance", id: "local" } as any,
      modelRegistry: {} as any,
      createSession: vi.fn(async () => ({ session, extensionsResult: loader.getExtensions() })) as any,
      resourceLoaderFactory: () => loader as any,
      modelRuntimeFactory: vi.fn(async () => ({} as any)),
    });
    await expect(model.generateText({ messages, signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: "MODEL_UNAVAILABLE", message: "provider authentication failed" });
    expect(session.prompt).toHaveBeenCalledOnce();
    expect(session.dispose).toHaveBeenCalledOnce();
  });
});
