import { utf8Length } from "@opencharm-labs/protocol/text";

// The charm's report page (spec 003, spec 018): text is sent one line per tts sentence_start
// message. The charm takes 2,000 bytes in one message and keeps 32 KB; a longer line is split on a
// character boundary.
const REPORT_LINE_BYTES = 2000;
const MAX_REPORT_BYTES = 32 * 1024;

// Line breaks kept as written (blank lines too), a line longer than the charm's limit split into
// more lines.
function reportLines(text: string): string[] {
  const lines: string[] = [];
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    let out = "";
    let bytes = 0;
    for (const char of line) {
      const size = utf8Length(char);
      if (bytes + size > REPORT_LINE_BYTES) {
        lines.push(out);
        out = "";
        bytes = 0;
      }
      out += char;
      bytes += size;
    }
    lines.push(out);
  }
  return lines;
}

export { MAX_REPORT_BYTES, REPORT_LINE_BYTES, reportLines };
