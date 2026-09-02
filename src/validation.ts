import { isDeepStrictEqual } from "node:util";
import { questionCapabilities } from "./capabilities.js";
import { QuestionInvalidError } from "./errors.js";
import { normalizeRequest } from "./normalize.js";
import { prepareArguments } from "./prepare.js";
import type { NormalizedRequest, RawRequest, StructuredQuestionError } from "./types.js";

type Issue = StructuredQuestionError["issues"][number];
const builtins = new Set(["text", "textarea", "date", "radio", "checkbox", "select", "treeSelect", "confirm"]);
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const pathFor = (base: string, key: string) => base ? `${base}.${key}` : key;
const issue = (code: string, message: string, path?: string): Issue => ({ code, message, ...(path ? { path } : {}) });

function parseCollection(value: unknown, key: string, path: string, issues: Issue[]): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    issues.push(issue(key === "questions" ? "invalid_questions_json" : "invalid_options", `${key} must be valid JSON.`, path));
    return undefined;
  }
}

function aliasConflict(
  item: Record<string, unknown>,
  aliases: string[],
  path: string,
  issues: Issue[],
  normalize: (value: unknown) => unknown = value => value,
) {
  const supplied = aliases.map(key => normalize(item[key])).filter(value => value !== undefined);
  if (supplied.length > 1 && supplied.slice(1).some(value => !isDeepStrictEqual(value, supplied[0]))) {
    issues.push(issue("conflicting_aliases", `Conflicting aliases were supplied for ${aliases[0]}.`, pathFor(path, aliases[0]!)));
  }
}

const canonicalString = (value: unknown) => {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return undefined;
  if (typeof value === "number" && !Number.isFinite(value)) return undefined;
  const normalized = String(value).trim();
  return normalized || undefined;
};
const canonicalInputType = (value: unknown) => {
  const raw = canonicalString(value);
  if (!raw) return undefined;
  const normalized = raw.replace(/[-_\s]/g, "").toLowerCase();
  if (["textarea", "multiline", "longtext"].includes(normalized)) return "textarea";
  if (["text", "input", "string"].includes(normalized)) return "text";
  if (["date", "datepicker"].includes(normalized)) return "date";
  if (["checkbox", "multiselect"].includes(normalized)) return "checkbox";
  if (["select", "dropdown"].includes(normalized)) return "select";
  if (["confirm", "boolean"].includes(normalized)) return "confirm";
  if (normalized === "treeselect") return "treeSelect";
  if (normalized === "radio") return "radio";
  if (questionCapabilities.get(raw) || raw.includes("/") || raw.includes(":")) return raw;
  return undefined;
};
const canonicalDefault = (value: unknown) => {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    if (!trimmed.startsWith("[")) return trimmed;
    try { value = JSON.parse(trimmed) as unknown; } catch { return trimmed; }
  }
  if (Array.isArray(value)) return value.flatMap(item => canonicalOption(item) ?? []);
  return canonicalOption(value) ?? value;
};
const canonicalBoolean = (value: unknown) => {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 0 ? false : value === 1 ? true : undefined;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "on", "是", "开启", "启用"].includes(normalized)) return true;
  if (["false", "0", "no", "off", "否", "关闭", "禁用"].includes(normalized)) return false;
  return undefined;
};
const canonicalDataSourceAlias = (value: unknown) => {
  if (typeof value === "string") {
    try { value = JSON.parse(value) as unknown; } catch { return undefined; }
  }
  if (!record(value) || canonicalString(value.type)?.toLowerCase() !== "api") return undefined;
  const endpoint = canonicalString(value.endpoint);
  if (!endpoint) return undefined;
  const methodValue = canonicalString(value.method)?.toUpperCase();
  const method = methodValue === "GET" || methodValue === "POST" ? methodValue : undefined;
  const pageSizeValue = typeof value.pageSize === "number"
    ? value.pageSize
    : typeof value.pageSize === "string" ? Number(value.pageSize.trim()) : Number.NaN;
  const extraFieldsSource = value.extraFields === undefined ? [] : Array.isArray(value.extraFields) ? value.extraFields : [value.extraFields];
  const normalized: Record<string, unknown> = { type: "api", endpoint };
  if (method) normalized.method = method;
  if (record(value.params)) normalized.params = value.params;
  if (Number.isFinite(pageSizeValue) && pageSizeValue >= 1) normalized.pageSize = pageSizeValue;
  const extraFields = extraFieldsSource.flatMap(item => canonicalString(item) ? [canonicalString(item)!] : []);
  if (extraFields.length) normalized.extraFields = extraFields;
  for (const key of ["searchParam", "pageParam", "pageSizeParam", "resultPath", "totalPath", "idField", "labelField", "childrenField"]) {
    const field = canonicalString(value[key]);
    if (field) normalized[key] = field;
  }
  return normalized;
};

