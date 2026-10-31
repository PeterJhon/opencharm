# 011: Ask on the charm

Status: In progress
Depends on: 005, 006, 010

## Why

Agents ask before doing something outside their rules (ACP `session/request_permission`). Today charmd refuses every request because nobody can answer. The charm's decision layout (SPEC section 5: orange means "it needs you"; hold = yes, press = no) is made for exactly this.

## Scope

- **Protocol** (TypeScript and C++, shared fixtures):
  - charmd → charm `{"type":"charm","op":"ask","id","text","yes"?,"no"?}`: a question (≤ 2000 bytes), optional labels (≤ 12 characters, default ALLOW / NO). A charm says `features.long_ask` in its hello; charmd keeps the question to 200 bytes for a charm that doesn't (a newer charmd with an older charm).
  - charmd → charm `{"type":"charm","op":"ask_end","id"}`: the question is gone (timed out, turn cancelled).
  - charm → charmd `{"type":"charm","op":"answer","id","yes":true|false}`.
- **Charm** (firmware core, so device and emulator alike):
  - Shows the decision layout: the question in the speech layout, the orange ring, and a hint line `HOLD · ALLOW    PRESS · NO`. The question wraps and is taller than its three-line window: dragging it scrolls through the whole task, and the hint stays put. A thin scrollbar shows there is more. Hold and press answer as before; no new required gesture.
  - Holding the key for 200 ms answers yes at once, without opening the microphone. A short press answers no.
  - The screen stays awake while asking. Locking or a lost connection drops the question.
  - Speech already playing keeps playing.
- **charmd**:
  - The session asks only an unlocked charm, one question at a time, and treats a 30 s silence as no (`ask_end` is sent).
  - A cancelled turn, a lock or a closed connection also count as no.
  - The turn hands `ask` to the agent. The question reads "Claude Code wants to write notes/x.md"; a long tool title is kept (paths shortened, no arbitrary 120-character cut) and fitted to the charm's limit.
  - The ACP adapter turns a permission request into a question: yes → `allow_once`, no → `reject_once`. A request outside a turn is still refused.
- `opencharm dev ask <charm> "<question>"` pushes a question by hand and prints the answer.
- Emulator rebuilt; an end-to-end test answers yes with a hold and no with a press.

## Not in scope

"Always allow" answers (every request is once), questions the agent asks of its own accord (MCP, spec 012), speaking the question aloud.

## Acceptance

- [x] Protocol fixtures parse in TypeScript and C++; invalid ones (long text, bad id, missing yes) are rejected.
- [x] Firmware tests: hold = yes without mic, press = no, `ask_end` clears, lock clears, no dimming while asking.
- [x] charmd tests: answer routing, timeout → no + `ask_end`, cancel → no, locked charm → no, ACP mapping.
- [x] Emulator end to end: decision shown (screenshot), hold → the fake agent's "Done.", press → "Not allowed."
- [x] Real Claude Code: a write outside `charm/` is asked on a charm; yes writes the file, no doesn't.
- [x] A long question (the full tool title) wraps, scrolls to its end on square and round screens, and dragging it does not answer (UI snapshots `decision-long-480`, `decision-long-466-round`; `ui_test.cpp`).
- [x] charmd sends the full title; a charm without `features.long_ask` still gets at most 200 bytes (`session.test.ts`, `acp.test.ts`).
- [x] `npm run check`, firmware tests and format, end to end green; docs in sync.

## Notes (31 October 2026)

- A long approval was cut after three lines at 35 px, so the person could not read what they were approving. The question now scrolls (the same decision layout, ring and hint) and charmd sends the whole tool title; the protocol limit rises from 200 to 2000 bytes for a charm that advertises `features.long_ask` in its hello. The 200-byte limit stays for older charms, so a newer charmd never makes a question vanish on them.

## Notes (1 October 2026)

- Protocol: 5 valid and 4 invalid fixtures, both languages. Firmware: 7 state-machine tests and decision snapshots (square and round, long questions end in "…" after three lines; the round hint goes on two lines). charmd: session, turn, ACP and admin tests. Emulator end to end: hold → "Done.", press → "Not allowed." (screenshot `firmware/sim/build/e2e/5-ask.png`).
- Real Claude Code in a starter clone: "Claude Code wants to write ../hello-yes.txt." → yes → the file was written; no → it wasn't. The starter's own persona (work inside `charm/` only) makes the agent decline such requests by itself; the question appears when an agent does ask.
- Found on the way: the user's claude.ai connectors (Gmail, Drive…) reached the voice agent; the `claude` preset now turns them off (`ENABLE_CLAUDEAI_MCP_SERVERS=0`), verified.
- `opencharm dev ask <charm> <question>` asks by hand; `scripts/smoke-turn.ts` answers with `SMOKE_ANSWER=yes|no`.
- A fresh review found and fixed:
  - a face tap hid the question
  - question limits were counted in characters by charmd but in bytes by the charm, so an accented question could vanish; the protocol now counts bytes on both sides and charmd fits text with "…"
  - a question ending mid-press could start a talk
  - a question during a talk turned half a sentence into a turn
  - the wait for an answer counted against the 60 s turn
  - ACP got "rejected" instead of "cancelled" after a cancel
  - a queued question waited after its turn was cancelled
- Follow-up: the local voice round-trip test (real `say` + whisper) failed once under full-suite load and passed on reruns.
