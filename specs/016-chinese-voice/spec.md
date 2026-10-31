# 016: Chinese voice

Status: In progress
Depends on: 003, 005

## Why

The charm's local voice only covers European languages: Parakeet TDT 0.6B v3 has no CJK tokens, and Supertonic covers `en/it/es/fr/de/pt`. A Chinese-speaking person can type to the agent, but cannot hold the key and talk, hear the reply, or read it on the charm. The agent (Claude Code) already answers in Chinese; the body should hear and speak it too.

## Scope

- **Local listening:** SenseVoice int8 (`zh/en/ja/ko/yue`, 2025-09-09) when the charm's language is `zh`; Parakeet otherwise. One model covers Mandarin and English, and reports the language it heard. Pinned by URL, size and SHA-256; downloaded on first use into `~/.opencharm/models` like the existing models.
- **Local speaking:** Kokoro 82M multilingual (int8, Apache-2.0) for Chinese sentences, Supertonic for the other languages. The choice is per sentence, from the sentence's script (CJK characters), so a reply that quotes English is still read with the English voice.
- **Language:** `zh` joins the languages charmd tells apart; Settings and the setup offer **中文**; charmd's config accepts `zh`.
- **Download and status:** the two new models appear in `opencharm voice`, `opencharm status` and Settings' status line, with the same progress and retry rules as the existing models.
- **The charm's screen:** the text fonts gain a Chinese fallback: Noto Sans SC (SIL OFL). Geist Mono keeps Latin and punctuation; Han characters fall through to the Chinese font, and the 35 px speech line uses the same 24 px glyphs (a little smaller).
  - **The board** carries the full GB18030 BMP font: 27,584 CJK characters (Extension A, Unified Ideographs, Compatibility Ideographs) plus CJK punctuation and fullwidth forms, as a 24 px binary LVGL font (`charm_cjk_24_full.bin`, 7.3 MB) read from flash on demand (`dynamic_glyph_load`); it is embedded in an 11 MB app partition. The source is the full Noto Sans SC Medium OTF (8.1 MB, OFL), and `npm run firmware:fonts` regenerates the binary.
  - **The emulator, host tests and desktop panel** keep the small C font (`charm_cjk_24.c`), Noto Sans SC subset to GB2312 level-1 (3,778 characters with punctuation, about 1 MB in firmware), because the binary font needs LVGL memory-mapped FS and the full size; they still show only the common characters.
- **Docs:** OPENCHARM.md, README, `packages/charmd/README.md`, `apps/desktop/README.md` and `firmware/README.md` say what Chinese support covers and what it costs (downloads, flash).

## Decisions

- `zh` is the switch for the local Chinese models; other languages keep today's models (maintainer chose local Chinese support, 31 October 2026). The language is already the charm's explicit "which language should this be" control, so no second model picker.
- SenseVoice over Paraformer: it hears Mandarin, English, Cantonese, Japanese and Korean, and detects which one, so mixed Mandarin/English speech works; Paraformer is Chinese-only (maintainer's direction: local, KISS).
- Kokoro 82M multilingual over the Chinese Piper voice: the Piper `zh_CN-huayan-medium` model card says its dataset licence is unknown, which this repository can't ship; Kokoro is Apache-2.0 (like the WSYue-ASR conversion behind SenseVoice), and its English voices mean a Chinese-mode charm can also read English sentences, though Supertonic stays the choice for non-Chinese sentences in this change.
- Per-sentence routing by script, not by the reply's declared language: an agent may mix Chinese and English in one answer, and each sentence should be intelligible.
- A C-array font, tried against LVGL's binary font loader: the loader and `lv_font_conv`'s byte layout disagreed (glyph bitmaps drawn garbled, even after repacking the headers), while the same font as a C array rendered correctly. The generated file is 6.7 MB of source — over the repository's 1 MB rule, so it is on the big-files list — but only about 1 MB in the firmware, and the 24 px font serves both text sizes.
- GB2312 level-1 for the small subset: the 3,755 most common simplified characters plus Chinese punctuation, generated from the encoding; it stays the emulator/host font (about 1 MB).
- **The board gets the full GB18030 BMP font** (maintainer chose this over another subset, 31 October 2026): 27,584 characters cover names, rarer simplified forms and most traditional codepoints; the binary is 7.3 MB and the app partition grows from 6 MB to 11 MB. Extensions B and beyond, emoji and colour fonts remain out (they do not fit the 16 MB flash as bitmaps). The binary font is loaded with `dynamic_glyph_load` so the 7.3 MB stays in flash, not RAM; the earlier binary-font attempt failed because the loader copied every glyph into the small LVGL pool.
- The board's font is read from the app image's flash through LVGL's MEMFS; the emulator and host tests keep the C array and do not need MEMFS.

## Not in scope

- Chinese labels for the app or the charm's UI (the app chrome and Settings stay English).
- Cantonese-specific voices, Traditional Chinese fonts, Japanese/Korean fonts or voices.
- Cloud Chinese voices; Microsoft's read-aloud service still returns 403 here.
- Pinyin input on the charm: the desktop's typing field and the agent's own chat remain the text path.

## Acceptance

- [x] The two models are pinned in `packages/charmd/src/voice/models.ts` by URL, byte size and SHA-256; `packages/charmd/src/voice/models.test.ts` checks the pins.
- [x] `zh` is detected from Chinese text and transcripts (`language.ts` tests), accepted by charmd's config, and offered by Settings and the setup (中文).
- [x] A Chinese sentence synthesized by the local speaker is heard back as Chinese by SenseVoice (`sherpa.test.ts`, with the models installed); `dev say` on the desktop and board speaks Chinese through charmd (manual check, 31 October 2026).
- [ ] With language 中文, holding the key and speaking Mandarin transcribes Chinese (manual check with a microphone; the model-level round trip passes).
- [x] Local mode still works in English when the language is not 中文 (Parakeet + Supertonic; the existing round-trip test passes).
- [x] `opencharm voice` lists all four models, with installed/downloading/failed states; `opencharm status` carries the download and failure messages.
- [x] A firmware UI snapshot shows a Chinese speech line on the square and round screens; `npm run firmware:test` passes.
- [x] The board's full binary font loads with dynamic glyph loading and draws 㐀 (U+3400, outside the small C font) in a host render (`ui_test.cpp`, `face-rare-cjk-480.png`); the board flashed the 11 MB app, booted with the new partition table, and logged `full CJK font: 7457 KB`.
- [x] `npm run device:build` reports the app partition fits: about 10.3 MB of 11 MB (7 % free) (the full font adds 7.3 MB).
- [ ] `npm run check` is green: the changed workspaces pass, but the charmd suite still fails on this Windows checkout for unrelated drive-letter and process-spawn reasons.
- [x] The docs named in Scope are updated.

## Next

- A separate listening-model choice, once more than two local languages exist.
- CJK Extensions B+ or emoji, which would need a different storage/rendering plan; the board's 16 MB flash cannot hold them as bitmaps.
- A 35 px Chinese font, if the 24 px glyphs in the speech line look too small on the board; it would add about 2 MB of flash and 13 MB of generated source.

## Open questions

- Whether a Chinese reply that mixes an English word ("Peter") should split the sentence for the voice; Kokoro's Chinese lexicon skips those words today.
