import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ServerMessage } from "@opencharm-labs/protocol/messages";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { parseServerMessage } from "@opencharm-labs/protocol/parse";

import { PairingRegistry } from "../auth/pairing";
import { CharmLook, type LookMessage } from "../look";
import { StateStore } from "../store/state-store";
import { Session, type SessionDeps } from "./session";

type Sent = ServerMessage | { closed: number };

const HELLO = JSON.stringify({
  type: "hello",
  version: 1,
  features: { opencharm: true },
  transport: "websocket",
  audio_params: {
    format: "opus",
    sample_rate: 16000,
    channels: 1,
    frame_duration: 60,
  },
});
const HELLO_LONG_ASK = JSON.stringify({
  type: "hello",
  version: 1,
  features: { opencharm: true, long_ask: true },
  transport: "websocket",
  audio_params: {
    format: "opus",
    sample_rate: 16000,
    channels: 1,
    frame_duration: 60,
  },
});
const HELLO_REPORT = JSON.stringify({
  type: "hello",
  version: 1,
  features: { opencharm: true, report: true },
  transport: "websocket",
  audio_params: {
    format: "opus",
    sample_rate: 16000,
    channels: 1,
    frame_duration: 60,
  },
});
const HELLO_CLOCK = JSON.stringify({
  type: "hello",
  version: 1,
  features: { opencharm: true, clock: true },
  transport: "websocket",
  audio_params: {
    format: "opus",
    sample_rate: 16000,
    channels: 1,
    frame_duration: 60,
  },
});
const unlock = (pin: string) =>
  JSON.stringify({ type: "charm", op: "unlock", pin });
const LISTEN = JSON.stringify({
  type: "listen",
  state: "start",
  mode: "manual",
});

let store: StateStore;
let pairing: PairingRegistry;

function open(token?: string, askTimeoutMs?: number, look?: () => LookMessage) {
  const sent: Sent[] = [];
  const session = new Session({
    store,
    pairing,
    connectionId: `conn-${Math.random()}`,
    token,
    ...(askTimeoutMs ? { askTimeoutMs } : {}),
    ...(look ? { look } : {}),
    outbound: {
      send: (message) => sent.push(message),
      close: (code) => sent.push({ closed: code }),
    },
  });
  return { session, sent, last: () => sent.at(-1) };
}

async function pairedCharm(pin = "482913") {
  const first = open();
  await first.session.onText(HELLO);
  const token = await first.session.completePairing("pip", pin);
  return { token, first };
}

beforeEach(() => {
  store = new StateStore(
    join(mkdtempSync(join(tmpdir(), "oc-session-")), "state.json")
  );
  pairing = new PairingRegistry({ ttlMs: 300_000, maxPending: 8 });
});

describe("before hello", () => {
  it("closes a connection that skips the hello", async () => {
    const { session, last } = open();
    await session.onText(LISTEN);
    expect(last()).toEqual({ closed: 1008 });
  });
});

describe("an unpaired charm", () => {
  it("gets a server hello with 24 kHz audio, then a pairing code", async () => {
    const { session, sent } = open();
    await session.onText(HELLO);
    expect(sent[0]).toMatchObject({
      type: "hello",
      audio_params: { sample_rate: 24000 },
    });
    expect(sent[1]).toMatchObject({
      type: "charm",
      op: "pair_code",
      expires_in: 300,
    });
    expect(session.state).toBe("unpaired");
  });

  it("receives a token when the admin pairs it, then sits locked", async () => {
    const { first } = await pairedCharm();
    const paired = first.sent.find((m) => "op" in m && m.op === "paired");
    expect(paired).toMatchObject({
      token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) as unknown,
    });
    expect(first.session.state).toBe("locked");
  });

  it("ignores unlock attempts", async () => {
    const { session, last } = open();
    await session.onText(HELLO);
    await session.onText(unlock("1234"));
    expect(session.state).toBe("unpaired");
    expect(last()).toMatchObject({ op: "pair_code" });
  });
});

