# 017 — plan

## Protocol

- [x] `packages/protocol/src/messages.ts`: `progressEntry`, `progress` (server), `speak` (client), `features.speak` in the server hello; export the entry type if the turn needs it.
- [x] `packages/protocol/fixtures/valid/server-charm-progress.json`, `client-charm-speak.json`; one invalid progress fixture (bad status).
- [x] `packages/protocol/README.md`: both rows and limits.
- [x] `firmware/core/include/charm/protocol.h`, `src/protocol.cpp`: parse `progress`, parse `features.speak`, build `client_speak`; protocol tests; fixture checks.
- [x] `tools/checks` if the fixture count or message lists need it (check first).

## charmd

- [x] `agent/types.ts`: progress update types; `onProgress` carries plan/tool updates rather than a bare line.
- [x] `agent/acp.ts`: emit the plan entries and tool calls with ids and statuses.
- [x] `turn/turn.ts`: per-turn progress list, dedupe/trim, send `progress` on change, face line, `read()` for `speak`, reading gate for the reply, abort stops reading first.
- [x] `device/session.ts`: handle `charm:speak`; hello `features.speak`.
- [x] Tests: `turn.test.ts`, `session.test.ts`, `acp.test.ts` (fake agent plan/tool), plus the emulator e2e for the whole path.
- [x] `packages/charmd/README.md`.

## Firmware

- [x] `include/charm/view.h`: `ProgressEntry`, `show_progress`, `on_progress_tap`, `progress_text` / row area for tests.
- [x] `include/charm/app.h`, `src/app.cpp`: store progress, open on hold while working, tap sends `speak`, close on key/tap/speech/ask/needs_you/end, clear when work ends.
- [x] `src/ui/lvgl_view.{h,cpp}`: scroll list, row tap, opacity by status, round width, title, hide battery, face hidden, ink colour, yield to speech.
- [x] `device/main/main.cpp`, `sim/src/sim_main.cpp`: wire `on_progress_tap`.
- [x] Tests: `app_test.cpp` behaviour; `ui_test.cpp` snapshots and a row tap; existing fakes updated.
- [x] `firmware/README.md` if it describes the hold gesture.

## Verification

- [x] Fake ACP agent: a `progress` prompt emits a plan + tool call and waits; emulator e2e opens the page, taps a row and hears it.
- [x] `npm run firmware:test` (host, 96 + 49 cases), `npm run firmware:sim`, `npm run test:e2e -w packages/cli` (13 e2e cases).
- [ ] `npm run check`: `format:check`, lint and typecheck are green; `npm test` has the known Windows environment failures (`.claude/skills` not a symlink, admin-socket/config path tests, one ACP "missing command" test). Recorded in the PR.
- [ ] Board: rebuild and flash only the app partition; hold, scroll, tap, read; manual note in the PR. The build is green (`opencharm.bin` 0x2f70a0 bytes, 51 % of the 6 MB app partition free); flashing waits for the board's USB port (none enumerated on 31 October 2026).
