type ProgressStatus = "pending" | "in_progress" | "completed" | "failed";
type ProgressLine = { text: string; status: ProgressStatus };
// What the agent is working through (spec 017): its plan as a whole (each change replaces the
// previous one), or one tool call. A tool update may carry only a status; the turn keeps the title.
type ProgressUpdate =
  | { kind: "plan"; entries: ProgressLine[] }
  | {
      kind: "tool";
      id: string;
      text?: string;
      status?: ProgressStatus;
    };

type ReplyInput = {
  sessionKey: string;
  text: string;
  signal: AbortSignal;
  // Ask the person holding the charm, e.g. ask("write notes/plants.md"); resolves false on no,
  // silence or a cancelled turn. Absent when nobody can answer.
  ask?: (action: string) => Promise<boolean>;
  // What the agent is doing now, for the charm's working face and its progress page (spec 017).
  // Absent for agents without it.
  onProgress?: (update: ProgressUpdate) => void;
};

// Every agent is the same shape to charmd: text in, a stream of text out. Memory, persona and tools
// stay inside the agent; the session key is how it knows which charm is talking.
type AgentAdapter = {
  name: string;
  reply: (input: ReplyInput) => AsyncIterable<string>;
  // Optional: start up while the user is still speaking, so the first answer comes sooner.
  warm?: (sessionKey: string) => void;
  // Optional: forget this charm's conversation, so its next turn starts a fresh one in the agent.
  // Never called during a turn of that charm (agent/conversations.ts waits for it to end).
  reset?: (sessionKey: string) => void;
  // Optional: release long-lived resources (processes, sockets) when charmd stops.
  dispose?: () => void;
};

export type {
  AgentAdapter,
  ProgressLine,
  ProgressStatus,
  ProgressUpdate,
  ReplyInput,
};
