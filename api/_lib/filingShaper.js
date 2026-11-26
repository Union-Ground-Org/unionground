import { readFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import bidiFactory from "bidi-js";
import { readFilingFont } from "../../src/lib/filingFont.js";

// Shaped text for the official filing copy (#8725): Arabic, Hebrew,
// Devanagari, Chinese, Japanese and Korean names and answers drawn readably,
// every embedded font subset to the glyphs the copy draws. HarfBuzz
// (harfbuzzjs, WASM) shapes and subsets; bidi-js orders right-to-left text.
// Fonts: Noto Sans, Noto Sans Arabic, Hebrew and Devanagari (SIL OFL 1.1,
// fonts/OFL.txt), and Noto Sans CJK SC (SIL OFL 1.1, fonts/OFL-NotoSansCJK.txt),
// all read from the bundle, never fetched at run time. The CJK font is 16 MB:
// the Vercel build fetches it, pinned by sha256
// (scripts/fetch-filing-cjk-font.mjs), and it is read only when a copy first
// needs it. Without it, Chinese, Japanese and Korean stay [U+XXXX] codes with
// the note. A character no font has is written as its code.
// Server only: the website's demo preview keeps the unshaped renderer.

// Font order decides which font draws a character that several fonts have.
const FONTS = [
  ["latin", "NotoSans-Regular.ttf"],
  ["arabic", "NotoSansArabic-Regular.ttf"],
  ["hebrew", "NotoSansHebrew-Regular.ttf"],
  ["devanagari", "NotoSansDevanagari-Regular.ttf"],
];
// Noto Sans CJK SC Regular from the notofonts release Sans2.004. Its CFF
// outlines are CID-keyed (Adobe-Identity-0) with every CID equal to its glyph
// id, so the copy draws a glyph by that number (checked when it was pinned).
const CJK_FONT = new URL("./fonts/NotoSansCJKsc-Regular.otf", import.meta.url);
const HB_MEMORY_MODE_WRITABLE = 2;
const HB_SUBSET_FLAGS_NO_HINTING = 0x1;
const HB_SUBSET_FLAGS_RETAIN_GIDS = 0x2;
const HB_SUBSET_SETS_DROP_TABLE_TAG = 3;
const HB_SUBSET_SETS_NAME_ID = 4;
// Layout tables are for shaping, done before the PDF is written; dropping
// them also stops the subsetter keeping glyphs the copy never draws.
const DROPPED_TABLES = ["GSUB", "GPOS", "GDEF", "BASE", "JSTF", "MATH"];
const LETTER = /\p{L}/u;
// The scripts only the shaper's other fonts draw. Text without them (U+2212
// and other symbols one of those fonts happens to have included) is drawn as
// without the shaper.
const CJK_SCRIPTS = "\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}\\p{Script=Bopomofo}";
const SHAPED_SCRIPT = new RegExp(`[\\p{Script=Arabic}\\p{Script=Hebrew}\\p{Script=Devanagari}${CJK_SCRIPTS}]`, "u");
// Characters that make the shaper read the CJK font, and the only ones it
// draws from it outside a CJK run: the CJK scripts and every CJK block, by
// block and not by script, since many characters CJK writers type are
// Script=Common (the long-vowel mark U+30FC, the iteration marks, CJK
// punctuation): Hangul Jamo; CJK radicals, Kangxi radicals and ideographic
// description; CJK symbols and punctuation, Hiragana, Katakana, Bopomofo,
// Hangul compatibility jamo, Kanbun, CJK strokes, Katakana phonetic
// extensions, enclosed CJK letters and CJK compatibility (U+3000-33FF);
// the ideograph blocks; Hangul Jamo extensions and syllables; CJK
// compatibility ideographs; the angle brackets U+2329 and U+232A (the same
// characters as U+3008 and U+3009); vertical forms, CJK compatibility forms
// and small form variants; halfwidth and fullwidth forms; the kana
// supplements; the enclosed ideographic supplement; and the supplementary
// ideograph planes. Other symbols the CJK font also has (circled digits,
// box drawing, arrows) are drawn from it only inside a CJK run.
const CJK_CHAR = new RegExp(`[${CJK_SCRIPTS}\\u1100-\\u11FF\\u2E80-\\u2FFF\\u3000-\\u33FF\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uA960-\\uA97F\\uAC00-\\uD7FF\\uF900-\\uFAFF\\u2329\\u232A\\uFE10-\\uFE1F\\uFE30-\\uFE6F\\uFF00-\\uFFEF\\u{1AFF0}-\\u{1B16F}\\u{1F200}-\\u{1F2FF}\\u{20000}-\\u{3FFFF}]`, "u");
// A line with kana is set in Japanese glyph forms, one with Hangul in Korean
// ones; other Chinese characters take the font's default (Simplified Chinese).
const cjkLanguage = (text) => {
  if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text)) return "ja";
  if (/\p{Script=Hangul}/u.test(text)) return "ko";
  return null;
};

