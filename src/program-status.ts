/**
 * Blocked program status: while a question dialog waits for the user, the extension asks Pi to report
 * the pane as blocked, which Pi renders to the terminal as OSC 7501. The message is user-configurable
 * because a terminal's program-status surface shows it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** Config file in the Pi agent directory, stored next to `ask-user-question.auth.json`. */
export const PROGRAM_STATUS_CONFIG_FILE = "ask-user-question.json";
export const DEFAULT_BLOCKED_MESSAGE = "我需要你的帮助";

/** Pi replaces control characters and cuts a report at 2048 bytes; keep the configured text short. */
const MAX_BLOCKED_MESSAGE_LENGTH = 120;

export interface ProgramStatusConfig {
  version: 1;
  blockedMessage: string;
}

/** One human-readable line: control characters and newlines become spaces, then the text is cut. */
export function normalizeBlockedMessage(value: unknown): string {
  if (typeof value !== "string") return DEFAULT_BLOCKED_MESSAGE;
  const line = [...value.replace(/[\u0000-\u001f\u007f]+/g, " ")].slice(0, MAX_BLOCKED_MESSAGE_LENGTH).join("").trim();
  return line === "" ? DEFAULT_BLOCKED_MESSAGE : line;
}

/** Read the configured blocked message. A missing or malformed file falls back to the default. */
export function loadBlockedMessage(
  agentDir: string = getAgentDir(),
  readFile: (path: string) => string = path => readFileSync(path, "utf8"),
): string {
  try {
    const parsed = JSON.parse(readFile(join(agentDir, PROGRAM_STATUS_CONFIG_FILE))) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return DEFAULT_BLOCKED_MESSAGE;
    const candidate = parsed as Partial<ProgramStatusConfig>;
    return candidate.version === 1 ? normalizeBlockedMessage(candidate.blockedMessage) : DEFAULT_BLOCKED_MESSAGE;
  } catch {
    return DEFAULT_BLOCKED_MESSAGE;
  }
}
