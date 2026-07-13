import { createServer } from "node:http";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, normalize, resolve } from "node:path";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn as spawnPty, type IPty } from "node-pty";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

type Scenario = { args: Record<string, unknown>; marker?: string; keys?: string; followupMarker?: string; followupKeys?: string; steps?: Array<{ marker: string; keys: string }>; expected?: string; abort?: boolean };

const root = resolve(import.meta.dirname, "..");
const piExecutable = join(resolve(process.execPath, ".."), "pi");
let sandbox = "";
let project = "";
let state = "";
let barePath = "";
let baseUrl = "";
let scenario: Scenario | undefined;
let lastToolResult = "";
let lastToolDetails: unknown;
let remoteAttempts = 0;
const requestLog: string[] = [];
const remoteSeen: Array<{ method: string | undefined; url: string | undefined; headers: import("node:http").IncomingHttpHeaders; body: string }> = [];
const children = new Set<ChildProcessWithoutNullStreams>();
const ptys = new Set<IPty>();

const ansi = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;
const clean = (value: string) => value.replace(ansi, "").replace(/\r/g, "");

function sessionFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sessionFiles(path) : path.endsWith(".jsonl") ? [path] : [];
  });
}

function latestToolDetails(): unknown {
  let latest: { timestamp: number; details: unknown } | undefined;
  for (const file of sessionFiles(join(state, "sessions"))) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line) continue;
      const entry = JSON.parse(line) as { timestamp?: string; message?: { role?: string; toolName?: string; details?: unknown; timestamp?: number } };
      if (entry.message?.role !== "toolResult" || entry.message.toolName !== "ask_user_question") continue;
      const timestamp = entry.message.timestamp ?? Date.parse(entry.timestamp ?? "");
      if (!latest || timestamp > latest.timestamp) latest = { timestamp, details: entry.message.details };
    }
  }
  return latest?.details;
}

function completion(response: import("node:http").ServerResponse, body: Record<string, unknown>, finish: string) {
  response.writeHead(200, { "content-type": "text/event-stream", connection: "keep-alive", "cache-control": "no-cache" });
  const chunk = (delta: Record<string, unknown>, finishReason: string | null = null) => response.write(`data: ${JSON.stringify({ id: "chatcmpl-test", object: "chat.completion.chunk", created: 1, model: "acceptance", choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`);
  chunk(body);
  chunk({}, finish);
  response.end("data: [DONE]\n\n");
}

const fixtureServer = createServer((request, response) => {
  requestLog.push(`${request.method} ${request.url}`);
  if (request.url?.startsWith("/local/repo.git/")) {
    const pathname = new URL(request.url, "http://fixture").pathname;
    const path = normalize(join(barePath, decodeURIComponent(pathname.slice("/local/repo.git/".length))));
    if (!path.startsWith(barePath) || !existsSync(path)) { response.statusCode = 404; response.end("missing"); return; }
    response.setHeader("content-type", "application/octet-stream"); response.end(readFileSync(path)); return;
  }
  if (request.url === "/v1/chat/completions" && request.method === "POST") {
    let raw = "";
    request.on("data", part => { raw += String(part); });
    request.on("end", () => {
      const payload = JSON.parse(raw) as { messages?: Array<{ role?: string; content?: string }> };
      const toolMessage = [...(payload.messages ?? [])].reverse().find(message => message.role === "tool");
      if (toolMessage) {
        lastToolResult = toolMessage.content ?? "";
        completion(response, { role: "assistant", content: `CONTINUED:${lastToolResult}` }, "stop");
        return;
      }
      if (!scenario) throw new Error("scenario missing");
      completion(response, { role: "assistant", content: null, tool_calls: [{ index: 0, id: "call_acceptance", type: "function", function: { name: "ask_user_question", arguments: JSON.stringify(scenario.args) } }] }, "tool_calls");
    });
    return;
  }
  if (request.url?.startsWith("/remote")) {
    remoteAttempts += 1;
    if (request.url.includes("transport") && remoteAttempts <= 1) { request.socket.destroy(); return; }
    let body = ""; request.on("data", part => { body += String(part); }); request.on("end", () => {
      remoteSeen.push({ method: request.method, url: request.url, headers: request.headers, body });
      if (request.url!.includes("http-error") && remoteAttempts <= 1) { response.statusCode = 503; response.end("retry"); return; }
      if (request.url!.includes("invalid-json") && remoteAttempts <= 1) { response.end("not json"); return; }
      if (request.url!.includes("invalid-mapping") && remoteAttempts <= 1) { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ wrong: [] })); return; }
      const parsedBody = body ? JSON.parse(body) as Record<string, unknown> : {};
      const url = new URL(request.url!, baseUrl);
      const query = url.searchParams.get("q") ?? (typeof parsedBody.q === "string" ? parsedBody.q : undefined);
      const page = url.searchParams.get("page") ?? parsedBody.page;
      const text = page === "2" || page === 2 ? "Page two" : query ? "Search result" : "Alpha";
      const code = page === "2" || page === 2 ? "page-two" : query ? "search" : "alpha";
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ payload: { rows: [{ code, text, nodes: [{ code: "child", text: "Child" }], meta: "kept" }], total: 2 } }));
    });
    return;
  }
  response.statusCode = 404; response.end("missing");
});

