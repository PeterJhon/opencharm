import type {
  ProgressEntry,
  ServerMessage,
} from "@opencharm-labs/protocol/messages";
import { fitUtf8, utf8Length } from "@opencharm-labs/protocol/text";

import type { AgentAdapter, ProgressUpdate } from "../agent/types";
import { opusPacketSamples48k, writeOggOpus } from "../audio/ogg-opus";
import { guessLanguage } from "../voice/language";
import { VoiceNotReady } from "../voice/models";
import { PacketStream, packetsOf } from "../voice/packets";
import type { LiveTranscription, VoiceProvider } from "../voice/types";
import { ACP_AGENTS } from "../agent/acp-agents";
import { MAX_REPORT_BYTES, reportLines } from "../report";
import { SentenceSplitter, cleanForSpeech } from "./sentences";

type TurnState = "idle" | "listening" | "thinking" | "speaking";
type TurnDeps = {
  voice: VoiceProvider;
  agent: AgentAdapter;
  sessionKey: string;
  send: (message: ServerMessage) => void;
  sendAudio: (packet: Buffer) => void;
  timeoutMs: number;
  log?: (entry: Record<string, unknown>) => void;
  logTranscripts?: boolean;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  // A question on the charm (the session's ask); absent when there's no charm to ask.
  ask?: (text: string, options?: AskOptions) => Promise<boolean>;
  // Asked at the start of each turn: false shows the reply as text, with no speech (spec 003).
  speakAloud?: () => boolean;
  // The charm's hello offered `features.report`: it keeps a text reply as one scrollable page.
  report?: () => boolean;
  // Ask the person to send or redo what was heard before the agent runs (spec 019).
  confirmHeard?: () => boolean;
};
type Stage = "stt" | "agent" | "tts";
// A face from the agent's tools: an agent state, maybe drawn as a feeling, maybe with a line.
type ShownFace = { state: string; feeling?: string; text?: string };
type AskOptions = { yes?: string; no?: string; signal?: AbortSignal };

// A minute of speech at 60 ms per packet; longer holds are cut, not buffered forever.
const MAX_FRAMES = 1000;
// How far ahead of real time the charm's player is kept, so a late timer or a busy moment doesn't run
// it dry (each gap is a click).
const LEAD_MS = 250;
// Text-only replies: each sentence stays for about its reading time (3 words a second, at least 2 s).
const READING_WORDS_PER_SECOND = 3;
const MIN_READING_MS = 2000;
// Sentences synthesizing at once: the one playing and the next, so the next is ready in time without
// a long reply opening a connection (or a local job) per sentence.
const LOOKAHEAD = 2;
// The progress page's limits (spec 017), matching packages/protocol.
const MAX_PROGRESS_ENTRIES = 12;
const MAX_PROGRESS_BYTES = 200;
// A face line is short enough to read at a glance.
const MAX_STEP_CHARS = 60;
const AGENT_LABELS: Record<string, string> = {
  ...Object.fromEntries(
    Object.entries(ACP_AGENTS).map(([name, agent]) => [name, agent.label])
  ),
};

// Orders turns across every charm, so the newest agent turn can be told apart (newConversation).
let turnsStarted = 0;

class TurnTimeout extends Error {}

class StageError extends Error {
  constructor(
    readonly stage: Stage,
    cause: unknown
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
  }
}

const CJK =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;
// Reading time for text-only replies. Chinese and the other CJK scripts have no spaces, so a
// sentence would otherwise count as one "word" and flash by in the 2 s minimum. Four characters a
// second for CJK, three words a second for the rest.
function readingMs(text: string): number {
  const cjk = text.match(CJK)?.length ?? 0;
  const words = text.replace(CJK, " ").split(/\s+/).filter(Boolean).length;
  return Math.max(
    MIN_READING_MS,
    (cjk / 4 + words / READING_WORDS_PER_SECOND) * 1000
  );
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function inStage<T>(stage: Stage, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw error instanceof TurnTimeout ? error : new StageError(stage, error);
  }
}

