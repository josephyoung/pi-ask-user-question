import { describe, expect, it, vi } from "vitest";
import {
  DataSourceCredentialError,
  createDataSourceCredentialResolver,
  fetchWithDataSourceCredentials,
  loadDataSourceAuthConfig,
  type DataSourceAuthConfig,
} from "../src/data-source-auth.js";

const config: DataSourceAuthConfig = {
  version: 1,
  rules: [
    { origin: "https://oa.example.com", headers: { Authorization: "OA_TOKEN" } },
    {
      origin: "https://oa.example.com",
      pathPrefix: "/admin/",
      headers: { Authorization: "OA_ADMIN_TOKEN" },
      cookies: { session: "OA_SESSION" },
    },
  ],
};

describe("user-owned remote data credentials", () => {
  it("loads rules from the Pi agent directory without exposing file contents on failure", () => {
    expect(loadDataSourceAuthConfig("/agent", path => {
      expect(path).toBe("/agent/ask-user-question.auth.json");
      return JSON.stringify(config);
    })).toEqual(config);
    expect(loadDataSourceAuthConfig("/agent", () => { throw Object.assign(new Error(), { code: "ENOENT" }); })).toEqual({ version: 1, rules: [] });
    expect(() => loadDataSourceAuthConfig("/agent", () => '{"secret":"value"}')).toThrow("Remote credential configuration could not be loaded");
  });
  it("uses normalized origin and the longest path prefix and reads env at request time", () => {
    const env: Record<string, string | undefined> = {
      OA_TOKEN: "basic",
      OA_ADMIN_TOKEN: "admin-one",
      OA_SESSION: "session-one",
    };
    const resolve = createDataSourceCredentialResolver(config, name => env[name]);
    expect(resolve(new URL("https://OA.EXAMPLE.COM/admin/projects"))).toEqual({
      headers: { Authorization: "admin-one" },
      cookies: { session: "session-one" },
    });
    env.OA_ADMIN_TOKEN = "admin-two";
    expect(resolve(new URL("https://oa.example.com/admin/projects"))?.headers.Authorization).toBe("admin-two");
    expect(resolve(new URL("https://oa.example.com/public"))?.headers.Authorization).toBe("basic");
    expect(resolve(new URL("https://oa.example.com/administrator"))?.headers.Authorization).toBe("basic");
    expect(resolve(new URL("https://other.example.com/admin/projects"))).toBeUndefined();
  });

  it("rejects missing configured env values and authenticated non-loopback HTTP", () => {
    const missing = createDataSourceCredentialResolver(config, () => undefined);
    expect(() => missing(new URL("https://oa.example.com/admin/projects"))).toThrow(DataSourceCredentialError);

    expect(() => createDataSourceCredentialResolver({
      version: 1,
      rules: [{ origin: "http://oa.example.com", headers: { Authorization: "OA_TOKEN" } }],
    }, () => "secret")).toThrow(/loopback/);

    const loopback = createDataSourceCredentialResolver({
      version: 1,
      rules: [{ origin: "http://127.0.0.1:3000", headers: { Authorization: "OA_TOKEN" } }],
    }, () => "secret");
    expect(loopback(new URL("http://127.0.0.1:3000/projects"))?.headers.Authorization).toBe("secret");
  });

  it("follows same-origin redirects manually without leaking credentials", async () => {
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const value = String(url);
      if (value.endsWith("/start")) return new Response(null, { status: 302, headers: { location: "/final" } });
      expect(new Headers(init?.headers).get("Authorization")).toBe("basic");
      return new Response("ok", { status: 200 });
    });
    const resolve = createDataSourceCredentialResolver(config, name => name === "OA_TOKEN" ? "basic" : undefined);
    const response = await fetchWithDataSourceCredentials(new URL("https://oa.example.com/start"), {}, resolve, fetch);
    expect(await response.text()).toBe("ok");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" });
  });

  it("refuses an authenticated cross-origin redirect", async () => {
    const fetch = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { location: "https://evil.example/steal" },
    }));
    const resolve = createDataSourceCredentialResolver(config, name => name === "OA_TOKEN" ? "basic" : undefined);
    await expect(fetchWithDataSourceCredentials(
      new URL("https://oa.example.com/start"),
      {},
      resolve,
      fetch,
    )).rejects.toThrow(/cross-origin redirect/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([301, 302, 303])("converts authenticated POST to GET for redirect status %s", async status => {
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/submit")) return new Response(null, { status, headers: { location: "/result" } });
      expect(init?.method).toBe("GET");
      expect(init?.body).toBeUndefined();
      expect(new Headers(init?.headers).has("Content-Type")).toBe(false);
      expect(new Headers(init?.headers).get("Authorization")).toBe("basic");
      return new Response("ok", { status: 200 });
    });
    const resolve = createDataSourceCredentialResolver(config, name => name === "OA_TOKEN" ? "basic" : undefined);
    await expect(fetchWithDataSourceCredentials(
      new URL("https://oa.example.com/submit"),
      { method: "POST", body: "payload", headers: { "Content-Type": "text/plain" } },
      resolve,
      fetch,
    )).resolves.toBeInstanceOf(Response);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("redacts credential values rejected by the Headers implementation", async () => {
    const secret = "bearer-secret\r\ninjected: value";
    const resolve = createDataSourceCredentialResolver({
      version: 1,
      rules: [{ origin: "https://oa.example.com", headers: { Authorization: "OA_TOKEN" } }],
    }, () => secret);
    let caught: unknown;
    try {
      await fetchWithDataSourceCredentials(new URL("https://oa.example.com/projects"), {}, resolve, vi.fn());
    } catch (cause) {
      caught = cause;
    }
    expect(caught).toBeInstanceOf(DataSourceCredentialError);
    expect(String(caught)).toContain("could not be applied");
    expect(String(caught)).not.toContain(secret);
    expect(String(caught)).not.toContain("injected");
  });
});
