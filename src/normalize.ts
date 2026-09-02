import type { Answer, AnswerInput, BuiltinInputType, DataSource, InputType, NormalizedQuestion, NormalizedRequest, OptionId, OptionItem, RawQuestion, RawRequest } from "./types.js";
import { isDeepStrictEqual } from "node:util";
import { format, isMatch, parse } from "date-fns";
import { flattenOptions } from "./options.js";
import { questionCapabilities } from "./capabilities.js";

export const missingBaseUrlError = `Relative dataSource.endpoint requires top-level dataSourceBaseUrl. Retry silently with either {"question":"Choose","inputType":"select","default":"first","dataSource":{"type":"api","endpoint":"/options"},"dataSourceBaseUrl":"https://api.example.com"} or {"questions":[{"id":"choice","question":"Choose","inputType":"select","default":"first","dataSource":{"type":"api","endpoint":"/options"}}],"dataSourceBaseUrl":"https://api.example.com"}. Do not ask the user for the base URL.`;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const firstString = (...values: unknown[]) => {
  for (const value of values) {
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") continue;
    if (typeof value === "number" && !Number.isFinite(value)) continue;
    const normalized = String(value).trim();
    if (normalized) return normalized;
  }
  return undefined;
};
const optionKey = (id: OptionId) => `${typeof id}:${String(id)}`;
const isOptionId = (v: unknown): v is OptionId => (typeof v === "string" && v.trim().length > 0) || (typeof v === "number" && Number.isFinite(v));
const isOptionObject = (v: unknown): v is { id: OptionId } => isRecord(v) && isOptionId(v.id);
const parseJsonString = (value: unknown): unknown => {
  if (typeof value !== "string" || !value.trim()) return value;
  try { return JSON.parse(value) as unknown; } catch { return value; }
};
export const isOtherOption = (option: Pick<OptionItem, "label">) => ["other", "其他"].includes(option.label.trim().toLocaleLowerCase());

function normalizedBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 0 ? false : value === 1 ? true : undefined;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLocaleLowerCase();
  if (["true", "1", "yes", "on", "是", "开启", "启用"].includes(normalized)) return true;
  if (["false", "0", "no", "off", "否", "关闭", "禁用"].includes(normalized)) return false;
  return undefined;
}

function normalizedFieldAssist(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 0 ? false : true;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLocaleLowerCase();
  if (["true", "1", "yes", "on", "enabled", "enable", "是", "开启", "启用"].includes(normalized)) return true;
  if (["false", "0", "no", "off", "disabled", "disable", "否", "关闭", "禁用"].includes(normalized)) return false;
  return undefined;
}

function canonicalDataSource(value: unknown): DataSource | undefined {
  value = parseJsonString(value);
  if (!isRecord(value) || firstString(value.type)?.toLocaleLowerCase() !== "api") return undefined;
  const endpoint = firstString(value.endpoint);
  if (!endpoint) return undefined;
  const methodValue = firstString(value.method)?.toUpperCase();
  const method = methodValue === "GET" || methodValue === "POST" ? methodValue : undefined;
  const pageSizeValue = typeof value.pageSize === "number"
    ? value.pageSize
    : typeof value.pageSize === "string" ? Number(value.pageSize.trim()) : Number.NaN;
  const pageSize = Number.isFinite(pageSizeValue) && pageSizeValue >= 1 ? pageSizeValue : undefined;
  const extraFieldsSource = value.extraFields === undefined
    ? []
    : Array.isArray(value.extraFields) ? value.extraFields : [value.extraFields];
  const extraFields = extraFieldsSource.flatMap(item => firstString(item) ? [firstString(item)!] : []);
  const normalizedStrings: Partial<DataSource> = {};
  for (const key of ["searchParam", "pageParam", "pageSizeParam", "resultPath", "totalPath", "idField", "labelField", "childrenField"] as const) {
    const normalized = firstString(value[key]);
    if (normalized) normalizedStrings[key] = normalized;
  }
  return {
    type: "api", endpoint,
    ...(method ? { method } : {}),
    ...(isRecord(value.params) ? { params: value.params } : {}),
    ...normalizedStrings,
    ...(pageSize !== undefined ? { pageSize } : {}),
    ...(extraFields.length ? { extraFields } : {}),
  };
}

