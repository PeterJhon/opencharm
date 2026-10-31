// Converts Geist Mono (SIL OFL) into LVGL bitmap fonts for charm-core. Run after changing faces or
// sizes: npm run firmware:fonts. Sizes are for the 480 px screen class (see firmware/README.md).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

type FacesJson = { faces: Array<{ L: string; R: string; M?: string }> };

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..", "..");
const OUT = join(HERE, "..", "src", "ui", "fonts");
const EXTRA_BOLD = join(HERE, "GeistMono-ExtraBold.ttf");
const MEDIUM = join(HERE, "GeistMono-Medium.ttf");
const SYMBOLS = join(HERE, "NotoSansSymbols2-Regular.ttf");
const HEART = 0x2665;

function faceGlyphs(): string {
  const { faces } = JSON.parse(
    readFileSync(join(ROOT, "packages", "design", "faces.json"), "utf8")
  ) as FacesJson;
  const chars = new Set<string>(["−", "z", "o", "O"]);
  for (const face of faces)
    for (const part of [face.L, face.R, face.M ?? ""])
      for (const ch of part.replace(/︎/g, "")) chars.add(ch);
  chars.delete(String.fromCodePoint(HEART));
  return [...chars].join("");
}

function convert(
  name: string,
  size: number,
  fonts: Array<{ file: string; symbols?: string; range?: string }>
): void {
  const args = [
    "--no-compress",
    "--no-prefilter",
    "--bpp",
    "4",
    "--size",
    String(size),
    "--format",
    "lvgl",
    "--lv-include",
    "lvgl.h",
  ];
  // Paths relative to the repo, with forward slashes on every OS: they're written into the generated
  // file's header, and a Windows build shouldn't change it.
  const repoPath = (path: string) => relative(ROOT, path).replaceAll("\\", "/");
  for (const font of fonts) {
    args.push("--font", repoPath(font.file));
    if (font.symbols) args.push("--symbols", font.symbols);
    if (font.range) args.push("--range", font.range);
  }
  args.push("-o", repoPath(join(OUT, `${name}.c`)));
  // The script itself, not npm's shim: Node can't spawn the extensionless Unix link on Windows, and
  // the shim would put face glyphs like ">" and "^" through cmd.exe.
  execFileSync(
    process.execPath,
    [join(ROOT, "node_modules", "lv_font_conv", "lv_font_conv.js"), ...args],
    { cwd: ROOT, stdio: "inherit" }
  );
  console.log(`wrote firmware/core/src/ui/fonts/${name}.c`);
}

const eyes = faceGlyphs();
const withHeart = (size: number) => [
  { file: EXTRA_BOLD, symbols: eyes },
  { file: SYMBOLS, range: `0x${HEART.toString(16)}` },
];
convert("charm_eyes_163", 163, withHeart(163));
convert("charm_eyes_95", 95, withHeart(95));
convert("charm_eyes_57", 57, withHeart(57));
convert("charm_digits_80", 80, [{ file: EXTRA_BOLD, symbols: "0123456789 %" }]); // pairing code, battery percent
// Latin-1 plus the punctuation agents like to use, for spoken lines and hints.
const TEXT_RANGE =
  "0x20-0x7E,0xA0-0xFF,0x2013-0x2014,0x2018-0x201D,0x2022,0x2026,0x2212";
convert("charm_text_35", 35, [{ file: MEDIUM, range: TEXT_RANGE }]);
convert("charm_text_24", 24, [{ file: MEDIUM, range: TEXT_RANGE }]);

// Chinese is a fallback font of its own: 3,778 characters at 24 px (the 35 px text falls back to the
// same glyphs, drawn a little smaller). Geist Mono keeps Latin and punctuation (src/ui/lvgl_view.cpp).
const CHINESE_FONT = join(HERE, "NotoSansSC-Medium-subset.ttf");
const CHINESE = readFileSync(join(HERE, "common-chinese.txt"), "utf8").trim();
convert("charm_cjk_24", 24, [{ file: CHINESE_FONT, symbols: CHINESE }]);

// The board's full font (spec 016): GB18030's BMP CJK (Ext A, unified, compatibility) and CJK
// punctuation, as a binary LVGL font read from flash. It is too large for the emulator/host, which
// keep the 3,778-character C font above; the board's app partition is 11 MB.
const FULL = join(HERE, "NotoSansSC-Medium.otf");
const FULL_RANGES = [
  "0x3000-0x303F", // CJK punctuation
  "0x3400-0x4DBF", // CJK Extension A
  "0x4E00-0x9FFF", // CJK Unified Ideographs
  "0xF900-0xFAFF", // CJK Compatibility Ideographs
  "0xFF00-0xFFEF", // Halfwidth and Fullwidth Forms
];
function convertFullBin(): void {
  const out = join(OUT, "charm_cjk_24_full.bin");
  const args = [
    "--no-compress",
    "--no-prefilter",
    "--bpp",
    "4",
    "--size",
    "24",
    "--format",
    "bin",
    "--font",
    relative(ROOT, FULL).replaceAll("\\", "/"),
  ];
  for (const range of FULL_RANGES) args.push("--range", range);
  args.push("-o", relative(ROOT, out).replaceAll("\\", "/"));
  execFileSync(
    process.execPath,
    [join(ROOT, "node_modules", "lv_font_conv", "lv_font_conv.js"), ...args],
    { cwd: ROOT, stdio: "inherit" }
  );
  console.log("wrote firmware/core/src/ui/fonts/charm_cjk_24_full.bin");
}
convertFullBin();