describe("a paired charm", () => {
  it("always starts locked on a new connection", async () => {
    const { token } = await pairedCharm();
    const { session, last } = open(token);
    await session.onText(HELLO);
    expect(last()).toEqual({
      type: "charm",
      op: "locked",
      reason: "boot",
      tries_left: 5,
    });
    expect(session.state).toBe("locked");
  });

  it("unlocks with the right PIN", async () => {
    const { token } = await pairedCharm("482913");
    const { session, last } = open(token);
    await session.onText(HELLO);
    await session.onText(unlock("482913"));
    expect(last()).toEqual({ type: "charm", op: "unlocked" });
    expect(session.state).toBe("unlocked");
  });

  it("counts wrong PINs and blocks after five, across reconnects", async () => {
    const { token } = await pairedCharm("482913");
    const a = open(token);
    await a.session.onText(HELLO);
    for (const pin of ["0000", "1111", "2222"])
      await a.session.onText(unlock(pin));
    expect(a.last()).toEqual({
      type: "charm",
      op: "locked",
      reason: "wrong_pin",
      tries_left: 2,
    });

    const b = open(token);
    await b.session.onText(HELLO);
    expect(b.last()).toMatchObject({ reason: "boot", tries_left: 2 });
    await b.session.onText(unlock("3333"));
    await b.session.onText(unlock("4444"));
    expect(b.last()).toEqual({
      type: "charm",
      op: "locked",
      reason: "blocked",
    });
    await b.session.onText(unlock("482913"));
    expect(b.last()).toEqual({
      type: "charm",
      op: "locked",
      reason: "blocked",
    });
    expect(b.session.state).toBe("locked");
  });

  it("resets the counter after a correct PIN", async () => {
    const { token } = await pairedCharm("482913");
    const { session } = open(token);
    await session.onText(HELLO);
    await session.onText(unlock("0000"));
    await session.onText(unlock("482913"));
    expect(store.find("pip")?.failedTries).toBe(0);
  });

  it("answers listen and audio before unlock with locked, and drops them", async () => {
    const { token } = await pairedCharm();
    const { session, last } = open(token);
    await session.onText(HELLO);
    await session.onText(LISTEN);
    expect(last()).toMatchObject({ op: "locked", reason: "boot" });
    await session.onBinary(Buffer.alloc(120));
    expect(last()).toMatchObject({ op: "locked" });
  });

  it("closes the connection on an oversized audio frame", async () => {
    const { token } = await pairedCharm();
    const { session, last } = open(token);
    await session.onText(HELLO);
    await session.onBinary(Buffer.alloc(5000));
    expect(last()).toEqual({ closed: 1009 });
  });

  it("gets revoked and closed when its token is unknown", async () => {
    const { session, sent } = open("x".repeat(43));
    await session.onText(HELLO);
    expect(sent.slice(-2)).toEqual([
      { type: "charm", op: "revoked" },
      { closed: 4001 },
    ]);
  });
});

describe("admin actions", () => {
  async function unlockedSession() {
    const { token } = await pairedCharm("482913");
    const opened = open(token);
    await opened.session.onText(HELLO);
    await opened.session.onText(unlock("482913"));
    return opened;
  }

  it("lock sends locked(remote)", async () => {
    const { session, last } = await unlockedSession();
    session.lockRemote();
    expect(last()).toEqual({ type: "charm", op: "locked", reason: "remote" });
    expect(session.state).toBe("locked");
  });

  it("unlock clears a block and unlocks the connected charm", async () => {
    const { token } = await pairedCharm("482913");
    const { session, last } = open(token);
    await session.onText(HELLO);
    for (let i = 0; i < 5; i++) await session.onText(unlock("0000"));
    session.unlockByAdmin();
    expect(last()).toEqual({ type: "charm", op: "unlocked" });
    expect(store.find("pip")).toMatchObject({ blocked: false, failedTries: 0 });
  });

  it("revoke sends revoked and closes", async () => {
    const { session, sent } = await unlockedSession();
    session.revoke();
    expect(sent.slice(-2)).toEqual([
      { type: "charm", op: "revoked" },
      { closed: 4001 },
    ]);
  });
});

