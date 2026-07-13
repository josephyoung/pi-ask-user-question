import { describe, expect, it } from "vitest";
import { missingBaseUrlError, normalizeAnswer, normalizeRequest } from "../src/normalize.js";

describe("compatibility normalization", () => {
  it("accepts JSON-stringified questions and identity/input/default aliases", () => {
    const request = normalizeRequest({
      questions: JSON.stringify({ key: "reason", prompt: "Why?", input_type: "long_text", prefill: "Because", required: true }),
    });
    expect(request).toMatchObject({ grouped: true, questions: [{ id: "reason", question: "Why?", inputType: "textarea", default: "Because", required: true }] });
    expect(normalizeRequest({ question: "Folded prompt", questions: { id: "folded", default: "answer" } })).toMatchObject({
      grouped: true, questions: [{ id: "folded", question: "Folded prompt", default: "answer" }],
    });
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

  it("rejects top-level confirmation mixed with questions like the canonical Dano contract", () => {
    expect(() => normalizeRequest({ confirm: true, questions: { id: "confirm", question: "Proceed?" } })).toThrow("field configuration belongs inside");
    expect(() => normalizeRequest({ choices: ["ignored"], questions: [
      { id: "first", question: "First", default: "one" },
      { id: "second", question: "Second", default: "two" },
    ] })).toThrow("field configuration belongs inside");
    expect(() => normalizeRequest({ input_type: "confirm", questions: [
      { id: "first", question: "First", default: "one" },
      { id: "second", question: "Second", default: "two" },
    ] })).toThrow("field configuration belongs inside");
  });

  it("gives correct single and grouped retry examples before a relative source opens", () => {
    expect(() => normalizeRequest({ question: "Pick", inputType: "select", default: "a", dataSource: { type: "api", endpoint: "/options" } })).toThrow(missingBaseUrlError);
    expect(missingBaseUrlError).toContain('"question":"Choose"');
    expect(missingBaseUrlError).toContain('"questions"');
    expect(missingBaseUrlError).toContain('"dataSourceBaseUrl"');
  });
});