function canonicalOption(value: unknown): { id: string | number; label: string } | undefined {
  if (typeof value === "string") {
    const normalized = value.trim();
    return normalized ? { id: normalized, label: normalized } : undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) return { id: value, label: String(value) };
  if (typeof value === "boolean") return { id: String(value), label: String(value) };
  if (!record(value)) return undefined;
  const idAliases = [value.id, value.value, value.key]
    .map(item => typeof item === "number" && Number.isFinite(item) ? item : canonicalString(item))
    .filter(item => item !== undefined);
  if (idAliases.length > 1 && idAliases.slice(1).some(item => !isDeepStrictEqual(item, idAliases[0]))) return undefined;
  const labelAliases = [value.label, value.text, value.name].map(canonicalString).filter(item => item !== undefined);
  if (labelAliases.length > 1 && labelAliases.slice(1).some(item => item !== labelAliases[0])) return undefined;
  const rawId = idAliases[0];
  const label = labelAliases[0];
  const id = rawId ?? label;
  const finalLabel = label ?? canonicalString(id);
  return id !== undefined && finalLabel ? { id, label: finalLabel } : undefined;
}

function canonicalOptions(value: unknown): Array<{ id: string | number; label: string }> | undefined {
  if (typeof value === "string") {
    try { value = JSON.parse(value) as unknown; } catch { return undefined; }
  }
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const options: Array<{ id: string | number; label: string }> = [];
  for (const option of value) {
    const normalized = canonicalOption(option);
    if (!normalized) return undefined;
    options.push(normalized);
  }
  return options;
}

function invalidOptionIssues(value: unknown, path: string): Issue[] {
  if (typeof value === "string") {
    try { value = JSON.parse(value) as unknown; } catch { return [issue("invalid_options", "options must be valid JSON.", path)]; }
  }
  if (!Array.isArray(value) || value.length === 0) {
    return [issue("invalid_options", "options must be a non-empty array of valid, unambiguous choices.", path)];
  }
  const invalid = value.flatMap((option, index) => canonicalOptions([option])
    ? []
    : [issue("invalid_options", "Each option must have a non-empty id and label.", `${path}[${index}]`)]);
  return invalid.length ? invalid : [issue("invalid_options", "options must be a non-empty array of valid, unambiguous choices.", path)];
}