function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(command, args, { cwd, env: { ...process.env, ...env }, encoding: "utf8", timeout: 120_000 });
  if (result.status !== 0) throw new Error(`${command} failed (${result.status}):\n${result.stdout}\n${result.stderr}`);
  return `${result.stdout}${result.stderr}`;
}

async function runAsync(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = {}) {
  const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let output = ""; child.stdout.on("data", data => { output += String(data); }); child.stderr.on("data", data => { output += String(data); });
  const status = await new Promise<number | null>((resolvePromise, reject) => { child.on("error", reject); child.on("close", resolvePromise); });
  if (status !== 0) throw new Error(`${command} failed (${status}):\n${output}`);
  return output;
}

async function runPi(next: Scenario): Promise<string> {
  scenario = next; lastToolResult = ""; lastToolDetails = undefined; remoteAttempts = 0; requestLog.length = 0; remoteSeen.length = 0;
  const args = ["--no-skills", "--no-context-files", "--approve", "--model", "acceptance/local", "--api-key", "test", "--thinking", "off", "--tools", "ask_user_question", "RUN ACCEPTANCE SCENARIO"];
  const env = Object.fromEntries(Object.entries({ ...process.env, PI_CODING_AGENT_DIR: state, NPM_CONFIG_CACHE: join(sandbox, "npm-cache"), TERM: "xterm-256color" }).filter((entry): entry is [string, string] => entry[1] !== undefined));
  const child = spawnPty(process.execPath, [realpathSync(piExecutable), ...args], { cwd: project, env, cols: 100, rows: 32 });
  ptys.add(child);
  const steps = next.steps ?? [
    ...(next.marker ? [{ marker: next.marker, keys: next.keys ?? "\r" }] : []),
    ...(next.followupMarker ? [{ marker: next.followupMarker, keys: next.followupKeys ?? "\r" }] : []),
  ];
  let output = ""; let stepIndex = 0; let stepOffset = 0; let exiting = false;
  const receive = (data: Buffer) => {
    output += data.toString();
    const visible = clean(output);
    const newVisible = clean(output.slice(stepOffset));
    const step = steps[stepIndex];
    if (step && newVisible.includes(step.marker)) { stepIndex += 1; stepOffset = output.length; child.write(step.keys); }
    if (!exiting && (visible.includes("CONTINUED:") || (next.abort && visible.includes("Question was aborted")))) { exiting = true; setTimeout(() => child.write("\u0004"), 25); }
  };
  child.onData(data => receive(Buffer.from(data)));
  const status = await new Promise<number | null>((resolvePromise, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(`real pi timeout steps=${stepIndex}/${steps.length} requests=${requestLog.join(",")} tool=${lastToolResult}:\n${clean(output).slice(0, 3000)}\n---tail---\n${clean(output).slice(-3000)}`)); }, 30_000);
    child.onExit(({ exitCode }) => { clearTimeout(timer); resolvePromise(exitCode); });
  });
  ptys.delete(child);
  if (status !== 0) throw new Error(`real pi exited ${status}:\n${clean(output).slice(-5000)}`);
  lastToolDetails = latestToolDetails();
  if (next.expected) expect(lastToolResult).toContain(next.expected);
  return clean(output);
}

