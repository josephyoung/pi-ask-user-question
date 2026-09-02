export type FieldAssistAction = "regenerate" | "polish";
export type FieldAssistFieldType = "input" | "textarea";

export interface FieldAssistInput {
  action: FieldAssistAction;
  fieldType: FieldAssistFieldType;
  title: string;
  placeholder?: string;
  currentValue: string;
  prefill?: string;
}

export type FieldAssistErrorCode =
  | "EMPTY_POLISH_INPUT"
  | "FIELD_ASSIST_DISABLED"
  | "FIELD_ASSIST_NOT_ALLOWED"
  | "REQUEST_TOO_LARGE"
  | "MODEL_UNAVAILABLE"
  | "MODEL_TIMEOUT"
  | "MODEL_ABORTED"
  | "INVALID_MODEL_OUTPUT"
  | "RATE_LIMITED"
  | "INTERNAL_ERROR";

export class FieldAssistError extends Error {
  constructor(
    readonly code: FieldAssistErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface FieldAssistMessage {
  role: "system" | "user";
  content: string;
}

export interface FieldAssistModel {
  generateText(request: {
    messages: FieldAssistMessage[];
    signal: AbortSignal;
  }): Promise<string>;
}

export interface FieldAssistWarning {
  code: "SENSITIVE_FIELD";
  message: string;
}

export interface FieldAssistResult {
  value: string;
  metadata: {
    action: FieldAssistAction;
    fieldType: FieldAssistFieldType;
    inputLength: number;
    outputLength: number;
    elapsedMs: number;
    attempts: number;
    warnings?: FieldAssistWarning[];
  };
}

const LIMITS = {
  inputMaxChars: 2_000,
  textareaMaxChars: 12_000,
  inputOutputMaxChars: 240,
  textareaOutputMaxChars: 3_000,
};

const WARNING_PATTERN =
  /password|passwd|pwd|token|secret|credential|api[ _-]?key|apikey|private key|ssh key|cookie|session|authorization|bearer|验证码|密码|令牌|密钥|秘钥|身份证|银行卡|手机号|邮箱验证码|短信验证码/i;

const SECRET_VALUE_PATTERN =
  /\b(?:sk-[A-Za-z0-9_-]{16,}|[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,})\b|-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:token|secret|api[ _-]?key|authorization|bearer)\s*[:=]\s*\S{8,}/i;

const FOLLOW_UP_QUESTION_PATTERN =
  /ask_user_question|(?:请问|请您|麻烦您|需要您)|(?:请|麻烦|需要)(?:补充|提供|告知|填写|输入|说明|确认)|(?:还需要|需要更多|缺少).*(?:信息|内容)/i;

const fieldAssistMaxRetries = (value: number | undefined) =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : 10;

export function buildPolishMessages(input: FieldAssistInput): FieldAssistMessage[] {
  return [
    {
      role: "system",
      content: [
        "你是字段文本润色助手。",
        "目标是在不新增具体事实的前提下，让原文更自然、更完整、更适合填写。",
        "原文是唯一事实来源；字段标题、placeholder 只能用于判断语气和表达形式，不能用于补写事实。",
        "允许修正错别字、病句、语序、空白、口语化表达，并可补充通用连接词或谓语使句子完整。",
        "不改变金额、时间、数量、人名、部门、审批事项、编号、专有名词。",
        "不要新增原文没有的具体原因、时间、地点、人物、金额、数量、部门、审批事项、编号或专有名词。",
        "不要只补一个句末标点或只做空白调整。",
        "不要追问用户，不要请求补充信息。",
        "保持原文语种。",
        "只输出润色后的字段值，不要解释，不要加标题，不要用 Markdown 包裹。",
      ].join("\n"),
    },
    { role: "user", content: input.currentValue },
  ];
}

export function buildRegenerateMessages(input: FieldAssistInput): FieldAssistMessage[] {
  return [
    {
      role: "system",
      content: [
        "你是 ask_user_question 字段生成助手。",
        "根据字段标题、placeholder、字段类型和已有内容生成一个可直接填入字段的答案。",
        "重新生成时必须给出不同于 currentValue 和 prefill 的新内容，不要只复读、补标点或微调空白。",
        "只输出字段值，不要解释，不要加标题，不要用 Markdown 包裹。",
        input.fieldType === "input" ? "输出应简短，适合单行输入框。" : "输出可以是自然段，适合多行文本框。",
      ].join("\n"),
    },
    {
      role: "user",
      content: JSON.stringify({
        title: input.title,
        placeholder: input.placeholder,
        fieldType: input.fieldType,
        currentValue: input.currentValue,
        prefill: input.prefill,
      }),
    },
  ];
}

function retryMessages(messages: FieldAssistMessage[], action: FieldAssistAction): FieldAssistMessage[] {
  return [
    ...messages,
    {
      role: "system",
      content: action === "polish"
        ? [
            "上一次输出不是合格润色，可能只是补标点、追问用户，或新增了原文没有的具体事实。",
            "请重新输出一个有意义的安全润色结果。",
            "不要只补句末标点，不要只调整空白。",
            "不要新增具体原因、时间、地点、人物、金额、数量、部门或审批事项。",
            "不要追问用户，不要请求补充信息，不要调用工具。",
            "只输出字段值，不要解释。",
          ].join("\n")
        : [
            "上一次输出不是可直接填入字段的正文，或只是复读了已有内容。",
            "请返回一个不同于 currentValue 和 prefill 的字段值。",
            "不要追问用户，不要请求补充信息，不要调用工具。",
            "只输出字段值，不要解释。",
          ].join("\n"),
    },
  ];
}

export function assertFieldAssistAllowed(input: FieldAssistInput): void {
  if (input.action === "polish" && !input.currentValue.trim()) {
    throw new FieldAssistError("EMPTY_POLISH_INPUT", "Please enter content before polishing");
  }
  const max = input.fieldType === "input" ? LIMITS.inputMaxChars : LIMITS.textareaMaxChars;
  if (input.currentValue.length > max) {
    throw new FieldAssistError("REQUEST_TOO_LARGE", "Field content is too long");
  }
  const outboundContent = [input.title, input.currentValue, input.prefill, input.placeholder];
  if (outboundContent.some(value => typeof value === "string" && SECRET_VALUE_PATTERN.test(value))) {
    throw new FieldAssistError("FIELD_ASSIST_NOT_ALLOWED", "Field contains obvious secret credentials");
  }
}

export function getFieldAssistWarnings(input: {
  title: string;
  placeholder?: string;
  prefill?: string;
}): FieldAssistWarning[] {
  const sensitive = [input.title, input.placeholder, input.prefill]
    .filter((value): value is string => Boolean(value))
    .some(value => WARNING_PATTERN.test(value));
  return sensitive
    ? [{ code: "SENSITIVE_FIELD", message: "该字段可能包含敏感信息，请确认内容适合发送给 AI 辅助。" }]
    : [];
}

export function normalizeFieldAssistOutput(value: string, fieldType: FieldAssistFieldType): string {
  const normalized = fieldType === "input"
    ? value.replace(/\s+/g, " ").trim()
    : value.replace(/\r\n/g, "\n").split("\n").map(line => line.trimEnd()).join("\n").trim();
  const max = fieldType === "input" ? LIMITS.inputOutputMaxChars : LIMITS.textareaOutputMaxChars;
  return normalized.length > max ? normalized.slice(0, max).trimEnd() : normalized;
}

function comparable(value: string | undefined): string {
  return (value ?? "")
    .toLocaleLowerCase()
    .replace(/[\s\u3000，。！？、,.!?:：；;'"“”‘’（）()[\]{}<>《》【】\-—_]+/g, "");
}

function assertOutput(input: FieldAssistInput, value: string): void {
  if (!value) throw new FieldAssistError("INVALID_MODEL_OUTPUT", "AI 辅助返回了空内容，请重试");
  if (FOLLOW_UP_QUESTION_PATTERN.test(value)) {
    throw new FieldAssistError("INVALID_MODEL_OUTPUT", "AI 辅助返回了追问内容，请重试");
  }
  const output = comparable(value);
  if (input.action === "regenerate") {
    const repeated = [input.currentValue, input.prefill]
      .map(comparable)
      .some(original => original && original === output);
    if (repeated) throw new FieldAssistError("INVALID_MODEL_OUTPUT", "AI 辅助返回了重复内容，请重试");
    return;
  }

  const source = comparable(input.currentValue);
  if (source && source === output) {
    throw new FieldAssistError("INVALID_MODEL_OUTPUT", "AI 润色只做了标点或空白调整，请重试");
  }
  if (Array.from(input.currentValue.trim()).length > 4) return;
  const invented = [
    "个人事务", "私事", "家中", "家庭", "临时", "突发", "请假", "无法参加",
    "无法出席", "会议", "项目", "工作安排",
  ].some(term => value.includes(term) && !input.currentValue.includes(term));
  if (invented) {
    throw new FieldAssistError("INVALID_MODEL_OUTPUT", "AI 润色新增了原文没有的具体信息，请重试");
  }
}

export function createFieldAssistService(options: {
  model: FieldAssistModel;
  timeoutMs?: number;
  maxRetries?: number;
}) {
  return {
    async assist(
      input: FieldAssistInput,
      runOptions: { signal?: AbortSignal } = {},
    ): Promise<FieldAssistResult> {
      const startedAt = Date.now();
      assertFieldAssistAllowed(input);
      const baseMessages = input.action === "polish"
        ? buildPolishMessages(input)
        : buildRegenerateMessages(input);
      const maxAttempts = 1 + fieldAssistMaxRetries(options.maxRetries);
      let value = "";
      let attempts = 0;
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        attempts = attempt + 1;
        const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? 60_000);
        const signal = runOptions.signal
          ? AbortSignal.any([runOptions.signal, timeoutSignal])
          : timeoutSignal;
        try {
          const raw = await options.model.generateText({
            messages: attempt === 0 ? baseMessages : retryMessages(baseMessages, input.action),
            signal,
          });
          value = normalizeFieldAssistOutput(raw, input.fieldType);
          assertOutput(input, value);
          break;
        } catch (cause) {
          if (runOptions.signal?.aborted && !(cause instanceof FieldAssistError)) {
            throw new FieldAssistError("MODEL_ABORTED", "AI assist was aborted", { cause });
          }
          if (timeoutSignal.aborted && !(cause instanceof FieldAssistError)) {
            throw new FieldAssistError("MODEL_TIMEOUT", "AI assist timed out", { cause });
          }
          if (attempt < maxAttempts - 1 && cause instanceof FieldAssistError && cause.code === "INVALID_MODEL_OUTPUT") {
            continue;
          }
          throw cause;
        }
      }
      const warnings = getFieldAssistWarnings(input);
      return {
        value,
        metadata: {
          action: input.action,
          fieldType: input.fieldType,
          inputLength: input.currentValue.length,
          outputLength: value.length,
          elapsedMs: Date.now() - startedAt,
          attempts,
          ...(warnings.length ? { warnings } : {}),
        },
      };
    },
  };
}
