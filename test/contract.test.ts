import { describe, expect, it } from "vitest";
import { ASK_USER_QUESTION_TOOL_NAME, createTool, description, parameters, promptGuidelines, promptSnippet } from "../src/index.js";

describe("canonical model-facing contract", () => {
  it("serializes the frozen Dano contract plus the approved request-context additions", () => {
    const tool = createTool();
    expect({ name: tool.name, description, promptSnippet, promptGuidelines, parameters }).toMatchSnapshot();
    expect(ASK_USER_QUESTION_TOOL_NAME).toBe("ask_user_question");
    expect(parameters.properties).toHaveProperty("dataSourceBaseUrl");
    expect(JSON.stringify(parameters.properties.dataSource)).toContain("headers");
    expect(JSON.stringify(parameters.properties.dataSource)).toContain("cookies");
  });
});
