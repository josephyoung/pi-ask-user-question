import { describe, expect, it, vi } from "vitest";
import {
  FieldAssistError,
  createFieldAssistService,
  getFieldAssistWarnings,
  normalizeFieldAssistOutput,
  type FieldAssistInput,
} from "../src/field-assist.js";

const input = (overrides: Partial<FieldAssistInput> = {}): FieldAssistInput => ({
  action: "polish",
  fieldType: "textarea",
  title: "请假原因",
  currentValue: "个人事务",
  ...overrides,
});

describe("Field Assist", () => {
  it("warns for sensitive metadata but allows assistance", async () => {
    const model = { generateText: vi.fn().mockResolvedValue("仅用于紧急联系。") };
    const service = createFieldAssistService({ model, maxRetries: 0 });
    await expect(service.assist(input({
      action: "regenerate",
      fieldType: "input",
      title: "手机号",
      currentValue: "",
    }))).resolves.toMatchObject({
      value: "仅用于紧急联系。",
      metadata: { warnings: [{ code: "SENSITIVE_FIELD" }] },
    });
    expect(model.generateText).toHaveBeenCalledOnce();
    expect(getFieldAssistWarnings({ title: "API token", placeholder: "请输入" })).toHaveLength(1);
  });

  it("rejects obvious credentials and overlong input before creating a model request", async () => {
    const model = { generateText: vi.fn() };
    const service = createFieldAssistService({ model });
    await expect(service.assist(input({ currentValue: "api_key=sk-1234567890abcdefghijklmnop" })))
      .rejects.toMatchObject({ code: "FIELD_ASSIST_NOT_ALLOWED" });
    await expect(service.assist(input({
      action: "regenerate",
      title: "token=abcdefghijklmnopqrstuvwxyz123456",
      currentValue: "",
    }))).rejects.toMatchObject({ code: "FIELD_ASSIST_NOT_ALLOWED" });
    await expect(service.assist(input({
      action: "regenerate",
      currentValue: "",
      prefill: "token=abcdefghijklmnopqrstuvwxyz123456",
    }))).rejects.toMatchObject({ code: "FIELD_ASSIST_NOT_ALLOWED" });
    await expect(service.assist(input({ fieldType: "input", currentValue: "x".repeat(2001) })))
      .rejects.toMatchObject({ code: "REQUEST_TOO_LARGE" });
    expect(model.generateText).not.toHaveBeenCalled();
  });

  it("retries only invalid semantic output and uses a polish-specific retry prompt", async () => {
    const model = {
      generateText: vi.fn()
        .mockResolvedValueOnce("有事。")
        .mockResolvedValueOnce("有事需要处理"),
    };
    const service = createFieldAssistService({ model, maxRetries: 1 });
    await expect(service.assist(input({ fieldType: "input", currentValue: "有事" })))
      .resolves.toMatchObject({ value: "有事需要处理", metadata: { attempts: 2 } });
    expect(model.generateText.mock.calls[1]?.[0].messages.at(-1)?.content).toContain("不要只补句末标点");
  });

  it("rejects repeated generation and follow-up questions after the retry budget", async () => {
    const repeated = { generateText: vi.fn().mockResolvedValue("原内容") };
    await expect(createFieldAssistService({ model: repeated, maxRetries: 1 }).assist(input({
      action: "regenerate",
      currentValue: "原内容",
    }))).rejects.toMatchObject({ code: "INVALID_MODEL_OUTPUT" });
    expect(repeated.generateText).toHaveBeenCalledTimes(2);

    const followup = { generateText: vi.fn().mockResolvedValue("请补充具体原因") };
    await expect(createFieldAssistService({ model: followup, maxRetries: 0 }).assist(input()))
      .rejects.toMatchObject({ code: "INVALID_MODEL_OUTPUT" });
  });

  it("normalizes and bounds output by field type", () => {
    expect(normalizeFieldAssistOutput("  one\n two  ", "input")).toBe("one two");
    expect(normalizeFieldAssistOutput("line  \r\nnext  ", "textarea")).toBe("line\nnext");
    expect(normalizeFieldAssistOutput("x".repeat(500), "input")).toHaveLength(240);
    expect(normalizeFieldAssistOutput("x".repeat(4000), "textarea")).toHaveLength(3000);
  });

  it("propagates abort and preserves stable model failures", async () => {
    const controller = new AbortController();
    const model = {
      generateText: vi.fn(async ({ signal }: { signal: AbortSignal }) => {
        controller.abort();
        if (signal.aborted) throw new FieldAssistError("MODEL_ABORTED", "AI assist was aborted");
        return "unreachable";
      }),
    };
    await expect(createFieldAssistService({ model }).assist(input(), { signal: controller.signal }))
      .rejects.toMatchObject({ code: "MODEL_ABORTED" });
  });
});
