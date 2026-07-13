import type { Theme } from "@earendil-works/pi-coding-agent";
import { Editor, Key, matchesKey, type EditorTheme, type TUI } from "@earendil-works/pi-tui";
import { loadOptions } from "./data-source.js";
import { isOtherOption, normalizeAnswer } from "./normalize.js";
import { usesTextEditor } from "./presentation.js";
import type { Answer, AnswerInput, NormalizedQuestion, NormalizedRequest, OptionItem } from "./types.js";

export type FormOutcome =
  | { kind: "answered"; answers: Record<string, Answer>; disposeCount: number }
  | { kind: "cancelled"; disposeCount: number }
  | { kind: "aborted"; disposeCount: number };

const flatten = (items: OptionItem[], depth = 0): Array<OptionItem & { depth: number }> => items.flatMap(item => [{ ...item, depth }, ...flatten(item.children ?? [], depth + 1)]);
const defaultText = (q: NormalizedQuestion) => typeof q.default === "string" ? q.default : "";

export function createQuestionForm(
  tui: TUI,
  theme: Theme,
  done: (outcome: FormOutcome) => void,
  request: NormalizedRequest,
  signal?: AbortSignal,
) {
  let index = 0;
  let optionIndex = 0;
  let disposed = false;
  let disposeCount = 0;
  let settled = false;
  let searchMode = false;
  let customMode = false;
  const pages = new Map<string, number>();
  const searches = new Map<string, string>();
  const totals = new Map<string, number>();
  const answers = new Map<string, AnswerInput>();
  const errors = new Map<string, string>();
  const loading = new Set<string>();
  for (const q of request.questions) if (q.default !== undefined) answers.set(q.id, q.default);
  const editorTheme: EditorTheme = {
    borderColor: s => theme.fg("accent", s),
    selectList: {
      selectedPrefix: s => theme.fg("accent", s), selectedText: s => theme.fg("accent", s),
      description: s => theme.fg("muted", s), scrollInfo: s => theme.fg("dim", s), noMatch: s => theme.fg("warning", s),
    },
  };
  const editor = new Editor(tui, editorTheme);
  editor.setText(defaultText(request.questions[0]!));

  function refresh() { tui.requestRender(); }
  function settle(kind: FormOutcome["kind"]) {
    if (settled) return;
    settled = true;
    disposeResources();
    if (kind === "answered") done({ kind, answers: Object.fromEntries(answers) as Record<string, Answer>, disposeCount });
    else done({ kind, disposeCount });
  }
  const onAbort = () => settle("aborted");
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();

  function current() { return request.questions[index]!; }
  function options(q = current()) { return flatten(q.options ?? []); }
  function storeEditor() {
    const q = current();
    if (usesTextEditor(q)) answers.set(q.id, editor.getText());
  }
  function move(delta: number) {
    storeEditor();
    index = (index + delta + request.questions.length) % request.questions.length;
    optionIndex = 0;
    editor.setText(defaultText(current()));
    const existing = answers.get(current().id);
    if (typeof existing === "string" && usesTextEditor(current())) editor.setText(existing);
    if (current().dataSource && !current().options?.length) void reload();
    refresh();
  }
  function finishQuestion() {
    if (request.grouped && index < request.questions.length - 1) move(1);
    else submit();
  }
  async function reload(search?: string, append = false) {
    const q = current();
    if (!q.dataSource || loading.has(q.id)) return;
    loading.add(q.id); errors.delete(q.id); refresh();
    try {
      if (search !== undefined) searches.set(q.id, search);
      const activeSearch = searches.get(q.id);
      const page = pages.get(q.id) ?? 1;
      const query = activeSearch === undefined ? { page } : { search: activeSearch, page };
      const loaded = await loadOptions(q.dataSource, request.dataSourceBaseUrl, query, signal);
      q.options = append ? [...(q.options ?? []), ...loaded.options].filter((option, position, all) => all.findIndex(candidate => typeof candidate.id === typeof option.id && candidate.id === option.id) === position) : loaded.options;
      if (loaded.total !== undefined) totals.set(q.id, loaded.total);
      optionIndex = 0;
    } catch (cause) { errors.set(q.id, cause instanceof Error ? cause.message : String(cause)); }
    finally { loading.delete(q.id); refresh(); }
  }

  function submit() {
    storeEditor();
    try {
      const normalized: Record<string, Answer> = {};
      for (const q of request.questions) {
        if (!answers.has(q.id)) {
          if (q.required) throw new Error(`Missing answer for grouped question: ${q.id}`);
          continue;
        }
        normalized[q.id] = normalizeAnswer(q, answers.get(q.id)!);
      }
      answers.clear();
      for (const [key, value] of Object.entries(normalized)) answers.set(key, value);
      settle("answered");
    } catch (cause) { errors.set(current().id, cause instanceof Error ? cause.message : String(cause)); refresh(); }
  }

  function disposeResources() {
    if (disposed) return;
    disposed = true; disposeCount += 1;
    signal?.removeEventListener("abort", onAbort);
  }

  if (current().dataSource && !current().options?.length) void reload();

  return {
    render(width: number): string[] {
      const q = current(); const opts = options(); const lines: string[] = [];
      lines.push(theme.fg("accent", "─".repeat(Math.max(1, width))));
      if (request.grouped) {
        lines.push(theme.fg("muted", `Question ${index + 1}/${request.questions.length} · Tab/Shift+Tab navigate · Ctrl+S submit`));
        for (const [questionIndex, question] of request.questions.entries()) {
          const value = answers.get(question.id);
          lines.push(`${questionIndex === index ? ">" : " "} ${question.question}: ${value === undefined ? "(optional)" : Array.isArray(value) ? value.join(", ") : String(value)}`);
        }
        lines.push("");
      }
      lines.push(theme.fg("text", theme.bold(q.question)));
      if (q.dateFormat) lines.push(theme.fg("muted", `Format: ${q.dateFormat}`));
      if (loading.has(q.id)) lines.push(theme.fg("muted", "Loading remote options…"));
      const error = errors.get(q.id); if (error) lines.push(theme.fg("warning", `${error} · press r to retry`));
      if (usesTextEditor(q) || searchMode || customMode) lines.push(...editor.render(Math.max(1, width - 2)).map(line => ` ${line}`));
      else if (q.kind === "confirm") {
        ["Yes", "No"].forEach((label, i) => lines.push(`${i === optionIndex ? ">" : " "} ${label}`));
      }
      else {
        opts.forEach((opt, i) => {
          const selected = q.kind === "multiple" && Array.isArray(answers.get(q.id)) && (answers.get(q.id) as unknown[]).some(v => v === opt.id);
          const prefix = i === optionIndex ? ">" : " ";
          const extra = opt.extra && Object.keys(opt.extra).length ? ` · ${Object.values(opt.extra).map(String).join(" · ")}` : "";
          lines.push(`${prefix} ${selected ? "[x]" : q.kind === "multiple" ? "[ ]" : ""} ${"  ".repeat(opt.depth)}${opt.label}${extra}`);
        });
      }
      if (q.dataSource && totals.has(q.id)) lines.push(theme.fg("dim", `Showing ${opts.length} of ${totals.get(q.id)}`));
      if (q.dataSource) lines.push(theme.fg("dim", searchMode ? "Search remote options" : "s search · n next page · r retry"));
      const enterAction = request.grouped && index < request.questions.length - 1 ? "next" : "submit";
      lines.push(theme.fg("dim", q.kind === "multiple"
        ? `Space toggle · Enter ${enterAction} · Ctrl+S submit · Esc cancel`
        : `Enter ${enterAction} · Ctrl+S submit · Esc cancel`));
      lines.push(theme.fg("accent", "─".repeat(Math.max(1, width))));
      return lines;
    },
    invalidate() {},
    handleInput(data: string) {
      const q = current(); const opts = options();
      if (matchesKey(data, "ctrl+c")) { settle("aborted"); return; }
      if (matchesKey(data, Key.escape)) { settle("cancelled"); return; }
      if (matchesKey(data, "ctrl+s")) { submit(); return; }
      if (request.grouped && matchesKey(data, Key.tab)) { move(1); return; }
      if (request.grouped && matchesKey(data, "shift+tab")) { move(-1); return; }
      if (data === "r" && q.dataSource && !searchMode) { void reload(); return; }
      if (data === "n" && q.dataSource && !searchMode) { pages.set(q.id, (pages.get(q.id) ?? 1) + 1); void reload(undefined, true); return; }
      if (data === "s" && q.dataSource && !searchMode) { searchMode = true; editor.setText(""); refresh(); return; }
      if (searchMode) {
        if (matchesKey(data, Key.enter)) { const search = editor.getText(); searchMode = false; pages.set(q.id, 1); void reload(search); return; }
        editor.handleInput(data); refresh(); return;
      }
      if (customMode) {
        if (matchesKey(data, Key.enter)) {
          const custom = editor.getText().trim();
          if (!custom) { errors.set(q.id, "请输入其他回答"); refresh(); return; }
          if (q.kind === "multiple") {
            const values = Array.isArray(answers.get(q.id)) ? [...answers.get(q.id) as Array<string | number>] : [];
            values.push(custom); answers.set(q.id, values);
          } else answers.set(q.id, custom);
          customMode = false;
          finishQuestion();
        } else { editor.handleInput(data); refresh(); }
        return;
      }
      if (usesTextEditor(q)) {
        if (matchesKey(data, Key.enter)) {
          answers.set(q.id, editor.getText());
          finishQuestion();
        } else { editor.handleInput(data); refresh(); }
        return;
      }
      if (matchesKey(data, Key.up)) { optionIndex = Math.max(0, optionIndex - 1); refresh(); return; }
      if (matchesKey(data, Key.down)) { optionIndex = Math.min(opts.length - 1, optionIndex + 1); refresh(); return; }
      if (matchesKey(data, Key.enter) || matchesKey(data, Key.space)) {
        if (q.kind === "confirm") {
          answers.set(q.id, optionIndex === 0);
          finishQuestion();
          return;
        }
        const selected = opts[optionIndex]; if (!selected) return;
        if (q.kind === "multiple" && matchesKey(data, Key.enter)) { finishQuestion(); return; }
        if (isOtherOption(selected)) {
          customMode = true; editor.setText(""); refresh(); return;
        }
        if (q.kind === "multiple") {
          const values = Array.isArray(answers.get(q.id)) ? [...answers.get(q.id) as Array<string | number>] : [];
          const at = values.findIndex(v => v === selected.id); if (at >= 0) values.splice(at, 1); else values.push(selected.id);
          answers.set(q.id, values); refresh();
        } else {
          answers.set(q.id, selected.id);
          finishQuestion();
        }
      }
    },
    dispose() {
      disposeResources();
    },
  };
}
