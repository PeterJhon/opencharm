// End to end: a long agent turn shows its plan and tool calls on the charm (spec 017). Holding the
// face opens a scrollable list; tapping a line asks charmd to read it, without ending the turn.
// Needs `npm run firmware:sim` and Google Chrome.
import type { Page } from "playwright";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  type Emulator,
  SHOTS,
  pairAndUnlock,
  startEmulator,
  waitFor,
} from "./helpers";

let emulator: Emulator;

async function screenBox(page: Page) {
  const box = await page.locator("#screen").boundingBox();
  if (!box) throw new Error("no screen on the page");
  return box;
}

beforeAll(async () => {
  emulator = await startEmulator("progress wait");
  await pairAndUnlock(emulator);
}, 60_000);

afterAll(async () => {
  await emulator?.close();
});

describe("progress on the emulated charm", () => {
  it("shows the plan and tool calls, scrolls, and reads a tapped line", async () => {
    const { page } = emulator;

    // A spoken turn: the fake agent sends a plan and a tool call, then keeps working. The fake voice
    // hears "progress wait" whatever arrives.
    await page.keyboard.down("Space");
    await page.waitForTimeout(1200);
    await page.keyboard.up("Space");
    const shown = await waitFor(
      page,
      (t) =>
        t.messages.some(
          (m) => m.op === "progress" && (m.entries?.length ?? 0) >= 3
        ),
      "the agent's progress",
      15_000
    );
    const entries = shown.messages
      .filter((m) => m.op === "progress")
      .at(-1)?.entries;
    expect(entries).toEqual([
      { text: "Read the spec", status: "completed" },
      { text: "Run npm test", status: "in_progress" },
      { text: "run npm test", status: "completed" },
    ]);

    // Hold the face for a second: the same gesture as the status screen.
    const box = await screenBox(page);
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.waitForTimeout(1300);
    await page.mouse.up();
    await waitFor(page, (t) => t.progressOpen, "the progress page");
    await page.screenshot({ path: join(SHOTS, "6-progress.png") });

    // Tap the first line, at the top of the list (the view scrolls the active line into sight).
    const scale = box.width / 480;
    await page.mouse.move(box.x + 240 * scale, box.y + 150 * scale);
    await page.mouse.down();
    await page.waitForTimeout(150);
    await page.mouse.up();
    await waitFor(
      page,
      (t) =>
        t.messages.some(
          (m) =>
            m.type === "tts" &&
            m.state === "sentence_start" &&
            m.text === "Read the spec"
        ),
      "the tapped line read aloud",
      15_000
    );
    await waitFor(page, (t) => !t.progressOpen, "speech taking the screen");
    await page.screenshot({ path: join(SHOTS, "6-progress-read.png") });
  }, 60_000);
});
