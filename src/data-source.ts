import type { DataSource, OptionItem } from "./types.js";

export interface LoadOptionsRequest { search?: string; page?: number }
export interface LoadedOptions { options: OptionItem[]; total?: number; requestUrl: string }

function atPath(value: unknown, path?: string): unknown {
  if (!path) return value;
  return path.split(".").reduce<unknown>((current, part) => current && typeof current === "object" ? (current as Record<string, unknown>)[part] : undefined, value);
}
function cookieHeader(cookies: Record<string, string> | undefined): string {
  return Object.entries(cookies ?? {}).map(([key, value]) => `${key}=${value}`).join("; ");
}
function mapItem(raw: unknown, source: DataSource): OptionItem {
  if (!raw || typeof raw !== "object") throw new Error("Remote option mapping failed: item is not an object");
  const item = raw as Record<string, unknown>;
  const id = item[source.idField ?? "id"];
  const label = item[source.labelField ?? "label"];
  if (!((typeof id === "string" && id.length) || typeof id === "number") || typeof label !== "string" || !label.length) throw new Error("Remote option mapping failed: id or label is invalid");
  const result: OptionItem = { id, label };
  const children = item[source.childrenField ?? "children"];
  if (Array.isArray(children)) result.children = children.map(child => mapItem(child, source));
  if (source.extraFields?.length) result.extra = Object.fromEntries(source.extraFields.map(key => [key, item[key]]));
  return result;
}

export async function loadOptions(source: DataSource, baseUrl: string | undefined, request: LoadOptionsRequest = {}, signal?: AbortSignal): Promise<LoadedOptions> {
  const url = new URL(source.endpoint, baseUrl);
  const params: Record<string, unknown> = { ...(source.params ?? {}) };
  if (source.searchParam && request.search !== undefined) params[source.searchParam] = request.search;
  if (source.pageParam) params[source.pageParam] = request.page ?? 1;
  if (source.pageSizeParam) params[source.pageSizeParam] = source.pageSize ?? 20;
  const method = source.method ?? "GET";
  const headers = new Headers(source.headers);
  const cookie = cookieHeader(source.cookies);
  if (cookie) headers.set("Cookie", [headers.get("Cookie"), cookie].filter(Boolean).join("; "));
  let body: string | undefined;
  if (method === "GET") for (const [key, value] of Object.entries(params)) url.searchParams.set(key, typeof value === "string" ? value : JSON.stringify(value));
  else {
    headers.set("Content-Type", headers.get("Content-Type") ?? "application/json");
    body = JSON.stringify(params);
  }
  let response: Response;
  const init: RequestInit = { method, headers };
  if (body !== undefined) init.body = body;
  if (signal !== undefined) init.signal = signal;
  try { response = await fetch(url, init); }
  catch (cause) { throw new Error(`Remote options transport failed: ${cause instanceof Error ? cause.message : String(cause)}`); }
  if (!response.ok) throw new Error(`Remote options HTTP ${response.status}`);
  let json: unknown;
  try { json = await response.json(); } catch { throw new Error("Remote options returned invalid JSON"); }
  const values = atPath(json, source.resultPath);
  if (!Array.isArray(values)) throw new Error("Remote option mapping failed: resultPath is not an array");
  const totalValue = atPath(json, source.totalPath);
  const result: LoadedOptions = { options: values.map(value => mapItem(value, source)), requestUrl: url.toString() };
  if (typeof totalValue === "number") result.total = totalValue;
  return result;
}
