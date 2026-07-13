import { createServer } from "node:http";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, normalize, resolve } from "node:path";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn as spawnPty, type IPty } from "node-pty";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

type Scenario = {
  args: Record<string, unknown>;
  toolCalls?: Record<string, unknown>[];
  nextTurnArgs?: Record<string, unknown>;
  marker?: string;
  keys?: string;
  followupMarker?: string;
  followupKeys?: string;
  steps?: Array<{ marker: string; keys: string }>;
  expected?: string;
  abort?: boolean;
};

const root = resolve(import.meta.dirname, "..");
const piExecutable = join(resolve(process.execPath, ".."), "pi");
let sandbox = "";
let project = "";
let state = "";
let barePath = "";
let baseUrl = "";
let scenario: Scenario | undefined;
let lastToolResult = "";
let lastToolResults: string[] = [];
let toolResultBatches: string[][] = [];
let lastToolDetails: unknown;
let remoteAttempts = 0;
let toolBatchIndex = 0;
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
      const messages = payload.messages ?? [];
      const latest = messages.at(-1);
      if (latest?.role === "tool") {
        lastToolResults = [];
        for (let index = messages.length - 1; index >= 0 && messages[index]?.role === "tool"; index -= 1) lastToolResults.push(messages[index]?.content ?? "");
        toolResultBatches.push([...lastToolResults]);
        lastToolResult = lastToolResults[0] ?? "";
        if (scenario?.nextTurnArgs && toolBatchIndex === 1) completion(response, { role: "assistant", content: "FIRST_DONE" }, "stop");
        else completion(response, { role: "assistant", content: `CONTINUED:${lastToolResults.join("|")}` }, "stop");
        return;
      }
      if (!scenario) throw new Error("scenario missing");
      const calls = toolBatchIndex === 1 && scenario.nextTurnArgs ? [scenario.nextTurnArgs] : scenario.toolCalls ?? [scenario.args];
      toolBatchIndex += 1;
      completion(response, { role: "assistant", content: null, tool_calls: calls.map((args, index) => ({ index, id: `call_acceptance_${toolBatchIndex}_${index}`, type: "function", function: { name: "ask_user_question", arguments: JSON.stringify(args) } })) }, "tool_calls");
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
      if (request.url!.includes("invalid-id") && remoteAttempts <= 1) { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ payload: { rows: [{ code: null, text: "Bad" }] } })); return; }
      if (request.url!.includes("invalid-label") && remoteAttempts <= 1) { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ payload: { rows: [{ code: "bad", text: " " }] } })); return; }
      const parsedBody = body ? JSON.parse(body) as Record<string, unknown> : {};
      const url = new URL(request.url!, baseUrl);
      const query = url.searchParams.get("q") ?? (typeof parsedBody.q === "string" ? parsedBody.q : undefined);
      const page = url.searchParams.get("page") ?? parsedBody.page;
      if (request.url!.includes("remote-total-later")) {
        const pageTwo = page === "2" || page === 2;
        const payload = pageTwo
          ? { rows: [{ code: "three", text: "Three" }] }
          : { rows: [{ code: "one", text: "One" }, { code: "two", text: "Two" }], total: 3 };
        response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ payload })); return;
      }
      if (request.url!.includes("remote-total")) {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ payload: { rows: [{ code: "one", text: "One" }, { code: "two", text: "Two" }], total: 2 } }));
        return;
      }
      if (request.url!.includes("remote-short")) {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ payload: { rows: [{ code: "one", text: "One" }] } }));
        return;
      }
      if (request.url!.includes("remote-pages") || request.url!.includes("remote-failed-page")) {
        const pageTwo = page === "2" || page === 2;
        const pageTwoAttempts = remoteSeen.filter(item => item.url?.includes("remote-failed-page") && item.url.includes("page=2")).length;
        if (request.url!.includes("remote-failed-page") && pageTwo && pageTwoAttempts === 1) { response.statusCode = 503; response.end("retry"); return; }
        const rows = pageTwo ? [{ code: "three", text: "Three" }] : [{ code: "one", text: "One" }, { code: "two", text: "Two" }];
        response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ payload: { rows } })); return;
      }
      if (request.url!.includes("remote-numeric-label")) {
        response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ payload: { rows: [{ code: 7, text: 700 }] } })); return;
      }
      if (request.url!.includes("remote-label-search")) {
        const rows = [{ code: "same", text: query ? "New label" : "Old label" }];
        response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ payload: { rows, total: 1 } })); return;
      }
      if (request.url!.includes("remote-dedupe")) {
        const pageTwo = page === "2" || page === 2;
        const rows = pageTwo
          ? [{ code: 0, text: "Numeric zero duplicate" }, { code: "new", text: "New" }]
          : [{ code: 0, text: "Numeric zero" }, { code: "0", text: "String zero" }];
        response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ payload: { rows } })); return;
      }
      const text = page === "2" || page === 2 ? "Page two" : query ? "Search result" : "Alpha";
      const code = page === "2" || page === 2 ? "page-two" : query ? "search" : "alpha";
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ payload: { rows: [{ code, text, nodes: [{ code: "child", text: "Child" }], meta: "kept" }], total: 1 } }));
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
  scenario = next; lastToolResult = ""; lastToolResults = []; toolResultBatches = []; lastToolDetails = undefined; remoteAttempts = 0; toolBatchIndex = 0; requestLog.length = 0; remoteSeen.length = 0;
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
    if (!exiting && (visible.includes("CONTINUED:") || (next.abort && !next.nextTurnArgs && visible.includes("Question was aborted")))) { exiting = true; setTimeout(() => child.write("\u0004"), 25); }
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
    const primitiveSelect = await runPi({ args: { question: "Primitive select", options: [{ id: 1, label: "One" }, { id: 2, label: "Two" }], default: 1 }, marker: "Primitive select", keys: "\u001b[B\r", expected: "2" });
    expect(primitiveSelect).toContain("Primitive select: Two");
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
    expect(await runPi({ args: { question: "Tree custom", inputType: "treeSelect", default: "alpha", dataSource: { type: "api", endpoint: `${baseUrl}/remote`, resultPath: "payload.rows", totalPath: "payload.total", idField: "code", labelField: "text", childrenField: "nodes" } }, marker: "Alpha", keys: "\r", expected: '"alpha"' })).toContain("Tree custom: Alpha");
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
    ], expected: '["typescript","python"]' });
    expect(lastToolDetails).toEqual({ status: "answered", answer: ["typescript", "python"] });
    expect(output).toContain("Structured multiple: TypeScript, Python");
    expect(output).toContain("CONTINUED:");
  }, 120_000);

  it("normalizes every compatible structured default into visible canonical form state", async () => {
    const args = { questions: [
      { id: "label", question: "Label default", options: [{ id: 1, label: "Alternative" }, { id: 2, label: "Recommended" }], default: "Recommended", required: true },
      { id: "object", question: "Object default", options: [{ id: "a", label: "Alpha" }, { id: "b", label: "Beta" }], default: { id: "b", label: "ignored" }, required: true },
      { id: "typed", question: "Typed default", options: [{ id: 0, label: "Numeric zero" }, { id: "0", label: "String zero" }], default: "string:0", required: true },
      { id: "numeric", question: "Numeric default", options: [{ id: 0, label: "Numeric zero" }, { id: "0", label: "String zero" }], default: 0, required: true },
      { id: "multiple", question: "JSON multiple default", options: [{ id: "ts", label: "TypeScript" }, { id: "py", label: "Python" }], multiple: true, default: '["TypeScript",{"id":"ts","label":"ignored"},"py"]', required: true },
    ] };
    const output = await runPi({ args, steps: [
      { marker: ">  Recommended", keys: "\t" },
      { marker: ">  Beta", keys: "\t" },
      { marker: ">  String zero", keys: "\t" },
      { marker: ">  Numeric zero", keys: "\t" },
      { marker: "> [x] TypeScript", keys: "\u0013" },
    ], expected: '"multiple":["ts","py"]' });
    expect(lastToolDetails).toEqual({ status: "answered", answer: { label: 2, object: "b", typed: "0", numeric: 0, multiple: ["ts", "py"] } });
    expect(output).toContain("[x] Python");
    expect(output).toContain("Label default: Recommended");
    expect(output).toContain("JSON multiple default: TypeScript, Python");
  }, 120_000);

  it("clears optional select and treeSelect answers and omits them from grouped results", async () => {
    const output = await runPi({ args: { questions: [
      { id: "flat", question: "Flat optional", inputType: "select", options: ["Recommended", "Alternative"], default: "Recommended" },
      { id: "tree", question: "Tree optional", inputType: "treeSelect", options: [{ id: "root", label: "Root", children: [{ id: "child", label: "Child" }] }], default: "root" },
    ] }, steps: [
      { marker: ">  Recommended", keys: "\u001b[3~" },
      { marker: "> Flat optional: (optional)", keys: "\t" },
      { marker: ">  Root", keys: "\u001b[3~" },
      { marker: "> Tree optional: (optional)", keys: "\u0013" },
    ], expected: "{}" });
    expect(lastToolDetails).toEqual({ status: "answered", answer: {} });
    expect(output).toContain("Flat optional: (optional)");
    expect(output).toContain("Tree optional: (optional)");
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

  it("validates date configuration and defaults before UI but returns final user input unchanged", async () => {
    const invalidFormat = await runPi({ args: { question: "Invalid format", inputType: "date", dateFormat: "yyyy-MM", default: "2026-07" }, expected: "must include year, month, and day" });
    expect(invalidFormat).not.toContain("Format: yyyy-MM");
    await runPi({ args: { question: "Invalid default", inputType: "date", dateFormat: "yyyy-MM-dd", default: "2026/07/13" }, expected: "Date default must match dateFormat" });

    const required = await runPi({ args: { question: "Required date", inputType: "date", dateFormat: "yyyy-MM-dd", default: "2026-07-13", required: true }, steps: [
      { marker: "Required date", keys: "\u0015\r" },
      { marker: "答案不能为空", keys: "business-day-after-close\r" },
    ], expected: '"business-day-after-close"' });
    expect(lastToolDetails).toEqual({ status: "answered", answer: "business-day-after-close" });
    expect(required).toContain("Required date: business-day-after-close");

    await runPi({ args: { question: "Optional date", inputType: "date", dateFormat: "yyyy-MM-dd", default: "2026-07-13" }, marker: "Optional date", keys: "\u0015\r", expected: 'question: ""' });
    expect(lastToolDetails).toEqual({ status: "answered", answer: "" });
  }, 120_000);

  it("returns missing-base guidance before UI, keeps remote errors field-local, supports cancel and abort", async () => {
    const missing = await runPi({ args: { question: "Missing base", inputType: "select", default: "alpha", dataSource: { type: "api", endpoint: "/remote" } }, expected: "Relative dataSource.endpoint" });
    expect(lastToolResult).toContain('"questions"'); expect(missing).not.toContain("Missing base ·");
    const retry = await runPi({ args: { questions: [
      { id: "preserved", question: "Preserved answer", default: "kept", required: true },
      { id: "remote", question: "Retry remote", inputType: "select", default: "alpha", dataSource: { type: "api", endpoint: `${baseUrl}/remote-http-error`, resultPath: "payload.rows", idField: "code", labelField: "text" } },
    ] }, steps: [{ marker: "Preserved answer", keys: "\r" }, { marker: "press r to retry", keys: "r" }, { marker: "Alpha", keys: "\r\u0013" }], expected: '"preserved":"kept"' });
    expect(retry).toContain("Remote options HTTP 503");
    expect(lastToolResult).toContain('"remote":"alpha"');
    const validation = await runPi({ args: { questions: [
      { id: "confirm", question: "Confirm required", confirm: true, required: true },
      { id: "reason", question: "Preserved reason", default: "kept", required: true },
    ] }, steps: [
      { marker: "Confirm required", keys: "\t" },
      { marker: "Preserved reason", keys: "\u0013\u001b[Z" },
      { marker: "Missing answer for grouped question: confirm", keys: "\r" },
      { marker: "> Preserved reason: kept", keys: "\u0013" },
    ], expected: '"reason":"kept"' });
    expect(validation).toContain("Missing answer for grouped question: confirm");
    expect(lastToolDetails).toEqual({ status: "answered", answer: { confirm: true, reason: "kept" } });
    expect(await runPi({ args: { question: "Cancel custom", inputType: "date", dateFormat: "yyyy-MM-dd", default: "2026-07-13" }, marker: "Cancel custom", keys: "\u001b", expected: "cancelled" })).toContain("CONTINUED:");
    expect(await runPi({ args: { question: "Abort custom", inputType: "date", dateFormat: "yyyy-MM-dd", default: "2026-07-13" }, marker: "Abort custom", keys: "\u0003", abort: true })).toContain("Question was aborted");
  }, 120_000);

  it("drives authenticated POST, search, appended pagination and every field-local retry through real Pi", async () => {
    const mappedSource = { type: "api", endpoint: `${baseUrl}/remote-post`, method: "POST", params: { fixed: "yes" }, headers: { "x-test": "header", Cookie: "existing=1" }, cookies: { session: "abc" }, resultPath: "payload.rows", totalPath: "payload.total", idField: "code", labelField: "text", childrenField: "nodes", extraFields: ["meta"] };
    const mapped = await runPi({ args: { question: "POST remote", inputType: "treeSelect", default: "alpha", dataSource: mappedSource }, steps: [
      { marker: "Child", keys: "\u001b[B" }, { marker: ">    Child", keys: "\r" },
    ], expected: '"child"' });
    expect(remoteSeen[0]).toMatchObject({ method: "POST", headers: { "x-test": "header", cookie: "existing=1; session=abc" }, body: '{"fixed":"yes"}' });
    expect(mapped).toContain("Alpha · kept");
    expect(mapped).toContain("Child");
    expect(mapped).toContain("Showing 1 of 1");

    const searchSource = { type: "api", endpoint: `${baseUrl}/remote-search`, searchParam: "q", pageParam: "page", pageSizeParam: "limit", pageSize: 1, resultPath: "payload.rows", idField: "code", labelField: "text" };
    await runPi({ args: { question: "Search remote", inputType: "select", default: "alpha", dataSource: searchSource }, steps: [
      { marker: "Alpha", keys: "s" }, { marker: "Search remote options", keys: "needle" }, { marker: "needle", keys: "\r" },
      { marker: "Search result", keys: "n" }, { marker: "Page two", keys: "\u001b[B" }, { marker: ">  Page two", keys: "\r" },
    ], expected: '"page-two"' });
    expect(remoteSeen.some(item => item.url?.includes("q=needle") && item.url.includes("page=2") && item.url.includes("limit=1"))).toBe(true);
    expect(remoteSeen.map(item => item.url)).toEqual([
      "/remote-search?page=1&limit=1",
      "/remote-search?q=needle&page=1&limit=1",
      "/remote-search?q=needle&page=2&limit=1",
    ]);

    const updatedLabel = await runPi({ args: { question: "Updated label", inputType: "select", default: "same", dataSource: {
      ...searchSource, endpoint: `${baseUrl}/remote-label-search`, totalPath: "payload.total",
    } }, steps: [
      { marker: "Old label", keys: "s" }, { marker: "Search remote options", keys: "new" },
      { marker: "new", keys: "\r" }, { marker: "New label", keys: "\r" },
    ], expected: '"same"' });
    expect(updatedLabel).toContain("Updated label: New label");

    for (const [suffix, marker] of [["transport", "transport failed"], ["invalid-json", "invalid JSON"], ["invalid-mapping", "mapping failed"], ["invalid-id", "mapping failed"], ["invalid-label", "mapping failed"]] as const) {
      const output = await runPi({ args: { questions: [
        { id: "preserved", question: `Preserved ${suffix}`, default: "kept", required: true },
        { id: "remote", question: `Retry ${suffix}`, inputType: "select", default: "alpha", dataSource: { type: "api", endpoint: `${baseUrl}/remote-${suffix}`, resultPath: "payload.rows", idField: "code", labelField: "text" } },
      ] }, steps: [
        { marker: `Preserved ${suffix}`, keys: "\r" }, { marker, keys: "r" }, { marker: "Alpha", keys: "\r\u0013" },
      ], expected: '"preserved":"kept"' });
      expect(output).toContain(marker);
      expect(lastToolResult).toContain('"remote":"alpha"');
    }
  }, 120_000);

  it("maps numeric labels and keeps select children distinct from treeSelect through real Pi", async () => {
    const numeric = await runPi({ args: { question: "Numeric label", inputType: "select", default: 7, dataSource: {
      type: "api", endpoint: `${baseUrl}/remote-numeric-label`, resultPath: "payload.rows", idField: "code", labelField: "text",
    } }, marker: "700", keys: "\r", expected: "7" });
    expect(lastToolDetails).toEqual({ status: "answered", answer: 7 });
    expect(numeric).toContain("Numeric label: 700");

    const flat = await runPi({ args: { question: "Flat remote", inputType: "select", default: "alpha", dataSource: {
      type: "api", endpoint: `${baseUrl}/remote`, resultPath: "payload.rows", idField: "code", labelField: "text", childrenField: "nodes",
    } }, marker: "Alpha", keys: "\r", expected: '"alpha"' });
    expect(flat).not.toContain("  Child");

    const tree = await runPi({ args: { question: "Tree remote", inputType: "treeSelect", default: "alpha", dataSource: {
      type: "api", endpoint: `${baseUrl}/remote`, resultPath: "payload.rows", idField: "code", labelField: "text", childrenField: "nodes",
    } }, steps: [{ marker: "  Child", keys: "\u001b[B" }, { marker: ">    Child", keys: "\r" }], expected: '"child"' });
    expect(tree).toContain("Tree remote: Child");
  }, 120_000);

  it("terminates remote pagination from total and short pages and retries failed pages exactly", async () => {
    const source = (endpoint: string) => ({ type: "api", endpoint: `${baseUrl}/${endpoint}`, pageParam: "page", pageSizeParam: "limit", pageSize: 2, resultPath: "payload.rows", idField: "code", labelField: "text" });

    await runPi({ args: { question: "Total stop", inputType: "select", default: "one", dataSource: { ...source("remote-total"), totalPath: "payload.total" } }, marker: "Showing 2 of 2", keys: "n\r", expected: '"one"' });
    expect(remoteSeen.map(item => item.url)).toEqual(["/remote-total?page=1&limit=2"]);

    await runPi({ args: { question: "Short stop", inputType: "select", default: "one", dataSource: source("remote-short") }, marker: "One", keys: "n\r", expected: '"one"' });
    expect(remoteSeen.map(item => item.url)).toEqual(["/remote-short?page=1&limit=2"]);

    await runPi({ args: { question: "Full continues", inputType: "select", default: "one", dataSource: source("remote-pages") }, steps: [
      { marker: "Two", keys: "n" }, { marker: "Three", keys: "\u001b[B\u001b[B\r" },
    ], expected: '"three"' });
    expect(remoteSeen.map(item => item.url)).toEqual(["/remote-pages?page=1&limit=2", "/remote-pages?page=2&limit=2"]);

    await runPi({ args: { question: "Known total continues", inputType: "select", default: "one", dataSource: { ...source("remote-total-later"), totalPath: "payload.total" } }, steps: [
      { marker: "Showing 2 of 3", keys: "n" }, { marker: "Showing 3 of 3", keys: "n\r" },
    ], expected: '"one"' });
    expect(remoteSeen.map(item => item.url)).toEqual(["/remote-total-later?page=1&limit=2", "/remote-total-later?page=2&limit=2"]);

    await runPi({ args: { question: "Typed dedupe", inputType: "select", default: 0, dataSource: source("remote-dedupe") }, steps: [
      { marker: "String zero", keys: "n" }, { marker: "New", keys: "\u001b[B\u001b[B\r" },
    ], expected: '"new"' });
    expect(remoteSeen.map(item => item.url)).toEqual(["/remote-dedupe?page=1&limit=2", "/remote-dedupe?page=2&limit=2"]);

    const retry = await runPi({ args: { question: "Failed page", inputType: "select", default: "one", dataSource: source("remote-failed-page") }, steps: [
      { marker: "Two", keys: "n" },
      { marker: "HTTP 503", keys: "r" },
      { marker: "Three", keys: "\u001b[B\u001b[B\r" },
    ], expected: '"three"' });
    expect(retry).toContain("One");
    expect(remoteSeen.map(item => item.url)).toEqual(["/remote-failed-page?page=1&limit=2", "/remote-failed-page?page=2&limit=2", "/remote-failed-page?page=2&limit=2"]);
  }, 120_000);

  it("rejects a duplicate pending call, then releases submit and retry state for the next Agent turn", async () => {
    const output = await runPi({
      args: { question: "unused", default: "unused" },
      toolCalls: [
        { questions: [{ id: "first", question: "Original pending", default: "kept", required: true }] },
        { questions: [{ id: "second", question: "Duplicate pending", default: "retry", required: true }] },
      ],
      nextTurnArgs: { questions: [{ id: "next", question: "After duplicate", default: "fresh", required: true }] },
      steps: [
        { marker: "Original pending", keys: "\u0013" },
        { marker: "FIRST_DONE", keys: "RUN SECOND TURN\r" },
        { marker: "After duplicate", keys: "\u0013" },
      ],
      expected: '"next":"fresh"',
    });
    expect(toolResultBatches[0]?.some(result => result.includes("exactly one native ask_user_question call"))).toBe(true);
    expect(toolResultBatches[0]?.some(result => result.includes('"first":"kept"'))).toBe(true);
    expect(output).toContain("Original pending: kept");
    expect(output).toContain("exactly one native ask_user_question call");
    expect(output).toContain("After duplicate: fresh");
  }, 120_000);

  it("releases cancelled form state and opens a fresh question in the next real Pi Agent turn", async () => {
    const output = await runPi({
      args: { question: "First turn cancel", inputType: "date", dateFormat: "yyyy-MM-dd", default: "2026-07-13" },
      nextTurnArgs: { questions: [{ id: "second", question: "Second turn", default: "fresh", required: true }] },
      steps: [
        { marker: "First turn cancel", keys: "\u001b" },
        { marker: "FIRST_DONE", keys: "RUN SECOND TURN\r" },
        { marker: "Second turn", keys: "\u0013" },
      ],
      expected: '"second":"fresh"',
    });
    expect(lastToolDetails).toEqual({ status: "answered", answer: { second: "fresh" } });
    expect(output).toContain("FIRST_DONE");
    expect(output).toContain("Second turn: fresh");
  }, 120_000);

  it("releases aborted form state and opens a fresh question in the next real Pi Agent turn", async () => {
    const output = await runPi({
      args: { question: "First turn abort", inputType: "date", dateFormat: "yyyy-MM-dd", default: "2026-07-13" },
      nextTurnArgs: { questions: [{ id: "second", question: "After abort", default: "fresh", required: true }] },
      steps: [
        { marker: "First turn abort", keys: "\u0003" },
        { marker: "FIRST_DONE", keys: "RUN SECOND TURN\r" },
        { marker: "After abort", keys: "\u0013" },
      ],
      expected: '"second":"fresh"',
      abort: true,
    });
    expect(lastToolDetails).toEqual({ status: "answered", answer: { second: "fresh" } });
    expect(toolResultBatches[0]?.some(result => result.includes("Question was aborted"))).toBe(true);
    expect(output).toContain("After abort: fresh");
  }, 120_000);
});
