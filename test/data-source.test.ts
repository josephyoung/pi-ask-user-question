import { createServer, type IncomingMessage } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { loadOptions } from "../src/data-source.js";
import { createDataSourceCredentialResolver } from "../src/data-source-auth.js";

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
  it("sends GET params, search and pagination and maps results", async () => {
    const result = await loadOptions({
      type: "api", endpoint: "/options", params: { fixed: "yes" },
      searchParam: "q", pageParam: "page", pageSizeParam: "limit", pageSize: 10,
      resultPath: "data.rows", totalPath: "data.total", idField: "code", labelField: "text", childrenField: "children", extraFields: ["meta"],
    }, baseUrl, { search: "sev", page: 2 });
    expect(result).toMatchObject({ total: 41, options: [{ id: 7, label: "Seven", extra: { meta: "kept" }, children: [{ id: 8, label: "Eight" }] }] });
    expect(seen.at(-1)).toMatchObject({ method: "GET" });
    expect(seen.at(-1)?.headers.authorization).toBeUndefined();
    expect(seen.at(-1)?.headers.cookie).toBeUndefined();
    expect(seen.at(-1)?.url).toContain("fixed=yes&q=sev&page=2&limit=10");
  });

  it("sends POST params in JSON", async () => {
    await loadOptions({ type: "api", endpoint: `${baseUrl}/post`, method: "POST", params: { scope: "all" }, resultPath: "data.rows", idField: "code", labelField: "text" }, undefined);
    expect(seen.at(-1)).toMatchObject({ method: "POST", body: '{"scope":"all"}' });
  });

  it("applies user-owned credentials only inside the production load path", async () => {
    const origin = new URL(baseUrl).origin;
    const resolveCredentials = createDataSourceCredentialResolver({
      version: 1,
      rules: [{
        origin,
        pathPrefix: "/protected/",
        headers: { Authorization: "TEST_AUTH" },
        cookies: { session: "TEST_SESSION" },
      }],
    }, name => ({ TEST_AUTH: "Bearer private", TEST_SESSION: "cookie-private" })[name]);
    await loadOptions({
      type: "api", endpoint: "/protected/options", resultPath: "data.rows", idField: "code", labelField: "text",
    }, baseUrl, {}, undefined, resolveCredentials);
    expect(seen.at(-1)?.headers.authorization).toBe("Bearer private");
    expect(seen.at(-1)?.headers.cookie).toBe("session=cookie-private");

    await loadOptions({
      type: "api", endpoint: "/public/options", resultPath: "data.rows", idField: "code", labelField: "text",
    }, baseUrl, {}, undefined, resolveCredentials);
    expect(seen.at(-1)?.headers.authorization).toBeUndefined();
    expect(seen.at(-1)?.headers.cookie).toBeUndefined();
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

  it("routes requests through an injectable RemoteOptionTransport", async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({ rows: [{ id: "injected", label: "Injected" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const result = await loadOptions(
      { type: "api", endpoint: "https://example.test/options", resultPath: "rows" },
      undefined,
      {},
      undefined,
      undefined,
      { request },
    );
    expect(result.options).toEqual([{ id: "injected", label: "Injected" }]);
    expect(request).toHaveBeenCalledOnce();
  });
});