// After a failed load, copies go unshaped for this long before the next try.
const RETRY_AFTER_MS = 60_000;
let loading = null;
let failedAt = -Infinity;

// Resolves to the shaper, or to null when HarfBuzz or a font cannot be loaded:
// the copy then falls back to the unshaped font path, never a failed download.
export function filingShaper() {
  if (!loading && Date.now() - failedAt < RETRY_AFTER_MS) return Promise.resolve(null);
  loading ??= loadFilingShaper().catch((error) => {
    console.error("[form-filing] text shaper unavailable", { error: String(error) });
    loading = null;
    failedAt = Date.now();
    return null;
  });
  return loading;
}

// The shaper with its fonts; `cjkFont` is where the CJK font is read from
// (tests pass a small subset of it).
export async function loadFilingShaper({ cjkFont = CJK_FONT } = {}) {
  const hb = await import("harfbuzzjs");
  const subsetModule = new WebAssembly.Module(readFileSync(new URL(import.meta.resolve("harfbuzzjs/dist/harfbuzz-subset.wasm"))));
  const bidi = bidiFactory();
  const entry = (key, bytes) => {
    const metrics = readFilingFont(bytes);
    const font = new hb.Font(new hb.Face(new hb.Blob(bytes)));
    return [key, { key, bytes: metrics.bytes, metrics, font, scale: 1 / metrics.unitsPerEm }];
  };
  const fonts = new Map(FONTS.map(([key, file]) => entry(key, readFileSync(new URL(`./fonts/${file}`, import.meta.url)))));
  return createShaper({ hb, bidi, fonts, subsetModule, loadCjk: () => entry("cjk", readFileSync(cjkFont))[1] });
}

