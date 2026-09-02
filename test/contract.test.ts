import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ASK_USER_QUESTION_TOOL_NAME, createTool, description, parameters, promptGuidelines, promptSnippet } from "../src/index.js";
import { pinnedDanoContract } from "./fixtures/dano-contract-288171.js";

describe("canonical model-facing contract", () => {
  it("serializes the current Dano contract plus only the approved CLI base URL", () => {
    const tool = createTool();
    expect({ name: tool.name, description, promptSnippet, promptGuidelines, parameters }).toMatchSnapshot();
    expect(ASK_USER_QUESTION_TOOL_NAME).toBe("ask_user_question");
    expect(parameters.properties).toHaveProperty("dataSourceBaseUrl");
    expect(parameters.properties).toHaveProperty("formIds");
    expect(JSON.stringify(parameters)).toContain("fieldAssist");
    expect(parameters.properties).not.toHaveProperty("field_assist");
    expect(parameters.properties).not.toHaveProperty("aiAssist");
    expect(parameters.properties).not.toHaveProperty("ai_assist");
    expect(parameters.properties).not.toHaveProperty("formId");
    expect(JSON.stringify(parameters)).not.toContain("headers");
    expect(JSON.stringify(parameters)).not.toContain("cookies");
    expect(tool.executionMode).toBe("sequential");
    expect(tool.prepareArguments).toBeTypeOf("function");
    expect(Object.keys(parameters.properties).filter(name => name !== "dataSourceBaseUrl"))
      .toEqual(pinnedDanoContract.propertyNames);
    const properties = parameters.properties as Record<string, unknown>;
    for (const [name, metadata] of Object.entries(pinnedDanoContract.propertyMetadata)) {
      expect(properties[name]).toMatchObject(metadata);
    }
    expect({ description, promptSnippet, promptGuidelines }).toEqual({
      description: pinnedDanoContract.description,
      promptSnippet: pinnedDanoContract.promptSnippet,
      promptGuidelines: pinnedDanoContract.promptGuidelines,
    });
  });

  it("supports only Pi 0.82.1 and later in the 0.82 line", () => {
    const pkg = JSON.parse(readFileSync(resolve(import.meta.dirname, "../package.json"), "utf8"));
    expect(pkg.peerDependencies["@earendil-works/pi-coding-agent"]).toBe("^0.82.1");
    expect(pkg.peerDependencies["@earendil-works/pi-tui"]).toBe("^0.82.1");
    expect(pkg.devDependencies["@earendil-works/pi-coding-agent"]).toBe("0.82.1");
    expect(pkg.devDependencies["@earendil-works/pi-tui"]).toBe("0.82.1");
  });
});
