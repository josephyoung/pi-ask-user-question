import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, type TUI } from "@earendil-works/pi-tui";
import { displayQuestionAnswer, formatDisplayed } from "./presentation.js";
import type { FormInteractionSnapshot } from "./interaction.js";

export type ConfirmationCardOutcome =
  | { kind: "confirm" }
  | { kind: "return_to_modify" }
  | { kind: "cancel" }
  | { kind: "aborted" };

const actions = [
  { label: "Confirm all", outcome: { kind: "confirm" } as const },
  { label: "Return to modify", outcome: { kind: "return_to_modify" } as const },
  { label: "Cancel", outcome: { kind: "cancel" } as const },
];

export function createConfirmationCard(
  tui: TUI,
  theme: Theme,
  done: (outcome: ConfirmationCardOutcome) => void,
  snapshot: FormInteractionSnapshot,
  signal?: AbortSignal,
) {
  let selected = 0;
  let settled = false;
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    signal?.removeEventListener("abort", onAbort);
  };
  const finish = (outcome: ConfirmationCardOutcome) => {
    if (settled) return;
    settled = true;
    dispose();
    done(outcome);
  };
  const onAbort = () => finish({ kind: "aborted" });
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  const refresh = () => tui.requestRender();

  return {
    render(width: number): string[] {
      const lines = [theme.fg("accent", "─".repeat(Math.max(1, width)))];
      lines.push(theme.bold("Submitted Forms · final confirmation"));
      lines.push(theme.fg("muted", `Revision ${snapshot.revision}`));
      for (const form of snapshot.forms) {
        lines.push("");
        lines.push(theme.bold(form.title ?? form.formId));
        for (const question of form.questions) {
          if (!(question.id in form.answer)) continue;
          const value = displayQuestionAnswer(question, form.answer[question.id]!);
          lines.push(`  ${question.question}: ${formatDisplayed(value)}`);
        }
      }
      lines.push("");
      for (const [index, action] of actions.entries()) {
        lines.push(`${index === selected ? ">" : " "} ${action.label}`);
      }
      lines.push(theme.fg("dim", "↑/↓ choose · Enter apply · Esc cancel"));
      lines.push(theme.fg("accent", "─".repeat(Math.max(1, width))));
      return lines;
    },
    invalidate() {},
    handleInput(data: string) {
      if (matchesKey(data, "ctrl+c")) { finish({ kind: "aborted" }); return; }
      if (matchesKey(data, Key.escape)) { finish({ kind: "cancel" }); return; }
      if (matchesKey(data, Key.up)) { selected = Math.max(0, selected - 1); refresh(); return; }
      if (matchesKey(data, Key.down)) { selected = Math.min(actions.length - 1, selected + 1); refresh(); return; }
      if (matchesKey(data, Key.enter)) finish(actions[selected]!.outcome);
    },
    dispose,
  };
}