export function createShaper({ hb, bidi, fonts, subsetModule, loadCjk = () => null }) {
  const latin = fonts.get("latin");
  // The CJK font, read the first time a copy needs it; null when it cannot
  // be read, and the copy then writes those characters as codes.
  let cjk;
  const cjkFont = () => {
    if (cjk === undefined) {
      try {
        cjk = loadCjk();
      } catch (error) {
        console.error("[form-filing] CJK font unavailable", { error: String(error) });
        cjk = null;
      }
      if (cjk) fonts.set("cjk", cjk);
    }
    return cjk;
  };
  const fontFor = (char, previous, cjkText) => {
    const code = char.codePointAt(0);
    if (CJK_CHAR.test(char)) cjkFont();
    // Marks, digits and punctuation stay with the run they sit in, so a script
    // is shaped as one run; a letter takes the first font that has it.
    if (previous && !LETTER.test(char) && previous.metrics.glyph(code)) return previous;
    // The CJK font is offered for a CJK character, and for every character of
    // a text that holds one (so ①, ★ or → in a Japanese answer draw wherever
    // they stand); never otherwise. It also has many symbols the other fonts
    // lack, and offering it for those in any text would make a copy depend on
    // whether this instance had read it for an earlier copy. The choice
    // depends only on the text, so a copy prints the same cold or warm.
    for (const font of fonts.values()) {
      if ((font.key !== "cjk" || cjkText || CJK_CHAR.test(char)) && font.metrics.glyph(code)) return font;
    }
    return null;
  };

  // The text as units: each drawable character with its font, or the
  // [U+XXXX] code (in Noto Sans) of one no font has.
  const units = (text) => {
    const out = [];
    let uncovered = false;
    let previous = null;
    const cjkText = CJK_CHAR.test(text) && Boolean(cjkFont());
    for (const char of text) {
      if (char === " ") { out.push({ space: true, text: " ", source: " " }); continue; }
      const font = fontFor(char, previous, cjkText);
      if (font) { out.push({ text: char, source: char, font }); previous = font; continue; }
      uncovered = true;
      const code = `[U+${char.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}]`;
      out.push({ text: code, source: char, font: latin, code: true });
      previous = latin;
    }
    return { units: out, uncovered };
  };

  // One HarfBuzz buffer for the shaper's life, reset before each run:
  // harfbuzzjs frees a buffer only when it is garbage collected, which cannot
  // happen while a copy is drawn.
  const buffer = new hb.Buffer();
  const shapeRun = (font, text, rtl, language = null) => {
    buffer.reset();
    buffer.addText(text);
    buffer.guessSegmentProperties();
    buffer.setDirection(rtl ? hb.Direction.RTL : hb.Direction.LTR);
    if (language) buffer.setLanguage(language);
    hb.shape(font.font, buffer);
    const infos = buffer.getGlyphInfos();
    const positions = buffer.getGlyphPositions();
    return infos.map((info, index) => ({
      g: info.codepoint,
      cluster: info.cluster,
      ax: positions[index].xAdvance * font.scale,
      dx: positions[index].xOffset * font.scale,
      dy: positions[index].yOffset * font.scale,
    }));
  };

  // One line in visual order: bidi levels on its text, same-font same-level
  // runs, runs reordered by UAX #9 rule L2, each shaped in its own direction.
  const visualRuns = (line, direction) => {
    // Levels come from the characters themselves: a code is one stand-in of
    // its character's bidi class, never its literal "[U+XXXX]" letters.
    const standIn = (unit) => {
      if (!unit.code) return unit.text;
      if (unit.source.length === 1) return unit.source;
      const type = bidi.getBidiCharTypeName(unit.source);
      // fixed-zone: ET here is the Unicode bidirectional class European Terminator, not a time zone
      return { L: "a", R: "\u05D0", AL: "\u0627", EN: "0", AN: "\u0660", NSM: "\u0300", BN: "\u00AD", ES: "+", ET: "#", CS: "," }[type] ?? "\uFFFC";
    };
    const text = line.map(standIn).join("");
    const levels = bidi.getEmbeddingLevels(text, direction === "auto" ? undefined : direction);
    const rtl = (levels.paragraphs[0]?.level ?? 0) % 2 === 1;
    const runs = [];
    let offset = 0;
    let previousFont = null;
    for (const unit of line) {
      const font = unit.space ? (previousFont?.metrics.glyph(32) ? previousFont : latin) : unit.font;
      const level = levels.levels[offset];
      const last = runs[runs.length - 1];
      // A [U+XXXX] code is a run of its own: its level places it among the
      // runs, and it is always shaped left to right, so it reads the same in
      // right-to-left text.
      if (!unit.code && last && !last.code && last.font === font && last.level === level) last.text += unit.text;
      else runs.push({ font, level, text: unit.text, code: Boolean(unit.code) });
      offset += standIn(unit).length;
      previousFont = font;
    }
    const maxLevel = Math.max(...runs.map((run) => run.level));
    const lowestOdd = Math.min(...runs.map((run) => run.level).filter((level) => level % 2 === 1), maxLevel + 1);
    for (let level = maxLevel; level >= lowestOdd; level -= 1) {
      for (let index = 0; index < runs.length;) {
        if (runs[index].level < level) { index += 1; continue; }
        let end = index;
        while (end < runs.length && runs[end].level >= level) end += 1;
        runs.splice(index, end - index, ...runs.slice(index, end).reverse());
        index = end;
      }
    }
    const language = cjkLanguage(text);
    for (const run of runs) {
      run.rtl = !run.code && run.level % 2 === 1;
      run.glyphs = shapeRun(run.font, run.text, run.rtl, run.font.key === "cjk" ? language : null);
    }
    return { runs, rtl };
  };
  // Width in em of a line exactly as it is drawn.
  const lineWidth = (line, direction) => visualRuns(line, direction).runs
    .reduce((total, run) => total + run.glyphs.reduce((sum, glyph) => sum + glyph.ax, 0), 0);

  // A word's units grouped by grapheme cluster (a [U+XXXX] code is one unit
  // standing for one character), so a break never falls inside a cluster.
  const graphemes = new Intl.Segmenter("und", { granularity: "grapheme" });
  const clusters = (word) => {
    const out = [];
    let unit = 0;
    for (const { segment } of graphemes.segment(word.map((each) => each.source).join(""))) {
      const cluster = [];
      for (let length = 0; length < segment.length; unit += 1) {
        cluster.push(word[unit]);
        length += word[unit].source.length;
      }
      out.push(cluster);
    }
    return out;
  };

  // Lines no wider than `width` points, each measured as it is drawn: breaks
  // at spaces, or between grapheme clusters of a word wider than a line
  // (never inside a cluster or a [U+XXXX] code).
  const breakLines = (all, size, width, direction) => {
    const words = [];
    let word = [];
    for (const unit of all) {
      if (unit.space) { if (word.length) words.push(word); word = []; } else word.push(unit);
    }
    if (word.length) words.push(word);
    const room = width / size;
    const fits = (candidate) => lineWidth(candidate, direction) <= room;
    const lines = [];
    let current = [];
    // Pieces of a word wider than a line, packed greedily: grapheme clusters,
    // or the units of a single cluster wider than a line by itself.
    const pack = (pieces) => {
      for (const piece of pieces) {
        if (current.length) {
          const candidate = [...current, ...piece];
          if (fits(candidate)) { current = candidate; continue; }
          lines.push(current);
          current = [];
        }
        if (piece.length > 1 && !fits(piece)) pack(piece.map((unit) => [unit]));
        else current = [...piece];
      }
    };
    for (const next of words) {
      if (current.length) {
        const candidate = [...current, { space: true, text: " ", source: " " }, ...next];
        if (fits(candidate)) { current = candidate; continue; }
        lines.push(current);
        current = [];
      }
      if (fits(next)) { current = [...next]; continue; }
      pack(clusters(next));
    }
    if (current.length) lines.push(current);
    return lines;
  };

  // One line placed: each glyph at its shaped position, with its text.
  const placeLine = (line, size, direction) => {
    const { runs, rtl } = visualRuns(line, direction);
    let x = 0;
    const placed = runs.map((run) => {
      const texts = glyphTexts(run.font, run.text, run.glyphs);
      return {
        key: run.font.key,
        glyphs: run.glyphs.map((glyph, index) => {
          // Right-to-left clusters of several letters are stored mirrored:
          // readers that reorder right-to-left text themselves then read
          // them in order (the line's ActualText is exact either way).
          const text = run.rtl ? [...texts[index]].reverse().join("") : texts[index];
          const out = { g: glyph.g, x: (x + glyph.dx) * size, y: glyph.dy * size, text };
          x += glyph.ax;
          return out;
        }),
      };
    });
    // ActualText is the line as printed: the stored text, with each character
    // no font has as the [U+XXXX] code the page shows.
    return { runs: placed, width: x * size, rtl, actualText: line.map((unit) => (unit.code ? unit.text : unit.source)).join("") };
  };

  return {
    // True when `text` holds an Arabic, Hebrew, Devanagari, Chinese,
    // Japanese or Korean character, or a character of a CJK block (fullwidth
    // digits, the postal mark 〒, the long-vowel mark ー), that Noto Sans
    // cannot draw and another of the shaper's fonts can. Only such text is
    // shaped: every other text (Western text, typed names, symbols) keeps the
    // renderer's own path, byte for byte as before the shaper.
    needs(text) {
      for (const char of String(text ?? "")) {
        const cjkChar = CJK_CHAR.test(char);
        if (!cjkChar && !SHAPED_SCRIPT.test(char)) continue;
        const code = char.codePointAt(0);
        if (cjkChar) cjkFont();
        if (!latin.metrics.glyph(code) && [...fonts.values()].some((font) => font.metrics.glyph(code))) return true;
      }
      return false;
    },
    // `text` uses plain spaces only (the renderer normalizes tab, newline,
    // carriage return and space). `direction` is the paragraph direction:
    // "ltr" for the copy's own lines (labels in English or Spanish), "auto"
    // for text that stands alone, such as a typed name. Returns the lines in
    // drawing order.
    layout(text, { size, width, direction = "ltr" }) {
      const { units: all, uncovered } = units(text);
      return { lines: breakLines(all, size, width, direction).map((line) => placeLine(line, size, direction)), uncovered };
    },
    // The font program for one copy: only the glyphs it draws, with the
    // licence names, and its PDF font descriptor metrics. A TrueType font
    // keeps its glyph ids. The CJK font's CFF table is embedded on its own
    // (FontFile3 /CIDFontType0C): its glyphs are renumbered, but each keeps
    // its CID, the number the copy draws it by.
    embed(key, glyphs) {
      const { metrics, bytes } = fonts.get(key);
      const subset = subsetFont(subsetModule, bytes, glyphs, !metrics.cff);
      const program = metrics.cff ? fontTable(subset, "CFF ") : subset;
      return { ...metrics, postScriptName: `${subsetTag(glyphs)}+${metrics.postScriptName}`, bytes: program, deflated: deflateSync(program, { level: 9 }) };
    },
  };
}

