import type { Answer, AnswerInput, DataSource, InputType, NormalizedQuestion, NormalizedRequest, OptionId, OptionItem, RawQuestion, RawRequest } from "./types.js";
import { format, isMatch, parse } from "date-fns";
import { flattenOptions } from "./options.js";

export const missingBaseUrlError = `Relative dataSource.endpoint requires top-level dataSourceBaseUrl. Retry silently with either {"question":"Choose","inputType":"select","default":"first","dataSource":{"type":"api","endpoint":"/options"},"dataSourceBaseUrl":"https://api.example.com"} or {"questions":[{"id":"choice","question":"Choose","inputType":"select","default":"first","dataSource":{"type":"api","endpoint":"/options"}}],"dataSourceBaseUrl":"https://api.example.com"}. Do not ask the user for the base URL.`;
export const mixedGroupedFieldsError = "Invalid ask_user_question call: when using questions, field configuration belongs inside each questions[] item. Move options, inputType, dateFormat, required, dataSource, multiple, default, and confirm out of the top level. Retry silently; do not explain this correction to the user.";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const firstString = (...values: unknown[]) => values.find((v): v is string => typeof v === "string" && v.trim().length > 0)?.trim();
const firstDefined = <T>(...values: Array<T | undefined>) => values.find((v): v is T => v !== undefined);
const optionKey = (id: OptionId) => `${typeof id}:${String(id)}`;
const isOptionId = (v: unknown): v is OptionId => (typeof v === "string" && v.trim().length > 0) || (typeof v === "number" && Number.isFinite(v));
const isOptionObject = (v: unknown): v is OptionItem => isRecord(v) && isOptionId(v.id) && typeof v.label === "string";
export const isOtherOption = (option: Pick<OptionItem, "label">) => ["other", "其他"].includes(option.label.trim().toLocaleLowerCase());

function parseQuestions(value: unknown): unknown[] {
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return []; }
  }
  if (Array.isArray(value)) return value;
  return value == null ? [] : [value];
}

function inputType(value: unknown): InputType | undefined {
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

function normalizeOption(value: string | OptionItem): OptionItem {
  if (typeof value === "string") {
    const id = value.trim();
    if (!id) throw new Error("Question options must be non-empty and unique");
    return { id, label: id };
  }
  if (!isOptionId(value.id) || !value.label.trim()) throw new Error("Question options must be non-empty and unique");
  return { ...value, id: typeof value.id === "string" ? value.id.trim() : value.id, label: value.label.trim() };
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
  const rawOptions = raw.options ?? raw.choices;
  const options = rawOptions?.map(normalizeOption);
  if (options && new Set(options.map(o => optionKey(o.id))).size !== options.length) throw new Error("Question options must be non-empty and unique");
  const selectedType = inputType(raw.inputType ?? raw.input_type ?? raw.type ?? raw.component);
  const multiple = raw.multiple ?? raw.multi ?? raw.multipleSelect ?? false;
  const finalType: InputType = raw.confirm || selectedType === "confirm" ? "confirm" : selectedType ?? (multiple ? "checkbox" : options ? "radio" : "text");
  if (raw.required !== undefined && typeof raw.required !== "boolean") throw new Error("required must be a boolean. Retry with required:true or required:false.");
  const dataSource = raw.dataSource ?? raw.data_source;
  if (dataSource && !["select", "treeSelect"].includes(finalType)) throw new Error("Data sources require select or treeSelect inputType");
  if (finalType === "date") {
    const formatError = validateDateFormat(raw.dateFormat); if (formatError) throw new Error(formatError);
    if (options || multiple || dataSource) throw new Error("Date questions cannot provide options, multiple, or dataSource.");
  } else if (raw.dateFormat !== undefined) throw new Error('dateFormat is only allowed when inputType is "date".');
  if (finalType === "confirm" && (options || multiple || dataSource)) throw new Error("Confirmation questions cannot provide options or multiple");
  if (["radio", "select", "treeSelect"].includes(finalType) && !options && !dataSource) throw new Error("Choice questions require options or dataSource");
  if ((multiple || finalType === "checkbox") && !options && !dataSource) throw new Error("Multiple-choice questions require options or dataSource");
  const kind = finalType === "confirm" ? "confirm" : finalType === "date" ? "date" : multiple || finalType === "checkbox" ? "multiple" : options || dataSource || ["radio", "select", "treeSelect"].includes(finalType) ? "single" : "text";
  const suppliedDefault = firstDefined(raw.default, raw.defaultValue, raw.prefill, raw.value);
  const defaultValue = kind === "multiple" ? normalizeMultipleDefault(suppliedDefault) : suppliedDefault;
  if (kind !== "confirm" && defaultValue === undefined) throw new Error("默认答案缺失：每个非确认问题都必须提供非空 default 推荐值");
  if (typeof defaultValue === "string" && !defaultValue.trim()) throw new Error("默认答案无效：default 必须是非空推荐值，不能是空字符串");
  if (kind === "date" && typeof defaultValue === "string" && raw.dateFormat && !matchesDateFormat(defaultValue, String(raw.dateFormat).trim())) {
    throw new Error(`Date default must match dateFormat: ${String(raw.dateFormat).trim()}`);
  }
  const result: NormalizedQuestion = { id, question, inputType: finalType, kind, required: raw.required === true };
  if (options) result.options = options;
  if (dataSource) result.dataSource = dataSource;
  if (finalType === "date") result.dateFormat = String(raw.dateFormat).trim();
  if (defaultValue !== undefined) result.default = normalizeAnswer(result, defaultValue);
  return result;
}

export function normalizeRequest(raw: RawRequest): NormalizedRequest {
  const grouped = raw.questions !== undefined;
  let items: RawQuestion[];
  if (grouped) {
    const illegal = [
      raw.options, raw.choices,
      raw.inputType, raw.input_type, raw.type, raw.component,
      raw.dateFormat, raw.dataSource, raw.data_source,
      raw.multiple, raw.multi, raw.multipleSelect,
      raw.required, raw.default, raw.defaultValue, raw.prefill, raw.value, raw.confirm,
    ].some(v => v !== undefined);
    const parsed = parseQuestions(raw.questions).filter(isRecord) as RawQuestion[];
    if (raw.confirm) throw new Error(mixedGroupedFieldsError);
    if (parsed.length !== 1 && illegal) throw new Error(mixedGroupedFieldsError);
    if (parsed.length === 1) {
      items = [{ ...raw, ...parsed[0], questions: undefined } as RawQuestion];
    } else items = parsed;
  } else items = [raw];
  if (items.length === 0) throw new Error("Question is required");
  const questions = items.map((item, i) => normalizeOne(item, grouped ? `q${i + 1}` : "answer"));
  if (new Set(questions.map(q => q.id)).size !== questions.length) throw new Error("Grouped question ids must be unique");
  const base = firstString(raw.dataSourceBaseUrl);
  if (questions.some(q => q.dataSource && !isAbsolute(q.dataSource.endpoint)) && !base) throw new Error(missingBaseUrlError);
  const result: NormalizedRequest = { grouped, questions };
  if (base) result.dataSourceBaseUrl = base;
  return result;
}

const isAbsolute = (value: string) => /^https?:\/\//i.test(value);

export function normalizeAnswer(question: NormalizedQuestion, value: AnswerInput): Answer {
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