function parseQuestions(value: unknown): unknown[] {
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return []; }
  }
  if (Array.isArray(value)) return value;
  return value == null ? [] : [value];
}

function inputType(value: unknown): BuiltinInputType | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.replace(/[-_\s]/g, "").toLowerCase();
  if (["textarea", "multiline", "longtext"].includes(v)) return "textarea";
  if (["text", "input", "string"].includes(v)) return "text";
  if (["date", "datepicker"].includes(v)) return "date";
  if (v === "radio") return "radio";
  if (["checkbox", "multiselect"].includes(v)) return "checkbox";
  if (["select", "dropdown"].includes(v)) return "select";
  if (v === "treeselect") return "treeSelect";
  if (["confirm", "boolean"].includes(v)) return "confirm";
}

function normalizeOption(value: unknown): OptionItem {
  if (typeof value === "string") {
    const id = value.trim();
    if (!id) throw new Error("Question options must be non-empty and unique");
    return { id, label: id };
  }
  if (typeof value === "number" && Number.isFinite(value)) return { id: value, label: String(value) };
  if (typeof value === "boolean") return { id: String(value), label: String(value) };
  if (!isRecord(value)) throw new Error("Question options must be non-empty and unique");
  const idAliases = [value.id, value.value, value.key].map(normalizeOptionId).filter(item => item !== undefined);
  if (idAliases.length > 1 && idAliases.slice(1).some(item => !isDeepStrictEqual(item, idAliases[0]))) {
    throw new Error("Question options must be non-empty and unique");
  }
  const labelAliases = [value.label, value.text, value.name].map(item => firstString(item)).filter(item => item !== undefined);
  if (labelAliases.length > 1 && labelAliases.slice(1).some(item => item !== labelAliases[0])) {
    throw new Error("Question options must be non-empty and unique");
  }
  const rawId = idAliases[0];
  const label = labelAliases[0];
  const id = rawId ?? normalizeOptionId(label);
  const finalLabel = label ?? firstString(id);
  if (id === undefined || !finalLabel) throw new Error("Question options must be non-empty and unique");
  return {
    id,
    label: finalLabel,
    ...(isRecord(value.extra) ? { extra: value.extra } : {}),
    ...(Array.isArray(value.children) ? { children: value.children.map(normalizeOption) } : {}),
  };
}

function normalizeOptionId(value: unknown): OptionId | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "boolean") return String(value);
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function compatibleOptions(value: unknown): OptionItem[] | undefined {
  if (typeof value === "string") {
    try { value = JSON.parse(value) as unknown; } catch { return undefined; }
  }
  if (!Array.isArray(value) || value.length === 0) return undefined;
  try {
    const options = value.map(normalizeOption);
    return new Set(options.map(option => optionKey(option.id))).size === options.length ? options : undefined;
  } catch {
    return undefined;
  }
}

function normalizeMultipleDefault(value: AnswerInput | undefined): AnswerInput | undefined {
  if (typeof value !== "string") return value;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed as AnswerInput : value;
  } catch {
    return value;
  }
}