function validateItem(item: Record<string, unknown>, path: string, grouped: boolean, issues: Issue[]) {
  aliasConflict(item, ["id", "key", "name"], path, issues, canonicalString);
  aliasConflict(item, ["question", "title", "label", "prompt"], path, issues, canonicalString);
  aliasConflict(item, ["inputType", "input_type", "type", "component"], path, issues, canonicalInputType);
  aliasConflict(item, ["default", "defaultValue", "prefill", "value"], path, issues, canonicalDefault);
  aliasConflict(item, ["dataSource", "data_source"], path, issues, canonicalDataSourceAlias);
  aliasConflict(item, ["multiple", "multi", "multipleSelect"], path, issues, canonicalBoolean);
  if (grouped && ![item.id, item.key, item.name].some(value => canonicalString(value))) {
    issues.push(issue("missing_question_id", "Grouped questions require a non-empty id.", pathFor(path, "id")));
  }
  if (![item.question, item.title, item.label, item.prompt].some(value => canonicalString(value))) {
    issues.push(issue("missing_question_text", "Question text is required.", pathFor(path, "question")));
  }
  const rawInputValues = [item.inputType, item.input_type, item.type, item.component];
  const rawInput = rawInputValues.map(canonicalString).find(value => value !== undefined);
  const normalizedInput = rawInputValues.map(canonicalInputType).find(value => value !== undefined);
  const aliases = new Set(["multiline", "longtext", "input", "string", "datepicker", "multiselect", "dropdown", "boolean", "treeselect"]);
  if (rawInput && !builtins.has(rawInput) && !builtins.has(normalizedInput ?? "") && !aliases.has(normalizedInput ?? "") && !questionCapabilities.get(rawInput)) {
    issues.push(issue("invalid_input_type", "inputType is not supported.", pathFor(path, "inputType")));
  }

  const optionCandidates = [item.options, item.choices]
    .filter(value => value !== undefined)
    .map(value => canonicalOptions(value));
  const validOptionCandidates = optionCandidates.filter((value): value is NonNullable<typeof value> => value !== undefined);
  if (validOptionCandidates.length > 1 && validOptionCandidates.slice(1).some(value => !isDeepStrictEqual(value, validOptionCandidates[0]))) {
    issues.push(issue("conflicting_aliases", "Conflicting aliases were supplied for options.", pathFor(path, "options")));
  }
  const options = validOptionCandidates[0];
  const selectedType = normalizedInput;
  const nonChoiceType = ["text", "textarea", "date", "confirm"].includes(selectedType ?? "");
  if ((item.options !== undefined || item.choices !== undefined) && !options && !nonChoiceType) {
    issues.push(...invalidOptionIssues(item.options !== undefined ? item.options : item.choices, pathFor(path, "options")));
  }
  const optionIds = new Map<string, number[]>();
  options?.forEach((option, index) => {
    const id = option.id;
    const key = `${typeof id}:${String(id)}`;
    const indexes = optionIds.get(key) ?? [];
    indexes.push(index);
    optionIds.set(key, indexes);
  });
  for (const indexes of optionIds.values()) {
    if (indexes.length < 2) continue;
    for (const index of indexes) issues.push(issue("duplicate_option_id", "Option id conflicts with another option.", `${pathFor(path, "options")}[${index}]`));
  }

  const defaultValue = [item.default, item.defaultValue, item.prefill, item.value].find(value => value !== undefined);
  if ((typeof defaultValue === "string" && !defaultValue.trim())
    || (record(defaultValue) && !((typeof defaultValue.id === "string" && defaultValue.id.trim()) || typeof defaultValue.id === "number"))) {
    issues.push(issue("invalid_default", "default must be a non-empty supported answer.", pathFor(path, "default")));
  }

  const dataSourceProvided = item.dataSource !== undefined || item.data_source !== undefined;
  const dataSource = [item.dataSource, item.data_source].map(canonicalDataSourceAlias).find(value => value !== undefined);
  if (dataSourceProvided && dataSource === undefined && ["select", "treeSelect"].includes(selectedType ?? "")) {
    issues.push(issue("invalid_data_source", "dataSource requires type api and a non-empty endpoint.", pathFor(path, "dataSource")));
  }
  const choiceType = ["radio", "select", "treeSelect", "checkbox"].includes(selectedType ?? "")
    || selectedType === undefined && canonicalBoolean(item.multiple) === true;
  if (choiceType && !options && dataSource === undefined) {
    issues.push(issue("missing_choice_source", "Choice questions require options or dataSource.", path || "question"));
  }
}