// One turn = hold the key, speak, release, hear the answer. It only moves audio and text: what to
// answer and how is the agent's business. A generation number makes sure a cancelled turn never
// sends anything after a newer one has started.
class TurnController {
  #state: TurnState = "idle";
  #frames: Buffer[] = [];
  // The voice hearing this hold as it goes, when it can (ElevenLabs).
  #live: LiveTranscription | undefined;
  #generation = 0;
  #controller: AbortController | undefined;
  #speaking = false;
  // A question on the charm hides what's being read: a sentence's reading time waits for it (the
  // charm keeps the sentence and shows it again when the question ends). Questions can queue.
  #questions = 0;
  #questionsEnd: Promise<void> | undefined;
  #endQuestions = () => {};
  readonly #questionStarts = new Set<() => void>();
  // When the charm's player will have played all the audio of this reply (#sendPaced).
  #playedBy = 0;
  // While a turn runs: how a question pauses its clock; and a face a tool asked to keep after it.
  #asking:
    ((text: string, options: AskOptions) => Promise<boolean>) | undefined;
  #endFace: ShownFace | undefined;
  // The progress page (spec 017): the latest plan, the turn's tool calls, and what has already
  // been sent, so unchanged updates cost nothing.
  #plan: ProgressEntry[] = [];
  #tools: Array<{
    id: string;
    text: string;
    status: ProgressEntry["status"];
  }> = [];
  #stepShown = "";
  #progressSent = "";
  // A progress line being read aloud while the agent keeps working. The reply waits for it.
  #reading:
    | {
        controller: AbortController;
        done: Promise<void>;
        finish: () => void;
        silent: boolean;
      }
    | undefined;
  // When this charm's current turn began, in turnsStarted's order; undefined between turns.
  #runOrder: number | undefined;
  readonly #deps: TurnDeps;

  constructor(deps: TurnDeps) {
    this.#deps = deps;
  }

  get state(): TurnState {
    return this.#state;
  }

  #face(state: string, text?: string, feeling?: string): void {
    this.#deps.send({
      type: "charm",
      op: "face",
      state,
      ...(feeling ? { feeling } : {}),
      ...(text ? { text } : {}),
    });
  }

  get busy(): boolean {
    return this.#state !== "idle";
  }

  // A turn past listening (thinking or answering), the only time the agent can be at work for this
  // charm: its place in the order turns began, else undefined.
  get answering(): number | undefined {
    return this.#state === "thinking" || this.#state === "speaking"
      ? this.#runOrder
      : undefined;
  }

  // A face from the agent's tools: shown now and, during a turn, kept when the turn ends.
  showFace(face: ShownFace): void {
    this.#face(face.state, face.text, face.feeling);
    if (this.busy) this.#endFace = face;
  }

  // A question from the agent's tools: during a turn it pauses the turn's clock and is cancelled
  // with the turn, like a permission question.
  ask(text: string, options: AskOptions = {}): Promise<boolean> {
    if (this.#asking) return this.#asking(text, options);
    return this.#deps.ask
      ? this.#deps.ask(text, options)
      : Promise.resolve(false);
  }

  // The list the charm shows: the latest plan, then as many recent tool calls as fit.
  #progressEntries(): ProgressEntry[] {
    const plan = this.#plan.slice(0, MAX_PROGRESS_ENTRIES);
    const room = MAX_PROGRESS_ENTRIES - plan.length;
    const tools = room > 0 ? this.#tools.slice(-room) : [];
    return [...plan, ...tools.map(({ text, status }) => ({ text, status }))];
  }

  #sendProgress(): void {
    const entries = this.#progressEntries();
    const same = JSON.stringify(entries);
    if (same === this.#progressSent) return;
    this.#progressSent = same;
    this.#deps.send({ type: "charm", op: "progress", entries });
  }

  // The turn is over: the charm puts the face back and its status gesture returns.
  #clearProgress(): void {
    if (this.#plan.length === 0 && this.#tools.length === 0) return;
    this.#plan = [];
    this.#tools = [];
    this.#stepShown = "";
    this.#progressSent = "";
    this.#deps.send({ type: "charm", op: "progress", entries: [] });
  }

  // The current step on the working face: a plan line or a tool call, cut to one short line.
  #announceStep(text: string): void {
    const line = [...text.trim()].slice(0, MAX_STEP_CHARS).join("");
    if (!line || line === this.#stepShown) return;
    this.#stepShown = line;
    this.#face("working", line);
  }

  #onProgress(
    update: ProgressUpdate,
    live: () => boolean,
    asking: boolean
  ): void {
    if (!live()) return;
    if (update.kind === "plan") {
      // The plan arrives whole, each change replacing the last.
      this.#plan = update.entries
        .map((entry) => ({
          text: fitUtf8(entry.text.trim(), MAX_PROGRESS_BYTES),
          status: entry.status,
        }))
        .filter((entry) => entry.text.length > 0)
        .slice(0, MAX_PROGRESS_ENTRIES);
      const active =
        this.#plan.find((entry) => entry.status === "in_progress") ??
        this.#plan.find((entry) => entry.status === "pending") ??
        this.#plan[this.#plan.length - 1];
      if (active && !asking) this.#announceStep(active.text);
    } else {
      const text = update.text
        ? fitUtf8(update.text.trim(), MAX_PROGRESS_BYTES)
        : undefined;
      let tool = this.#tools.find((entry) => entry.id === update.id);
      if (!tool) {
        if (!text) return;
        tool = { id: update.id, text, status: "pending" };
        this.#tools.push(tool);
        if (this.#tools.length > MAX_PROGRESS_ENTRIES) this.#tools.shift();
      }
      if (text) tool.text = text;
      if (update.status) tool.status = update.status;
      if (!asking) this.#announceStep(tool.text);
    }
    this.#sendProgress();
  }

  // Reads one progress line while the agent keeps working (spec 017). Returns false when the reply
  // itself is speaking, or another line is being read: never two voices at once.
  read(text: string): boolean {
    // With replies as text there is no voice running, so a tapped progress line stays visual
    // (spec 017).
    if (!(this.#deps.speakAloud?.() ?? true)) return false;
    const line = text.trim();
    if (!line) return false;
    if (this.#state === "idle") {
      void this.say(line).catch(() => undefined);
      return true;
    }
    if (this.#state !== "thinking" || this.#reading || this.#speaking)
      return false;
    const controller = new AbortController();
    let finish = () => {};
    const done = new Promise<void>((resolve) => (finish = resolve));
    const reading = { controller, done, finish, silent: false };
    this.#reading = reading;
    const timer = setTimeout(() => {
      // A voice that never returns must not leave the charm in a speech layout or hold the reply.
      controller.abort();
      if (this.#reading !== reading) return;
      reading.silent = true;
      reading.finish();
      this.#reading = undefined;
      this.#deps.send({ type: "tts", state: "stop" });
    }, this.#deps.timeoutMs);
    void this.#readDuringTurn(line, reading)
      .catch(() => undefined)
      .finally(() => {
        clearTimeout(timer);
        finish();
        if (this.#reading === reading) this.#reading = undefined;
      });
    return true;
  }

  #stopReading(): void {
    const reading = this.#reading;
    if (!reading) return;
    // The charm already stopped its own speech on a key press, or a new turn is taking over: a
    // late tts stop would cut the new speech.
    reading.silent = true;
    reading.controller.abort();
    // A speaker that ignores the signal must not keep the reply waiting.
    reading.finish();
    this.#reading = undefined;
  }

  async #readDuringTurn(
    text: string,
    reading: { controller: AbortController; silent: boolean }
  ): Promise<void> {
    const { signal } = reading.controller;
    let started = false;
    let speaking = guessLanguage(text) ?? this.#deps.voice.language ?? "en";
    const splitter = new SentenceSplitter({ firstClause: true });
    const sentences: Array<{ text: string; language: string }> = [];
    const add = (sentence: string) => {
      const clean = cleanForSpeech(sentence);
      if (!clean) return;
      speaking = guessLanguage(clean) ?? speaking;
      sentences.push({ text: clean, language: speaking });
    };
    for (const sentence of splitter.push(text)) add(sentence);
    for (const sentence of splitter.flush()) add(sentence);
    try {
      for (const sentence of sentences) {
        if (signal.aborted) return;
        if (!started) {
          started = true;
          this.#deps.send({ type: "tts", state: "start" });
        }
        this.#deps.send({
          type: "tts",
          state: "sentence_start",
          text: sentence.text,
        });
        await this.#sendPaced(
          packetsOf(this.#deps.voice, sentence.text, signal, sentence.language),
          () => !signal.aborted,
          () => undefined
        );
      }
    } finally {
      // A key press or a new turn stopped the charm's own speech already; a natural end or a
      // timeout needs the stop to leave the speech layout.
      if (started && !reading.silent)
        this.#deps.send({ type: "tts", state: "stop" });
    }
  }

  #cancel(): void {
    // A reading stops here on a new turn, not on a key press (abort stops it first, and the charm
    // has already left its speech layout by itself).
    const wasReading = Boolean(this.#reading);
    this.#stopReading();
    this.#endLive();
    this.#endFace = undefined;
    this.#generation += 1;
    this.#controller?.abort();
    this.#controller = undefined;
    if (this.#speaking || wasReading)
      this.#deps.send({ type: "tts", state: "stop" });
    this.#speaking = false;
  }

  // A charm just unlocked: start the agent and load the voice now, not on the first question.
  warm(): void {
    this.#deps.agent.warm?.(this.#deps.sessionKey);
    void this.#deps.voice.warm?.().catch(() => undefined);
  }

  listenStart(): void {
    if (this.#state === "thinking" || this.#state === "speaking")
      this.#cancel();
    this.#state = "listening";
    this.#frames = [];
    this.#endLive();
    this.#live = this.#deps.voice.live?.();
    this.#face("listening");
    // The user is speaking for a few seconds anyway: a good moment for a slow agent to start up,
    // and for the voice to get ready to answer (when the answer will be spoken).
    this.#deps.agent.warm?.(this.#deps.sessionKey);
    if (this.#deps.speakAloud?.() ?? true) this.#deps.voice.prime?.();
  }

  audio(frame: Buffer): void {
    if (this.#state === "listening" && this.#frames.length < MAX_FRAMES) {
      this.#frames.push(frame);
      this.#live?.push(frame);
    }
  }

  #endLive(): void {
    this.#live?.cancel();
    this.#live = undefined;
  }

  abort(): void {
    // A press while a progress line is being read stops that reading only: the agent keeps working
    // (spec 017).
    if (this.#reading) {
      this.#stopReading();
      return;
    }
    if (this.#state === "idle") return;
    this.#cancel();
    this.#state = "idle";
    this.#face("idle");
  }

  listenStop(): Promise<void> {
    if (this.#state !== "listening") return Promise.resolve();
    const frames = this.#frames;
    const live = this.#live;
    this.#frames = [];
    this.#live = undefined;
    if (frames.length === 0) {
      live?.cancel();
      this.#state = "idle";
      this.#face("idle");
      return Promise.resolve();
    }
    return this.#run(live ? { frames, live } : { frames });
  }

  // The live transcript first: most of it is in by the time the key is let go. If it fails, the
  // whole clip goes the usual way, so a turn never depends on it.
  async #transcribe(
    frames: Buffer[],
    live: LiveTranscription | undefined,
    signal: AbortSignal
  ): Promise<string> {
    if (live) {
      try {
        return await live.finish(signal);
      } catch (error) {
        if (signal.aborted) throw error;
        this.#deps.log?.({
          event: "live-stt-failed",
          session: this.#deps.sessionKey,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const ogg = writeOggOpus(frames, { inputSampleRate: 16000 });
    return this.#deps.voice.transcribe(ogg, signal);
  }

  // Typed text from the desktop charm (spec 013): no listening, and the answer comes as text, the way
  // it was asked (spec 003). A turn in progress is cancelled, as a new key hold would.
  typed(text: string): Promise<void> {
    if (this.busy) this.#cancel();
    return this.#run({ text: text.trim() });
  }

  async #run(
    input: { frames: Buffer[]; live?: LiveTranscription } | { text: string }
  ): Promise<void> {
    const generation = ++this.#generation;
    const live = () => this.#generation === generation;
    const controller = new AbortController();
    this.#controller = controller;
    this.#runOrder = ++turnsStarted;
    const { signal } = controller;
    const now = this.#deps.now ?? Date.now;
    const started = now();
    const timings: Record<string, number> = {};
    let heard = "";
    let said = "";
    let outcome = "done";
    const startClock = () =>
      setTimeout(
        () => controller.abort(new TurnTimeout()),
        this.#deps.timeoutMs
      );
    let timer = startClock();
    // Until the first audio the clock times getting an answer started; from then on it times
    // silence: anything from the agent or the voice resets it, so a long answer plays to the end but
    // an agent or a voice that stalls mid-answer still ends the turn.
    let asking = false;
    let reading = false;
    const restartClock = () => {
      clearTimeout(timer);
      timer = startClock();
    };
    const clock = {
      started: restartClock,
      // Before the first audio this is a silence clock too: a plan line, a tool call or agent text
      // within turnTimeoutSeconds keeps a long task alive; after it starts, a stalled voice ends it.
      touch: () => {
        if (!asking && !reading) restartClock();
      },
      // Reading a sentence is activity too: no clock while it's on screen.
      pause: () => {
        reading = true;
        clearTimeout(timer);
      },
      resume: () => {
        reading = false;
        restartClock();
      },
    };
    const timeoutGuard = new Promise<never>((_, reject) =>
      signal.addEventListener("abort", () => {
        if (signal.reason instanceof TurnTimeout) reject(signal.reason);
      })
    );
    timeoutGuard.catch(() => undefined);

    this.#state = "thinking";
    this.#face("thinking");
    // A new turn starts with an empty progress page (the charm clears it on the thinking face too).
    this.#plan = [];
    this.#tools = [];
    this.#stepShown = "";
    this.#progressSent = "";
    try {
      if ("text" in input) {
        heard = input.text;
      } else {
        const { frames, live: heardLive } = input;
        heard = await Promise.race([
          inStage("stt", () => this.#transcribe(frames, heardLive, signal)),
          timeoutGuard,
        ]);
        timings.sttMs = now() - started;
        if (!live()) return;
        this.#deps.send({ type: "stt", text: heard });
      }
      if (!heard) {
        outcome = "nothing-heard";
        this.#state = "idle";
        this.#face("idle");
        return;
      }

      // Confirm what was heard before spending an agent turn on it (spec 019): hold = send,
      // press = redo. A stray hold or a misheard question never reaches the agent. The turn's
      // clock waits while the question is up; the session's ask owns the 30 s answer timeout.
      if (
        !("text" in input) &&
        this.#deps.ask &&
        (this.#deps.confirmHeard?.() ?? false)
      ) {
        clearTimeout(timer);
        const send = await this.#deps.ask(heard, {
          yes: "SEND",
          no: "REDO",
          signal,
        });
        if (!live()) return;
        if (!send) {
          outcome = "not-confirmed";
          this.#state = "idle";
          this.#face("idle");
          return;
        }
        clearTimeout(timer);
        timer = startClock();
      }

      // Errors from the agent surface while its stream is read, inside #speak ("agent" stage).
      const ask = this.#deps.ask;
      const label = AGENT_LABELS[this.#deps.agent.name] ?? "Your agent";
      if (ask)
        this.#asking = async (text, options) => {
          asking = true;
          clearTimeout(timer);
          if (this.#questions++ === 0) {
            this.#questionsEnd = new Promise<void>((resolve) => {
              this.#endQuestions = resolve;
            });
            for (const notify of this.#questionStarts) notify();
          }
          try {
            return await ask(text, { ...options, signal });
          } finally {
            // Questions can be open at once (parallel tools): the turn's clock waits until the last
            // is answered, then restarts once, never leaving a second timer behind to cut the reply.
            if (--this.#questions === 0) {
              asking = false;
              this.#questionsEnd = undefined;
              this.#endQuestions();
              clearTimeout(timer);
              if (!signal.aborted) timer = startClock();
            }
          }
        };
      // The agent's plan and tool calls (spec 017): a line on the working face and the scrollable
      // page, without speech. A question holds the face line back so it isn't hidden.
      const reply = this.#deps.agent.reply({
        sessionKey: this.#deps.sessionKey,
        text: heard,
        signal,
        ...(ask
          ? {
              // The person gets the question's own 30 s; the turn's clock restarts after.
              ask: (action: string) => this.ask(`${label} wants to ${action}.`),
            }
          : {}),
        onProgress: (update) => {
          clock.touch(); // a working agent is not a stalled one
          this.#onProgress(update, live, asking);
        },
      });
      said = await this.#speak(
        reply,
        signal,
        live,
        timings,
        started,
        timeoutGuard,
        guessLanguage(heard) ?? this.#deps.voice.language ?? "en",
        clock,
        // It answers the way it was asked: typed gets text.
        !("text" in input) && (this.#deps.speakAloud?.() ?? true)
      );
      if (!live()) return;
      if (this.#speaking) this.#deps.send({ type: "tts", state: "stop" });
      this.#speaking = false;
      this.#state = "idle";
      const end = this.#endFace ?? { state: "idle" };
      this.#endFace = undefined;
      this.#face(end.state, end.text, end.feeling);
    } catch (error) {
      // Whichever half failed (the agent or the voice), the other stops too.
      if (!signal.aborted) controller.abort(error);
      outcome =
        error instanceof TurnTimeout
          ? "timeout"
          : error instanceof StageError
            ? `${error.stage}-error`
            : "error";
      if (!live()) return;
      if (this.#speaking) this.#deps.send({ type: "tts", state: "stop" });
      this.#speaking = false;
      this.#state = "idle";
      this.#face("failed", this.#failureLine(error));
    } finally {
      clearTimeout(timer);
      if (live()) {
        this.#controller = undefined;
        this.#asking = undefined;
        this.#endFace = undefined;
        this.#clearProgress();
      }
      this.#deps.log?.({
        event: "turn",
        session: this.#deps.sessionKey,
        outcome: live() ? outcome : "cancelled",
        ...timings,
        totalMs: now() - started,
        ...("text" in input ? { typed: true } : {}),
        ...(this.#deps.logTranscripts ? { heard, said: said.trim() } : {}),
      });
    }
  }

  // Speaks a stream of text sentence by sentence: synthesis of the next sentence overlaps playback of
  // the current one, so the first words play while the rest is still being written.
  async #speak(
    source: AsyncIterable<string>,
    signal: AbortSignal,
    live: () => boolean,
    timings: Record<string, number>,
    started: number,
    timeoutGuard: Promise<never>,
    language: string,
    clock: {
      started: () => void;
      touch: () => void;
      pause: () => void;
      resume: () => void;
    },
    aloud: boolean
  ): Promise<string> {
    const now = this.#deps.now ?? Date.now;
    const going = () => live() && !signal.aborted;
    // A progress line being read holds the reply's voice until it finishes (spec 017): one speech
    // stream at a time on the charm.
    const aborted = new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener("abort", () => resolve(), { once: true });
    });
    const waitForReading = async () => {
      while (this.#reading && going())
        await Promise.race([this.#reading.done, aborted]);
    };
    // Each sentence is spoken in its own language when it shows one, else in the one before it.
    let speaking = language;
    // The sentence playing and the next one synthesize; each plays from its first packet.
    const queue: Array<{
      text: string;
      language: string;
      packets?: PacketStream;
    }> = [];
    let playing = 0;
    const startUpTo = (end: number) => {
      for (let i = playing; i < Math.min(end, queue.length); i++) {
        const item = queue[i]!;
        item.packets ??= new PacketStream(
          packetsOf(this.#deps.voice, item.text, signal, item.language)
        );
      }
    };
    let wake: () => void = () => undefined;
    let sourceDone = false;
    let said = "";
    // A text reply for a charm that keeps a report (spec 003): the reply as written, kept for the
    // page; the paced sentences are only for older charms.
    const asPage = !aloud && (this.#deps.report?.() ?? false);
    let raw = "";
    let rawBytes = 0;
    const enqueue = (sentence: string) => {
      const text = cleanForSpeech(sentence);
      if (!text) return;
      said += `${text} `;
      speaking = guessLanguage(text) ?? speaking;
      const sentenceLanguage = speaking;
      timings.firstSentenceMs ??= now() - started;
      queue.push({ text, language: sentenceLanguage });
      if (aloud) startUpTo(playing + LOOKAHEAD);
      wake();
    };
    const produce = (async () => {
      // An early first clause only helps audio start sooner; as text it would flash up on its own.
      const splitter = new SentenceSplitter({ firstClause: aloud });
      await inStage("agent", async () => {
        for await (const chunk of source) {
          if (!going()) return;
          if (asPage && rawBytes < MAX_REPORT_BYTES) {
            raw += chunk;
            rawBytes += utf8Length(chunk);
          }
          timings.agentFirstMs ??= now() - started;
          clock.touch();
          for (const sentence of splitter.push(chunk)) enqueue(sentence);
        }
      });
      for (const sentence of splitter.flush()) enqueue(sentence);
    })().finally(() => {
      sourceDone = true;
      wake();
    });
    produce.catch(() => undefined);
    // The whole reply, as the agent wrote it, once the agent is done: no reading-time pacing and no
    // markdown cleaning for a charm that shows it as a page. The same tts messages carry the lines,
    // and the charm keeps them as one scrollable report (its report page).
    if (asPage) {
      await Promise.race([produce, timeoutGuard]);
      const text = raw.trim();
      if (going() && text) {
        this.#speaking = true;
        this.#state = "speaking";
        timings.firstTextMs ??= now() - started;
        this.#deps.send({ type: "tts", state: "start" });
        for (const line of reportLines(text))
          this.#deps.send({ type: "tts", state: "sentence_start", text: line });
      }
      return said.trim();
    }
    const play = async () => {
      for (;;) {
        if (!going()) return;
        await waitForReading();
        if (!going()) return;
        if (playing >= queue.length) {
          if (sourceDone) return;
          await new Promise<void>((resolve) => (wake = resolve));
          continue;
        }
        if (!aloud) {
          await this.#showForReading(
            queue[playing]!.text,
            signal,
            going,
            clock,
            timings,
            started
          );
          playing += 1;
          continue;
        }
        startUpTo(playing + LOOKAHEAD);
        const { text, packets } = queue[playing]!;
        if (!packets) throw new Error("A sentence wasn't started");
        await Promise.race([
          inStage("tts", () => packets.first()),
          timeoutGuard,
        ]);
        if (!going()) return;
        // A line tapped while the first packet was being made: it is read first.
        await waitForReading();
        if (!going()) return;
        if (!this.#speaking) {
          this.#speaking = true;
          this.#state = "speaking";
          this.#playedBy = 0;
          timings.firstAudioMs = now() - started;
          clock.started();
          this.#deps.send({ type: "tts", state: "start" });
        }
        this.#deps.send({ type: "tts", state: "sentence_start", text });
        await Promise.race([
          inStage("tts", () => this.#sendPaced(packets, going, clock.touch)),
          timeoutGuard,
        ]);
        playing += 1;
      }
    };
    await Promise.all([Promise.race([produce, timeoutGuard]), play()]);
    return said.trim();
  }

  // Speaks text directly: the dev command today, the agent's charm.say tool later.
  async say(text: string): Promise<void> {
    // Speaking over a turn would cancel the very answer that asked for it.
    if (this.busy)
      throw new Error(
        "The charm is in the middle of a turn: put this in your reply instead."
      );
    const generation = ++this.#generation;
    const live = () => this.#generation === generation;
    const controller = new AbortController();
    this.#controller = controller;
    // Speaking on its own, not answering: no agent turn is running.
    this.#runOrder = undefined;
    const startClock = () =>
      setTimeout(
        () => controller.abort(new TurnTimeout()),
        this.#deps.timeoutMs
      );
    let timer = startClock();
    // As in a turn: from the first audio on, the clock times silence.
    const restartClock = () => {
      clearTimeout(timer);
      timer = startClock();
    };
    let reading = false;
    const clock = {
      started: restartClock,
      touch: () => {
        if (!reading) restartClock();
      },
      pause: () => {
        reading = true;
        clearTimeout(timer);
      },
      resume: () => {
        reading = false;
        restartClock();
      },
    };
    const timeoutGuard = new Promise<never>((_, reject) =>
      controller.signal.addEventListener("abort", () => {
        if (controller.signal.reason instanceof TurnTimeout)
          reject(controller.signal.reason);
      })
    );
    timeoutGuard.catch(() => undefined);
    async function* once() {
      yield await Promise.resolve(text);
    }
    try {
      await this.#speak(
        once(),
        controller.signal,
        live,
        {},
        Date.now(),
        timeoutGuard,
        guessLanguage(text) ?? this.#deps.voice.language ?? "en",
        clock,
        this.#deps.speakAloud?.() ?? true
      );
      if (!live()) return;
      if (this.#speaking) this.#deps.send({ type: "tts", state: "stop" });
      this.#speaking = false;
      this.#state = "idle";
      this.#face("idle");
    } catch (error) {
      if (!controller.signal.aborted) controller.abort(error);
      if (!live()) return;
      if (this.#speaking) this.#deps.send({ type: "tts", state: "stop" });
      this.#speaking = false;
      this.#state = "idle";
      this.#face("failed", this.#failureLine(error));
    } finally {
      clearTimeout(timer);
    }
  }

  // A text-only reply (spec 003): the same speech messages with no audio, so the charm shows its
  // speech layout; each sentence stays for its reading time, and a press dismisses it (abort).
  async #showForReading(
    text: string,
    signal: AbortSignal,
    going: () => boolean,
    clock: {
      started: () => void;
      touch: () => void;
      pause: () => void;
      resume: () => void;
    },
    timings: Record<string, number>,
    started: number
  ): Promise<void> {
    if (!going()) return;
    if (!this.#speaking) {
      this.#speaking = true;
      this.#state = "speaking";
      timings.firstTextMs = (this.#deps.now ?? Date.now)() - started;
      clock.started();
      this.#deps.send({ type: "tts", state: "start" });
    }
    const sleep = this.#deps.sleep ?? sleepMs;
    const now = this.#deps.now ?? Date.now;
    const aborted = new Promise<"aborted">((resolve) =>
      signal.addEventListener("abort", () => resolve("aborted"), {
        once: true,
      })
    );
    this.#deps.send({ type: "tts", state: "sentence_start", text });
    clock.pause();
    // While a question is up the charm shows it, not this sentence (it keeps the sentence and puts
    // it back after): the reading time waits, and goes on with what it had left.
    let remaining = readingMs(text);
    while (going()) {
      if (this.#questionsEnd) {
        await Promise.race([this.#questionsEnd, aborted]);
        continue;
      }
      const from = now();
      let notify = () => {};
      const question = new Promise<"question">((resolve) => {
        notify = () => resolve("question");
      });
      this.#questionStarts.add(notify);
      const outcome = await Promise.race([
        sleep(remaining).then(() => "read" as const),
        aborted,
        question,
      ]);
      this.#questionStarts.delete(notify);
      if (outcome !== "question") break;
      remaining = Math.max(0, remaining - (now() - from));
    }
    clock.resume();
  }

  #failureLine(error: unknown): string {
    if (error instanceof TurnTimeout) return "That took too long.";
    // A model still downloading says how far it got ("Parakeet (listening) is still downloading (45%)").
    if (error instanceof StageError && error.cause instanceof VoiceNotReady)
      return error.cause.message;
    if (error instanceof StageError && error.stage === "stt")
      return "I couldn't hear that.";
    if (error instanceof StageError && error.stage === "tts")
      return "I couldn't speak that.";
    return `Can't reach ${AGENT_LABELS[this.#deps.agent.name] ?? "your agent"}`;
  }

  async #sendPaced(
    packets: AsyncIterable<Buffer>,
    live: () => boolean,
    onPacket: () => void
  ): Promise<void> {
    const sleep = this.#deps.sleep ?? sleepMs;
    const now = this.#deps.now ?? Date.now;
    // Paced on the clock, across the reply's sentences: adding up each packet's sleep let every late
    // timer eat into the lead (20 ms packets ran dry within seconds), and starting each sentence
    // afresh forgot what the player still had, so the lead grew by a sentence's burst each time.
    for await (const packet of packets) {
      if (!live()) return;
      this.#deps.sendAudio(packet);
      onPacket();
      this.#playedBy =
        Math.max(this.#playedBy, now()) + opusPacketSamples48k(packet) / 48;
      const wait = this.#playedBy - LEAD_MS - now();
      if (wait > 0) await sleep(wait);
    }
  }

  dispose(): void {
    this.#cancel();
    this.#state = "idle";
  }
}

export { TurnController };
export type { ShownFace, TurnDeps, TurnState };
