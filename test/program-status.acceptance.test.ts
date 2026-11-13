import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { spawn as spawnPty, type IPty } from "node-pty";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_BLOCKED_MESSAGE, PROGRAM_STATUS_CONFIG_FILE } from "../src/program-status.js";

const root = resolve(import.meta.dirname, "..");
const piExecutable = join(root, "node_modules", ".bin", "pi");
const formArgs = {
  title: "Leave request",
  questions: [{ id: "reason", question: "Reason", default: "Personal", required: true }],
};
const encode = (message: string) => Buffer.from(message, "utf8").toString("base64");
const ptys = new Set<IPty>();

let sandbox = "";
let project = "";
let state = "";
let server: Server | undefined;
let baseUrl = "";

/** Minimal OpenAI-compatible stub: one grouped question, then a settled continuation. */
function serve(request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse): boolean {
  if (request.url !== "/v1/chat/completions" || request.method !== "POST") return false;
  let raw = "";
  request.on("data", part => { raw += String(part); });
  request.on("end", () => {
    const messages = (JSON.parse(raw) as { messages?: Array<{ role?: string }> }).messages ?? [];
    response.writeHead(200, { "content-type": "text/event-stream", connection: "keep-alive", "cache-control": "no-cache" });
    const chunk = (delta: Record<string, unknown>, finish: string | null = null) => response.write(
      `data: ${JSON.stringify({ id: "chatcmpl-status", object: "chat.completion.chunk", created: 1, model: "acceptance", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
    );
    if (messages.at(-1)?.role === "tool") {
      chunk({ role: "assistant", content: "CONTINUED" }, "stop");
    } else {
      chunk({
        role: "assistant",
        content: null,
        tool_calls: [{ index: 0, id: "call_program_status_1_0", type: "function", function: { name: "ask_user_question", arguments: JSON.stringify(formArgs) } }],
      }, "tool_calls");
    }
    chunk({}, "stop");
    response.end("data: [DONE]\n\n");
  });
  return true;
}

function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const result = spawnSync(command, args, { cwd, env: { ...process.env, ...env }, encoding: "utf8", timeout: 120_000 });
  if (result.status !== 0) throw new Error(`${command} failed (${result.status}):\n${result.stdout}\n${result.stderr}`);
  return `${result.stdout}${result.stderr}`;
}

function writeStateConfig(blockedMessage?: string) {
  writeFileSync(join(state, "models.json"), JSON.stringify({
    providers: {
      acceptance: {
        baseUrl: `${baseUrl}/v1`,
        api: "openai-completions",
        apiKey: "test",
        compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
        models: [{ id: "local", reasoning: false, contextWindow: 32000, maxTokens: 4096 }],
      },
    },
  }));
  if (blockedMessage === undefined) return;
  writeFileSync(join(state, PROGRAM_STATUS_CONFIG_FILE), JSON.stringify({ version: 1, blockedMessage }));
}

/** Drive the real TUI to the open form, capture raw output, then submit and hold it until it settles. */
async function runScenario(): Promise<string> {
  const child = spawnPty(process.execPath, [
    realpathSync(piExecutable),
    "--no-skills", "--no-context-files", "--approve", "--model", "acceptance/local", "--api-key", "test",
    "--thinking", "off", "--tools", "ask_user_question", "RUN PROGRAM STATUS SCENARIO",
  ], {
    cwd: project,
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
      PI_CODING_AGENT_DIR: state,
      PI_PROGRAM_STATUS: "1",
      TERM: "xterm-256color",
    },
    cols: 100,
    rows: 32,
  });
  ptys.add(child);
  let raw = "";
  let submitted = false;
  let settled = false;
  const keys = () => {
    if (!submitted) { submitted = true; child.write("\r"); return; }
    if (settled) { let attempts = 0; const end = () => { child.write("\u0004"); if (++attempts < 20) setTimeout(end, 100); }; end(); }
  };
  child.onData(data => {
    raw += data;
    if (!submitted && raw.includes("Reason")) keys();
    if (submitted && !settled && raw.includes("CONTINUED")) { settled = true; keys(); }
  });
  const status = await new Promise<number | null>((resolveExit, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(`real pi timed out submitted=${submitted} settled=${settled}:${raw.slice(-2000)}`)); }, 40_000);
    child.onExit(({ exitCode }) => { clearTimeout(timer); resolveExit(exitCode); });
  });
  ptys.delete(child);
  expect(status).toBe(0);
  return raw;
}

const blockedRecords = (raw: string) => raw.split("\u001b]7501;").filter(record => record.startsWith("state=blocked"));
const settledRecords = (raw: string) => raw.split("\u001b]7501;").filter(record => /^state=(working|done)/.test(record));

beforeAll(async () => {
  mkdirSync(join(root, "temp"), { recursive: true });
  sandbox = mkdtempSync(join(root, "temp", "pi-auq-program-status-"));
  project = join(sandbox, "project");
  state = join(sandbox, "state");
  mkdirSync(project);
  mkdirSync(state);
  server = createServer((request, response) => { if (!serve(request, response)) { response.statusCode = 404; response.end(); } });
  await new Promise<void>(resolveListen => server!.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture did not bind");
  baseUrl = `http://127.0.0.1:${address.port}`;
  const env = { PI_CODING_AGENT_DIR: state, NPM_CONFIG_CACHE: join(sandbox, "npm-cache") };
  expect(run(process.execPath, [realpathSync(piExecutable), "install", root, "-l"], project, env)).toContain("Installed");
}, 180_000);

afterAll(async () => {
  for (const child of ptys) child.kill();
  if (server) await new Promise<void>(resolveClose => server!.close(() => resolveClose()));
  if (sandbox) rmSync(sandbox, { recursive: true, force: true });
  expect(sandbox === "" || existsSync(sandbox)).toBe(false);
});

describe("real Pi CLI blocked program status", () => {
  it("reports OSC 7501 blocked with the default message while the form waits, then reverts", async () => {
    writeStateConfig();
    const raw = await runScenario();
    const blocked = blockedRecords(raw);
    expect(blocked.length).toBeGreaterThan(0);
    for (const record of blocked) {
      expect(record).toContain("kind=question");
      expect(record).toContain(`msg=${encode(DEFAULT_BLOCKED_MESSAGE)}`);
    }
    expect(settledRecords(raw).length).toBeGreaterThan(0);
  }, 120_000);

  it("uses the message configured in the Pi agent directory", async () => {
    const configured = "我需要你的帮助：请先回答表单";
    writeStateConfig(configured);
    const raw = await runScenario();
    const blocked = blockedRecords(raw);
    expect(blocked.length).toBeGreaterThan(0);
    for (const record of blocked) expect(record).toContain(`msg=${encode(configured)}`);
  }, 120_000);
});
