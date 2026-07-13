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
  headers?: Record<string, string>;
  cookies?: Record<string, string>;
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

export type InputType = "text" | "textarea" | "date" | "radio" | "checkbox" | "select" | "treeSelect" | "confirm";

export interface RawQuestion {
  id?: string;
  key?: string;
  name?: string;
  question?: string;
  title?: string;
  label?: string;
  prompt?: string;
  options?: Array<string | OptionItem>;
  choices?: Array<string | OptionItem>;
  inputType?: InputType | string;
  type?: string;
  input_type?: string;
  component?: string;
  dateFormat?: unknown;
  dataSource?: DataSource;
  data_source?: DataSource;
  multiple?: boolean;
  multi?: boolean;
  multipleSelect?: boolean;
  required?: unknown;
  confirm?: true;
  default?: AnswerInput;
  defaultValue?: AnswerInput;
  prefill?: AnswerInput;
  value?: AnswerInput;
}

export interface RawRequest extends RawQuestion {
  questions?: unknown;
  dataSourceBaseUrl?: string;
}

export interface NormalizedQuestion {
  id: string;
  question: string;
  inputType: InputType;
  kind: "text" | "date" | "single" | "multiple" | "confirm";
  options?: OptionItem[];
  presentationOptions?: OptionItem[];
  dataSource?: DataSource;
  dateFormat?: string;
  required: boolean;
  default?: AnswerInput;
}

export interface NormalizedRequest {
  grouped: boolean;
  questions: NormalizedQuestion[];
  dataSourceBaseUrl?: string;
}

export type AskUserQuestionResult =
  | { status: "answered"; answer: Answer | Record<string, Answer> }
  | { status: "cancelled" };