// The text each glyph stands for. A glyph that is the font's own glyph for a
// letter of its cluster takes that letter (a vowel sign drawn as its own
// glyph reads as that sign); the rest of the cluster's letters go on its
// first glyph (a conjunct or ligature reads as all its letters, once).
function glyphTexts(font, text, glyphs) {
  const out = glyphs.map(() => "");
  const clusters = [...new Set(glyphs.map((glyph) => glyph.cluster))].sort((a, b) => a - b);
  for (const [position, cluster] of clusters.entries()) {
    const chars = [...text.slice(cluster, clusters[position + 1] ?? text.length)];
    const members = glyphs.map((glyph, index) => (glyph.cluster === cluster ? index : -1)).filter((index) => index >= 0);
    const taken = chars.map(() => false);
    for (const index of members) {
      const found = chars.findIndex((char, at) => !taken[at] && font.metrics.glyph(char.codePointAt(0)) === glyphs[index].g);
      if (found >= 0 && members.length > 1) { out[index] = chars[found]; taken[found] = true; }
    }
    out[members[0]] = chars.filter((_, at) => !taken[at]).join("") + out[members[0]];
  }
  return out;
}

// HarfBuzz's subsetter on a fresh instance per copy, so no memory is kept
// between requests.
function subsetFont(module, bytes, glyphs, retainGids) {
  const wasm = new WebAssembly.Instance(module, {}).exports;
  const source = wasm.malloc(bytes.length);
  new Uint8Array(wasm.memory.buffer).set(bytes, source);
  const blob = wasm.hb_blob_create(source, bytes.length, HB_MEMORY_MODE_WRITABLE, 0, 0);
  const face = wasm.hb_face_create(blob, 0);
  wasm.hb_blob_destroy(blob);
  const input = wasm.hb_subset_input_create_or_fail();
  if (!input) throw new Error("subset input unavailable");
  const glyphSet = wasm.hb_subset_input_glyph_set(input);
  for (const glyph of [0, ...glyphs]) wasm.hb_set_add(glyphSet, glyph);
  const dropped = wasm.hb_subset_input_set(input, HB_SUBSET_SETS_DROP_TABLE_TAG);
  for (const tag of DROPPED_TABLES) wasm.hb_set_add(dropped, [...tag].reduce((value, char) => ((value << 8) | char.charCodeAt(0)) >>> 0, 0));
  const names = wasm.hb_subset_input_set(input, HB_SUBSET_SETS_NAME_ID);
  for (const id of [0, 1, 2, 3, 4, 5, 6, 13, 14]) wasm.hb_set_add(names, id);
  wasm.hb_subset_input_set_flags(input, (retainGids ? HB_SUBSET_FLAGS_RETAIN_GIDS : 0) | HB_SUBSET_FLAGS_NO_HINTING);
  const subset = wasm.hb_subset_or_fail(face, input);
  wasm.hb_subset_input_destroy(input);
  if (!subset) throw new Error("font subset failed");
  const result = wasm.hb_face_reference_blob(subset);
  const length = wasm.hb_blob_get_length(result);
  const data = wasm.hb_blob_get_data(result, 0);
  return new Uint8Array(wasm.memory.buffer.slice(data, data + length));
}

// One table of an OpenType font, by tag.
function fontTable(font, tag) {
  const view = new DataView(font.buffer, font.byteOffset, font.byteLength);
  for (let index = 0; index < view.getUint16(4); index += 1) {
    const at = 12 + (index * 16);
    if (String.fromCharCode(...font.subarray(at, at + 4)) === tag) {
      const offset = view.getUint32(at + 8);
      return font.slice(offset, offset + view.getUint32(at + 12));
    }
  }
  throw new Error(`font has no ${tag} table`);
}

// The six-letter subset tag PDF names a subset font with, derived from the
// glyph set so the same copy gets the same name.
function subsetTag(glyphs) {
  let hash = 2166136261;
  for (const glyph of [...glyphs].sort((a, b) => a - b)) {
    hash ^= glyph;
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  let tag = "";
  for (let index = 0; index < 6; index += 1) { tag += String.fromCharCode(65 + (hash % 26)); hash = Math.floor(hash / 26); }
  return tag;
}
