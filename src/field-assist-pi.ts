import {
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSession,
  getAgentDir,
  type CreateAgentSessionOptions,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { FieldAssistError, type FieldAssistMessage, type FieldAssistModel } from "./field-assist.js";

type SessionFactory = typeof createAgentSession;
type LoaderOptions = ConstructorParameters<typeof DefaultResourceLoader>[0];
type ResourceLoaderFactory = (options: LoaderOptions) => InstanceType<typeof DefaultResourceLoader>;
type ModelRuntimeFactory = (
  registry: ExtensionContext["modelRegistry"],
  model: NonNullable<ExtensionContext["model"]>,
  agentDir: string,
) => Promise<ModelRuntime>;

export interface PiIsolatedFieldAssistOptions {
  cwd: string;
  agentDir?: string;
  model: ExtensionContext["model"];
  modelRegistry?: ExtensionContext["modelRegistry"];
  createSession?: SessionFactory;
  resourceLoaderFactory?: ResourceLoaderFactory;
  modelRuntimeFactory?: ModelRuntimeFactory;
}

async function createPersistedModelRuntime(
  _registry: ExtensionContext["modelRegistry"],
  model: NonNullable<ExtensionContext["model"]>,
  agentDir: string,
): Promise<ModelRuntime> {
  const runtime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
  });
  if (!runtime.getProvider(model.provider) || !runtime.hasConfiguredAuth(model.provider)) {
    throw new FieldAssistError("MODEL_UNAVAILABLE", "The current Pi model has no reusable persisted authentication for Field Assist");
  }
  return runtime;
}

function splitMessages(messages: FieldAssistMessage[]): { systemPrompt: string; userPrompt: string } {
  return {
    systemPrompt: messages.filter(message => message.role === "system").map(message => message.content).join("\n\n"),
    userPrompt: messages.filter(message => message.role === "user").map(message => message.content).join("\n\n"),
  };
}

function lastAssistantMessage(messages: readonly unknown[]): { content?: unknown; stopReason?: unknown; errorMessage?: unknown } | undefined {
  return [...messages].reverse().find(message =>
    typeof message === "object" && message !== null && (message as { role?: unknown }).role === "assistant",
  ) as { content?: unknown; stopReason?: unknown; errorMessage?: unknown } | undefined;
}

function assistantText(assistant: { content?: unknown } | undefined): string {
  const content = assistant?.content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: "text"; text: string } =>
      typeof block === "object" && block !== null
      && (block as { type?: unknown }).type === "text"
      && typeof (block as { text?: unknown }).text === "string",
    )
    .map(block => block.text)
    .join("")
    .trim();
}

function abortError(): DOMException {
  return new DOMException("Field Assist was aborted", "AbortError");
}

export function createPiIsolatedFieldAssistModel(options: PiIsolatedFieldAssistOptions): FieldAssistModel {
  return {
    async generateText(request): Promise<string> {
      if (!options.model) {
        throw new FieldAssistError("MODEL_UNAVAILABLE", "The current Pi model is unavailable for Field Assist");
      }
      if (!options.modelRegistry) {
        throw new FieldAssistError("MODEL_UNAVAILABLE", "The current Pi model authentication runtime is unavailable for Field Assist");
      }
      if (request.signal.aborted) throw abortError();

      if (options.modelRegistry.getRegisteredNativeProvider?.(options.model.provider)
        || options.modelRegistry.getRegisteredProviderConfig?.(options.model.provider)) {
        throw new FieldAssistError("MODEL_UNAVAILABLE", "A runtime-only current-model provider is unavailable to Field Assist");
      }

      const { systemPrompt, userPrompt } = splitMessages(request.messages);
      const agentDir = options.agentDir ?? getAgentDir();
      const modelRuntime = await (options.modelRuntimeFactory ?? createPersistedModelRuntime)(
        options.modelRegistry,
        options.model,
        agentDir,
      );
      if (options.modelRegistry.getProviderAuthStatus?.(options.model.provider).source === "runtime"
        && (!modelRuntime.getProvider(options.model.provider) || !modelRuntime.hasConfiguredAuth(options.model.provider))) {
        throw new FieldAssistError("MODEL_UNAVAILABLE", "Ephemeral current-model authentication is unavailable to Field Assist");
      }
      const loader = (options.resourceLoaderFactory ?? (value => new DefaultResourceLoader(value)))({
        cwd: options.cwd,
        agentDir,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        systemPrompt,
      });
      await loader.reload();

      let session: Awaited<ReturnType<SessionFactory>>["session"] | undefined;
      const createSessionOptions: CreateAgentSessionOptions = {
        cwd: options.cwd,
        agentDir,
        model: options.model,
        modelRuntime,
        thinkingLevel: "off",
        noTools: "all",
        tools: [],
        resourceLoader: loader,
        sessionManager: SessionManager.inMemory(options.cwd),
        settingsManager: SettingsManager.inMemory({
          retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
        }),
      };
      try {
        ({ session } = await (options.createSession ?? createAgentSession)(createSessionOptions));
        const activeSession = session;
        const onAbort = () => { void activeSession.abort(); };
        request.signal.addEventListener("abort", onAbort, { once: true });
        try {
          if (request.signal.aborted) {
            await activeSession.abort();
            throw abortError();
          }
          let rejectModelFailure!: (cause: FieldAssistError) => void;
          const modelFailure = new Promise<never>((_resolve, reject) => { rejectModelFailure = reject; });
          const unsubscribe = typeof activeSession.subscribe === "function"
            ? activeSession.subscribe(event => {
                if (event.type !== "message_end" || event.message.role !== "assistant" || event.message.stopReason !== "error") return;
                const message = event.message.errorMessage || "Current model request failed";
                void activeSession.abort();
                rejectModelFailure(new FieldAssistError(
                  /model|provider|api key|authentication|credential|auth/i.test(message) ? "MODEL_UNAVAILABLE" : "INTERNAL_ERROR",
                  message,
                ));
              })
            : () => undefined;
          try {
            await Promise.race([activeSession.prompt(userPrompt), modelFailure]);
          } finally {
            unsubscribe();
          }
          if (request.signal.aborted) throw abortError();
          const assistant = lastAssistantMessage(activeSession.messages);
          if (assistant?.stopReason === "error") {
            const message = typeof assistant.errorMessage === "string" ? assistant.errorMessage : "Current model request failed";
            throw new FieldAssistError(
              /model|provider|api key|authentication|credential|auth/i.test(message) ? "MODEL_UNAVAILABLE" : "INTERNAL_ERROR",
              message,
            );
          }
          const value = assistantText(assistant);
          if (!value) throw new FieldAssistError("INVALID_MODEL_OUTPUT", "AI assist returned empty content");
          return value;
        } finally {
          request.signal.removeEventListener("abort", onAbort);
        }
      } catch (cause) {
        if (request.signal.aborted) throw abortError();
        if (cause instanceof FieldAssistError) throw cause;
        const message = cause instanceof Error ? cause.message : String(cause);
        if (/model|provider|api key|authentication|credential|auth/i.test(message)) {
          throw new FieldAssistError(
            "MODEL_UNAVAILABLE",
            "The current model authentication is unavailable to the isolated Field Assist session",
            { cause },
          );
        }
        throw new FieldAssistError("INTERNAL_ERROR", "Field Assist model request failed", { cause });
      } finally {
        if (session) {
          try { await session.abort(); } finally { session.dispose(); }
        }
      }
    },
  };
}