function normalizeOne(raw: RawQuestion, fallbackId: string): NormalizedQuestion {
  const question = firstString(raw.question, raw.title, raw.label, raw.prompt);
  if (!question) throw new Error("Question is required");
  const id = firstString(raw.id, raw.key, raw.name) ?? fallbackId;
  const rawInputType = [raw.inputType, raw.input_type, raw.type, raw.component]
    .map(item => firstString(item))
    .find(item => item !== undefined && (inputType(item) !== undefined || questionCapabilities.get(item) !== undefined || item.includes("/") || item.includes(":")));
  const selectedType = inputType(rawInputType);
  if (!selectedType && rawInputType) {
    const capability = questionCapabilities.get(rawInputType);
    if (capability) {
      const canonical = capability.compile(raw);
      const state = capability.serialize(capability.initialize(canonical));
      return {
        id,
        question,
        inputType: capability.kind,
        kind: "capability",
        required: normalizedBoolean(raw.required) === true,
        fieldAssist: false,
        capability: { kind: capability.kind, version: capability.version, canonical, state },
      };
    }
    if (rawInputType.includes("/") || rawInputType.includes(":")) {
      throw new Error(`Question capability is not registered: ${rawInputType}`);
    }
  }
  const nonChoiceType = selectedType !== undefined && ["text", "textarea", "date", "confirm"].includes(selectedType);
  const options = nonChoiceType
    ? undefined
    : [raw.options, raw.choices].map(compatibleOptions).find(value => value !== undefined);
  if (!nonChoiceType && (raw.options !== undefined || raw.choices !== undefined) && !options) {
    throw new Error("Question options must be non-empty and unique");
  }
  const requestedMultiple = [raw.multiple, raw.multi, raw.multipleSelect]
    .map(normalizedBoolean).find(value => value !== undefined) ?? false;
  const finalType: InputType = normalizedBoolean(raw.confirm) === true || selectedType === "confirm" ? "confirm" : selectedType ?? (requestedMultiple ? "checkbox" : options ? "radio" : [raw.dataSource, raw.data_source].some(value => canonicalDataSource(value)) ? "select" : "text");
  const acceptsChoices = ["radio", "checkbox", "select", "treeSelect"].includes(finalType);
  const multiple = acceptsChoices && (requestedMultiple || finalType === "checkbox");
  const dataSource = ["select", "treeSelect"].includes(finalType)
    ? [raw.dataSource, raw.data_source].map(canonicalDataSource).find(value => value !== undefined)
    : undefined;
  if (finalType === "date") {
    const formatError = validateDateFormat(raw.dateFormat); if (formatError) throw new Error(formatError);
  }
  if (finalType === "confirm" && (options || multiple || dataSource)) throw new Error("Confirmation questions cannot provide options or multiple");
  if (["radio", "select", "treeSelect"].includes(finalType) && !options && !dataSource) throw new Error("Choice questions require options or dataSource");
  if ((multiple || finalType === "checkbox") && !options && !dataSource) throw new Error("Multiple-choice questions require options or dataSource");
  const kind = finalType === "confirm" ? "confirm" : finalType === "date" ? "date" : multiple || finalType === "checkbox" ? "multiple" : options || dataSource || ["radio", "select", "treeSelect"].includes(finalType) ? "single" : "text";
  const suppliedDefault = [raw.default, raw.defaultValue, raw.prefill, raw.value]
    .map(normalizeDefault).find(value => value !== undefined);
  const compatibleDefault = kind === "text" && (typeof suppliedDefault === "number" || typeof suppliedDefault === "boolean")
    ? String(suppliedDefault)
    : suppliedDefault;
  const defaultValue = kind === "multiple" ? normalizeMultipleDefault(compatibleDefault) : compatibleDefault;
  if (typeof defaultValue === "string" && !defaultValue.trim()) throw new Error("默认答案无效：default 必须是非空推荐值，不能是空字符串");
  if (kind === "date" && typeof defaultValue === "string" && raw.dateFormat && !matchesDateFormat(defaultValue, String(raw.dateFormat).trim())) {
    throw new Error(`Date default must match dateFormat: ${String(raw.dateFormat).trim()}`);
  }
  const configuredFieldAssist = [raw.fieldAssist, raw.field_assist, raw.aiAssist, raw.ai_assist]
    .map(normalizedFieldAssist)
    .find(value => value !== undefined);
  const result: NormalizedQuestion = {
    id,
    question,
    inputType: finalType,
    kind,
    required: normalizedBoolean(raw.required) === true,
    fieldAssist: kind === "text" ? configuredFieldAssist ?? finalType === "textarea" : false,
  };
  if (options) result.options = options;
  if (dataSource) result.dataSource = dataSource;
  if (finalType === "date") result.dateFormat = String(raw.dateFormat).trim();
  if (defaultValue !== undefined) result.default = normalizeAnswer(result, defaultValue);
  return result;
}

function normalizeDefault(value: unknown): AnswerInput | undefined {
  if (typeof value === "string" || typeof value === "number" && Number.isFinite(value) || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    const normalized: Array<string | number | OptionItem> = [];
    for (const item of value) {
      if (typeof item === "string" || typeof item === "number" && Number.isFinite(item)) normalized.push(item);
      else try { normalized.push(normalizeOption(item)); } catch { /* ignore incompatible collection items */ }
    }
    return normalized;
  }
  if (isRecord(value)) {
    try { return normalizeOption(value); } catch { return undefined; }
  }
  return undefined;
}

