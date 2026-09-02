import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { loadOptions } from "../src/data-source.js";
import { createDataSourceCredentialResolver } from "../src/data-source-auth.js";
import { normalizeAnswer, normalizeRequest } from "../src/normalize.js";
import { displayQuestionAnswer } from "../src/presentation.js";

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("mock port unavailable");
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

describe("controlled npm mock API", () => {
  it("runs search, pagination, tree mapping, canonical selection, and scoped auth", async () => {
    const port = await availablePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const child = spawn("npm", ["run", "mock:api"], {
      cwd: new URL("..", import.meta.url),
      env: { ...process.env, PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", value => { output += String(value); });
    child.stderr.on("data", value => { output += String(value); });
    const closed = new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", code => code === 0 || code === null ? resolve() : reject(new Error(`mock API exited ${code}: ${output}`)));
    });
    try {
      await expect.poll(() => output, { timeout: 5_000 }).toContain("Mock project API listening");
      await expect(fetch(`${baseUrl}/health`).then(response => response.json())).resolves.toEqual({ status: "ok" });

      const credentials = createDataSourceCredentialResolver({
        version: 1,
        rules: [{
          origin: baseUrl,
          pathPrefix: "/api/projects",
          headers: { Authorization: "MOCK_AUTH" },
          cookies: { session: "MOCK_SESSION" },
        }],
      }, name => ({ MOCK_AUTH: "Bearer controlled", MOCK_SESSION: "controlled-cookie" })[name]);
      const source = {
        type: "api" as const,
        endpoint: "/api/projects",
        method: "GET" as const,
        searchParam: "q",
        pageParam: "page",
        pageSizeParam: "limit",
        pageSize: 2,
        resultPath: "payload.rows",
        totalPath: "payload.total",
        idField: "id",
        labelField: "name",
        childrenField: "children",
        extraFields: ["description"],
      };

      const first = await loadOptions(source, baseUrl, { page: 1 }, undefined, credentials);
      expect(first).toMatchObject({ total: 5, options: [
        { id: "project-1", label: "商城平台", extra: { description: "电商业务主项目" } },
        { id: "project-2", label: "运营后台", children: [{ id: "project-2-console" }, { id: "project-2-report", label: "数据报表" }] },
      ] });
      const second = await loadOptions(source, baseUrl, { page: 2 }, undefined, credentials);
      expect(second).toMatchObject({ total: 5, options: [{ id: "project-3" }, { id: "project-4" }] });
      const searched = await loadOptions(source, baseUrl, { search: "报表", page: 1 }, undefined, credentials);
      expect(searched.options).toHaveLength(1);

      const question = normalizeRequest({
        question: "选择远程项目", inputType: "treeSelect", options: searched.options, default: "project-2-report",
      }).questions[0]!;
      expect(normalizeAnswer(question, "project-2-report")).toBe("project-2-report");
      expect(displayQuestionAnswer(question, "project-2-report")).toBe("数据报表");
      await expect.poll(() => output).toContain("GET /health authorization=absent cookie=absent");
      expect(output).toContain("GET /api/projects?page=1&limit=2 authorization=present cookie=present");
      expect(output).toContain("GET /api/projects?page=2&limit=2 authorization=present cookie=present");
      expect(output).toContain("GET /api/projects?q=%E6%8A%A5%E8%A1%A8&page=1&limit=2 authorization=present cookie=present");
    } finally {
      child.kill("SIGTERM");
      await closed;
    }
  });
});