beforeAll(async () => {
  sandbox = mkdtempSync(join(tmpdir(), "pi-ask-user-question-acceptance-"));
  project = join(sandbox, "project"); state = join(sandbox, "state");
  const source = join(sandbox, "source"); barePath = join(sandbox, "repo.git");
  mkdirSync(project); mkdirSync(state); mkdirSync(source);
  cpSync(root, source, { recursive: true, filter: path => !path.includes("/.git") && !path.includes("/node_modules") && !path.includes("/coverage") });
  run("git", ["init"], source); run("git", ["add", "."], source);
  run("git", ["-c", "user.name=Acceptance", "-c", "user.email=acceptance@example.com", "commit", "-m", "test package"], source);
  run("git", ["clone", "--bare", source, barePath], sandbox);
  run("git", ["--git-dir", barePath, "update-server-info"], sandbox);
  await new Promise<void>(resolvePromise => fixtureServer.listen(0, "127.0.0.1", resolvePromise));
  const address = fixtureServer.address(); if (!address || typeof address === "string") throw new Error("fixture did not bind");
  baseUrl = `http://127.0.0.1:${address.port}`;
  const installOutput = await runAsync("pi", ["install", `${baseUrl}/local/repo.git`, "-l"], project, { PI_CODING_AGENT_DIR: state, NPM_CONFIG_CACHE: join(sandbox, "npm-cache") });
  expect(installOutput).toContain("Installed");
  expect(run("pi", ["--version"], project, { PI_CODING_AGENT_DIR: state }).trim()).toBe("0.80.6");
  writeFileSync(join(state, "models.json"), JSON.stringify({ providers: { acceptance: { baseUrl: `${baseUrl}/v1`, api: "openai-completions", apiKey: "test", compat: { supportsDeveloperRole: false, supportsReasoningEffort: false }, models: [{ id: "local", reasoning: false, contextWindow: 32000, maxTokens: 4096 }] } } }));
}, 120_000);

afterAll(async () => {
  for (const child of children) child.kill("SIGKILL");
  for (const child of ptys) child.kill();
  await new Promise<void>(resolvePromise => fixtureServer.close(() => resolvePromise()));
  if (sandbox) rmSync(sandbox, { recursive: true, force: true });
  expect(sandbox && existsSync(sandbox)).toBe(false);
});

