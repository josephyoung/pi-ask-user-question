import { describe, expect, it } from "vitest";
import { normalizeRequestStructured } from "../src/validation.js";

function failure(request: unknown) {
  try { normalizeRequestStructured(request); } catch (cause) { return JSON.parse((cause as Error).message); }
  throw new Error("Expected failure");
}

describe("Dano structured validation compatibility", () => {
  it.each([
    ["invalid request", "not an object", "invalid_request_shape", undefined],
    ["questions json", { questions: '[{"id":"x"' }, "invalid_questions_json", "questions"],
    ["questions shape", { questions: 7 }, "invalid_questions_shape", "questions"],
    ["question item", { questions: [null] }, "invalid_question_item", "questions[0]"],
    ["aliases", { question: "Pick", options: ["A"], choices: ["B"] }, "conflicting_aliases", "options"],
    ["missing id", { questions: [{ question: "First?" }] }, "missing_question_id", "questions[0].id"],
    ["missing text", { default: "A" }, "missing_question_text", "question"],
    ["input type", { question: "Value?", inputType: "spreadsheet" }, "invalid_input_type", "inputType"],
    ["options", { question: "Pick", options: ["A", null] }, "invalid_options", "options[1]"],
    ["choice source", { question: "Pick", inputType: "select" }, "missing_choice_source", "question"],
    ["data source", { question: "Who?", inputType: "select", dataSource: { type: "api" } }, "invalid_data_source", "dataSource"],
  ] as const)("returns a stable issue for %s", (_name, request, code, path) => {
    const result = failure(request);
    expect(result).toMatchObject({ status: "invalid", error: { code: "invalid_question_arguments", category: "validation", retryable: true } });
    expect(result.error.issues).toContainEqual(expect.objectContaining({ code, ...(path ? { path } : {}) }));
  });

  it("aggregates every missing and duplicate grouped id path", () => {
    expect(failure({ questions: [{ question: "A" }, { question: "B" }] }).error.issues.map((item: any) => item.path)).toEqual([
      "questions[0].id", "questions[1].id",
    ]);
    expect(failure({ questions: [
      { id: "same", question: "A" }, { id: "same", question: "B" }, { id: "same", question: "C" },
    ] }).error.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "duplicate_question_id", path: "questions[0].id" }),
      expect.objectContaining({ code: "duplicate_question_id", path: "questions[1].id" }),
      expect.objectContaining({ code: "duplicate_question_id", path: "questions[2].id" }),
    ]));
  });

  it("aggregates independent alias, identity, text, and default problems", () => {
    expect(failure({ questions: [{ options: ["A"], choices: ["B"], default: { unsupported: true } }] }).error.issues)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "missing_question_id", path: "questions[0].id" }),
        expect.objectContaining({ code: "missing_question_text", path: "questions[0].question" }),
        expect.objectContaining({ code: "conflicting_aliases", path: "questions[0].options" }),
        expect.objectContaining({ code: "invalid_default", path: "questions[0].default" }),
      ]));
  });

  it.each([
    [{ question: "Q", inputType: "text", type: "date", default: "x" }, "conflicting_aliases", "inputType"],
    [{ question: "Q", options: [{ id: "A", value: "B", label: "A" }, "C"], default: "A" }, "invalid_options", "options[0]"],
    [{ question: "Q", inputType: "select", dataSource: { type: "api", endpoint: "/a" }, data_source: { type: "api", endpoint: "/b" }, dataSourceBaseUrl: "https://example.test" }, "conflicting_aliases", "dataSource"],
    [{ question: "Q", options: ["A", "B"], multiple: true, multi: false, default: ["A"] }, "conflicting_aliases", "multiple"],
    [{ question: "Q", default: "A", defaultValue: "B" }, "conflicting_aliases", "default"],
  ])("rejects incompatible aliases", (request, code, path) => {
    expect(failure(request).error.issues).toContainEqual(expect.objectContaining({ code, path }));
  });

  it("does not serialize raw invalid values", () => {
    const secret = "secret-answer-value";
    expect(JSON.stringify(failure({ question: "Pick", options: ["A"], default: { secret } }))).not.toContain(secret);
  });
});