describe("the charm's look", () => {
  const look = new CharmLook(
    { colour: "cobalt", sleepAfterMinutes: 4, motion: "full", volume: 85 },
    "Momo"
  );
  const lookNow = () => look.message();

  it("comes right before unlocked when the PIN is right", async () => {
    const { token } = await pairedCharm("482913");
    const { session, sent } = open(token, undefined, lookNow);
    await session.onText(HELLO);
    await session.onText(unlock("482913"));
    expect(sent.slice(-2)).toEqual([
      look.message(),
      { type: "charm", op: "unlocked" },
    ]);
  });

  it("is never sent to a locked charm, even for a wrong PIN", async () => {
    const { token } = await pairedCharm("482913");
    const { session, sent } = open(token, undefined, lookNow);
    await session.onText(HELLO);
    await session.onText(unlock("0000"));
    session.sendLook(look.message());
    expect(sent.some((m) => "op" in m && m.op === "look")).toBe(false);
  });

  it("comes right before unlocked when the admin unlocks it", async () => {
    const { token } = await pairedCharm("482913");
    const { session, sent } = open(token, undefined, lookNow);
    await session.onText(HELLO);
    session.unlockByAdmin();
    expect(sent.slice(-2)).toEqual([
      look.message(),
      { type: "charm", op: "unlocked" },
    ]);
  });

  it("reaches an unlocked charm when it changes", async () => {
    const { token } = await pairedCharm("482913");
    const { session, last } = open(token, undefined, lookNow);
    await session.onText(HELLO);
    await session.onText(unlock("482913"));
    const lime = { ...look.message(), glyph: "#D6F78A" };
    session.sendLook(lime);
    expect(last()).toEqual(lime);
  });
});

