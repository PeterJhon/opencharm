# 019: Confirm what was heard

Status: In progress
Depends on: 003, 011

## Why

A voice turn goes straight from the transcript to the agent: a misheard word, or a hold that wasn't meant as a question, spends an agent turn on the wrong thing and the person only notices from the answer. The transcript is already on the charm (spec 003); it can be a question the person answers before the agent runs.

## Scope

- **charmd** (`packages/charmd`): after speaking-to-text on a voice turn, and before the agent is called, charmd asks the charm (the existing decision layout, spec 011) with the transcript as the question and the labels `SEND` / `REDO`. Hold the key = send the transcript to the agent; a press = redo: the turn ends without reaching the agent, and the next hold records again. No answer within the question's 30 s counts as redo. The turn's own clock waits while the question is up. Typed text never asks. The full transcript goes to the agent on send; the decision page shows it as far as the charm's ask limit allows (2,000 bytes to a charm that offers `features.long_ask`, else 200).
- **Config**: `confirmHeard` (default `true`) in charmd's config; the desktop app's managed charmd uses the default. `false` restores the old flow (the transcript goes straight to the agent). The turn log's outcome is `not-confirmed` when the person redoes.
- **Firmware**: no change; the question uses the decision layout and the orange ring that already exist.
- **Docs**: `OPENCHARM.md` (the controls: hold = send, press = redo), `packages/charmd/README.md` (the setting and the flow).

## Decisions

- Every voice turn asks, not only short or uncertain ones: speech-to-text has no confidence to threshold, and the maintainer asked to check each one (maintainer, 31 October 2026).
- A press means redo, not a second recording in the same gesture: the mic rule says the mic is on only while the key is down, so the next hold records again (maintainer's rule, spec 003).
- Typed text doesn't ask: it's exact and came from a keyboard (maintainer, 31 October 2026).
- Default on, with `confirmHeard: false` as the way out; the desktop Settings toggle is a follow-up (maintainer, 31 October 2026).
- The transcript alone is the question: the hint `HOLD · SEND    PRESS · REDO` says what the choice is, and the text stays scrollable (maintainer, 31 October 2026).

## Not in scope

- Correcting the transcript by typing on the charm (a board has no keyboard); a redo records again.
- Confidence scores or asking only when the speech-to-text is unsure.
- A desktop Settings switch for `confirmHeard`; it is the config file for now.
- Changing the question for the agent's own permission requests; they keep their own flow after the confirmation.

## Acceptance

- [x] A voice turn asks with the transcript and `SEND` / `REDO`; a redo never calls the agent, sends no reply and ends on the idle face; the log says `not-confirmed` (`turn.test.ts`).
- [x] A send lets the turn continue to the agent; typed text and `confirmHeard: false` never ask (`turn.test.ts`).
- [x] Over a real socket the charm receives the ask, a no leaves no tts, and a yes produces the spoken reply (`daemon.test.ts`).
- [ ] A voice turn on the board: hold to send, press to redo, and the next hold records again (manual).

## Next

- A Settings toggle for "Confirm what was heard" in the desktop app (and the CLI), so the config is discoverable.

## Open questions

- None yet.