function missingAliases(item: RawQuestion, keys: Array<keyof RawQuestion>): boolean {
  return keys.every(key => item[key] === undefined);
}

function foldSingleGroupedItem(raw: RawRequest, item: RawQuestion): RawQuestion {
  const folded = { ...item };
  const copyFamily = (keys: Array<keyof RawQuestion>) => {
    if (!missingAliases(folded, keys)) return;
    for (const key of keys) if (raw[key] !== undefined) folded[key] = raw[key] as never;
  };
  copyFamily(["id", "key", "name"]);
  if (missingAliases(folded, ["question", "title", "label", "prompt"])) {
    for (const key of ["question", "label", "prompt"] as const) if (raw[key] !== undefined) folded[key] = raw[key];
  }
  copyFamily(["options", "choices"]);
  copyFamily(["inputType", "input_type", "type", "component"]);
  copyFamily(["fieldAssist", "field_assist", "aiAssist", "ai_assist"]);
  copyFamily(["dataSource", "data_source"]);
  copyFamily(["multiple", "multi", "multipleSelect"]);
  copyFamily(["default", "defaultValue", "prefill", "value"]);
  for (const key of ["dateFormat", "required"] as const) if (folded[key] === undefined && raw[key] !== undefined) folded[key] = raw[key];
  return folded;
}

function confirmationParameterShape(value: unknown): string {
  if (value === undefined) return "omitted";
  if (Array.isArray(value)) return `array(${value.length})`;
  return typeof value;
}

function confirmationSelection(raw: RawRequest) {
  const candidates: unknown[] = [];
  const ignoredReasons = new Set<string>();
  for (const [field, value] of [["formIds", raw.formIds], ["formId", raw.formId]] as const) {
    if (value === undefined) continue;
    if (Array.isArray(value)) candidates.push(...value);
    else if (typeof value === "string") {
      const parsed = parseJsonString(value);
      if (Array.isArray(parsed)) candidates.push(...parsed);
      else candidates.push(value);
    } else ignoredReasons.add(`malformed_${field}`);
  }
  const formIds = candidates.flatMap(candidate => {
    if (typeof candidate !== "string" || !candidate.trim()) {
      ignoredReasons.add("malformed_form_id");
      return [];
    }
    return [candidate.trim()];
  }).filter((value, index, all) => all.indexOf(value) === index);
  return {
    formIds,
    context: {
      receivedShape: {
        formIds: confirmationParameterShape(raw.formIds),
        formId: confirmationParameterShape(raw.formId),
      },
      ignoredReasons: [...ignoredReasons],
      fallbackAttempted: true,
    },
  };
}

export function normalizeRequest(raw: RawRequest): NormalizedRequest {
  if (normalizedBoolean(raw.confirm) === true && raw.questions === undefined) {
    const selection = confirmationSelection(raw);
    return {
      kind: "confirmation",
      grouped: false,
      questions: [],
      formIds: selection.formIds,
      confirmationContext: selection.context,
    };
  }
  const grouped = raw.questions !== undefined;
  let items: RawQuestion[];
  if (grouped) {
    const parsed = parseQuestions(raw.questions).filter(isRecord) as RawQuestion[];
    items = parsed.length === 1 ? [foldSingleGroupedItem(raw, parsed[0]!)] : parsed;
  } else items = [raw];
  if (items.length === 0) throw new Error("Question is required");
  const questions = items.map((item, i) => normalizeOne(item, grouped ? `q${i + 1}` : "answer"));
  if (new Set(questions.map(q => q.id)).size !== questions.length) throw new Error("Grouped question ids must be unique");
  const base = firstString(raw.dataSourceBaseUrl);
  if (questions.some(q => q.dataSource && !isAbsolute(q.dataSource.endpoint)) && !base) throw new Error(missingBaseUrlError);
  const result: NormalizedRequest = { kind: "questions", grouped, questions };
  const title = grouped ? firstString(raw.title) ?? "表单" : undefined;
  if (title) result.title = title;
  if (base) result.dataSourceBaseUrl = base;
  return result;
}

