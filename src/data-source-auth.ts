export interface DataSourceAuthRule {
  origin: string;
  pathPrefix?: string;
  headers?: Record<string, string>;
  cookies?: Record<string, string>;
}

export interface DataSourceAuthConfig {
  version: 1;
  rules: DataSourceAuthRule[];
}

export interface ResolvedDataSourceCredentials {
  headers: Record<string, string>;
  cookies: Record<string, string>;
}

export type DataSourceCredentialResolver =
  (url: URL) => ResolvedDataSourceCredentials | undefined;

export class DataSourceCredentialError extends Error {
  readonly code = "DATA_SOURCE_CREDENTIAL_ERROR";
}

const isLoopback = (hostname: string) =>
  hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";

function normalizeRule(rule: DataSourceAuthRule): DataSourceAuthRule & { origin: string; pathPrefix: string } {
  let origin: URL;
  try {
    origin = new URL(rule.origin);
  } catch {
    throw new DataSourceCredentialError("Remote credential rule has an invalid origin");
  }
  if (origin.pathname !== "/" || origin.search || origin.hash || origin.username || origin.password) {
    throw new DataSourceCredentialError("Remote credential rule origin must not include a path");
  }
  if (origin.protocol !== "https:" && !(origin.protocol === "http:" && isLoopback(origin.hostname))) {
    throw new DataSourceCredentialError("Authenticated HTTP data sources are allowed only on loopback");
  }
  const rawPathPrefix = rule.pathPrefix?.startsWith("/") ? rule.pathPrefix : `/${rule.pathPrefix ?? ""}`;
  const pathPrefix = rawPathPrefix.length > 1 ? rawPathPrefix.replace(/\/+$/, "") : rawPathPrefix;
  return { ...rule, origin: origin.origin, pathPrefix };
}

export function loadDataSourceAuthConfig(
  agentDir = getAgentDir(),
  readFile: (path: string) => string = path => readFileSync(path, "utf8"),
): DataSourceAuthConfig {
  try {
    const parsed = JSON.parse(readFile(join(agentDir, DATA_SOURCE_AUTH_CONFIG_FILE))) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
    const candidate = parsed as Partial<DataSourceAuthConfig>;
    if (candidate.version !== 1 || !Array.isArray(candidate.rules)) throw new Error();
    return { version: 1, rules: candidate.rules };
  } catch (cause) {
    const code = typeof cause === "object" && cause !== null && "code" in cause ? (cause as { code?: unknown }).code : undefined;
    if (code === "ENOENT") return { version: 1, rules: [] };
    throw new DataSourceCredentialError("Remote credential configuration could not be loaded");
  }
}

export function createAgentDataSourceCredentialResolver(): DataSourceCredentialResolver {
  return createDataSourceCredentialResolver(loadDataSourceAuthConfig());
}

export function createDataSourceCredentialResolver(
  config: DataSourceAuthConfig,
  readEnvironment: (name: string) => string | undefined = name => process.env[name],
): DataSourceCredentialResolver {
  if (config.version !== 1 || !Array.isArray(config.rules)) {
    throw new DataSourceCredentialError("Remote credential configuration is invalid");
  }
  const rules = config.rules.map(normalizeRule)
    .sort((left, right) => right.pathPrefix.length - left.pathPrefix.length);

  return url => {
    const rule = rules.find(candidate => candidate.origin === url.origin
      && (candidate.pathPrefix === "/"
        || url.pathname === candidate.pathPrefix
        || url.pathname.startsWith(`${candidate.pathPrefix}/`)));
    if (!rule) return undefined;
    const resolveMap = (mapping: Record<string, string> | undefined) => Object.fromEntries(
      Object.entries(mapping ?? {}).map(([key, environmentName]) => {
        const value = readEnvironment(environmentName);
        if (value === undefined || value === "") {
          throw new DataSourceCredentialError("A configured remote credential is unavailable");
        }
        return [key, value];
      }),
    );
    return { headers: resolveMap(rule.headers), cookies: resolveMap(rule.cookies) };
  };
}

function cookieHeader(cookies: Record<string, string>): string {
  return Object.entries(cookies).map(([key, value]) => `${key}=${value}`).join("; ");
}

const isRedirect = (status: number) => status >= 300 && status < 400;

export async function fetchWithDataSourceCredentials(
  initialUrl: URL,
  init: RequestInit,
  resolveCredentials: DataSourceCredentialResolver,
  fetchImplementation: typeof fetch = fetch,
): Promise<Response> {
  let url = initialUrl;
  let requestInit = { ...init };
  for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
    const credentials = resolveCredentials(url);
    const headers = new Headers(requestInit.headers);
    headers.delete("Authorization");
    headers.delete("Cookie");
    try {
      for (const [key, value] of Object.entries(credentials?.headers ?? {})) headers.set(key, value);
      const cookies = cookieHeader(credentials?.cookies ?? {});
      if (cookies) headers.set("Cookie", cookies);
    } catch {
      throw new DataSourceCredentialError("Remote data source credentials could not be applied");
    }

    const response = await fetchImplementation(url, { ...requestInit, headers, redirect: "manual" });
    if (!isRedirect(response.status)) return response;
    const location = response.headers.get("location");
    if (!location) return response;
    if (redirectCount === 5) throw new DataSourceCredentialError("Remote data source redirected too many times");
    const redirected = new URL(location, url);
    if (credentials && redirected.origin !== url.origin) {
      throw new DataSourceCredentialError("Authenticated remote data source refused a cross-origin redirect");
    }
    const method = (requestInit.method ?? "GET").toUpperCase();
    if ((response.status === 303 && method !== "GET" && method !== "HEAD")
      || ([301, 302].includes(response.status) && method === "POST")) {
      const redirectedHeaders = new Headers(requestInit.headers);
      redirectedHeaders.delete("Content-Type");
      redirectedHeaders.delete("Content-Length");
      const { body: _body, ...withoutBody } = requestInit;
      requestInit = { ...withoutBody, method: "GET", headers: redirectedHeaders };
    }
    url = redirected;
  }
  throw new DataSourceCredentialError("Remote data source redirected too many times");
}
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const DATA_SOURCE_AUTH_CONFIG_FILE = "ask-user-question.auth.json";
