import { describe, expect, it } from "vitest";
import { missingBaseUrlError, normalizeAnswer, normalizeRequest } from "../src/normalize.js";
import { prepareArguments } from "../src/prepare.js";
import { normalizeRequestStructured } from "../src/validation.js";

describe("compatibility normalization", () => {
  it("prepares one-level JSON input before schema validation", () => {
    expect(prepareArguments(JSON.stringify({
      questions: JSON.stringify([{ id: "reason", question: "Why?" }]),
      options: JSON.stringify(["A", "B"]),
      formIds: JSON.stringify(["form-1"]),
    }))).toMatchObject({
      questions: [{ id: "reason", question: "Why?" }],
      options: ["A", "B"],
      formIds: '["form-1"]',
    });
  });

  it("accepts omitted defaults and applies Field Assist defaults", () => {
    const single = normalizeRequest({ question: "Optional text" } as any) as any;
    expect(single.questions[0]).toMatchObject({ inputType: "text", fieldAssist: false });
    expect(single.questions[0]).not.toHaveProperty("default");

    const textarea = normalizeRequest({ question: "Draft", inputType: "textarea" } as any) as any;
    expect(textarea.questions[0]).toMatchObject({ inputType: "textarea", fieldAssist: true });

    const disabled = normalizeRequest({ question: "Draft", inputType: "textarea", field_assist: "off" } as any) as any;
    expect(disabled.questions[0].fieldAssist).toBe(false);
    expect(normalizeRequest({ question: "Required", required: "true" } as any).questions[0]?.required).toBe(true);
  });

  it("keeps legacy ordinary confirmation distinct from Submitted Form confirmation", () => {
    expect(normalizeRequest({ confirm: true, formIds: '["form-1","form-1","form-2"]' } as any)).toMatchObject({
      kind: "confirmation",
      formIds: ["form-1", "form-2"],
    });
    expect(normalizeRequest({ question: "Proceed?", confirm: true } as any)).toMatchObject({
      kind: "questions",
      grouped: false,
      questions: [{ kind: "confirm", question: "Proceed?" }],
    });
    expect(normalizeRequest({ question: "Review this form?", confirm: true, formIds: ["form-1"] } as any))
      .toMatchObject({ kind: "confirmation", formIds: ["form-1"] });
    expect(normalizeRequest({ confirm: true } as any))
      .toMatchObject({ kind: "confirmation", formIds: [] });
    expect(normalizeRequest({ question: "Not a confirmation", confirm: "false" } as any).questions[0])
      .toMatchObject({ kind: "text", inputType: "text" });
    expect(normalizeRequest({ question: "Still not a confirmation", confirm: "0" } as any).questions[0])
      .toMatchObject({ kind: "text", inputType: "text" });
  });

  it("drops model-supplied remote credentials from the canonical source", () => {
    const request = normalizeRequest({
      question: "Project",
      inputType: "select",
      dataSource: {
        type: "api",
        endpoint: "https://example.test/projects",
        headers: { Authorization: "secret" },
        cookies: { session: "secret" },
      },
    } as any) as any;
    expect(request.questions[0].dataSource).not.toHaveProperty("headers");
    expect(request.questions[0].dataSource).not.toHaveProperty("cookies");
  });

  it("accepts JSON-stringified questions and identity/input/default aliases", () => {
    const request = normalizeRequest({
      questions: JSON.stringify({ key: "reason", prompt: "Why?", input_type: "long_text", prefill: "Because", required: true }),
    });
    expect(request).toMatchObject({ grouped: true, questions: [{ id: "reason", question: "Why?", inputType: "textarea", default: "Because", required: true }] });
    expect(normalizeRequest({ question: "Folded prompt", questions: { id: "folded", default: "answer" } })).toMatchObject({
      grouped: true, questions: [{ id: "folded", question: "Folded prompt", default: "answer" }],
    });
  });

  it("matches the pinned Dano option-alias compatibility matrix", () => {
    const expected = { kind: "single", options: [{ id: "是", label: "是" }, { id: "否", label: "否" }] };
    expect(normalizeRequestStructured({ question: "是否开始？", options: '["是"', choices: '["是","否"]' }).questions[0]).toMatchObject(expected);
    expect(normalizeRequestStructured({ question: "是否开始？", options: ["是", "否"], choices: '["是","否"]' }).questions[0]).toMatchObject(expected);
    expect(normalizeRequestStructured({
      title: { malformed: true },
      questions: [{ id: "reason", question: "用途？", inputType: "text", options: '["不适用"]', fieldAssist: { malformed: true }, default: "签署合同" }],
    }).questions[0]).toMatchObject({ kind: "text", fieldAssist: false, default: "签署合同" });
    expect(() => normalizeRequestStructured({ question: "选择？", options: "[]" })).toThrow("invalid_options");
    expect(() => normalizeRequestStructured({ questions: [{ question: "用途？", default: "合同" }] })).toThrow("missing_question_id");
  });

  it("normalizes labels, option objects, numeric IDs and typed keys to stable IDs", () => {
    const [question] = normalizeRequest({ question: "Pick", options: [{ id: 0, label: "Zero" }, { id: "0", label: "String zero" }, "Other"], default: 0 }).questions;
    expect(normalizeAnswer(question!, { id: 0, label: "ignored" })).toBe(0);
    expect(normalizeAnswer(question!, "string:0")).toBe("0");
    expect(normalizeAnswer(question!, "custom value")).toBe("custom value");
    const multiple = normalizeRequest({ question: "Pick many", options: ["Known", "Other"], multiple: true, default: ["Known"] }).questions[0]!;
    expect(normalizeAnswer(multiple, ["Known", "custom value"])).toEqual(["Known", "custom value"]);
    expect(() => normalizeAnswer(multiple, ["custom one", "custom two"])).toThrow("只能填写一个其他回答");
    const tree = normalizeRequest({ question: "Tree", inputType: "treeSelect", options: [{ id: "root", label: "Root", children: [{ id: "child", label: "Child" }] }], default: "root" }).questions[0]!;
    expect(normalizeAnswer(tree, "child")).toBe("child");
    expect(() => normalizeRequest({
      question: "Flat select", inputType: "select",
      options: [{ id: "root", label: "Root", children: [{ id: "child", label: "Child" }] }],
      default: "child",
    })).toThrow("答案必须匹配一个可选项");
  });

  it("normalizes a JSON-stringified multiple-choice default produced by a model tool call", () => {
    const question = normalizeRequest({
      question: "Stack",
      inputType: "checkbox",
      multiple: true,
      options: [{ id: "typescript", label: "TypeScript" }, { id: "python", label: "Python" }],
      default: '["typescript"]',
      required: true,
    }).questions[0]!;
    expect(question.default).toEqual(["typescript"]);
  });

  it("stores every static choice default in canonical de-duplicated answer form", () => {
    const options = [{ id: 0, label: "Numeric zero" }, { id: "0", label: "String zero" }];
    const cases = [
      { default: "Numeric zero", expected: 0 },
      { default: { id: 0, label: "ignored" }, expected: 0 },
      { default: 0, expected: 0 },
      { default: "string:0", expected: "0" },
    ] as const;

    for (const item of cases) {
      const question = normalizeRequest({ question: "Pick", options, default: item.default }).questions[0]!;
      expect(question.default).toEqual(item.expected);
    }

    const multiple = normalizeRequest({
      question: "Pick many",
      options,
      multiple: true,
      default: JSON.stringify(["Numeric zero", { id: 0, label: "ignored" }, "string:0"]),
    }).questions[0]!;
    expect(multiple.default).toEqual([0, "0"]);
  });

  it("keeps optional empty answers but blocks required empty answers", () => {
    const optional = normalizeRequest({ question: "Optional", default: "suggested" }).questions[0]!;
    const required = normalizeRequest({ question: "Required", default: "suggested", required: true }).questions[0]!;
    expect(normalizeAnswer(optional, "")).toBe("");
    expect(() => normalizeAnswer(required, "")).toThrow("答案不能为空");
  });

  it("returns dates unchanged and validates grouped identity uniqueness", () => {
    const date = normalizeRequest({ question: "When", inputType: "date", dateFormat: "yyyy-MM-dd", default: "2026-07-13" }).questions[0]!;
    expect(normalizeAnswer(date, "2026-07-14")).toBe("2026-07-14");
    expect(normalizeAnswer(date, "business-day-after-close")).toBe("business-day-after-close");
    expect(normalizeAnswer(date, "")).toBe("");
    expect(() => normalizeRequest({ question: "When", inputType: "date", dateFormat: "yyyy-MM-dd", default: "2026/07/13" })).toThrow("default");
    expect(() => normalizeRequest({ question: "When", inputType: "date", dateFormat: "MM-dd", default: "07-13" })).toThrow("year, month, and day");
    expect(() => normalizeRequest({ questions: [{ id: "same", question: "A", default: "a" }, { id: "same", question: "B", default: "b" }] })).toThrow("ids must be unique");
  });

  it("folds redundant top-level fields into one grouped field and ignores them for complete multi-field forms", () => {
    expect(normalizeRequest({
      question: 42 as any,
      choices: [true, { value: 7, text: false }] as any,
      required: "yes",
      confirm: true,
      questions: { key: 9, default: "true" },
    } as any)).toMatchObject({
      grouped: true,
      title: "表单",
      questions: [{
        id: "9",
        question: "42",
        kind: "single",
        required: true,
        options: [{ id: "true", label: "true" }, { id: 7, label: "false" }],
      }],
    });
    expect(normalizeRequest({ choices: ["ignored"], confirm: true, questions: [
      { id: "first", question: "First", default: "one" },
      { id: "second", question: "Second", default: "two" },
    ] })).toMatchObject({ questions: [
      { id: "first", question: "First", kind: "text" },
      { id: "second", question: "Second", kind: "text" },
    ] });
    expect(normalizeRequest({ input_type: "confirm", questions: [
      { id: "first", question: "First", default: "one" },
      { id: "second", question: "Second", default: "two" },
    ] })).toMatchObject({ questions: [
      { id: "first", kind: "text" },
      { id: "second", kind: "text" },
    ] });
  });

  it("matches Dano safe-scalar, option-alias, data-source, and inapplicable-field normalization", () => {
    expect(normalizeRequestStructured({
      title: 2026,
      dataSourceBaseUrl: "https://example.test/base/",
      questions: [{
        id: 7,
        question: false,
        inputType: "DROP_DOWN",
        options: [1, false, { key: "x", name: 99 }, { value: true, text: "Yes" }],
        dataSource: JSON.stringify({
          type: "API", endpoint: 123, method: "post", pageSize: "25",
          searchParam: 8, extraFields: ["owner", 9], headers: { Authorization: "ignored" },
        }),
      }],
    } as any)).toMatchObject({
      title: "2026",
      questions: [{
        id: "7",
        question: "false",
        inputType: "select",
        options: [
          { id: 1, label: "1" },
          { id: "false", label: "false" },
          { id: "x", label: "99" },
          { id: "true", label: "Yes" },
        ],
        dataSource: {
          type: "api", endpoint: "123", method: "POST", pageSize: 25,
          searchParam: "8", extraFields: ["owner", "9"],
        },
      }],
    });

    const text = normalizeRequestStructured({
      question: "Text",
      inputType: "text",
      options: { malformed: true },
      dataSource: { type: "api", endpoint: "https://example.test", method: "DELETE" },
      dateFormat: { malformed: true },
      multiple: true,
    } as any).questions[0]!;
    expect(text).toMatchObject({ kind: "text", inputType: "text" });
    expect(text).not.toHaveProperty("options");
    expect(text).not.toHaveProperty("dataSource");
    expect(text).not.toHaveProperty("dateFormat");

    const safeMethod = normalizeRequestStructured({
      question: "Remote",
      inputType: "select",
      dataSource: { type: "api", endpoint: "https://example.test", method: "DELETE" },
    } as any).questions[0]!.dataSource;
    expect(safeMethod).toEqual({ type: "api", endpoint: "https://example.test" });

    expect(normalizeRequestStructured({
      question: "Employee?",
      inputType: { malformed: true },
      type: "dropdown",
      options: { malformed: true },
      choices: ["Alice", "Bob"],
      dataSource: { type: "api" },
      data_source: { type: "API", endpoint: "/employees", method: "post", pageSize: "20" },
      default: null,
      prefill: "Alice",
      dataSourceBaseUrl: "https://example.test/api/",
    } as any).questions[0]).toMatchObject({
      inputType: "select",
      options: [{ id: "Alice", label: "Alice" }, { id: "Bob", label: "Bob" }],
      dataSource: { type: "api", endpoint: "/employees", method: "POST", pageSize: 20 },
      default: "Alice",
    });
  });

  it("rejects an empty grouped collection with a path-addressed structured issue", () => {
    try {
      normalizeRequestStructured({ questions: [] });
      throw new Error("expected validation failure");
    } catch (cause: any) {
      expect(cause.result.error).toMatchObject({
        code: "invalid_question_arguments",
        issues: [{ code: "missing_question_text", path: "questions" }],
      });
    }
  });

  it("gives correct single and grouped retry examples before a relative source opens", () => {
    expect(() => normalizeRequest({ question: "Pick", inputType: "select", default: "a", dataSource: { type: "api", endpoint: "/options" } })).toThrow(missingBaseUrlError);
    expect(missingBaseUrlError).toContain('"question":"Choose"');
    expect(missingBaseUrlError).toContain('"questions"');
    expect(missingBaseUrlError).toContain('"dataSourceBaseUrl"');
    try {
      normalizeRequestStructured({ question: "Pick", inputType: "select", dataSource: { type: "api", endpoint: "/options" } });
      throw new Error("expected structured failure");
    } catch (cause: any) {
      expect(cause.result.error.issues[0]).toMatchObject({ code: "invalid_data_source" });
    }
  });
});
