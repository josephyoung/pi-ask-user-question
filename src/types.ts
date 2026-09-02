export type OptionId = string | number;

export interface OptionItem {
  id: OptionId;
  label: string;
  extra?: Record<string, unknown>;
  children?: OptionItem[];
}

export type AnswerInput = string | number | boolean | OptionItem | Array<string | number | OptionItem>;
export type Answer = string | number | boolean | Array<string | number>;

export interface DataSource {
  type: "api";
  endpoint: string;
  method?: "GET" | "POST";
  params?: Record<string, unknown>;
  searchParam?: string;
  pageParam?: string;
  pageSizeParam?: string;
  pageSize?: number;
  resultPath?: string;
  totalPath?: string;
  idField?: string;
  labelField?: string;
  childrenField?: string;
  extraFields?: string[];
}

export type BuiltinInputType = "text" | "textarea" | "date" | "radio" | "checkbox" | "select" | "treeSelect" | "confirm";
export type InputType = BuiltinInputType | (string & {});

export interface RawQuestion {
  id?: unknown;
  key?: unknown;
  name?: unknown;
  question?: unknown;
  title?: unknown;
  label?: unknown;
  prompt?: unknown;
  options?: unknown;
  choices?: unknown;
  inputType?: unknown;
  type?: unknown;
  input_type?: unknown;
  component?: unknown;
  fieldAssist?: unknown;
  field_assist?: unknown;
  aiAssist?: unknown;
  ai_assist?: unknown;
  dateFormat?: unknown;
  dataSource?: unknown;
  data_source?: unknown;
  multiple?: unknown;
  multi?: unknown;
  multipleSelect?: unknown;
  required?: unknown;
  confirm?: unknown;
  default?: unknown;
  defaultValue?: unknown;
  prefill?: unknown;
  value?: unknown;
}

export interface RawRequest extends RawQuestion {
  questions?: unknown;
  dataSourceBaseUrl?: string;
  formIds?: unknown;
  formId?: unknown;
}

export interface NormalizedQuestion {
  id: string;
  question: string;
  inputType: InputType;
  kind: "text" | "date" | "single" | "multiple" | "confirm" | "capability";
  options?: OptionItem[];
  presentationOptions?: OptionItem[];
  dataSource?: DataSource;
  fieldAssist: boolean;
  dateFormat?: string;
  required: boolean;
  default?: AnswerInput;
  capability?: {
    kind: string;
    version: number;
    canonical: unknown;
    state: unknown;
  };
}

export interface NormalizedRequest {
  kind: "questions" | "confirmation";
  grouped: boolean;
  title?: string;
  questions: NormalizedQuestion[];
  dataSourceBaseUrl?: string;
  formIds?: string[];
  confirmationContext?: {
    receivedShape: { formIds: string; formId: string };
    ignoredReasons: string[];
    fallbackAttempted: boolean;
  };
}

export type AskUserQuestionResult =
  | { status: "answered"; answer: Answer | Record<string, Answer>; formId?: string }
  | {
      status: "confirmed";
      answer: Record<string, Answer>;
      confirmationOfToolCallId: string;
      forms: Array<{ formId: string; answer: Record<string, Answer> }>;
    }
  | { status: "cancelled" }
  | { status: "invalid"; error: StructuredQuestionError };

export interface StructuredQuestionError {
  code:
    | "invalid_question_arguments"
    | "invalid_confirmation_source"
    | "duplicate_question_call"
    | "question_presentation_timeout"
    | "question_presentation_failed"
    | "question_validation_failed"
    | "question_cancelled";
  category: "validation" | "confirmation" | "duplicate_call" | "lifecycle";
  message: string;
  retryable: boolean;
  issues: Array<{ code: string; path?: string; message: string }>;
  sourceCode?: string;
  terminalCode?: string;
  context?: Record<string, unknown>;
}
