# 018: Computer updates on the charm

Status: In progress
Depends on: 003, 017

## Why

The person works with Claude Code on the computer; the charm is a second screen on the desk. Until now the charm only showed the agent charmd starts for it: an answer being written in another terminal was invisible. The person wants the computer's work to appear on the charm — what Claude is doing, when it needs them, and the answer it just gave — without switching the charm's agent or copying text.

## Scope

- **charmd** (`packages/charmd`): a new admin action `show { charm?, text }` displays text from the computer on the charm as its **report page**, the same page a text reply uses (spec 003). The daemon sends the text as the existing `tts start` / `sentence_start` / `tts stop` messages, one line per message (a line over 2,000 bytes is split on a character boundary), and nothing is spoken. It is refused while the charm is locked, in a turn, or its hello didn't offer `features.report` (an older firmware would not keep the report). Text is capped at 12,000 UTF-8 bytes so the admin socket's 16 KB request limit holds. No protocol change and no firmware change: the charm already has the report page and the hello feature.
- **CLI** (`packages/cli`): `opencharm show [--charm <name>] [--stdin] <text>` sends one update; without `--charm` it goes to the newest unlocked charm. `opencharm hook` reads a Claude Code hook event on stdin and mirrors it: `Stop` shows the last assistant answer from the transcript as a report, `Notification` lights the orange "it needs you" face with the notification's message, and `PreToolUse` shows a `working` face with the tool and its target (a file or command). The hook never fails the agent's turn, prints nothing on stdout, and ignores a charm that is off, locked or busy. `--config` picks the charmd config (needed when charmd runs with one), `--charm` pins the charm.
- **Setup**: `docs/computer-updates.md` documents `opencharm show`, the three Claude Code hooks (user settings), and the one-line limits (200 bytes on a face, 12,000 bytes for a report, 32 KB kept by the charm).
- **Docs**: `OPENCHARM.md` (a computer's updates on the charm), `packages/charmd/README.md` (the admin action), `packages/cli` help.

## Decisions

- The computer's text is shown as the same scrollable report page as a text reply, not as a face line or speech: the person asked for all the information, and a report scrolls (maintainer, 31 October 2026).
- Only text from the computer is mirrored; OpenCharm can't read another terminal's session, so Claude Code hooks are the bridge (maintainer, 31 October 2026).
- A notification is the orange needs-you face, so the charm stays lit until the person presses the key; tool calls are a working face with a short line; the final answer is the report (maintainer, 31 October 2026).
- Updates never start an agent turn and never speak; the charm's own agent keeps its screen while it works, and an update is refused during a turn (maintainer, 31 October 2026).
- The hook trusts the transcript's last assistant text; no model call, no summarising, so what the charm shows is exactly what Claude said (maintainer, 31 October 2026).

## Not in scope

- Attaching to, or reading, another terminal's Claude Code session directly; the hooks are the only bridge.
- A desktop-app setting that installs the Claude Code hooks; the guide shows the settings JSON.
- Mirroring a whole screen, microphone audio or arbitrary logs continuously.
- Formatting markdown on the charm; the report shows the agent's text as written (spec 003).
- Showing updates while the charm is locked or in a turn; they are refused, not queued.

## Acceptance

- [x] `opencharm show` from the computer puts the text on the unlocked, idle charm as one report: tts messages with the text's lines, no audio, no turn (`session.test.ts`, `daemon.test.ts`).
- [x] The update is refused for a locked charm, a charm in a turn, a firmware without `features.report`, and text over 12,000 bytes (`session.test.ts`, `daemon.test.ts`).
- [x] Claude Code's `Stop`, `Notification` and `PreToolUse` events map to a report, the orange face and the working face; other events, an unreadable transcript, bad JSON and an unreachable charmd are ignored without failing the hook (`hook.test.ts`).
- [x] The CLI parses `--charm`, `--stdin` and the text, and refuses text over the budget before sending (`admin.test.ts`).
- [x] A push to the board, and the `hook` command with a `PreToolUse` event and a `Stop` event, reached the board on the maintainer's Windows machine (manual, 31 October 2026: the CLI printed `Shown on the charm`; the working face and a report were sent). Installing the hooks in the person's Claude Code settings is left to them (see docs/computer-updates.md).

## Next

- A desktop-app switch that adds the Claude Code hooks to the user's settings, so the setup is one click.

## Open questions

- None yet.
