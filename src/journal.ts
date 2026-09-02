import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export type JournalValueKind = "submitted-form" | "interaction" | "continuation";

const customType: Record<JournalValueKind, string> = {
  "submitted-form": "ask-user-question.submitted-form.v1",
  interaction: "ask-user-question.form-interaction.v1",
  continuation: "ask-user-question.recovered-continuation.v1",
};

export interface InteractionJournal {
  append(kind: JournalValueKind, value: unknown, context?: ExtensionContext): void;
  values(kind: JournalValueKind, context?: ExtensionContext): unknown[];
  hasToolResult?(toolCallId: string, context?: ExtensionContext): boolean;
}

export class InMemoryInteractionJournal implements InteractionJournal {
  private readonly entries: Array<{ kind: JournalValueKind; value: unknown }> = [];

  append(kind: JournalValueKind, value: unknown): void {
    this.entries.push({ kind, value });
  }

  values(kind: JournalValueKind): unknown[] {
    return this.entries.filter(entry => entry.kind === kind).map(entry => entry.value);
  }
}

export class PiInteractionJournal implements InteractionJournal {
  constructor(private readonly pi: ExtensionAPI) {}

  append(kind: JournalValueKind, value: unknown, _context?: ExtensionContext): void {
    this.pi.appendEntry(customType[kind], value);
  }

  values(kind: JournalValueKind, context?: ExtensionContext): unknown[] {
    if (!context) return [];
    return context.sessionManager.getBranch().flatMap(entry => {
      if (entry.type === "custom" && entry.customType === customType[kind]) return [entry.data];
      if (kind === "continuation" && entry.type === "custom_message" && entry.customType === customType[kind]) {
        return [entry.details];
      }
      return [];
    });
  }

  hasToolResult(toolCallId: string, context?: ExtensionContext): boolean {
    if (!context) return false;
    return context.sessionManager.getBranch().some(entry => entry.type === "message"
      && entry.message.role === "toolResult"
      && entry.message.toolName === "ask_user_question"
      && entry.message.toolCallId === toolCallId);
  }
}

export const JOURNAL_CUSTOM_TYPES = customType;