function foldSingleGroupedItem(request: Record<string, unknown>, item: Record<string, unknown>): Record<string, unknown> {
  const folded = { ...item };
  const copyFamily = (keys: string[]) => {
    if (keys.some(key => folded[key] !== undefined)) return;
    for (const key of keys) if (request[key] !== undefined) folded[key] = request[key];
  };
  copyFamily(["id", "key", "name"]);
  if (!["question", "title", "label", "prompt"].some(key => folded[key] !== undefined)) {
    for (const key of ["question", "label", "prompt"]) if (request[key] !== undefined) folded[key] = request[key];
  }
  copyFamily(["options", "choices"]);
  copyFamily(["inputType", "input_type", "type", "component"]);
  copyFamily(["fieldAssist", "field_assist", "aiAssist", "ai_assist"]);
  copyFamily(["dataSource", "data_source"]);
  copyFamily(["multiple", "multi", "multipleSelect"]);
  copyFamily(["default", "defaultValue", "prefill", "value"]);
  for (const key of ["dateFormat", "required"]) if (folded[key] === undefined && request[key] !== undefined) folded[key] = request[key];
  return folded;
}

export function collectQuestionIssues(raw: unknown): Issue[] {
  const issues: Issue[] = [];
  const prepared = prepareArguments(raw);
  if ("__invalidRequest" in prepared) return [issue("invalid_request_shape", "ask_user_question arguments must be an object.")];
  if (prepared.questions === undefined
    && (prepared.confirm === true || (typeof prepared.confirm === "string" && ["true", "1", "yes", "on", "是"].includes(prepared.confirm.trim().toLowerCase())))) return issues;
  const grouped = prepared.questions !== undefined;
  if (!grouped) {
    validateItem(prepared, "", false, issues);
    return issues;
  }
  const parsed = parseCollection(prepared.questions, "questions", "questions", issues);
  if (parsed === undefined) return issues;
  if (!Array.isArray(parsed) && !record(parsed)) {
    issues.push(issue("invalid_questions_shape", "questions must be one object or an array of objects.", "questions"));
    return issues;
  }
  const items = Array.isArray(parsed) ? parsed : [parsed];
  if (items.length === 0) {
    issues.push(issue("missing_question_text", "At least one question is required.", "questions"));
    return issues;
  }
  const ids = new Map<string, number[]>();
  items.forEach((value, index) => {
    const path = `questions[${index}]`;
    if (!record(value)) {
      issues.push(issue("invalid_question_item", "Each questions item must be an object.", path));
      return;
    }
    const effective = items.length === 1 ? foldSingleGroupedItem(prepared, value) : value;
    validateItem(effective, path, true, issues);
    const id = [effective.id, effective.key, effective.name].map(canonicalString).find(candidate => candidate !== undefined);
    if (id) {
      const indexes = ids.get(id) ?? [];
      indexes.push(index);
      ids.set(id, indexes);
    }
  });
  for (const indexes of ids.values()) {
    if (indexes.length < 2) continue;
    for (const index of indexes) issues.push(issue("duplicate_question_id", "Question id conflicts with another question.", `questions[${index}].id`));
  }
  return issues;
}

export function invalidQuestionArguments(issues: Issue[]): QuestionInvalidError {
  return new QuestionInvalidError({
    code: "invalid_question_arguments",
    category: "validation",
    message: "Question fields contain invalid arguments.",
    retryable: true,
    issues,
  });
}

export function normalizeRequestStructured(raw: unknown): NormalizedRequest {
  const prepared = prepareArguments(raw);
  const issues = collectQuestionIssues(prepared);
  if (issues.length) throw invalidQuestionArguments(issues);
  try {
    return normalizeRequest(prepared as unknown as RawRequest);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "Question arguments are invalid.";
    const code = message.includes("dateFormat") || message.includes("Date default") ? "invalid_date_format"
      : message.includes("dataSource") ? "invalid_data_source"
        : message.includes("default") || message.includes("答案") ? "invalid_default"
          : "invalid_options";
    throw invalidQuestionArguments([issue(code, message)]);
  }
}