describe("real Pi CLI acceptance in isolated Git-installed environment", () => {
  it("uses all four Pi primitives and continues the agent", async () => {
    expect(await runPi({ args: { question: "Primitive text", default: "Ada", required: true }, marker: "Primitive text", keys: "Grace\r", expected: '"Grace"' })).toContain("CONTINUED:");
    expect(await runPi({ args: { question: "Primitive textarea", inputType: "textarea", default: "Long default", required: true }, marker: "Primitive textarea", keys: "\r", expected: "Long default" })).toContain("CONTINUED:");
    expect(await runPi({ args: { question: "Primitive select", options: [{ id: 1, label: "One" }, { id: 2, label: "Two" }], default: 1 }, marker: "Primitive select", keys: "\u001b[B\r", expected: '"Two"' })).toContain("CONTINUED:");
    expect(await runPi({ args: { question: "Primitive confirm", confirm: true }, marker: "Primitive confirm", keys: "\r", expected: "true" })).toContain("CONTINUED:");
    expect(await runPi({ args: { question: "Primitive other", options: ["Known", "Other"], default: "Known" }, steps: [
      { marker: "Primitive other", keys: "\u001b[B" }, { marker: "→ Other", keys: "\r" }, { marker: "Other", keys: "custom\r" },
    ], expected: "custom" })).toContain("CONTINUED:");
  }, 120_000);

  it("submits every advanced type and a grouped form atomically through custom UI", async () => {
    expect(await runPi({ args: { question: "Multiple custom", options: ["A", "B", "Other"], multiple: true, default: ["A"], required: true }, steps: [
      { marker: "Multiple custom", keys: "\u001b[B" }, { marker: "> [ ] B", keys: " " }, { marker: "[x] B", keys: "\r" },
    ], expected: '["A","B"]' })).toContain("CONTINUED:");
    expect(await runPi({ args: { question: "Date custom", inputType: "date", dateFormat: "yyyy-MM-dd", default: "2026-07-13", required: true }, marker: "Date custom", keys: "\r", expected: "2026-07-13" })).toContain("CONTINUED:");
    expect(await runPi({ args: { question: "Tree custom", inputType: "treeSelect", default: "alpha", dataSource: { type: "api", endpoint: `${baseUrl}/remote`, resultPath: "payload.rows", totalPath: "payload.total", idField: "code", labelField: "text", childrenField: "nodes" } }, marker: "Alpha", keys: "\r", expected: '"Alpha"' })).toContain("CONTINUED:");
    const grouped = { questions: [
      { id: "text", question: "Grouped text", default: "ready", required: true },
      { id: "confirm", question: "Grouped confirm", confirm: true },
      { id: "choice", question: "Grouped remote", inputType: "select", default: "alpha", dataSource: { type: "api", endpoint: "/remote", resultPath: "payload.rows", idField: "code", labelField: "text" } },
    ], dataSourceBaseUrl: baseUrl };
    expect(await runPi({ args: grouped, marker: "Grouped text", keys: "\u0013", expected: '"text":"ready"' })).toContain("CONTINUED:");
  }, 120_000);

  it("submits structured multiple-choice labels without toggling the selection on Enter", async () => {
    const output = await runPi({ args: {
      question: "Structured multiple",
      inputType: "checkbox",
      multiple: true,
      options: [{ id: "typescript", label: "TypeScript" }, { id: "python", label: "Python" }],
      default: '["typescript"]',
      required: true,
    }, steps: [
      { marker: "Structured multiple", keys: "\u001b[B" },
      { marker: "> [ ] Python", keys: " " },
      { marker: "[x] Python", keys: "\r" },
    ], expected: '["TypeScript","Python"]' });
    expect(lastToolDetails).toEqual({ status: "answered", answer: ["typescript", "python"] });
    expect(output).toContain("CONTINUED:");
  }, 120_000);

  it("advances from grouped multiple choice and submits the final answer with Enter", async () => {
    const grouped = { questions: [
      { id: "languages", question: "Grouped multiple", options: ["A", "B"], multiple: true, default: ["A"], required: true },
      { id: "following", question: "Following text", default: "done", required: true },
    ] };
    const output = await runPi({ args: grouped, steps: [
      { marker: "Grouped multiple", keys: "\u001b[B" },
      { marker: "> [ ] B", keys: " " },
      { marker: "[x] B", keys: "\r" },
      { marker: "> Following text: done", keys: " changed\r" },
    ], expected: '"languages":["A","B"]' });
    expect(lastToolResult).toContain('"following":"done changed"');
    expect(output).toContain("CONTINUED:");
  }, 120_000);

  it("returns missing-base guidance before UI, keeps remote errors field-local, supports cancel and abort", async () => {
    const missing = await runPi({ args: { question: "Missing base", inputType: "select", default: "alpha", dataSource: { type: "api", endpoint: "/remote" } }, expected: "Relative dataSource.endpoint" });
    expect(lastToolResult).toContain('"questions"'); expect(missing).not.toContain("Missing base ·");
    const retry = await runPi({ args: { questions: [
      { id: "preserved", question: "Preserved answer", default: "kept", required: true },
      { id: "remote", question: "Retry remote", inputType: "select", default: "alpha", dataSource: { type: "api", endpoint: `${baseUrl}/remote-http-error`, resultPath: "payload.rows", idField: "code", labelField: "text" } },
    ] }, steps: [{ marker: "Preserved answer", keys: "\r" }, { marker: "press r to retry", keys: "r" }, { marker: "Alpha", keys: "\r\u0013" }], expected: '"preserved":"kept"' });
    expect(retry).toContain("Remote options HTTP 503");
    expect(lastToolResult).toContain('"remote":"Alpha"');
    expect(await runPi({ args: { question: "Cancel custom", inputType: "date", dateFormat: "yyyy-MM-dd", default: "2026-07-13" }, marker: "Cancel custom", keys: "\u001b", expected: "cancelled" })).toContain("CONTINUED:");
    expect(await runPi({ args: { question: "Abort custom", inputType: "date", dateFormat: "yyyy-MM-dd", default: "2026-07-13" }, marker: "Abort custom", keys: "\u0003", abort: true })).toContain("Question was aborted");
  }, 120_000);

  it("drives authenticated POST, search, appended pagination and every field-local retry through real Pi", async () => {
    const mappedSource = { type: "api", endpoint: `${baseUrl}/remote-post`, method: "POST", params: { fixed: "yes" }, headers: { "x-test": "header", Cookie: "existing=1" }, cookies: { session: "abc" }, resultPath: "payload.rows", totalPath: "payload.total", idField: "code", labelField: "text", childrenField: "nodes", extraFields: ["meta"] };
    const mapped = await runPi({ args: { question: "POST remote", inputType: "treeSelect", default: "alpha", dataSource: mappedSource }, steps: [
      { marker: "Child", keys: "\u001b[B" }, { marker: ">    Child", keys: "\r" },
    ], expected: '"Child"' });
    expect(remoteSeen[0]).toMatchObject({ method: "POST", headers: { "x-test": "header", cookie: "existing=1; session=abc" }, body: '{"fixed":"yes"}' });
    expect(mapped).toContain("Alpha · kept");
    expect(mapped).toContain("Child");
    expect(mapped).toContain("Showing 2 of 2");

    const searchSource = { type: "api", endpoint: `${baseUrl}/remote-search`, searchParam: "q", pageParam: "page", pageSizeParam: "limit", pageSize: 1, resultPath: "payload.rows", idField: "code", labelField: "text" };
    await runPi({ args: { question: "Search remote", inputType: "select", default: "alpha", dataSource: searchSource }, steps: [
      { marker: "Alpha", keys: "s" }, { marker: "Search remote options", keys: "needle" }, { marker: "needle", keys: "\r" },
      { marker: "Search result", keys: "n" }, { marker: "Page two", keys: "\u001b[B" }, { marker: ">  Page two", keys: "\r" },
    ], expected: '"Page two"' });
    expect(remoteSeen.some(item => item.url?.includes("q=needle") && item.url.includes("page=2") && item.url.includes("limit=1"))).toBe(true);

    for (const [suffix, marker] of [["transport", "transport failed"], ["invalid-json", "invalid JSON"], ["invalid-mapping", "mapping failed"]] as const) {
      const output = await runPi({ args: { question: `Retry ${suffix}`, inputType: "select", default: "alpha", dataSource: { type: "api", endpoint: `${baseUrl}/remote-${suffix}`, resultPath: "payload.rows", idField: "code", labelField: "text" } }, marker, keys: "r", followupMarker: "Alpha", followupKeys: "\r", expected: '"Alpha"' });
      expect(output).toContain(marker);
    }
  }, 120_000);
});
