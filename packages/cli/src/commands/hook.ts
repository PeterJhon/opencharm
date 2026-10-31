import { readFileSync } from "node:fs";

import { fitUtf8 } from "@opencharm-labs/protocol/text";

import { flagValue } from "../args";
import type { AdminDeps } from "./admin";

type HookEvent = {
  hook_event_name?: string;
  transcript_path?: string;
  message?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
};

// The daemon's own limit for `show` (the admin socket takes a 16 KB request); a longer answer is
// cut, with "…", rather than failing.
const MAX_SHOWN_BYTES = 12_000;
// A face line is short enough to read at a glance.
const MAX_LINE_BYTES = 200;

async function readStdin(
  input: AsyncIterable<string | Buffer>
): Promise<string> {
  let text = "";
  for await (const chunk of input) text += chunk.toString();
  return text;
}

// The last assistant text in a Claude Code transcript: the answer a Stop hook is about. A line that
// isn't JSON (or an assistant message with no text, like a tool call) is skipped.
function lastAnswer(path: string | undefined): string {
  if (!path) return "";
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return "";
  }
  let answer = "";
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let entry: { type?: string; message?: { content?: unknown } };
    try {
      entry = JSON.parse(line) as typeof entry;
    } catch {
      continue;
    }
    if (entry.type !== "assistant" || !Array.isArray(entry.message?.content))
      continue;
    const text = entry.message.content
      .filter(
        (part): part is { type: string; text: string } =>
          typeof part === "object" &&
          part !== null &&
          (part as { type?: unknown }).type === "text" &&
          typeof (part as { text?: unknown }).text === "string"
      )
      .map((part) => part.text)
      .join("\n");
    if (text.trim()) answer = text;
  }
  return answer;
}

// A short line for the working face: the tool, and what it is working on.
function toolLine(event: HookEvent): string {
  const input = event.tool_input ?? {};
  const target =
    [
      input.file_path,
      input.path,
      input.command,
      input.pattern,
      input.url,
      input.description,
    ].find(
      (value): value is string => typeof value === "string" && value.length > 0
    ) ?? "";
  const name = event.tool_name ?? "tool";
  return target ? `${name} · ${target}` : name;
}

// What to tell charmd for one Claude Code hook event: nothing for events we don't mirror.
function requestFor(
  event: HookEvent,
  charm: string | undefined
): Record<string, unknown> | undefined {
  const target = charm ? { charm } : {};
  if (event.hook_event_name === "Stop") {
    const text = fitUtf8(lastAnswer(event.transcript_path), MAX_SHOWN_BYTES);
    return text.trim() ? { cmd: "show", ...target, text } : undefined;
  }
  if (event.hook_event_name === "Notification") {
    return {
      cmd: "devFace",
      ...target,
      state: "needs_you",
      ...(event.message
        ? { text: fitUtf8(event.message, MAX_LINE_BYTES) }
        : {}),
    };
  }
  if (event.hook_event_name === "PreToolUse") {
    return {
      cmd: "devFace",
      ...target,
      state: "working",
      text: fitUtf8(toolLine(event), MAX_LINE_BYTES),
    };
  }
  return undefined;
}

// `opencharm hook`: Claude Code pipes an event on stdin. The answer goes to the charm as its report
// page; a notification turns the charm orange; a tool call shows what is being worked on. This
// never fails the agent's turn and prints nothing: stdout belongs to the hook protocol.
async function runHook(
  args: readonly string[],
  deps: AdminDeps,
  input: AsyncIterable<string | Buffer> = process.stdin
): Promise<void> {
  try {
    const event = JSON.parse(await readStdin(input)) as HookEvent;
    const request = requestFor(event, flagValue(args, "--charm"));
    if (request) await deps.send(deps.socket, request);
  } catch {
    // The charm may be off, locked or busy; a hook must not fail the agent's turn for that.
  }
}

export { lastAnswer, requestFor, runHook };
