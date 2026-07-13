import { createServer, type IncomingMessage } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadOptions } from "../src/data-source.js";

let baseUrl = "";
const seen: Array<{ method: string | undefined; url: string | undefined; headers: IncomingMessage["headers"]; body: string }> = [];
const server = createServer((request, response) => {
  let body = "";
  request.on("data", chunk => { body += String(chunk); });
  request.on("end", () => {
    seen.push({ method: request.method, url: request.url, headers: request.headers, body });
    if (request.url?.startsWith("/invalid-json")) { response.end("not json"); return; }
    if (request.url?.startsWith("/error")) { response.statusCode = 503; response.end("down"); return; }
    response.setHeader("content-type", "application/json");
    const numericLabel = request.url?.startsWith("/numeric-label");
    response.end(JSON.stringify({ data: { rows: [{ code: 7, text: numericLabel ? 700 : "Seven", children: [{ code: 8, text: "Eight" }], meta: "kept" }], total: 41 } }));
  });
});

beforeAll(async () => {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture server did not bind");
  baseUrl = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });

describe("remote data source", () => {
  it("sends GET params, search, pagination, headers and appended cookies and maps results", async () => {
    const result = await loadOptions({
      type: "api", endpoint: "/options", params: { fixed: "yes" }, headers: { "x-test": "header", Cookie: "existing=1" }, cookies: { session: "abc", tenant: "two" },
      searchParam: "q", pageParam: "page", pageSizeParam: "limit", pageSize: 10,
      resultPath: "data.rows", totalPath: "data.total", idField: "code", labelField: "text", childrenField: "children", extraFields: ["meta"],
    }, baseUrl, { search: "sev", page: 2 });
    expect(result).toMatchObject({ total: 41, options: [{ id: 7, label: "Seven", extra: { meta: "kept" }, children: [{ id: 8, label: "Eight" }] }] });
    expect(seen.at(-1)).toMatchObject({ method: "GET", headers: { "x-test": "header", cookie: "existing=1; session=abc; tenant=two" } });
    expect(seen.at(-1)?.url).toContain("fixed=yes&q=sev&page=2&limit=10");
  });

  it("sends POST params in JSON", async () => {
    await loadOptions({ type: "api", endpoint: `${baseUrl}/post`, method: "POST", params: { scope: "all" }, resultPath: "data.rows", idField: "code", labelField: "text" }, undefined);
    expect(seen.at(-1)).toMatchObject({ method: "POST", body: '{"scope":"all"}' });
  });

  it("accepts finite numeric remote labels as display strings", async () => {
    const result = await loadOptions({
      type: "api", endpoint: `${baseUrl}/numeric-label`, resultPath: "data.rows", idField: "code", labelField: "text",
    }, undefined);
    expect(result.options).toMatchObject([{ id: 7, label: "700" }]);
  });

  it("reports HTTP, invalid JSON and invalid mapping failures distinctly", async () => {
    await expect(loadOptions({ type: "api", endpoint: `${baseUrl}/error` }, undefined)).rejects.toThrow("HTTP 503");
    await expect(loadOptions({ type: "api", endpoint: `${baseUrl}/invalid-json` }, undefined)).rejects.toThrow("invalid JSON");
    await expect(loadOptions({ type: "api", endpoint: `${baseUrl}/options`, resultPath: "missing" }, undefined)).rejects.toThrow("resultPath");
  });
});
