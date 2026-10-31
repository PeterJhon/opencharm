import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { runHook } from "./hook";

const SOCKET = "/tmp/test.sock";

function event(value: object): Readable {
  return Readable.from([JSON.stringify(value)]);
}

function deps(send = vi.fn().mockResolvedValue({ connected: 1 })) {
  return { socket: SOCKET, send, prompt: vi.fn() };
}

describe("opencharm hook", () => {
  it("shows Claude's last answer as the charm's report on Stop", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-hook-"));
    const transcript = join(dir, "session.jsonl");
    writeFileSync(
      transcript,
      [
        JSON.stringify({ type: "user", message: { content: "hi" } }),
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "tool_use", name: "Bash" }] },
        }),
        JSON.stringify({
          type: "assistant",
          message: {
            content: [{ type: "text", text: "## Done\n\nAll green." }],
          },
        }),
      ].join("\n")
    );
    const send = vi.fn().mockResolvedValue({ connected: 1 });
    await runHook(
      [],
      deps(send),
      event({ hook_event_name: "Stop", transcript_path: transcript })
    );
    expect(send).toHaveBeenCalledWith(SOCKET, {
      cmd: "show",
      text: "## Done\n\nAll green.",
    });
  });

  it("turns the charm orange for a notification, with the message", async () => {
    const send = vi.fn().mockResolvedValue({ connected: 1 });
    await runHook(
      [],
      deps(send),
      event({
        hook_event_name: "Notification",
        message: "Claude needs your permission to use Bash",
      })
    );
    expect(send).toHaveBeenCalledWith(SOCKET, {
      cmd: "devFace",
      state: "needs_you",
      text: "Claude needs your permission to use Bash",
    });
  });

  it("shows what a tool is working on before it runs", async () => {
    const send = vi.fn().mockResolvedValue({ connected: 1 });
    await runHook(
      [],
      deps(send),
      event({
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "npm test" },
      })
    );
    expect(send).toHaveBeenCalledWith(SOCKET, {
      cmd: "devFace",
      state: "working",
      text: "Bash · npm test",
    });
  });

  it("names the charm when told to", async () => {
    const send = vi.fn().mockResolvedValue({ connected: 1 });
    await runHook(
      ["--charm", "peter"],
      deps(send),
      event({
        hook_event_name: "PreToolUse",
        tool_name: "Read",
        tool_input: { file_path: "src/main.ts" },
      })
    );
    expect(send).toHaveBeenCalledWith(SOCKET, {
      cmd: "devFace",
      charm: "peter",
      state: "working",
      text: "Read · src/main.ts",
    });
  });

  it("ignores events it doesn't mirror, an unreadable transcript and bad JSON", async () => {
    const send = vi.fn();
    await runHook([], deps(send), event({ hook_event_name: "SessionStart" }));
    await runHook(
      [],
      deps(send),
      event({ hook_event_name: "Stop", transcript_path: "/nope/missing.jsonl" })
    );
    await runHook([], deps(send), Readable.from(["not json"]));
    expect(send).not.toHaveBeenCalled();
  });

  it("never fails when charmd is unreachable", async () => {
    const send = vi.fn().mockRejectedValue(new Error("charmd is not running"));
    await expect(
      runHook(
        [],
        deps(send),
        event({ hook_event_name: "Notification", message: "Waiting for you" })
      )
    ).resolves.toBeUndefined();
  });
});