const isAbsolute = (value: string) => /^https?:\/\//i.test(value);

export function normalizeAnswer(question: NormalizedQuestion, value: AnswerInput): Answer {
  if (question.kind === "capability") {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean"
      || (Array.isArray(value) && value.every(item => typeof item === "string" || typeof item === "number"))) {
      return value as Answer;
    }
    throw new Error("Custom question returned an unsupported answer");
  }
  if (question.kind === "confirm") {
    if (typeof value !== "boolean") throw new Error("请确认或取消");
    return value;
  }
  if (question.kind === "text" || question.kind === "date") {
    if (typeof value !== "string") throw new Error("答案不能为空");
    if (question.required && !value.trim()) throw new Error("答案不能为空");
    return question.kind === "text" ? value.trim() : value;
  }
  if (question.kind === "multiple") {
    if (!Array.isArray(value)) throw new Error("请至少选择一个选项");
    if (question.required && value.length === 0) throw new Error("请至少选择一个选项");
    const ids = value.map(v => normalizeChoice(question, v))
      .filter((id, index, all) => all.findIndex(candidate => optionKey(candidate) === optionKey(id)) === index);
    if (question.options?.some(isOtherOption)) {
      const known = flattenOptions(question.options).filter(option => !isOtherOption(option));
      const customCount = ids.filter(id => !known.some(option => option.id === id || String(option.id) === String(id))).length;
      if (customCount > 1) throw new Error("只能填写一个其他回答");
    }
    return ids;
  }
  if (Array.isArray(value) || typeof value === "boolean") throw new Error("请选择一个有效选项");
  return normalizeChoice(question, value);
}

const dateReference = new Date(2026, 6, 3, 9, 30, 0, 0);
function validateDateFormat(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return 'dateFormat is required for inputType:"date" and must be a non-empty string such as "yyyy-MM-dd" or "yyyy-MM-dd HH:mm".';
  const pattern = value.trim();
  if (![/y/, /M/, /d/].every(part => part.test(pattern))) return 'dateFormat must include year, month, and day tokens, for example "yyyy-MM-dd".';
  const hasTime = /[Hm]/.test(pattern);
  if (/[hKk]/.test(pattern)) return "dateFormat time formats must use 24-hour H/HH tokens; 12-hour h/K/k tokens are not supported.";
  if (hasTime && ![/H/, /m/].every(part => part.test(pattern))) return 'dateFormat time formats must use 24-hour hour and minute tokens, for example "yyyy-MM-dd HH:mm".';
  if (/[sSaXxOzZ]/.test(pattern)) return "dateFormat supports date-only or date-time-to-minute formats; seconds and time zones are not supported.";
  try { format(dateReference, pattern); return null; } catch (cause) { return `dateFormat is not supported: ${cause instanceof Error ? cause.message : String(cause)}`; }
}
function matchesDateFormat(value: string, pattern: string): boolean {
  if (!isMatch(value, pattern)) return false;
  return !Number.isNaN(parse(value, pattern, dateReference).getTime());
}

function normalizeChoice(question: NormalizedQuestion, value: string | number | OptionItem): OptionId {
  const candidate = isOptionObject(value) ? value.id : typeof value === "string" ? value.trim() : value;
  if (!isOptionId(candidate)) throw new Error("请选择一个有效选项");
  const catalog = question.presentationOptions ?? question.options ?? [];
  const options = question.inputType === "treeSelect" ? flattenOptions(catalog) : catalog;
  if (!options.length) return candidate;
  const exact = options.find(o => o.id === candidate);
  if (exact && !isOtherOption(exact)) return exact.id;
  const byString = options.filter(o => String(o.id) === String(candidate));
  if (byString.length === 1 && !isOtherOption(byString[0]!)) return byString[0]!.id;
  if (typeof candidate === "string") {
    const typed = options.find(o => optionKey(o.id) === candidate);
    if (typed && !isOtherOption(typed)) return typed.id;
    const labels = options.filter(o => o.label === candidate);
    if (labels.length === 1 && !isOtherOption(labels[0]!)) return labels[0]!.id;
    if (options.some(isOtherOption)) return candidate;
  }
  throw new Error("答案必须匹配一个可选项");
}