describe("the reply report (spec 003)", () => {
  async function offeredReport(hello: string) {
    const { token } = await pairedCharm("482913");
    let offered: (() => boolean) | undefined;
    const session = new Session({
      store,
      pairing,
      connectionId: `conn-report-${Math.random()}`,
      token,
      outbound: { send: () => undefined, close: () => undefined },
      createTurn: (io) => {
        offered = io.report;
        return {
          dispose: () => undefined,
          warm: () => undefined,
        } as unknown as import("../turn/turn").TurnController;
      },
    });
    await session.onText(hello);
    await session.onText(unlock("482913"));
    return offered;
  }

  it("hands the charm's report feature to the turn", async () => {
    const offered = await offeredReport(HELLO_REPORT);
    expect(offered?.()).toBe(true);
  });

  it("says no for a charm that doesn't offer it", async () => {
    const offered = await offeredReport(HELLO);
    expect(offered?.()).toBe(false);
  });

  async function unlocked(
    hello: string,
    createTurn?: SessionDeps["createTurn"]
  ) {
    const { token } = await pairedCharm("482913");
    const sent: Sent[] = [];
    const session = new Session({
      store,
      pairing,
      connectionId: `conn-show-${Math.random()}`,
      token,
      ...(createTurn ? { createTurn } : {}),
      outbound: {
        send: (message) => sent.push(message),
        close: () => undefined,
      },
    });
    await session.onText(hello);
    await session.onText(unlock("482913"));
    sent.length = 0;
    return { session, sent };
  }

  it("shows text from the computer on the report page, one line per message", async () => {
    const { session, sent } = await unlocked(HELLO_REPORT);
    session.showReport("## Status\n\n- built");
    expect(sent).toEqual([
      expect.objectContaining({ type: "tts", state: "start" }),
      expect.objectContaining({
        type: "tts",
        state: "sentence_start",
        text: "## Status",
      }),
      expect.objectContaining({
        type: "tts",
        state: "sentence_start",
        text: "",
      }),
      expect.objectContaining({
        type: "tts",
        state: "sentence_start",
        text: "- built",
      }),
      expect.objectContaining({ type: "tts", state: "stop" }),
    ]);
  });

  it("refuses a charm whose firmware doesn't show a report", async () => {
    const { session } = await unlocked(HELLO);
    expect(() => session.showReport("hi")).toThrow(/doesn't show reports/);
  });

  it("refuses while the charm is in a turn", async () => {
    const { session } = await unlocked(HELLO_REPORT, () => {
      return {
        busy: true,
        warm: () => undefined,
        dispose: () => undefined,
      } as unknown as import("../turn/turn").TurnController;
    });
    expect(() => session.showReport("hi")).toThrow(/middle of a turn/);
  });
});

describe("frame order", () => {
  it("keeps audio in order with the listen messages around it", async () => {
    const { token } = await pairedCharm("482913");
    const frames: number[] = [];
    const sent: Sent[] = [];
    const session = new Session({
      store,
      pairing,
      connectionId: "conn-order",
      token,
      outbound: {
        send: (m) => sent.push(m),
        close: (c) => sent.push({ closed: c }),
      },
      createTurn: () =>
        ({
          listenStart: () => frames.push(-1),
          audio: (frame: Buffer) => frames.push(frame.length),
          listenStop: () => {
            frames.push(-2);
            return Promise.resolve();
          },
          abort: () => undefined,
          dispose: () => undefined,
          warm: () => undefined,
        }) as unknown as import("../turn/turn").TurnController,
    });
    await session.onText(HELLO);
    await session.onText(unlock("482913"));
    void session.onText(LISTEN);
    // Not awaited on purpose: the frames must wait behind the queued "listen start".
    void session.onBinary(Buffer.alloc(3));
    void session.onBinary(Buffer.alloc(4));
    await session.onText(JSON.stringify({ type: "listen", state: "stop" }));
    expect(frames).toEqual([-1, 3, 4, -2]);
  });
});

describe("questions on the charm", () => {
  async function unlockedSession(askTimeoutMs?: number) {
    const { token } = await pairedCharm("482913");
    const opened = open(token, askTimeoutMs);
    await opened.session.onText(HELLO);
    await opened.session.onText(unlock("482913"));
    return opened;
  }
  const answer = (id: string, yes: boolean) =>
    JSON.stringify({ type: "charm", op: "answer", id, yes });
  const asks = (sent: Sent[]) =>
    sent.filter(
      (m): m is Extract<ServerMessage, { op: "ask" }> =>
        "op" in m && m.op === "ask"
    );

  it("shows the question on the charm and resolves with its answer", async () => {
    const { session, sent } = await unlockedSession();
    const asked = session.ask("Claude Code wants to write notes.md.");
    await expect.poll(() => asks(sent).length).toBe(1);
    const [question] = asks(sent);
    expect(question).toMatchObject({
      type: "charm",
      op: "ask",
      text: "Claude Code wants to write notes.md.",
    });
    expect(question?.id).toMatch(/^[A-Za-z0-9_-]{1,32}$/);
    await session.onText(answer(question?.id ?? "", true));
    expect(await asked).toBe(true);

    const second = session.ask("Again?");
    await expect.poll(() => asks(sent).length).toBe(2);
    await session.onText(answer(asks(sent)[1]?.id ?? "", false));
    expect(await second).toBe(false);
  });

  it("fits an older charm's question in 200 bytes, however it's written", async () => {
    const { session, sent } = await unlockedSession();
    void session.ask(`${"é".repeat(150)}?`, { yes: "ÉÉÉÉÉÉÉÉ" });
    await expect.poll(() => asks(sent).length).toBe(1);
    const [question] = asks(sent);
    expect(new TextEncoder().encode(question?.text).length).toBeLessThanOrEqual(
      200
    );
    expect(new TextEncoder().encode(question?.yes).length).toBeLessThanOrEqual(
      12
    );
    expect(parseServerMessage(JSON.stringify(question)).ok).toBe(true);
  });

  it("sends the whole task to a charm that can scroll it, up to 2000 bytes", async () => {
    const { token } = await pairedCharm("482913");
    const { session, sent } = open(token);
    await session.onText(HELLO_LONG_ASK);
    await session.onText(unlock("482913"));

    const task = `Claude Code wants to ${"run the whole task and check every file. ".repeat(12)}`;
    void session.ask(task);
    await expect.poll(() => asks(sent).length).toBe(1);
    const [question] = asks(sent);
    expect(question?.text).toBe(task); // the whole title, under 2000 bytes
    await session.onText(answer(question?.id ?? "", false));

    const tooLong = `Claude Code wants to ${"x".repeat(2500)}`;
    void session.ask(tooLong);
    await expect.poll(() => asks(sent).length).toBe(2);
    const [second] = asks(sent).slice(-1);
    expect(new TextEncoder().encode(second?.text).length).toBeLessThanOrEqual(
      2000
    );
    expect(second?.text.endsWith("…")).toBe(true);
    await session.onText(answer(second?.id ?? "", false));
  });

  it("ignores answers to other questions", async () => {
    const { session, sent } = await unlockedSession(80);
    const asked = session.ask("Allow?");
    await expect.poll(() => asks(sent).length).toBe(1);
    await session.onText(answer("someone-else", true));
    expect(await asked).toBe(false);
    expect(sent).toContainEqual({
      type: "charm",
      op: "ask_end",
      id: asks(sent)[0]?.id,
    });
  });

  it("takes silence as no, and clears the question from the charm", async () => {
    const { session, sent } = await unlockedSession(50);
    expect(await session.ask("Allow?")).toBe(false);
    expect(sent.at(-1)).toEqual({
      type: "charm",
      op: "ask_end",
      id: asks(sent)[0]?.id,
    });
  });

  it("takes a cancelled turn as no, and clears the question", async () => {
    const { session, sent } = await unlockedSession();
    const stop = new AbortController();
    const asked = session.ask("Allow?", { signal: stop.signal });
    await expect.poll(() => asks(sent).length).toBe(1);
    stop.abort();
    expect(await asked).toBe(false);
    expect(sent.at(-1)).toMatchObject({ op: "ask_end" });
  });

  it("says no at once to a locked charm, without asking it", async () => {
    const { token } = await pairedCharm("482913");
    const { session, sent } = open(token);
    await session.onText(HELLO);
    expect(await session.ask("Allow?")).toBe(false);
    expect(asks(sent)).toEqual([]);
  });

  it("says no when the charm is locked while asking", async () => {
    const { session, sent } = await unlockedSession();
    const asked = session.ask("Allow?");
    await expect.poll(() => asks(sent).length).toBe(1);
    session.lockRemote();
    expect(await asked).toBe(false);
  });

  it("a queued question gives up as soon as its turn is cancelled", async () => {
    const { session, sent } = await unlockedSession();
    void session.ask("First?");
    await expect.poll(() => asks(sent).length).toBe(1);
    const stop = new AbortController();
    const queued = session.ask("Second?", { signal: stop.signal });
    stop.abort();
    const started = Date.now();
    expect(await queued).toBe(false);
    expect(Date.now() - started).toBeLessThan(500);
    expect(asks(sent)).toHaveLength(1);
  });

  it("asks one question at a time", async () => {
    const { session, sent } = await unlockedSession();
    const first = session.ask("First?");
    const second = session.ask("Second?");
    await expect.poll(() => asks(sent).length).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(asks(sent).map((q) => q.text)).toEqual(["First?"]);
    await session.onText(answer(asks(sent)[0]?.id ?? "", true));
    expect(await first).toBe(true);
    await expect.poll(() => asks(sent).length).toBe(2);
    await session.onText(answer(asks(sent)[1]?.id ?? "", false));
    expect(await second).toBe(false);
  });
});

describe("reading a tapped progress line (spec 017)", () => {
  async function unlockedWithTurn(createTurn: SessionDeps["createTurn"]) {
    const { token } = await pairedCharm("482913");
    const sent: Sent[] = [];
    const session = new Session({
      store,
      pairing,
      connectionId: `conn-${Math.random()}`,
      token,
      createTurn,
      outbound: {
        send: (message) => sent.push(message),
        close: (code) => sent.push({ closed: code }),
      },
    });
    await session.onText(HELLO);
    await session.onText(unlock("482913"));
    return { session, sent };
  }

  it("offers speak in its hello and hands a tapped line to the turn", async () => {
    const reads: string[] = [];
    const opened = await unlockedWithTurn(
      () =>
        ({
          read: (text: string) => {
            reads.push(text);
            return true;
          },
          warm: () => undefined,
          dispose: () => undefined,
        }) as unknown as import("../turn/turn").TurnController
    );
    const hello = opened.sent.find((m) => "type" in m && m.type === "hello");
    expect(hello).toMatchObject({ features: { speak: true } });
    await opened.session.onText(
      JSON.stringify({ type: "charm", op: "speak", text: "Run npm test" })
    );
    expect(reads).toEqual(["Run npm test"]);
  });
});

describe("the screen's clock", () => {
  it("sends the computer's local time on unlock and each minute, to a charm that shows it", async () => {
    const { token } = await pairedCharm("482913");
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(2026, 9, 31, 21, 55, 10));
      const sent: Sent[] = [];
      const session = new Session({
        store,
        pairing,
        connectionId: `conn-${Math.random()}`,
        token,
        outbound: {
          send: (message) => sent.push(message),
          close: (code) => sent.push({ closed: code }),
        },
      });
      await session.onText(HELLO_CLOCK);
      await session.onText(unlock("482913"));
      const clocks = () =>
        sent.filter((m) => "op" in m && m.op === "clock");
      expect(clocks()).toEqual([
        { type: "charm", op: "clock", time: "21:55" },
      ]);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(clocks()).toEqual([
        { type: "charm", op: "clock", time: "21:55" },
        { type: "charm", op: "clock", time: "21:56" },
      ]);
      // Locked: the screen is the PIN pad, so the clock stops until the next unlock.
      session.lockRemote();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(clocks()).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never sends a clock to a charm that doesn't show one", async () => {
    const { token } = await pairedCharm("482913");
    const { session, sent } = open(token);
    await session.onText(HELLO);
    await session.onText(unlock("482913"));
    expect(sent.some((m) => "op" in m && m.op === "clock")).toBe(false);
  });
});
