# 017: Progress on the charm

Status: In progress
Depends on: 003, 010

## Why

A long agent turn is opaque from the charm: the face says "thinking" while Claude Code plans, reads and runs for minutes. The person holding the charm wants to see what the agent is doing, hear a line read out, and scroll back through the steps. The desktop is where the work is; the charm should still show it.

## Scope

- **Protocol** (`packages/protocol`): a server → charm `charm` `progress` message carries the current list: `entries: [{ text, status }]`, at most 12 entries, each text 1–200 UTF-8 bytes, status `pending` / `in_progress` / `completed` / `failed`. A charm → charmd `charm` `speak` message carries one line to read (1–200 bytes). charmd's `hello` offers `features.speak`, and a charm sends `speak` only when it is offered (an older charmd closes the connection on an unknown message). Shared fixtures cover both directions.
- **charmd** (`packages/charmd`): the ACP adapter reports plan entries and tool calls (`tool_call`, `tool_call_update`) to the turn. The turn keeps one list per turn — the latest plan followed by tool calls, deduplicated by tool-call id, capped at 12 — sends the whole list on change, and keeps showing the active step as a line on the working face. A `speak` message makes the turn read that line with the chosen voice while the agent keeps working; a key press (`abort`) stops the reading, not the agent turn. A reply that becomes ready waits for the reading to finish instead of talking over it. `read` is refused while the reply itself is speaking.
- **Firmware core** (`firmware/core`): while the agent works, touching and holding the face for a second opens a read-only progress page instead of the status screen. The page is a vertical scroll list, one line per entry at 24 px (the CJK fallback applies), with the entry in progress at full opacity, pending and finished ones dimmer (a failed one a little brighter than finished, so it is noticed). When the person spoke, the page starts with `You · <transcript>` (spec 003), then the list. There is no orange. With replies spoken, a tap on a line sends `speak`; with replies as text there is no voice, so a tap stays visual. A key press, a tap on the background or the agent finishing closes the page and brings the face back. The page yields to speech, a question or "it needs you". The status screen keeps its gesture whenever there is no progress to show. The emulator and the board use the same core and view.
- **Docs**: `OPENCHARM.md` (the hold gesture and progress), `packages/protocol/README.md` (messages and limits), `packages/charmd/README.md` and `firmware/README.md` where they describe the screen.

## Decisions

- Content is the agent's plan plus its tool calls, not the agent's written answer or raw logs (maintainer, 31 October 2026).
- A line is read only when tapped, and only while replies are spoken; there is no automatic narration. With replies as text, tapping a line does nothing audible (maintainer, 31 October 2026; updated 31 October 2026).
- The list opens on the existing touch-and-hold gesture while the agent is working, so no new gesture is required and the status screen keeps its place when idle (proposed while building; the maintainer asked for "划着看", 31 October 2026).
- Reading a line is a voice action, not a new agent turn: the agent keeps working and the line is answered by the same speaker. A press stops the reading only (spec 003's press-to-stop, narrowed while a line is being read).
- Progress is not stored on the charm or by charmd: it lives for the turn and disappears when the agent stops working. Nothing leaves the charm for this feature.

## Not in scope

- Showing progress in the desktop charm's notch panel (spec 013); it may follow once it has a pointer or keyboard gesture.
- Progress from agents or HTTP servers that don't speak ACP; the face keeps its current line.
- Keeping progress across turns, history, or an agent tool to read it.
- Rich formatting (diffs, file names as links, per-tool icons).

## Acceptance

- [x] Both messages parse on both sides, and the shared fixtures cover them (`packages/protocol`, `firmware/core` protocol tests).
- [x] A turn sends plan entries and tool calls in order, updates a tool entry rather than duplicating it, drops old completed tools past 12, and sends nothing when nothing changed (`turn.test.ts`).
- [x] Tapping a line during a turn makes the speaker say it, keeps the agent turn running, and a press stops the reading without cancelling the turn; a reply waits for the reading (`turn.test.ts`, `session.test.ts`, emulator e2e). With Speak replies off, no synthesis or audio happens for the tap.
- [x] What the person said appears as `You · <transcript>` on the face and above the progress list (`app_test.cpp`, UI snapshot `progress-heard-480`).
- [x] Holding the face while progress exists opens the progress page; a tap on a line sends `speak` only when charmd offered it and replies are spoken (with text replies it stays silent); a key press, a background tap, speech, a question and the end of work close it (`app_test.cpp`, `turn.test.ts`).
- [x] The page draws on square and round screens and scrolls, and keeps Chinese inside the circle (UI snapshots `progress-480`, `progress-466`).
- [x] The emulator, driven by the fake ACP agent, shows progress and sends the tapped line to be read (CLI e2e). Manual check on the board still to do once it is connected.
- [ ] `npm run check` is green. Formatting, lint and typecheck are green; `npm test` still has the Windows environment failures listed in the plan.

## Open questions

- None yet.
